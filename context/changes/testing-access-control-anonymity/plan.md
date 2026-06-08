# Test Phase 1 — Access-Control & Anonymity Core Implementation Plan

## Overview

Add the missing automated tests for **risk #1** (admin-only reads — zero coverage today), establish a **manual SQL-probe gate** for the DB-layer guarantees that the pure-node Vitest harness cannot exercise (RLS SELECT policy + anon column grants), and close two small **#2/#3 edge gaps** — without re-covering the already-strong #2/#3 suite. This is the test deliverable for rollout Phase 1 of `context/foundation/test-plan.md` ("Access-control & anonimowość core"), covering risks #1/#2/#3.

## Current State Analysis

From `context/changes/testing-access-control-anonymity/research.md` (git 88bdf71):

- **#2 (anonymity) and #3 (whitelist) are already covered.** Whitelist at unit (`src/lib/submissions/submission-input.test.ts:23`) and at the service-role route boundary (`src/pages/api/submissions.test.ts:139,171`); anonymity for logs/headers/cookies (`submissions.test.ts:297,322`) and the AI prompt (`src/lib/enrichment/enrich.test.ts:62`). Per test-plan §1 (cost×signal), these are **not** re-covered here.
- **#1 (access control) has zero automated coverage.** The guard is split across three places: `src/middleware.ts` (`/dashboard` prefix → redirect non-admins), `src/pages/dashboard/submissions/[id].astro` (no per-page check; relies on middleware + RLS), and the DB **RLS policy + column grants** (`supabase/migrations/20260605000000_...rls.sql`, `20260528000000_create_submissions.sql`).
- **The harness is pure-node Vitest** (`vitest.config.ts`: node env, `include: src/**/*.{test,spec}.ts`, `@`→`src`). No jsdom, no `@cloudflare/vitest-pool-workers`, no DB layer. `.astro` pages and Postgres RLS are **not** exercisable here.
- **Two facts that shape the tests** (research, verified against source):
  - The anonymous insert runs through the **service-role** client (`src/pages/api/submissions.ts:40-48`), which **bypasses RLS and column grants**. So the DB column-grant is a *backstop for a path the app does not use*; the SQL probe documents this explicitly.
  - The app allow-list (env var → in-memory Set, `src/lib/auth/allowlist.ts:12-27`) and the DB allow-list (`admin_allowlist`, additive-only seed) can **diverge** on the removed-admin case.

## Desired End State

- `npm test` runs new green tests proving: `isAllowedAdmin()` is fail-closed and correct; the middleware guard's `/dashboard` prefix actually covers `/dashboard/submissions/[id]` and redirects non-admins/unauth to `/auth/signin` while passing admins through.
- A committed, annotated SQL-probe script that a developer can run against a local/staging Supabase to confirm the RLS SELECT policy and the anon column grants behave as designed, with documented expected outcomes (incl. the removed-admin `DELETE`).
- The two #2/#3 edge asserts are added to the existing test files.
- `test-plan.md` records the new test types in its cookbook, appends a per-phase note, wires the new manual gate in §5, and bumps the Phase 1 §3 Status.

Verify: `npm test`, `npm run lint`, `npm run typecheck` all pass; the SQL-probe script produces the documented results when run manually.

### Key Discoveries:

- Middleware prefix guard: `src/middleware.ts:22` — `PROTECTED_ROUTES.some((r) => pathname.startsWith(r))` (covers sub-routes; this is the "is /dashboard root enough?" challenge made testable).
- Allow-list SSOT: `src/lib/auth/allowlist.ts:12-27` — Set built **at module load**; fail-closed on empty.
- Service-role bypass: `src/pages/api/submissions.ts:40-48` + migration note `20260528000000_create_submissions.sql:143-146`.
- RLS policy: `supabase/migrations/20260605000000_...rls.sql:80-84` (`USING (public.is_allowed_admin())`); `is_allowed_admin()` reads `lower(auth.jwt() ->> 'email')` (`:57-63`).
- Column grants: `20260528000000_create_submissions.sql:133-139` (`GRANT INSERT (department, branch, topic, content, signature) TO anon`; enrichment/ai/id NOT granted).
- Reference test patterns: `submissions.test.ts` (`vi.hoisted` + `vi.mock` at module edges); `submission-input.test.ts` (pure-function `describe/it/expect`).

## What We're NOT Doing

