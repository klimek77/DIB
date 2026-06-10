# Auth & abuse-boundary tests (rollout Phase 3) Implementation Plan

## Overview

Rollout Phase 3 of `context/foundation/test-plan.md` ("Auth & granica nadużyć"). Two thin test slices
that *pin contracts already correct in the live code*, plus the manual pre-pilot gates the automated
layer cannot cover:

- **#5 (Medium×Medium)** — magic-link spam / admin enumeration: an integration test proving the
  allow-list gates fail-closed *before* the OTP send and that the endpoint's response is identical across
  every branch (non-enumeration). The built-in Supabase throttle is **documented, not asserted**.
- **#6 (High×Medium)** — magic-link cookie/PKCE round-trip on the Workers runtime: a contract test on a
  **real `workerd` Response** proving the `@supabase/ssr` cookie adapter emits durable session
  `Set-Cookie` headers for the `?code=` / `exchangeCodeForSession` path, **plus** a manual preview-deploy
  smoke for the cross-origin verifier axis no in-repo test can reproduce.

## Current State Analysis

(Lifted from `context/changes/testing-auth-abuse-boundary/research.md` — the codebase baseline; not re-derived.)

- **#5 is largely closed by construction.** `src/pages/api/auth/signin.ts:18` checks `isAllowedAdmin(email)`
  *before* calling `signInWithOtp` (`:21-27`), so a non-admin never triggers an email. Transport throws are
  swallowed (`:28-31`) and the endpoint **unconditionally** redirects to `/auth/check-email` (`:34`) —
  identical response for allow-listed / not-allow-listed / malformed / error. The allow-list
  (`src/lib/auth/allowlist.ts`) is fail-closed (empty ⇒ deny all) and frozen in a `Set` at import.
- **The throttle exists but is not a test target.** `supabase/config.toml` `[auth.rate_limit]` is **local-dev
  only**; the repo is linked to a hosted project ("Digital Idea Box"). With the built-in email provider
  (current state) the send rate is a demo limit that **cannot be raised** — that's a prod blocker resolved by
  configuring custom SMTP, a *manual* gate, not a unit test.
- **#6's common failure hypotheses are ruled out by library code** (`secure`-over-http never set;
  multi-`Set-Cookie` appended per-cookie; cookies buffered+flushed onto the 302; single shared client
  factory `src/lib/supabase.ts:13-24`, so PKCE round-trips). The remaining real axes are (a) the cookie
  write being a **runtime-timing property** of the streaming Workers response — a mocked-cookie unit test
  proves "adapter called", not "header survives on the edge" — and (b) `SameSite=Lax` + an origin/email-
  redirect hop (`emailRedirectTo` derives from request origin, `signin.ts:19`).
- **The email carries a link AND a 6-digit code, but the app uses only the link.** No UI accepts an OTP
  code; the production path is `?code=` → `exchangeCodeForSession` (`callback.ts:23-31`). The `token_hash`
  branch (`callback.ts:13-18`) is a fallback for a different template and is **not** the path to test.
- **`@cloudflare/vitest-pool-workers` is absent today** (`vitest.config.ts:5-8` records the deliberate
  "add later only if a test genuinely requires the live Workers runtime"). #6 is that case.
- **Reusable test patterns exist**: B4 `loadAllowlist` re-import (`src/lib/auth/allowlist.test.ts:7-16`),
  B5 three-boundary mock + synthetic context (`src/middleware.test.ts`), B6 route-handler with mocked
  edge bindings + direct invoke (`src/pages/api/submissions.test.ts:13-89`).

## Desired End State

- `npm test` (node env) includes a new `src/pages/api/auth/signin.test.ts` whose **full branch matrix**
  proves: `signInWithOtp` is called *only* for an allow-listed email, and every branch returns the
  **identical** `302 → /auth/check-email`.
- A new, isolated `@cloudflare/vitest-pool-workers` workspace project runs a contract test in `workerd`
  asserting the **session `Set-Cookie` shape on a real Response** for the `?code=` callback path; the
  existing node suite is unchanged and still fast.
