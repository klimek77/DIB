# Auth Refit — Magic-Link + Admin Allow-List Implementation Plan

## Overview

Replace the scaffold's email+password auth (with open self-registration) with passwordless **magic-link** login, gated by a manually-configured **admin allow-list**. This is a refit, not an addition: the password and self-registration paths are removed so no two login paths can coexist. This change also closes the F-01 exposure — `submissions_authenticated_select USING (true)` is open to *any* authenticated user, which is only safe once the only way to authenticate is to be an allow-listed admin.

Implements roadmap **F-02** (`auth-refit-magic-link`, Stream B) → PRD **FR-009** + **Access Control** (admin path).

## Current State Analysis

The repo ships the `10x-astro-starter` scaffold auth (Supabase SSR, password-based):

- `src/lib/supabase.ts:7` — `createClient(headers, cookies)` wraps `createServerClient` (`@supabase/ssr` ^0.10.3) with cookie `getAll`/`setAll`. Returns `null` when env is unconfigured. **Reused unchanged** — its `setAll → cookies.set` wiring is exactly what the PKCE callback needs.
- `src/middleware.ts:4` — guards `PROTECTED_ROUTES = ["/dashboard"]`, sets `locals.user` from `supabase.auth.getUser()`, redirects unauthenticated users to `/auth/signin`. **No allow-list check** — any authenticated Supabase user passes.
- `src/pages/api/auth/signin.ts` — POST `{email, password}` → `signInWithPassword` → redirect `/`. **Rewritten** to magic-link request.
- `src/pages/api/auth/signup.ts` + `src/pages/auth/signup.astro` + `src/pages/auth/confirm-email.astro` + `src/components/auth/SignUpForm.tsx` — open self-registration (`signUp`); **anyone can create an account today**. **Deleted.**
- `src/pages/api/auth/signout.ts`, `src/components/Topbar.astro`, `src/pages/dashboard.astro` signout form — kept (signout is unchanged).
- `src/components/auth/{FormField,SubmitButton,ServerError,PasswordToggle}.tsx` — `PasswordToggle` becomes orphaned after the refit (**deleted**); the other three are reused by the email-only sign-in form.
- `astro.config.mjs:18` — env schema exposes only `SUPABASE_URL` / `SUPABASE_KEY` as optional server secrets. **No allow-list var.**
- `src/lib/config-status.ts` — drives a "Supabase not configured" banner; extended with an allow-list-unconfigured warning.
- **No test runner** (testing deferred to Module 3). Automated verification = `astro check` + `eslint` + `astro build`.

### Key Discoveries:

