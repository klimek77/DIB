---
date: 2026-06-09T00:00:00+02:00
researcher: klimek77
git_commit: d1191f8eb6ea81d5157c742b885f2201169bae07
branch: main
repository: klimek77/DIB
topic: "Auth & abuse-boundary: magic-link spam/enumeration (#5) + Workers cookie/PKCE round-trip (#6)"
tags: [research, codebase, auth, magic-link, allowlist, pkce, cloudflare-workers, set-cookie, enumeration, rate-limit]
status: complete
last_updated: 2026-06-09
last_updated_by: klimek77
last_updated_note: "Added follow-up research resolving the 4 open questions (hosted-project rate limits & SMTP, magic-link code-vs-link path, redirect URLs, vitest-pool-workers CI cost)"
---

# Research: Auth & abuse-boundary (rollout Phase 3 — risks #5 and #6)

**Date**: 2026-06-09T00:00:00+02:00
**Researcher**: klimek77
**Git Commit**: d1191f8eb6ea81d5157c742b885f2201169bae07
**Branch**: main
**Repository**: klimek77/DIB

> References are local `file:line` (clickable in-terminal, consumed by `/10x-plan`). They are NOT
> rewritten to GitHub permalinks: the primary consumers are local skills, and several load-bearing
> refs live in `node_modules/**` (not in the repo, not permalinkable). The commit is pushed
> (`main == origin/main`), so any `src/**` ref can be permalinked on demand against `d1191f8`.

## Research Question