- `context/foundation/test-plan.md` §6.3 cookbook (currently TBD) is filled with the established pattern;
  §6.2 gains the signin route test as a reference.
- The manual pre-pilot gates (custom SMTP, hosted rate limit, redirect-URL registration, preview smoke)
  are recorded as Manual Verification items in Phase 2, paired with the §5 preview-smoke gate.

### Key Discoveries:

- Pre-send allow-list gate + unconditional neutral redirect: `src/pages/api/auth/signin.ts:18,28-34`.
- Cookie adapter passes options verbatim, no `cookieOptions` ⇒ `@supabase/ssr` `DEFAULT_COOKIE_OPTIONS`
  (`Path=/`, `SameSite=Lax`, `httpOnly:false`, `Max-Age≈400d`, **no `Secure`**): `src/lib/supabase.ts:19-24`.
- PKCE verifier cookie `sb-<ref>-auth-token-code-verifier` round-trips through the one shared adapter.
- Workers adapter appends each `Set-Cookie` individually: `node_modules/@astrojs/cloudflare/dist/utils/handler.js:65-69`.
- Route-test harness to copy: `src/pages/api/submissions.test.ts:13-89` (mock edge, fabricate context, invoke handler).

## What We're NOT Doing

- **No custom rate-limiter** and **no throttle assertion** — the built-in Supabase throttle is real but
  Supabase-owned and environment-dependent; testing it is out of scope (test-plan §2 #5 anti-pattern).
- **No CI wiring of the workers pool** — deferred to test-plan **Phase 4** (quality-gates). This change adds
  the workspace project + local-run test only.
- **No live Supabase round-trip in tests** — the #6 contract fakes the network (token response), never a
  real auth server (keeps CI hermetic; honours the edge-only mocking policy).
- **No browser / E2E** — test-plan §7 excludes it for #6 (a `wrangler dev` E2E reproduces the *passing* dev
  path = false green).
- **No `token_hash` / `verifyOtp` path test** — prod uses `?code=`; that branch is a fallback (revisit only
  if the preview smoke shows the real link carries `?token_hash=`).
- **No DB-layer allow-list probes** — covered by `supabase/tests/access-control-probes.sql` (Phase 1).
- **No production auth-code rewrite for testability** — none is needed: the workers test drives the BUILT
  worker via `SELF.fetch` and intercepts outbound Supabase calls with `cloudflare:test` `fetchMock`
  (see Critical Implementation Details).

## Implementation Approach