- **Magic-link request** is `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser, emailRedirectTo } })` (Supabase Auth docs, verified 2026-06-01).
- **PKCE callback**: `@supabase/ssr` uses the PKCE flow → the email link returns `?code=` to a server route that calls `exchangeCodeForSession(code)`. The canonical Astro pattern is a `GET` handler at `src/pages/auth/callback.ts`; it builds the SSR server client and exchanges the code, which sets the session cookies via `setAll`. Our existing `createClient` already provides that client.
- **Code-verifier cookie** is written at request time (during `signInWithOtp` on the server), so the link must be opened in the **same browser** that requested it.
- **Workers Set-Cookie quirk** (`infrastructure.md` Devil's Advocate #3): callback cookies can fail to round-trip on Workers' streaming response model — breaks in prod, not dev. Must be tested behind a preview deploy with explicit cookie attributes.
- **F-01 RLS is app-gated, not DB-gated** here — see "What We're NOT Doing" and "Open Risks & Assumptions".

## Desired End State

- The only way to reach `/dashboard` is: enter an allow-listed work email on `/auth/signin` → receive a magic link → open it in the same browser → land authenticated on `/dashboard`.
- A non-allow-listed email receives **no email** and sees the same neutral confirmation as an allow-listed one (no enumeration).
- `/auth/signup` returns 404; no password field exists anywhere; `signInWithPassword` / `signUp` are not called by any code path.
- With `ALLOWED_ADMIN_EMAILS` empty/unset, **no one** can authenticate, and the home page shows a config-status warning.
- A stale session for an email that was removed from the allow-list is blocked from `/dashboard` by middleware.

**Verification of end state:** the Phase 2/3 manual checks below, run against local Supabase (Mailpit/Inbucket for email) and once against a Cloudflare preview deploy for the cookie round-trip.

## What We're NOT Doing

- **Not changing the F-01 RLS policy** (`submissions_authenticated_select USING (true)`). The chosen allow-list lives in an env-var, so there is no `auth.uid()` roster in the DB to gate against. The policy is safe because the employee submission path is anonymous (`anon`) and the only principals that can obtain a Supabase session are allow-listed admins → `authenticated ≡ admin`. (See Open Risks for the invalidation trigger.)
- **Not building an admin-management UI or DB allow-list table** — env-var is the source of truth (lessons.md: don't build a consumer that doesn't exist yet).
- **Not configuring the Cloudflare Access network gate** — that is roadmap F-04 (`corporate-network-gate`), independent of this change.
- **Not setting up custom SMTP in code** — the spam-filter mitigation is a Supabase dashboard config + IT coordination step, surfaced as a risk, not implemented here.
- **Not adding role hierarchy, password reset, or account recovery** — PRD Non-Goals / out of MVP scope.
- **Not adding rate-limiting** beyond Supabase's built-in OTP request limits.

## Implementation Approach

Three phases, ordered so the **security-relevant cut lands before cosmetic UI work**, and so each phase is independently verifiable:

1. **Phase 1 (additive):** introduce the allow-list config + helper with no behavior change. Nothing depends on it yet, so it can't break login.
2. **Phase 2 (security cut):** swap the auth path — rewrite the sign-in endpoint to request a magic link (request-time gate), add the callback (exchange + session-time gate), add the middleware session gate, and delete the self-registration endpoint + its confirmation page. After this phase **no endpoint accepts a password or self-registration**.
3. **Phase 3 (cosmetic):** strip the password/self-registration UI — email-only sign-in form, delete the sign-up page + now-orphaned components, fix copy and nav links.

Ships **atomically** (single branch, single deploy): see Critical Implementation Details for why no intermediate deploy is allowed.

## Critical Implementation Details

- **Atomic ship.** Between Phase 2 and Phase 3 the `SignInForm` still renders a password field that the rewritten endpoint ignores, and the sign-up *page* still exists though its endpoint is gone. This is fine within one branch but must **not** be deployed as an intermediate state. Deploy only after Phase 3.
- **`emailRedirectTo` must be an absolute URL** derived from the incoming request origin (Workers has no fixed base), pointing at `/auth/callback`, and that exact URL (plus preview-Worker subdomains) must be present in Supabase → Auth → URL Configuration → Redirect URLs. A missing entry makes the callback fail silently with an auth error.
- **Magic-link delivery shape is config-dependent.** Under the `@supabase/ssr` PKCE default the link carries `?code=`, but a project whose email template uses `{{ .TokenHash }}` (or that isn't on the PKCE flow) delivers `token_hash` + `type` and no `code`. The callback handles both (Phase 2 #2); during verification, confirm which param the actual link carries so a silent bounce-to-signin is diagnosable.
- **Workers cookie round-trip.** Pin `SameSite`/`Secure`/`Path` on the session cookies and verify the callback end-to-end on a Cloudflare preview deploy, not just local dev (infra Devil's Advocate #3). Local success does not prove prod success here.
- **Single shared `isAllowedAdmin()` helper** is used by the request endpoint, the callback, and the middleware so the three enforcement points cannot drift. Email comparison is case-insensitive and trimmed.
- **Non-allowed session must be cleared, not just redirected.** The callback signs out a successfully-authenticated-but-not-allowed user before redirecting; middleware additionally blocks `/dashboard` for any non-allowed session as defense in depth.

---

## Phase 1: Allow-list config + helper

### Overview

Add the `ALLOWED_ADMIN_EMAILS` env var, a fail-closed allow-list helper, and a config-status warning. No auth behavior changes — purely new surface that later phases consume.

### Changes Required:

#### 1. Env schema

**File**: `astro.config.mjs`

**Intent**: Expose the admin allow-list as a server-only secret so it is readable via `astro:env/server` like the existing Supabase vars and never reaches the client.

**Contract**: Add `ALLOWED_ADMIN_EMAILS: envField.string({ context: "server", access: "secret", optional: true })` to the `env.schema` block. Optional so the build/typecheck pass without it set; "configured" is decided at runtime by the helper.

#### 2. Allow-list helper

**File**: `src/lib/auth/allowlist.ts` (new)

**Intent**: Single source of truth for "is this email an admin?" plus a "is the list configured?" check for the banner. Fail-closed: an empty or unset list authorizes no one.

**Contract**: Reads `ALLOWED_ADMIN_EMAILS` from `astro:env/server`. Exports:
- `isAllowlistConfigured(): boolean` — true only when the parsed list is non-empty.
- `isAllowedAdmin(email: string | null | undefined): boolean` — case-insensitive, trimmed membership test; returns `false` for empty input or empty list.

```ts
// parse once at module load; comma-separated, trimmed, lowercased, empties dropped
const allowed = new Set(
  (ALLOWED_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);
export const isAllowlistConfigured = () => allowed.size > 0;
export const isAllowedAdmin = (email?: string | null) =>
  !!email && allowed.has(email.trim().toLowerCase());
```

#### 3. Config-status warning

**File**: `src/lib/config-status.ts`

**Intent**: Surface a visible banner when the allow-list is unconfigured, so a fail-closed deploy (nobody can log in) is diagnosable at a glance rather than looking like a broken login.

**Contract**: Append a `ConfigStatus` entry `{ name: "Admin allow-list", configured: isAllowlistConfigured(), message: "ALLOWED_ADMIN_EMAILS nie jest ustawiony — logowanie administratora jest wyłączone (fail-closed)." }`. Reuses the existing `missingConfigs` filter — no banner-component change needed.

### Success Criteria:

#### Automated Verification:

- Typecheck passes: `npm run typecheck`
- Targeted lint clean: `npx eslint src/lib/auth/allowlist.ts src/lib/config-status.ts astro.config.mjs`
- Build passes: `npm run build`

#### Manual Verification:

- With `ALLOWED_ADMIN_EMAILS` unset, the home page shows the "Admin allow-list" warning banner.
- Reading `allowlist.ts`: empty/unset list → `isAllowedAdmin` returns `false` for every input (fail-closed confirmed); a configured `"a@x.com, B@X.com"` matches `"A@x.com"` (case/whitespace-insensitive).

**Implementation Note**: After automated verification passes, pause for human confirmation of the manual checks before Phase 2.

---

## Phase 2: Swap the auth path — magic-link + gates

### Overview

Rewrite sign-in to request a magic link (request-time allow-list gate), add the PKCE callback (exchange + session-time gate), add the middleware session gate, and remove the self-registration endpoint and its confirmation page. After this phase, password and self-registration are gone at the endpoint level.

### Changes Required:

#### 1. Magic-link request endpoint

**File**: `src/pages/api/auth/signin.ts`

**Intent**: Replace password sign-in with a magic-link request. Apply the request-time gate (skip sending to non-allowed emails) and always redirect to the neutral "check your email" page regardless of allow-list status (no enumeration).

**Contract**: `POST` reads `email` from form data. If `isAllowedAdmin(email)`, call `signInWithOtp` with `shouldCreateUser: true` and `emailRedirectTo` = `${new URL(context.request.url).origin}/auth/callback`. Always redirect to `/auth/check-email`. If `createClient` returns `null`, redirect to `/auth/signin?error=...` as today.

```ts
// only this branch sends an email; non-allowed emails fall through silently
if (isAllowedAdmin(email)) {
  await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: `${origin}/auth/callback` },
  });
}
return context.redirect("/auth/check-email");
```

#### 2. PKCE callback

**File**: `src/pages/auth/callback.ts` (new)

**Intent**: Establish a session from the magic-link callback, enforce the session-time allow-list, and land the admin on `/dashboard`. Handle **both** link shapes Supabase may deliver so the callback works regardless of the project's flow config / email template (see Critical Implementation Details).

**Contract**: `GET` builds the client via the existing `createClient(context.request.headers, context.cookies)`. If it returns `null` (Supabase unconfigured), redirect `/auth/signin?error=...` — matching the guard in `signin.ts:10` and `middleware.ts:9`. Otherwise it accepts either delivery shape:
- **PKCE** (`@supabase/ssr` default): a `?code=` query param → `exchangeCodeForSession(code)`.
- **Token-hash** (some templates / non-PKCE flow): `token_hash` + `type` query params → `verifyOtp({ token_hash, type })`.

If neither param is present, or the exchange/verify errors → redirect `/auth/signin?error=...` (neutral). On success, read the authenticated email; if **not** `isAllowedAdmin`, call `signOut()` and redirect `/auth/signin` (neutral denied). If allowed, redirect `/dashboard`.

```ts
const code = url.searchParams.get("code");
const tokenHash = url.searchParams.get("token_hash");
const type = url.searchParams.get("type"); // e.g. "magiclink" | "email"
const result = code
  ? await supabase.auth.exchangeCodeForSession(code)
  : tokenHash && type
    ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    : { data: { user: null }, error: new Error("missing code/token_hash") };
if (result.error || !isAllowedAdmin(result.data.user?.email)) {
  await supabase.auth.signOut();
  return context.redirect("/auth/signin");
}
return context.redirect("/dashboard");
```

#### 3. Middleware session gate

**File**: `src/middleware.ts`

**Intent**: Make the allow-list authoritative on every protected request, so a forwarded link or a removed admin's stale session cannot read the dashboard. This is the check that closes the F-01 exposure.

**Contract**: After resolving `context.locals.user`, treat a user whose email is not `isAllowedAdmin` as unauthenticated: for `PROTECTED_ROUTES`, redirect to `/auth/signin`. Leaves the existing null-user redirect intact. (`locals.user` stays the raw Supabase user; the gate is purely access control.)

#### 4. Neutral "check your email" page

**File**: `src/pages/auth/check-email.astro` (new)

**Intent**: The single post-request landing page for both allowed and non-allowed emails — neutral copy that never reveals whether an email is on the list.

**Contract**: Static Astro page using `Layout`, copy along the lines of "Jeśli ten adres jest uprawniony, wysłaliśmy link do logowania. Sprawdź skrzynkę." with a link back to `/auth/signin`. No query params, no conditional state.

#### 5. Delete self-registration endpoint + old confirmation page

**Files**: `src/pages/api/auth/signup.ts` (delete), `src/pages/auth/confirm-email.astro` (delete)

**Intent**: Remove the open `signUp` path and the signup-specific confirmation page (superseded by `check-email.astro`).

**Contract**: Files removed. No code references `confirm-email` after `signup.ts` is gone (it was only the `signup.ts` redirect target).

#### 6. Local Supabase dev config (addendum — landed in Phase 2)

**File**: `supabase/config.toml`

**Intent**: Align local-dev auth redirect URLs with the Astro dev server so the magic-link callback round-trips during local manual verification (2.6/2.7). Local-only — production redirect URLs are configured in the Supabase dashboard (manual check 2.5).

**Contract**: `site_url` → `http://localhost:4321`; `additional_redirect_urls` → `["http://localhost:4321/**", "http://127.0.0.1:4321/**"]`. No production impact.

### Success Criteria:

#### Automated Verification:

- Typecheck passes: `npm run typecheck`
- Targeted lint clean: `npx eslint src/pages/api/auth/signin.ts src/pages/auth/callback.ts src/middleware.ts src/pages/auth/check-email.astro`
- Build passes: `npm run build`
- `signup.ts` and `confirm-email.astro` no longer exist; `grep -r "signInWithPassword\|signUp\b" src/` returns nothing.

#### Manual Verification:

- Supabase → Auth → URL Configuration → Redirect URLs includes `<origin>/auth/callback` (and preview-Worker subdomains).
- Local: `supabase start` + Mailpit/Inbucket. Allowed email → link arrives → opened in the same browser → lands authenticated on `/dashboard`.
- Non-allowed email → `/auth/check-email` shown and **no email sent** (Mailpit empty).
- Remove your email from `ALLOWED_ADMIN_EMAILS` while holding a valid session → `/dashboard` redirects to `/auth/signin`.
- Cookie round-trip verified on a Cloudflare **preview deploy** (not only local) — admin stays logged in after callback.

**Implementation Note**: After automated verification passes, pause for human confirmation of the manual checks before Phase 3.

---

## Phase 3: Retire password/self-registration UI

### Overview

Strip the remaining password/self-registration UI so the surface matches the magic-link endpoints from Phase 2.

### Changes Required:

#### 1. Email-only sign-in form

**File**: `src/components/auth/SignInForm.tsx`

**Intent**: Reduce the form to a single email field that posts to the magic-link endpoint.

**Contract**: Remove password state, `PasswordToggle`, and password validation. Keep email validation, `FormField` (email), `ServerError`, `SubmitButton`. Submit still `POST`s to `/api/auth/signin`; button label "Send magic link" / pending "Sending link…".

#### 2. Delete sign-up page + orphaned components

**Files**: `src/pages/auth/signup.astro` (delete), `src/components/auth/SignUpForm.tsx` (delete), `src/components/auth/PasswordToggle.tsx` (delete)

**Intent**: Remove the self-registration page and the components no longer referenced after the email-only refit.

**Contract**: Files removed. `FormField`, `SubmitButton`, `ServerError` remain (still used by `SignInForm`).

#### 3. Sign-in page copy

**File**: `src/pages/auth/signin.astro`

**Intent**: Update heading/copy for passwordless login and drop the "Don't have an account? Sign up" link.

**Contract**: Remove the sign-up link paragraph; adjust copy to instruct entering a work email to receive a sign-in link. Still renders `SignInForm` with the `serverError` prop.

#### 4. Topbar nav

**File**: `src/components/Topbar.astro`

**Intent**: Remove the "Sign up" link from the logged-out state (keep "Sign in"); logged-in state (email + Dashboard + Sign out) unchanged.

**Contract**: Delete the `Sign up` anchor in the `else` branch.

#### 5. Welcome page CTA

**File**: `src/components/Welcome.astro`

**Intent**: Remove the home-page "Sign Up" button (lines 47–52) that points to the now-deleted `/auth/signup`, leaving "Sign In" as the sole call-to-action. This is the third `/auth/signup` caller (alongside `signin.astro` and `Topbar.astro`).

**Contract**: Delete the second `<a href="/auth/signup">…Sign Up…</a>` button; keep the "Sign In" button. No `/auth/signup` reference should remain anywhere in `src/`.

### Success Criteria:

#### Automated Verification:

- Typecheck passes: `npm run typecheck`
- Targeted lint clean: `npx eslint src/components/auth/SignInForm.tsx src/pages/auth/signin.astro src/components/Topbar.astro src/components/Welcome.astro`
- Build passes: `npm run build` (catches dangling imports of deleted components)
- `signup.astro`, `SignUpForm.tsx`, `PasswordToggle.tsx` no longer exist.
- No self-registration links remain: `grep -rn "/auth/signup" src/` returns nothing.

#### Manual Verification:

- `/auth/signin` shows an email-only form, "Send magic link" button, no password field, no "Sign up" link.
- `/auth/signup` returns 404.
- Logged-out Topbar **and** the home page (`Welcome.astro`) show "Sign in" only (no "Sign up"); logged-in Topbar/dashboard signout still works.

**Implementation Note**: After automated verification passes, pause for human confirmation, then this change is ready to ship (single deploy).

---

## Testing Strategy

No automated test runner exists (testing is introduced in Module 3), so verification is build/typecheck/lint + structured manual checks.

### Manual Testing Steps:

1. Local Supabase up (`supabase start`), `ALLOWED_ADMIN_EMAILS` set to your email; request a link, read it in Mailpit/Inbucket, open in the same browser → authenticated on `/dashboard`.
2. Non-allowed email → neutral page, no email sent.
3. Empty `ALLOWED_ADMIN_EMAILS` → home banner warns; no login possible.
4. Removed-from-list stale session → blocked from `/dashboard`.
5. Preview deploy → callback cookie round-trip holds on Workers.
6. `/auth/signup` → 404; no password field anywhere.

## Performance Considerations

Negligible. Allow-list parsing happens once at module load; auth calls are network-bound to Supabase. Magic-link confirmation is well within the PRD's <1s expectation (that NFR is about the employee submission path, not admin login).

## Migration Notes

Scaffold Supabase project likely has no real password users; if any test users exist they are simply orphaned (password login removed). No data migration. `ALLOWED_ADMIN_EMAILS` must be set via `wrangler secret put ALLOWED_ADMIN_EMAILS` before the production deploy, and `/auth/callback` added to Supabase Redirect URLs.

## References

- Roadmap: `context/foundation/roadmap.md` → F-02
- PRD: `context/foundation/prd.md` → FR-009, `## Access Control`
- Infra risk register: `context/foundation/infrastructure.md` (Set-Cookie quirk, SMTP spam-filter)
- Lessons: `context/foundation/lessons.md` (deferred permissive gate; don't build absent consumers)
- Supabase Auth docs (verified 2026-06-01): `signInWithOtp`, `exchangeCodeForSession`, Astro callback route
- Reused client: `src/lib/supabase.ts:7`

## Open Risks & Assumptions

- **Assumption: only admins ever authenticate.** This is what makes the unchanged F-01 RLS (`USING (true)`) safe. **Invalidation trigger:** if a future change gives employees Supabase accounts (any non-admin authenticated principal), `USING (true)` becomes a read hole and the admin SELECT policy must be tightened then. (lessons.md: "A deferred permissive gate is live exposure".)
- **Magic-link emails may be soft-blocked** by the corporate spam filter → configure Supabase Auth custom SMTP with an SPF/DKIM-trusted From-domain; coordinate with IT before pilot (infra Pre-Mortem). Not blocking for local/dev verification.
- **Workers Set-Cookie round-trip** may differ prod vs dev → must verify on a preview deploy (infra Devil's Advocate #3).
- **PKCE same-browser requirement** → a link opened on a different device fails; acceptable for admins on their work machine; documented in `check-email` expectations.
- **Supabase Redirect URLs** must include `/auth/callback` (+ preview subdomains); a missing entry breaks the callback.
- **Fail-closed lockout**: a botched `ALLOWED_ADMIN_EMAILS` secret locks out all admins (loud, intended) — the config-status banner is the safety net.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Allow-list config + helper

#### Automated

- [x] 1.1 Typecheck passes: `npm run typecheck` — 7c61c5a
- [x] 1.2 Targeted lint clean on `allowlist.ts`, `config-status.ts`, `astro.config.mjs` — 7c61c5a
- [x] 1.3 Build passes: `npm run build` — 7c61c5a

#### Manual

- [x] 1.4 Home page shows "Admin allow-list" warning when unset — 7c61c5a
- [x] 1.5 `isAllowedAdmin` fail-closed on empty; case/whitespace-insensitive when configured — 7c61c5a

### Phase 2: Swap the auth path — magic-link + gates

#### Automated

- [x] 2.1 Typecheck passes: `npm run typecheck` — eb2b27c
- [x] 2.2 Targeted lint clean on `signin.ts`, `callback.ts`, `middleware.ts`, `check-email.astro` — eb2b27c
- [x] 2.3 Build passes: `npm run build` — eb2b27c
- [x] 2.4 `signup.ts` + `confirm-email.astro` deleted; no `signInWithPassword`/`signUp` references in `src/` — eb2b27c

#### Manual

- [x] 2.5 `/auth/callback` present in Supabase Redirect URLs (+ preview subdomains) — eb2b27c
- [x] 2.6 Allowed email → link → same-browser open → authenticated on `/dashboard` — eb2b27c
- [x] 2.7 Non-allowed email → neutral `/auth/check-email`, no email sent — eb2b27c
- [x] 2.8 Removed-from-list stale session → blocked from `/dashboard` — eb2b27c
- [ ] 2.9 Cookie round-trip holds on a Cloudflare preview deploy

### Phase 3: Retire password/self-registration UI

#### Automated

- [x] 3.1 Typecheck passes: `npm run typecheck`
- [x] 3.2 Targeted lint clean on `SignInForm.tsx`, `signin.astro`, `Topbar.astro`, `Welcome.astro`
- [x] 3.3 Build passes: `npm run build`
- [x] 3.4 `signup.astro`, `SignUpForm.tsx`, `PasswordToggle.tsx` deleted
- [x] 3.5 No `/auth/signup` references remain in `src/` (`grep -rn`)

#### Manual

- [x] 3.6 `/auth/signin` is email-only, "Send magic link", no password field, no sign-up link
- [x] 3.7 `/auth/signup` returns 404
- [x] 3.8 Logged-out Topbar + home page show "Sign in" only; signout still works