Ground the risk-response assumptions for Phase 3 of `context/foundation/test-plan.md` ("Auth & granica
nadużyć"), verifying — not assuming — the two risks:

- **#5** (Medium×Medium) — spam / enumeration of magic-links: repeated OTP requests flood the inbox,
  hit an SMTP rate-limit, or reveal which email is on the allow-list.
- **#6** (High×Medium) — magic-link cookie/PKCE does not round-trip on the Workers runtime (prod ≠ dev):
  the admin cannot log in on production even though it works locally.

The §2 "Risk Response Guidance" columns define exactly what research must ground:
- #5: *does Supabase OTP have a built-in throttle; how does the allow-list behave fail-closed; is the
  response identical for an account vs a non-account.*
- #6: *the shape of Set-Cookie on a streaming Workers response; the format and handoff of the PKCE verifier.*

## Summary

Both risks are **well-mitigated in the live code**, and the test plan's chosen verification mix is
correct. The research changes the framing of each risk from "is it protected?" to "what is the cheapest
test that proves the protection without a false green?":

- **#5 is largely closed by construction.** The allow-list is enforced **before** the OTP is sent
  (`src/pages/api/auth/signin.ts:18`), so a non-allow-listed address never receives an email — the spam
  vector is gated, not rate-limited. Enumeration is closed because the endpoint **always** redirects to
  the same neutral page (`/auth/check-email`) regardless of allow-list membership, malformed input, or a
  swallowed Supabase error (`signin.ts:28-34`). A **built-in Supabase throttle does exist and is
  explicitly configured** (`supabase/config.toml`: `email_sent=2/h`, `max_frequency="1s"`,
  `sign_in_sign_ups=30/5min`, `token_verifications=30/5min`) and **there is no custom rate-limiter** in
  the codebase. → The cheapest real signal is an **integration test of allow-list fail-closed +
  non-enumeration** (node env, mock the Supabase client). The throttle should be **documented as present,
  not unit-tested** (it is Supabase-owned, environment-dependent, and not reproducible in the node harness).

- **#6's most-cited failure hypothesis is ruled out by the code; the real exposure is narrower.** The flow
  is a textbook `@supabase/ssr` server-side **PKCE** flow through a **single shared client factory**
  (`src/lib/supabase.ts`), so the PKCE verifier round-trips by construction (same adapter writes it at
  signin and reads it at callback). `secure: true`-over-http, multiple-`Set-Cookie`-collapse, and
  cookies-dropped-on-302 are all **ruled out** by what the libraries actually emit. The genuine prod≠dev
  axes are: (1) the cookie write is a **runtime-timing property** of the streaming Workers response — a
  mocked-cookie unit test proves "the adapter was called", not "the header survives on the deployed edge"
  (the test plan's "fałszywy zielony"); and (2) `emailRedirectTo` is computed from the **request origin**
  (`signin.ts:19`), so dev (`localhost`) and prod (real domain) differ, and `SameSite=Lax` + a
  cross-origin / email-redirector hop (or a missing Supabase Redirect-URL allow-list entry) can drop the
  verifier and bounce the user silently to `/auth/signin`. → This justifies the plan's mix verbatim:
  **a `@cloudflare/vitest-pool-workers` contract test** for the Set-Cookie shape on a real `workerd`
  Response, **plus a manual preview-deploy smoke** for the cross-origin verifier round-trip (the
  highest-risk axis no in-repo test can reproduce).

**Net for the plan:** #5 → one integration spec (existing node harness, no new tooling). #6 → one
contract spec that requires **adding `@cloudflare/vitest-pool-workers`** (absent today, §4/§6.3 of the
plan anticipate this) + the already-required manual preview smoke (§5 gate).

## Detailed Findings

### Risk #5 — magic-link spam / admin enumeration

#### A. OTP-request endpoint and the pre-send allow-list gate

The only place a magic link is requested is `POST /api/auth/signin`
(`src/pages/api/auth/signin.ts`). The structure is the entire risk story:

- Email is read and trimmed (`signin.ts:7`), no server-side format validation (client-side only, in
  `src/components/auth/SignInForm.tsx:19-20`).
- **The allow-list is checked BEFORE the OTP send** (`signin.ts:18`): `if (isAllowedAdmin(email)) { ...
  signInWithOtp(...) }`. A non-allow-listed email **never reaches Supabase** — no email is dispatched.
- The `signInWithOtp` call (`signin.ts:21-27`) passes `shouldCreateUser: true` and
  `emailRedirectTo: ${origin}/auth/callback` (origin derived from the request — see #6).
- Transport throws are **swallowed** (`signin.ts:28-31`) precisely so an allowed-but-erroring email still
  lands on the neutral page and never leaks a 500.
- **Unconditional** `return context.redirect("/auth/check-email")` (`signin.ts:34`).

So the spam vector for #5 is **gated, not throttled**: the abuse "flood a non-admin's inbox" is
impossible because non-admins are filtered out before send; "flood an admin's inbox" is bounded by the
Supabase built-in throttle (below).

#### B. The allow-list module (fail-closed, frozen-at-import)

`src/lib/auth/allowlist.ts` (28 lines):
- Loads `ALLOWED_ADMIN_EMAILS` from `astro:env/server` (`allowlist.ts:1`), declared in
  `astro.config.mjs:21` as a server-secret, optional string. Comma-separated (`.env.example:4`).
- Builds a **frozen `Set` once at module load** (`allowlist.ts:12-17`), normalizing each entry with
  `.trim().toLowerCase()` and `.filter(Boolean)`. Mutating env after import does NOT rebuild the Set.
- `isAllowedAdmin(email)` → `!!email && allowed.has(email.trim().toLowerCase())` (`allowlist.ts:25-27`).
- `isAllowlistConfigured()` → `allowed.size > 0` (`allowlist.ts:20-21`).
- **Fail-closed by design** (`allowlist.ts:7-10` comment): an empty/unset list authorizes no one.

#### C. Non-enumeration (response is identical for account vs non-account)

Confirmed identical across all cases — the endpoint cannot be used to enumerate the admin roster:
- Allow-listed → email sent → 302 `/auth/check-email`.
- Non-allow-listed → no email → **same** 302 `/auth/check-email` (no `?error=`, no differing status).
- Malformed / Supabase error on allowed → swallowed → **same** 302 `/auth/check-email`.
- The landing page (`src/pages/auth/check-email.astro:14-16`) is generic: *"Jeśli ten adres jest
  uprawniony, wysłaliśmy na niego link…"* — it never confirms membership or send.

Defense in depth — two more gates re-apply the **same** `isAllowedAdmin` helper so the three points
cannot drift:
- **Callback gate** (`src/pages/auth/callback.ts:35-42`): after `exchangeCodeForSession`, a successfully
  authenticated-but-not-allowed user is **signed out** and redirected to `/auth/signin` (neutral).
- **Middleware gate** (`src/middleware.ts:22-26`): every `/dashboard*` request re-checks the allow-list
  against the session user; not-allowed → redirect `/auth/signin`. This is the gate that closes the F-01
  "any authenticated user can read" exposure.

#### D. The built-in throttle exists and is configured; no custom rate-limiter

`supabase/config.toml` `[auth.rate_limit]` and `[auth.email]`:
- `email_sent = 2` per hour (`config.toml:182`) — applies to OTP delivery.
- `max_frequency = "1s"` (`config.toml:213`) — minimum interval between OTP sends per user.
- `sign_in_sign_ups = 30` per 5-min per IP (`config.toml:190`); `token_verifications = 30` per 5-min per
  IP (`config.toml:192`); `otp_expiry = 3600`, `otp_length = 6`.
- **Custom SMTP is commented out** (`config.toml:219-227`) → default Supabase sandbox/inbucket
  (`config.toml:97-107`) is in effect locally, so the built-in `email_sent` limit applies unmodified.
- **No custom rate-limiter anywhere** in `src/**` (no `rateLimit`/`throttle`/`cooldown`/`429`/KV/DO
  counters on the auth path; the only `429` is in `src/lib/enrichment/errors.ts:27`, unrelated). No
  rate-limit library in `package.json`.

→ Confirms the plan's instruction: *"najpierw zweryfikuj built-in throttle — nie testuj rate-limitera,
którego nie ma"*. The built-in throttle **is real** (so the risk is bounded), but it is **Supabase-owned
and environment-specific** (see Open Questions on `config.toml` vs hosted-project settings), so it is not
a unit-test target.

### Risk #6 — magic-link cookie / PKCE round-trip on the Workers runtime

#### A. Callback route

`src/pages/auth/callback.ts` (45 lines, server endpoint):
- Builds the SSR client from the **same factory**, passing request headers + Astro cookies
  (`callback.ts:6`).
- Reads `code` (`callback.ts:11-12`); also reads `token_hash`+`type` (`callback.ts:13-18`) for a non-PKCE
  email-template fallback.
- PKCE path: `await supabase.auth.exchangeCodeForSession(code)` (`callback.ts:23-31`); token-hash path:
  `verifyOtp({ token_hash, type })`.
- Allow-list re-check + **signOut on not-allowed** (`callback.ts:35-42`); success → `redirect("/dashboard")`
  (`callback.ts:44`).
- The **session cookie is not set explicitly here** — `exchangeCodeForSession` triggers the
  `@supabase/ssr` storage flush through the adapter's `setAll`, buffered on `AstroCookies` and serialized
  onto the **302 redirect** by the adapter.

#### B. The cookie adapter (heart of #6)

`src/lib/supabase.ts` (26 lines) — `createServerClient` with the modern `getAll`/`setAll` adapter:
- `getAll()` parses the inbound `Cookie` header (`supabase.ts:13-18`).
- `setAll()` forwards each cookie's `options` **verbatim** to `cookies.set(...)` (`supabase.ts:19-24`).
- **No `cookieOptions` are passed to `createServerClient`** → cookies use `@supabase/ssr`'s
  `DEFAULT_COOKIE_OPTIONS` (`node_modules/@supabase/ssr/dist/main/utils/constants.js:4-11`):
  `path:"/"`, `sameSite:"lax"`, `httpOnly:false`, `maxAge:400d`, **and `secure` is absent** (grep for
  `secure` over `@supabase/ssr/dist/main` returns nothing). Astro's `AstroCookies.set` does not inject a
  protocol-based `Secure` either (`node_modules/astro/dist/core/cookies/cookies.js:136-142`).

#### C. PKCE verifier round-trips by construction

- `flowType:"pkce"` is the `createServerClient` default
  (`node_modules/@supabase/ssr/dist/main/createServerClient.js:33`).
- The verifier cookie `sb-<ref>-auth-token-code-verifier` is **eagerly flushed the instant it is set**
  (`node_modules/@supabase/ssr/dist/main/cookies.js:290-307` → `applyServerStorage` →
  `setAll`), so it lands on the signin redirect.
- **Signin** (`src/pages/api/auth/signin.ts:9`) and **callback** (`src/pages/auth/callback.ts:6`) both
  build the client from the **one** `createClient` in `src/lib/supabase.ts`, same anon key, same adapter,
  same cookie name/options. **No anon-vs-callback client divergence** → the verifier round-trips, provided
  the cookie survives the redirect hop (see E).

#### D. Adapter / runtime config

- `astro.config.mjs`: `output:"server"` (`:11`), `adapter: cloudflare()` with **no options** (`:16`),
  `astro:env` secrets schema (`:17-26`).
- `wrangler.jsonc`: `compatibility_date:"2026-05-08"` (`:5`), `compatibility_flags:["nodejs_compat"]`
  (`:6`), custom entry `main:"src/worker.ts"` (`:4`), QUEUE bindings + `*/15` cron (`:20-22,32-47`); no
  KV/D1/DO in the auth path.
- Custom entry `src/worker.ts` delegates `fetch` to the adapter `handle` (`worker.ts:10,32`). The adapter
  emits **each cookie as its own `Set-Cookie` header** via `response.headers.append(...)`
  (`node_modules/@astrojs/cloudflare/dist/utils/handler.js:65-69`), which is the correct multi-cookie
  shape on a Workers `Response` (chunked `.0`/`.1` session tokens are appended individually too).

#### E. dev ≠ prod — what is real vs ruled out

**Ruled out by the code:**
- `secure:true` over http localhost — never set anywhere (so cannot be the dev-pass/prod-fail axis).
- Multiple `Set-Cookie` collapsing on Workers — appended per-cookie (`handler.js:66-67`).
- Cookies dropped on a 302 — buffered on `AstroCookies` independent of status, flushed onto the redirect.
- PKCE anon-vs-callback client mismatch — single shared factory.

**Real / not provable without the live Workers runtime (why a unit test can false-green):**
1. **Streaming-response timing is a runtime property, not a logic property.** Cookies are flushed onto
   `response.headers` *after* `app.render` returns (`handler.js:65`). A unit test that mocks
   `context.cookies` and asserts `cookies.set` was called never runs `workerd` and cannot observe whether
   the header survives on the deployed edge. This is exactly the plan's `test-plan.md:70` "fałszywy
   zielony — unit mockujący cookie bez runtime Workers".
2. **`SameSite=Lax` + origin-derived `emailRedirectTo`.** `emailRedirectTo` is built from
   `new URL(context.request.url).origin` (`signin.ts:19`), so dev (`localhost`) and prod (real domain)
   compute different origins. `Lax` returns the verifier on a normal top-level GET from the email client,
   but a cross-origin / safe-link-redirector hop, a domain/subdomain split, or a **missing Supabase
   Redirect-URL allow-list entry** (historical `plan.md:63`) can drop the verifier → `exchangeCodeForSession`
   fails → silent bounce to `/auth/signin`. This is a prod-only condition no localhost test reproduces.
3. **Header byte-size limits on the edge** (chunked session + verifier + long domain) — possible, not
   verifiable from static reading; flagged for the manual smoke, not asserted.

## Code References

- `src/pages/api/auth/signin.ts:7,18,21-27,28-31,34` — OTP request; pre-send allow-list gate; swallowed errors; unconditional neutral redirect.
- `src/lib/auth/allowlist.ts:1,7-10,12-17,20-21,25-27` — env load, fail-closed comment, frozen Set, exported predicates.
- `src/pages/auth/check-email.astro:14-16` — neutral, membership-agnostic confirmation copy.
- `src/pages/auth/callback.ts:6,11-18,23-31,35-42,44` — SSR client, code/token-hash read, exchange, allow-list re-check + signOut, redirect.
- `src/middleware.ts:5,11-17,22-26` — protected routes, user population, per-request allow-list gate.
- `src/lib/supabase.ts:13-18,19-24` — `getAll`/`setAll` adapter; no `cookieOptions` passed.
- `src/components/auth/SignInForm.tsx:19-20` — client-side email-format validation (not relied on server-side).
- `astro.config.mjs:11,16,17-26` — `output:"server"`, `cloudflare()` no-options, env schema.
- `wrangler.jsonc:4-6,20-22,32-47` — custom entry, `nodejs_compat`, compat date, queue/cron bindings.
- `src/worker.ts:10,32` — custom Worker entry delegating to adapter `handle`.
- `supabase/config.toml:97-107,182,190,192,213,215,217,219-227` — inbucket, built-in `[auth.rate_limit]`, OTP config, commented-out custom SMTP.
- `src/lib/enrichment/errors.ts:27` — the only `429` handling (enrichment, NOT auth) — rules out a custom auth limiter.
- `node_modules/@supabase/ssr/dist/main/utils/constants.js:4-11` — `DEFAULT_COOKIE_OPTIONS` (no `secure`).
- `node_modules/@supabase/ssr/dist/main/createServerClient.js:33` — `flowType:"pkce"` default.
- `node_modules/@supabase/ssr/dist/main/cookies.js:193,290-307,357-361` — verifier flush + token chunking.
- `node_modules/@astrojs/cloudflare/dist/utils/handler.js:65-69` — per-cookie `Set-Cookie` append.
- `node_modules/astro/dist/core/cookies/cookies.js:136-142` — no protocol-based `Secure` injection.

### Reusable test patterns (Phase-3 scaffolding)

- **`loadAllowlist(emails)`** — `src/lib/auth/allowlist.test.ts:7-16` — `vi.resetModules()` +
  `vi.doMock("astro:env/server", …)` + dynamic `import("./allowlist")` to test a module that freezes env
  at import. The "removed admin" case (`:70-82`) re-imports without the leaver to prove re-config drops
  authorization — directly reusable for the stale-admin slice of #5.
- **Three-boundary middleware test** — `src/middleware.test.ts:6-15,22-24,34-49` — mock `astro:middleware`
  (`defineMiddleware` as identity → `onRequest` is a bare `(context, next)`), `@/lib/supabase`
  (`createClient` stub of `auth.getUser`), `@/lib/auth/allowlist` (`isAllowedAdmin` boolean); synthetic
  `context` + `next: vi.fn()`. The **template for testing the callback's allow-list re-check** without a
  live runtime.
- **Route-handler test** — `src/pages/api/submissions.test.ts:13-24,28-54,78-89` — mock edge bindings via
  `@/lib/runtime-env` (QUEUE) + `createAdminClient`, invoke the handler with a real `Request`. The
  **template for the #5 integration spec** (mock the Supabase client; assert `signInWithOtp` is NOT called
  for a non-allow-listed email; assert identical 302 → `/auth/check-email` across all branches). Also
  carries reusable **sentinel-leak** (`:75-76,350-354`) and **paranoid-context** (`:94-112`) anonymity
  guards.
- **`@cloudflare/vitest-pool-workers` is ABSENT** — not in `package.json` (`:21,43,62`), and
  `vitest.config.ts:5-8` records the deliberate "add later only if a test genuinely requires the live
  Workers runtime". The #6 contract test is that case → Phase 3 must add it.

## Architecture Insights

- **Single `isAllowedAdmin()` across three gates (request / callback / middleware)** is the load-bearing
  pattern for the whole auth boundary. The three points are intentionally redundant and share one helper
  so they cannot drift — tests should pin each gate independently (they fail in different ways) but assert
  the shared helper's fail-closed contract once.
- **Allow-list gating (not rate-limiting) is the spam control for #5.** The "abuse" is neutralized by
  *who can trigger a send*, with the Supabase built-in throttle as a secondary bound on an admin's own
  inbox. This inverts the naive instinct to "add a rate-limiter".
- **Enumeration resistance is an explicit, swallow-everything design** (`signin.ts:28-34`), not an
  accident — the catch block exists *to preserve* the uniform response. A test should treat "any branch
  that returns something other than 302 `/auth/check-email`" as a regression.
- **#6 is a runtime-trust boundary, not a logic boundary.** The cookie/PKCE logic is provably correct from
  the source; what is unprovable in-repo is whether the deployed `workerd` streaming response carries the
  headers and whether the prod origin/redirect topology preserves the `Lax` verifier. This is why the plan
  splits #6 into a `workerd`-pool contract test (header shape) + a manual preview smoke (origin/redirect
  round-trip) — the two halves the source cannot self-certify.
- **Frozen-at-import env state** (allow-list `Set`) is a recurring shape in this repo; the `loadAllowlist`
  re-import helper is the established way to test it and should be reused, not re-invented.

## Historical Context (from prior changes)

- `context/archive/2026-06-01-auth-refit-magic-link/plan.md` — the auth design of record:
  - `:26-27` PKCE callback + same-browser code-verifier requirement; `:64` dual link-shape (`?code=` vs
    `token_hash`) handling so a silent bounce-to-signin is diagnosable.
  - `:28,65,345` Workers Set-Cookie quirk (cites infra Devil's Advocate #3): "Local success does not prove
    prod success"; pin `SameSite`/`Secure`/`Path` and verify on a Cloudflare **preview deploy**.
  - `:63` `emailRedirectTo` must be an absolute URL from the request origin AND present in Supabase → Auth
    → Redirect URLs (plus preview subdomains) — a missing entry **fails the callback silently**.
  - `:34,147,172,200-204` non-enumeration design: non-allow-listed email gets no email and the same neutral
    page; denied-after-auth path also neutral.
  - `:66` single shared `isAllowedAdmin()` across the three enforcement points.
  - `:48` **"Not adding rate-limiting beyond Supabase's built-in OTP request limits"** — the explicit scope
    decision behind risk #5's "verify built-in, don't build custom".
  - `:344` magic-link emails may be **soft-blocked by a corporate spam filter** → configure custom SMTP with
    SPF/DKIM before pilot (the prod-SMTP angle of #5).
  - `:382` Phase-2 cookie round-trip was **verified live on a Cloudflare preview** (commit `75ceb45`,
    preview `33defad5`) — prior art that the manual smoke for #6 is the proven method here.
- `context/archive/2026-06-4-first-end-to-end-submission/plan.md` — the DB-side allow-list (S-01):
  - `:58-68` `is_allowed_admin()` `SECURITY DEFINER STABLE` function with pinned `search_path`, policy
    `USING (public.is_allowed_admin())`; empty allow-list table locks out every admin.
  - `:93-98` `admin_allowlist (email text PRIMARY KEY)` lower-cased, RLS on with no permissive policy.
  - `:111-113` `ALLOWED_ADMIN_EMAILS` is the SSOT; an idempotent seed upserts into the table
    (`ON CONFLICT DO NOTHING`), **additive-only — removal is a manual DB step** (the env↔table drift the
    test-plan §6.7 warns about).
  - `:462` verified live: a non-allow-listed authenticated session reads 0 rows at the DB layer.
- `context/foundation/infrastructure.md` — the source of the #6 framing:
  - `:53` **Devil's Advocate #3**: Supabase auth cookies on Workers have a history of Set-Cookie quirks;
    "breaks in prod, not dev"; surface as a 2-day issue.
  - `:85` risk-register row: use `@supabase/ssr` 0.10.3+, test the callback end-to-end behind Access before
    declaring auth done, record cookie attributes explicitly.
  - `:88` risk-register row (for #5): magic-link emails soft-blocked by corporate spam filter → custom
    From-domain on SPF/DKIM allow-list; coordinate with IT before pilot.

## Related Research

- This is the first `research.md` for an auth-focused change. Adjacent prior work lives in the archived
  plans above (`*auth-refit-magic-link*`, `*first-end-to-end-submission*`) rather than dedicated research
  docs.
- Test-plan context: `context/foundation/test-plan.md` §2 (risks #5/#6 + Risk Response Guidance rows
  `:69-70`), §3 Phase 3 (`:83`), §4 (`@cloudflare/vitest-pool-workers` "none yet", `:99`), §5 gates
  (manual preview smoke `:121`), §6.3 (auth/Workers cookbook, TBD `:164-166`), §7 (browser-E2E explicitly
  excluded for #6, `:224`).

## Open Questions

1. **`config.toml` vs hosted-project rate limits.** The `[auth.rate_limit]` values are the **local** dev
   config (inbucket SMTP). The production throttle is governed by the **hosted Supabase project's** Auth
   settings (and, with default shared SMTP, much tighter ~few-per-hour limits not meant for production).
   Does this project push `config.toml` as config-as-code, or are prod limits set in the dashboard? This
   determines whether `email_sent=2/h` is the actual prod ceiling. Either way it argues **against**
   unit-testing the throttle and **for** documenting it + the custom-SMTP pre-pilot action (`plan.md:344`).
2. **Which link shape does the live email actually carry** — PKCE `?code=` or `token_hash`+`type`? The
   callback handles both (`callback.ts:13-31`), but the default `@supabase/ssr` PKCE flow implies `?code=`.
   The #6 contract test should target the path the real email template uses; confirm against the Supabase
   email-template config before writing the assertion (historical `plan.md:64`).
3. **Are the prod + preview callback URLs registered in Supabase → Auth → Redirect URLs?** A missing entry
   is a silent-callback-failure mode independent of cookies (`plan.md:63`). This is a manual-smoke
   checklist item, not an automated test, but it belongs in the #6 verification steps.
4. **`@cloudflare/vitest-pool-workers` integration cost.** Adding it changes the runner topology (a
   second pool alongside the node env). The plan should decide whether the #6 contract test runs in CI
   (Phase 4 wiring) or local-only, given the live-runtime dependency.

## Follow-up Research 2026-06-09

Resolves the four Open Questions after a developer answer. New ground truth: the repo is **linked to a
hosted Supabase project** ("Digital Idea Box", ref `ovwgoqhqbbgfodivwmwk` — `supabase/.temp/linked-project.json`),
and **all email templates in `config.toml` are commented out** (`config.toml:229-238`), so the local
template/rate settings are NOT what runs in production. Current Supabase behavior grounded via Context7
(`/supabase/supabase`, `apps/docs/content/_partials/auth_rate_limits.mdx`, `.../auth/auth-smtp.mdx`,
troubleshooting `not-receiving-auth-emails…`).

### Q1 — prod rate limits & how to set them (this was the original "open" risk for #5)

- **`config.toml` `[auth.rate_limit]`/`[auth.email]` govern LOCAL dev only.** They reach the hosted
  project ONLY via an explicit `supabase config push` (Context7: `SUPABASE_ENV=production npx supabase config push`
  pushes Auth site URL + redirect URLs + config). It is a manual action, not automatic — so today the
  prod ceiling is whatever the **dashboard** holds, not `email_sent=2`.
- **The email-send limit is "Custom SMTP Only" customizable.** With the **built-in** Supabase email
  provider (current state — custom SMTP is commented out, `config.toml:219-227`), the project is pinned to
  a *very low demo limit* that **cannot be raised**. Supabase docs: *"The built-in email provider is for
  demonstration purposes only and offers a very low rate limit."* This is a real **production blocker** for
  an admin-login-by-magic-link flow, independent of any test.
- **How it should be done (pre-pilot, manual gates — NOT test assertions):**
  1. Configure **custom SMTP** in the dashboard (Auth → SMTP Settings) with an SPF/DKIM-trusted
     From-domain — this is the same action `plan.md:344` already requires for corporate-spam
     deliverability, and it is the prerequisite to a usable rate limit.
  2. Then set the **email rate limit** on the dashboard Rate Limits page (custom SMTP starts at 30/h,
     adjustable).
  3. Optionally adopt `supabase config push` so Site URL + redirect URLs (and supported auth config) live
     in version control — this also de-risks Q3.
- **Net for the test plan (unchanged but now firmly grounded):** do NOT unit-test the throttle — it is a
  hosted-project + SMTP-dependent platform limit, not reproducible in the node harness. The #5 automated
  test stays "allow-list fail-closed + non-enumeration". Add a **pre-pilot manual gate**: "custom SMTP
  configured + email rate limit set in the hosted project" (pairs with the §5 manual preview smoke).

### Q2 — the email carries BOTH a link and a code; which path does #6 test?

Developer confirms the received email contains a clickable link **and** a visible code. That is the
default magic-link template surfacing `{{ .ConfirmationURL }}` (the link) plus `{{ .Token }}` (a 6-digit
OTP, `otp_length=6` `config.toml:215`). Resolution:

- **The 6-digit code is unused by this app.** There is no UI to type an OTP: the sign-in form takes only
  an email (`SignInForm.tsx`) and `check-email.astro:14-16` instructs "open the link in the same browser".
  So the visible code is a red herring for the production flow.
- **The production path is the LINK → PKCE `?code=` → `exchangeCodeForSession`.** The link points at
  Supabase's `/auth/v1/verify?…&redirect_to=…/auth/callback`; after Supabase verifies, it 302-redirects to
  `/auth/callback?code=…` on the app domain, where `callback.ts:23-31` calls
  `exchangeCodeForSession(code)` and reads the `code_verifier` cookie. **This is exactly the cookie
  round-trip the #6 contract test must target.**
- The `token_hash`+`type` branch (`callback.ts:13-18`) is the fallback for a *custom* template whose
  ConfirmationURL embeds `{{ .TokenHash }}` — it is NOT the visible 6-digit `{{ .Token }}`. Don't aim the
  #6 test there unless the hosted template was changed to send `?token_hash=` to the callback.
- **Decisive one-shot check for the developer:** click a real magic link and look at the URL that lands on
  the app — `?code=` ⇒ PKCE path (test this); `?token_hash=&type=` ⇒ verifyOtp path. (Hosted email
  templates are dashboard-configured and independent of the commented-out `config.toml` ones, so the link
  the user clicks is the source of truth, not the repo.)

### Q3 — redirect URLs registered? ("tak sądzę")

- Probable but **must be verified during the manual preview smoke** — a missing entry makes the callback
  fail *silently* with an auth error (`plan.md:63`), which looks identical to the #6 cookie failure and
  would mislead diagnosis.
- Checklist for the smoke: Supabase → Auth → URL Configuration → Redirect URLs must include the **prod
  callback URL** AND the **preview-Worker subdomain pattern** (`*.workers.dev` / the `*.pages.dev`-style
  preview host), plus Site URL. Recommend moving these into `config.toml` `[auth]` and `supabase config
  push` (Context7 confirms push covers Site URL + redirect URLs) so they're version-controlled rather than
  dashboard-only — same action that helps Q1.

### Q4 — `@cloudflare/vitest-pool-workers` CI cost ("nie wiem") → recommendation

- **It runs tests inside `workerd` locally — no real deploy** — so it is CI-safe and is the only in-repo
  way to exercise the Set-Cookie shape on a *real* Workers `Response` (kills the "false green" from a
  mocked-cookie unit test).
- **Cost:** one devDependency + a separate vitest project so the fast node-env suite isn't slowed by
  `workerd` startup (a few seconds per pool boot).
- **Recommendation:** add it as a **separate vitest workspace project** scoped to the auth-runtime contract
  test(s) only; leave the existing node suite (`vitest.config.ts`) untouched. Wire it into CI in **Phase 4**
  (quality-gates) alongside `npm test`. It does NOT replace the manual preview smoke: `workerd` has no real
  domain/email path, so the cross-origin `SameSite=Lax` verifier axis (the highest-risk one) still needs
  the live preview deploy.

### Updated handoff to /10x-plan

- **#5** → one integration spec (node, existing harness): assert `signInWithOtp` not called for a
  non-allow-listed email + identical 302→`/auth/check-email` across all branches. **No throttle assertion.**
  Add a **pre-pilot manual gate**: custom SMTP + hosted email rate limit configured.
- **#6** → one contract spec targeting the **`?code=` / `exchangeCodeForSession`** path, requiring a new
  `@cloudflare/vitest-pool-workers` workspace project (CI-wired in Phase 4) + the manual preview smoke.
  Smoke checklist now explicitly includes **redirect-URL registration** (Q3) so a silent callback failure
  isn't misread as a cookie bug.