Sequence cheap-and-isolated before tooling-and-runtime: Phase 1 (#5) reuses the existing node harness with
zero new dependencies and gives fast feedback; Phase 2 (#6) introduces the `workerd` pool in an isolated
workspace so the node suite stays fast, writes the runtime contract test, fills the cookbook, and records
the manual gates. Both phases pin existing-correct behaviour — a failing assertion means a regression, not
a discovery.

## Critical Implementation Details

- **#6 must exercise the FULL pipeline — run the BUILT worker, never the route handler directly.** The
  `Set-Cookie` append happens in the adapter App pipeline (`@astrojs/cloudflare` `handler.js:65-69`,
  `app.setCookieHeaders` → `headers.append`), NOT in the route handler — `callback.ts` returns a bare
  `context.redirect()` Response, and `AstroCookies` is not publicly constructible. **Invoking the exported
  handler directly with a fabricated `cookies` object cannot produce real `Set-Cookie` headers — that
  approach IS the false green and is prohibited.** Instead: `npm run build`, run the built worker under the
  pool (pool config points at `wrangler.jsonc` / the built entry), drive it via `SELF.fetch(".../auth/callback?code=…")`
  from `cloudflare:test`, and intercept the outbound Supabase token call with `cloudflare:test`'s
  `fetchMock` so `exchangeCodeForSession` resolves a fake session — no production code seam needed.
- **Step-zero spike** (before writing the test): confirm `astro:env/server` in the built bundle reads
  miniflare-provided vars (`ALLOWED_ADMIN_EMAILS`, `SUPABASE_URL`, `SUPABASE_KEY`) — the Cloudflare adapter
  reads server secrets from runtime env, but verify it inside the pool before building assertions on it.
- **The inbound `SELF.fetch` request must carry a `code_verifier` cookie header** (simulating what signin
  set) so the exchange path is realistic; assert that cookie is **cleared/replaced** on the response
  alongside the session cookies.
- **Set-Cookie assertion targets** (from `DEFAULT_COOKIE_OPTIONS`): session cookie name(s)
  `sb-<ref>-auth-token` possibly chunked `.0`/`.1`, each with `Path=/`, `SameSite=Lax`, **no `Secure`**,
  `Max-Age≈34560000`, `httpOnly` absent. Assert presence + attributes, not exact value bytes.

---

## Phase 1: #5 — Allow-list fail-closed + non-enumeration (node integration)

### Overview

Pin the signin endpoint's gating + non-enumeration contract with one integration test in the existing node
harness. No new tooling.

### Changes Required:

#### 1. Signin endpoint integration test

**File**: `src/pages/api/auth/signin.test.ts` (new)

**Intent**: Prove that `POST /api/auth/signin` (a) calls `signInWithOtp` *only* when the email is
allow-listed, and (b) returns the identical neutral redirect for every branch, so the endpoint cannot be
used to enumerate the admin roster. Reuses the B6 route-test harness and B5 boundary-mock style.

**Contract**: Mock `@/lib/supabase` `createClient` → stub exposing `auth.signInWithOtp: vi.fn()`; mock
`@/lib/auth/allowlist` `isAllowedAdmin` → controllable boolean (the allow-list *logic* is already covered by
`allowlist.test.ts`; here we test the endpoint's *use* of the gate). Driver: fabricated `APIContext` —
hybrid of the two existing harnesses: a real `Request` (POST, `application/x-www-form-urlencoded`,
`email=…`) per `submissions.test.ts:78-89`, plus a `context.redirect` vi.fn returning a 302 `Response` per
`middleware.test.ts:34-49` (signin needs `redirect` at `signin.ts:11,34` and `cookies` at `:9` — the latter
inert because `createClient` is mocked). **Branch matrix (all five):**
  1. allow-listed → `signInWithOtp` called exactly once with `{ email, options: { shouldCreateUser: true,
     emailRedirectTo: "<origin>/auth/callback" } }`; response `302`, `Location: /auth/check-email`.
  2. not-allow-listed → `signInWithOtp` **not called**; response `302`, `Location: /auth/check-email`.
  3. malformed/empty email (server does no format check) → `isAllowedAdmin` false → not called → same `302`.
  4. allow-listed but `signInWithOtp` rejects (transport throw) → error swallowed → same `302`, **no 500**.
  5. unconfigured client (`createClient` → `null`, `signin.ts:10-12`) → `302 → /auth/signin?error=…` for
     **any** email (allow-listed and not) — a *different* page than branches 1–4, but email-independent,
     so non-enumeration holds; assert the response does not vary by email.
  Cross-branch assertion: identical status + `Location`, no `?error=` query param across branches 1–4;
  branch 5 asserted separately for email-independence.

### Success Criteria:

#### Automated Verification:

- New test passes and `npm test` (`vitest run`) is green.
- Typecheck passes: `npm run typecheck` (`astro check`).
- Lint passes: `npm run lint`.

#### Manual Verification:

- Code review confirms all four branches are present and the cross-branch "identical response" assertion
  is real (not four copies of the happy path).

**Implementation Note**: After automated verification passes, pause for human confirmation before Phase 2.

---

## Phase 2: #6 — Workers-runtime Set-Cookie contract (pool-workers) + manual gates

### Overview

Introduce the `@cloudflare/vitest-pool-workers` runtime in an isolated workspace project, write the
`Set-Cookie`-shape contract test on a real `workerd` Response for the `?code=` path, fill the cookbook, and
record the manual pre-pilot gates.

### Changes Required:

#### 1. Workers-pool tooling (isolated workspace project)

**File**: `package.json`, `vitest.config.ts` (+ a new workers vitest project config, e.g.
`vitest.workers.config.ts` or a workspace entry)

**Intent**: Add `@cloudflare/vitest-pool-workers` as a devDependency and register a **separate** vitest
project scoped to `*.workers.test.ts`, so the node suite (`vitest.config.ts`) is untouched and stays fast.
Add a script to run the workers project on demand.

**Gate (step zero, before any wiring)**: run
`npm view @cloudflare/vitest-pool-workers peerDependencies` and confirm the peer range admits the repo's
`vitest ^4.1.8`. If it does not: decide between (a) npm-aliasing a compatible vitest for the workers
project only, or (b) holding Phase 2 until pool-workers supports vitest 4 — record the decision in this
plan before proceeding. Do not start the wiring on an unverified peer range.

**Contract**: Node project's `include` excludes `**/*.workers.test.ts`; workers project uses
`defineWorkersConfig` with `include: ["**/*.workers.test.ts"]` and a `poolOptions.workers` config pointing
at `wrangler.jsonc` / the **built worker entry** (`compatibility_date "2026-05-08"`, `nodejs_compat`), with
miniflare-provided env vars (`ALLOWED_ADMIN_EMAILS`, `SUPABASE_URL`, `SUPABASE_KEY`) and the queue bindings
declared (the worker module exports a `queue` handler — it must load). The build is a prerequisite: e.g.
`"test:workers": "npm run build && vitest run --config vitest.workers.config.ts"`. `npm test` remains node-only.

#### 2. Callback Set-Cookie contract test

**File**: `src/pages/auth/callback.workers.test.ts` (new)

**Intent**: Prove that the `?code=` callback path, exchanging via the **real** `@supabase/ssr` adapter,
emits durable session `Set-Cookie` headers with the correct attributes on a real `workerd` `Response` — the
in-repo fence against the "false green". Exercises `callback.ts`'s allow-list re-check + redirect too.

**Contract**: Run in the workers project against the **built worker** (never the route handler directly —
see Critical Implementation Details). Drive `SELF.fetch(".../auth/callback?code=<fake>")` from
`cloudflare:test` with a `Cookie: sb-…-auth-token-code-verifier=…` header; `ALLOWED_ADMIN_EMAILS` provided
as a miniflare var so the fake session's user is allow-listed; intercept the Supabase token endpoint with
`cloudflare:test` `fetchMock` to resolve a fake PKCE session (real `@supabase/ssr` adapter + real App
pipeline stay in the path). **Assert** on the `SELF` Response: `Set-Cookie` for the session token (name
`sb-<ref>-auth-token`, possibly chunked `.0`/`.1`) with `Path=/`, `SameSite=Lax`, **no `Secure`**,
`Max-Age≈34560000`; the `code_verifier` cookie is cleared; and a not-allow-listed fake session instead
yields `signOut` + `302 → /auth/signin` (no session cookie). Assert attributes/presence, not value bytes.

#### 3. Cookbook + reference update

**File**: `context/foundation/test-plan.md` (§6.2, §6.3)

**Intent**: Fill the TBD §6.3 ("Adding an auth / Workers-runtime test") with the established pattern
(separate pool-workers project, fake-fetch + real adapter, `Set-Cookie` assertion) and add
`src/pages/api/auth/signin.test.ts` as a §6.2 integration reference. 2–4 lines each, per §6.6 convention.

**Contract**: Edit only §6.2 and §6.3 prose; do not touch the strategy sections (§1–§5) or the phase table.

### Success Criteria:

#### Automated Verification:

- `@cloudflare/vitest-pool-workers` installed; `npm run test:workers` runs the workers project green.
- The contract test asserts the session `Set-Cookie` shape on a real `workerd` Response and the verifier
  is cleared; the not-allow-listed case yields `302 → /auth/signin` with no session cookie.
- Node suite unaffected: `npm test` green and does **not** pick up `*.workers.test.ts`.
- Typecheck passes: `npm run typecheck`. Lint passes: `npm run lint`.
- Cookbook §6.3 filled + §6.2 reference added in `context/foundation/test-plan.md`.

#### Manual Verification:

- **Confirm the real magic-link lands on `?code=`** (not `?token_hash=`) — validates the tested path.
- **Custom SMTP** configured in the hosted Supabase project (From-domain on SPF/DKIM allow-list) — pre-pilot.
- **Hosted email rate limit** set on the dashboard Rate Limits page (custom SMTP starts 30/h) — pre-pilot.
- **Prod + preview callback URLs** present in Supabase → Auth → URL Configuration → Redirect URLs (a missing
  entry fails the callback silently and mimics a cookie bug).
- **Preview-deploy smoke** (§5 gate): request a link on a Cloudflare preview, click it, confirm the admin
  lands on `/dashboard` and the session persists across a reload (the cross-origin `SameSite=Lax` axis).

**Implementation Note**: The automated items can land in one session; the manual gates are pre-pilot
checklist items the human actions before the pilot — record their status, don't block the phase's code on them.

---

## Testing Strategy

### Unit / Integration Tests (node):

- `signin.test.ts` — the four-branch non-enumeration matrix (Phase 1).
- Allow-list *logic* fail-closed is already covered by `src/lib/auth/allowlist.test.ts` — not duplicated.

### Contract Test (workerd):

- `callback.workers.test.ts` — session `Set-Cookie` shape on a real Response for the `?code=` path; verifier
  cleared; not-allow-listed → signOut + signin redirect (Phase 2).

### Manual Testing Steps:

1. Trigger a real magic link on a preview deploy; inspect the landing URL for `?code=`.
2. Click the link in the same browser; confirm `/dashboard` loads and survives a reload.
3. Confirm a non-allow-listed email receives the same neutral page (no email sent) — spot-check enumeration.

## Performance Considerations

The workers pool adds `workerd` boot (~seconds) only to `npm run test:workers`; the everyday `npm test`
(node) is unchanged. This isolation is the reason for a separate project rather than `environmentMatchGlobs`.

## Migration Notes

None — additive test + tooling only. No schema, no production-behaviour change (the optional `fetch` seam,
if used, defaults to global fetch and is inert in production).

## References

- Research (baseline): `context/changes/testing-auth-abuse-boundary/research.md`
- Test plan: `context/foundation/test-plan.md` §2 (risks #5/#6), §3 Phase 3, §4, §5, §6.2/§6.3, §7
- Reference tests: `src/pages/api/submissions.test.ts:13-89` (route harness), `src/middleware.test.ts`
  (boundary mocks), `src/lib/auth/allowlist.test.ts:7-16` (B4 re-import)
- Production surfaces: `src/pages/api/auth/signin.ts`, `src/pages/auth/callback.ts`, `src/lib/supabase.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: #5 — Allow-list fail-closed + non-enumeration (node integration)

#### Automated

- [x] 1.1 New signin test passes and `npm test` is green — 8b8fb84
- [x] 1.2 Typecheck passes (`npm run typecheck`) — 8b8fb84
- [x] 1.3 Lint passes (`npm run lint`) — 8b8fb84

#### Manual

- [x] 1.4 Code review confirms all four branches + real cross-branch identical-response assertion — 8b8fb84

### Phase 2: #6 — Workers-runtime Set-Cookie contract (pool-workers) + manual gates

#### Automated

- [x] 2.1 `@cloudflare/vitest-pool-workers` installed; `npm run test:workers` green — 4582104
- [x] 2.2 Contract test asserts session Set-Cookie shape on real workerd Response + verifier cleared + not-allow-listed → signin redirect — 4582104
- [x] 2.3 Node suite unaffected (`npm test` green, excludes `*.workers.test.ts`) — 4582104
- [x] 2.4 Typecheck + lint pass — 4582104
- [x] 2.5 Cookbook §6.3 filled + §6.2 reference added — 4582104

#### Manual

- [x] 2.6 Confirmed real magic-link lands on `?code=` (not `?token_hash=`) — 4582104
- [x] 2.7 Custom SMTP configured in hosted Supabase (SPF/DKIM From-domain) — pre-pilot — 4582104
- [x] 2.8 Hosted email rate limit set on dashboard — pre-pilot — 4582104
- [x] 2.9 Prod + preview callback URLs registered in Supabase Redirect URLs — 4582104
- [x] 2.10 Preview-deploy smoke: admin logs in via real link and session persists across reload — 4582104