- **Not** re-covering risks #2/#3 beyond the two named edge asserts (existing suite is sufficient — test-plan §1).
- **Not** standing up a DB test harness (pgTAP / `@cloudflare/vitest-pool-workers`); RLS/grants are verified by the manual SQL-probe gate. (`vitest-pool-workers` gives a Workers runtime, not Postgres — it would not help here.)
- **Not** refactoring `[id].astro` to extract a testable guard (would touch production code; out of test-only scope).
- **Not** writing E2E/Playwright tests, auth/Workers-runtime tests (Phase 3 of the rollout), or queue idempotency tests (Phase 2).
- **Not** changing the risk strategy or quality-gate *definitions*; we only wire the gate this phase introduces, per test-plan's own "no gate without a phase that wires it" rule.
- **Not** testing the direct-PostgREST removed-admin attacker path automatically — documented as a known residual risk + manual `DELETE` step.

## Implementation Approach

Three independent phases, highest-risk first. Phases 1 and 3 are pure-node automated tests (CI-checkable). Phase 2 is the manual SQL-probe gate (a committed script + docs; its "verification" is running it by hand). No phase depends on another, so they can land in sequence with a manual checkpoint after each.

## Critical Implementation Details

- **`allowlist.ts` freezes its Set at module load.** `const allowed = new Set(... ALLOWED_ADMIN_EMAILS ...)` runs once at import (`src/lib/auth/allowlist.ts:12`). A single top-level `vi.mock("astro:env/server", ...)` fixes exactly one list, so testing the *empty-list fail-closed* case and the *populated* case in one file requires `vi.resetModules()` + `vi.doMock("astro:env/server", () => ({ ALLOWED_ADMIN_EMAILS: <value> }))` + a fresh `await import("./allowlist")` per scenario (a small `loadAllowlist(emails)` helper). Do not rely on mutating the env after import.
- **The middleware test mocks three module boundaries**, never the Astro runtime: `astro:middleware` (`defineMiddleware` as an identity passthrough so `onRequest` is the raw `(context, next)` fn), `@/lib/supabase` (`createClient` → a stub `{ auth: { getUser: () => Promise<{ data: { user } }> } }`, or `null`), and `@/lib/auth/allowlist` (`isAllowedAdmin` → a controllable boolean). Mocking `isAllowedAdmin` keeps the middleware test independent of the allow-list internals (separately unit-tested in Phase 1's first file).
- **The SQL probe needs both the role and the JWT claim.** `is_allowed_admin()` reads `auth.jwt() ->> 'email'`, so an RLS probe must `SET LOCAL ROLE authenticated` **and** `SET LOCAL request.jwt.claims = '{"email":"..."}'` in the same transaction; the positive case requires that email to already exist in `admin_allowlist` (seeded). Wrap every probe in `BEGIN … ROLLBACK` so probe inserts never persist.
- **The column-grant probe tests a path the live app bypasses.** It must `SET LOCAL ROLE anon` to exercise the grant (the production insert uses service-role and ignores grants). Annotate this in the script so a future reader does not mistake it for a test of the live endpoint.

## Phase 1: Risk #1 — app-layer access guard tests (automated)

### Overview

Prove the admin-only access decision at the two app layers that pure-node Vitest *can* reach: the allow-list function and the middleware route guard.

### Changes Required:

#### 1. Allow-list unit test

**File**: `src/lib/auth/allowlist.test.ts` (new)

**Intent**: Prove `isAllowedAdmin()` and `isAllowlistConfigured()` are correct and fail-closed — directly refuting "authenticated == authorized" by showing a non-listed email is rejected, including an email that *was* an admin but is no longer in the list.

**Contract**: Exercises `isAllowedAdmin(email?: string | null): boolean` and `isAllowlistConfigured(): boolean` from `./allowlist`. Cases: listed email → true; case-insensitive + surrounding-whitespace match → true; non-listed email → false; `undefined`/`null`/`""` → false; **empty `ALLOWED_ADMIN_EMAILS` → every email false** and `isAllowlistConfigured()` false; a "removed" email (present in one configured list, absent after reconfigure) → false. Per Critical Implementation Details, use a `loadAllowlist(emails)` helper (`vi.resetModules` + `vi.doMock("astro:env/server", …)` + dynamic import) to vary the list.

#### 2. Middleware route-guard test

**File**: `src/middleware.test.ts` (new)

**Intent**: Prove the `/dashboard` prefix guard covers the detail route `/dashboard/submissions/[id]` (not just `/dashboard` root), redirects non-admins and unauthenticated requests to `/auth/signin`, and lets admins through — and does not guard non-protected routes.

**Contract**: Imports `onRequest` from `./middleware` with `astro:middleware`, `@/lib/supabase`, `@/lib/auth/allowlist` mocked (see Critical Implementation Details). Drives a fake context `{ url: { pathname }, request: { headers }, cookies, locals: {}, redirect: vi.fn() }` and `next: vi.fn()`. Assert matrix: (a) `/dashboard/submissions/abc` + `isAllowedAdmin → false` → `redirect("/auth/signin")` called, `next` NOT called; (b) same path + `isAllowedAdmin → true` → `next` called, no redirect; (c) `/dashboard` + non-admin → redirect (root still guarded); (d) unauthenticated (`getUser` → `{ data: { user: null } }`) on a protected path → redirect; (e) a non-protected path (e.g. `/submit`) + non-admin → `next` called (no guard). Also assert `context.locals.user` is set from `getUser()`.

### Success Criteria:

#### Automated Verification:

- New tests pass: `npm test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- The middleware test's assertions reference `/dashboard/submissions/<id>` (a sub-route), not only `/dashboard` — confirming the prefix-coverage claim is actually exercised.
- The empty-list case in the allow-list test genuinely re-imports the module with an empty env (not a stale Set).

**Implementation Note**: After automated verification passes, pause for human confirmation before Phase 2.

---

## Phase 2: Risk #1 — RLS + column-grant manual SQL-probe gate

### Overview

Provide an executable, documented proof of the DB-layer guarantees the Vitest harness cannot reach: the RLS SELECT policy gates on `is_allowed_admin()`, and the anon role's column grant blocks writes to enrichment/`id`/status columns.

### Changes Required:

#### 1. SQL-probe script

**File**: `supabase/tests/access-control-probes.sql` (new)

**Intent**: A repeatable, annotated script a developer runs (psql or Supabase Studio SQL editor) against a local/staging DB to confirm RLS and column grants. Each probe states its expected outcome inline so a human can eyeball pass/fail.

**Contract**: Self-contained SQL, each probe in `BEGIN … ROLLBACK`. Probes:
- **RLS SELECT, non-admin** — `SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims = '{"email":"notadmin@example.com"}'; SELECT count(*) FROM public.submissions;` → expected **0 rows** (policy denies).
- **RLS SELECT, admin** — same with a seeded admin email → expected **>0** (or the row count present), proving the gate admits allow-listed principals.
- **Column grant, forbidden columns** — `SET LOCAL ROLE anon; INSERT INTO public.submissions (id, enrichment_status, ai_title) VALUES (...);` → expected **`ERROR: 42501 permission denied`**.
- **Column grant, allowed columns** — `SET LOCAL ROLE anon; INSERT INTO public.submissions (branch, topic, content) VALUES (<valid taxonomy>, <valid taxonomy>, 'x');` → expected **success** (then ROLLBACK).
- Header comment must note: this `anon`-role probe tests the column-grant backstop, which the **live endpoint bypasses** by using the service-role client (research finding).

#### 2. Gate documentation

**File**: `context/foundation/test-plan.md` (edit §5 + §6)

**Intent**: Wire the new manual gate (per test-plan's "no gate without a phase that wires it" rule) and record how to run the probe, including the removed-admin `DELETE`.

**Contract**: Add a §5 row: `manual SQL-probe (access control) | local/staging | required after §3 Phase 1 | RLS gate + anon column-grant (#1/#3 DB layer)`. Add a §6 cookbook subsection documenting: how to run `access-control-probes.sql`, the expected outcomes, and the note that **removing an admin requires `DELETE FROM public.admin_allowlist WHERE email = '<email>'`** (the `db:seed-admins` script is additive-only) so the app and DB allow-lists do not silently diverge.

### Success Criteria:

#### Automated Verification:

- Script file exists at `supabase/tests/access-control-probes.sql` and is syntactically valid SQL (loads without parse error, e.g. `psql --set ON_ERROR_STOP=1 -f` against a scratch DB, or Studio editor accepts it).
- `test-plan.md` still passes any repo markdown lint (`npm run lint` if it covers `.md`; otherwise N/A).

#### Manual Verification:

- Run all four probes against a local Supabase with a seeded admin: non-admin SELECT returns 0 rows; admin SELECT returns rows; anon insert to enrichment/id/status fails with `42501`; anon insert to allowed columns succeeds.
- The removed-admin `DELETE` step is documented and, when applied, the previously-admin email's SELECT probe then returns 0 rows.

**Implementation Note**: After the manual probes are confirmed, pause for human confirmation before Phase 3.

---

## Phase 3: #2/#3 edge asserts + wrap-up

### Overview

Close the two cheap, genuinely-missing assertions in the existing #2/#3 tests, then record this phase in the test plan.

### Changes Required:

#### 1. Error-path no-echo assert (#2)

**File**: `src/pages/api/submissions.test.ts` (edit)

**Intent**: Assert the 500 insert-failure response body is exactly the static Polish string and echoes none of the request input — closing the "an error won't leak PII" challenge with an explicit assertion.

**Contract**: In the existing failure-contract describe block (`:270`), add an assertion that the 500 response body equals the exact static error string from `submissions.ts:54` and contains no field from the submitted payload (content/signature/branch).

#### 2. Extend injected-keys whitelist assert (#3)

**File**: `src/lib/submissions/submission-input.test.ts` (edit)

**Intent**: Add the two server-controlled columns research flagged as missing from the injected-keys test, so the whitelist's "ignored by construction" guarantee is exhaustively asserted.

**Contract**: In the whitelist describe block (`:22`), add `enrichment_last_error` and `enrichment_attempted_at` to the injected payload and confirm they are absent from the validated value (the existing `Object.keys(value).sort()` seal already enforces the exact key set).

#### 3. Test-plan wrap-up

**File**: `context/foundation/test-plan.md` (edit §3 + §6.6)

**Intent**: Record that Phase 1 is implemented and capture the reusable patterns.

**Contract**: Bump §3 Phase 1 Status to `complete` (status vocab literal). Fill the §6.1/§6.2 cookbook slots that were "TBD — Phase 1" with the new patterns (allow-list unit test; mocked-`astro:middleware` guard test) referencing the new files. Append a §6.6 per-phase note (2–3 lines) on what Phase 1 established (e.g. the `loadAllowlist` module-reset pattern, the SQL-probe gate location).

### Success Criteria:

#### Automated Verification:

- Full suite passes: `npm test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- `test-plan.md` §3 Phase 1 Status reads `complete`; §6 cookbook references the new test files; §6.6 note is present.

**Implementation Note**: After automated verification passes, this completes Phase 1 of the rollout.

---

## Testing Strategy

### Unit Tests:

- `isAllowedAdmin()` / `isAllowlistConfigured()` — membership, case/whitespace normalization, fail-closed on empty, removed-admin (Phase 1).
- `validateSubmissionInput()` — extended injected-keys coverage (Phase 3).

### Integration Tests:

- Middleware `onRequest` guard behavior across protected/non-protected routes and admin/non-admin/unauth principals (Phase 1) — module-edge mocks only, per `submissions.test.ts` convention.
- Route 500 error-body no-echo (Phase 3).

### Manual Testing Steps:

1. Run `supabase/tests/access-control-probes.sql` against a local Supabase with a seeded admin; confirm the four documented outcomes (Phase 2).
2. Apply the removed-admin `DELETE` and re-run the admin SELECT probe; confirm it now returns 0 rows (Phase 2).

## Migration Notes

No schema changes. The SQL-probe script reads/writes only inside `BEGIN … ROLLBACK`; it never persists data.

## References

- Research: `context/changes/testing-access-control-anonymity/research.md`
- Test plan: `context/foundation/test-plan.md` (§2 Risk Response Guidance #1/#2/#3, §3 Phase 1, §6 cookbook)
- Lessons: `context/foundation/lessons.md` ("REVOKE FROM PUBLIC is a no-op… confirm with a SET LOCAL ROLE probe"; "deferred permissive gate is live exposure")
- Reference tests: `src/pages/api/submissions.test.ts`, `src/lib/submissions/submission-input.test.ts`
- Code under test: `src/lib/auth/allowlist.ts`, `src/middleware.ts`, `supabase/migrations/20260605000000_...rls.sql`, `supabase/migrations/20260528000000_create_submissions.sql`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Risk #1 — app-layer access guard tests

#### Automated

- [x] 1.1 New tests pass: `npm test` — f7d22ae
- [x] 1.2 Type checking passes: `npm run typecheck` — f7d22ae
- [x] 1.3 Linting passes: `npm run lint` — f7d22ae

#### Manual

- [x] 1.4 Middleware test asserts a `/dashboard/submissions/<id>` sub-route, not only `/dashboard` — f7d22ae
- [x] 1.5 Empty-list allow-list case re-imports the module with an empty env (not a stale Set) — f7d22ae

### Phase 2: Risk #1 — RLS + column-grant manual SQL-probe gate

#### Automated

- [x] 2.1 `supabase/tests/access-control-probes.sql` exists and is syntactically valid SQL — 4ade5e6
- [x] 2.2 `test-plan.md` passes repo markdown lint (or N/A) — 4ade5e6

#### Manual

- [x] 2.3 Four probes produce the documented outcomes (non-admin 0 rows; admin rows; anon forbidden-column insert → 42501; anon allowed-column insert → ok) — 4ade5e6
- [x] 2.4 Removed-admin `DELETE` documented; applying it makes the ex-admin SELECT probe return 0 rows — 4ade5e6

### Phase 3: #2/#3 edge asserts + wrap-up

#### Automated

- [x] 3.1 Full suite passes: `npm test` — 9cd9634
- [x] 3.2 Type checking passes: `npm run typecheck` — 9cd9634
- [x] 3.3 Linting passes: `npm run lint` — 9cd9634

#### Manual

- [x] 3.4 `test-plan.md` §3 Phase 1 Status = `complete`; §6 cookbook references new files; §6.6 note present — 9cd9634
