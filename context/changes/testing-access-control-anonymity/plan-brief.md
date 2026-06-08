# Test Phase 1 — Access-Control & Anonymity Core — Plan Brief

> Full plan: `context/changes/testing-access-control-anonymity/plan.md`
> Research: `context/changes/testing-access-control-anonymity/research.md`

## What & Why

Deliver the test suite for rollout Phase 1 of `context/foundation/test-plan.md` ("Access-control & anonimowość core"), covering risks #1 (unauthorized read of submissions), #2 (de-anonymization), #3 (forged AI/whitelist fields). Research found #2/#3 already well-covered, so the real work is risk #1 — which has **zero** coverage and lives partly in layers the pure-node harness can't reach.

## Starting Point

Pure-node Vitest harness (no DB, no `.astro`/Workers runtime). #3 whitelist is tested at unit + service-role route boundary; #2 anonymity is tested for logs/headers/cookies and the AI prompt. Risk #1's guard is split across `src/middleware.ts` (`/dashboard` prefix redirect), `src/pages/dashboard/submissions/[id].astro` (no per-page check), and the DB RLS policy + anon column grants — none of which has a test.

## Desired End State

`npm test` proves the allow-list is fail-closed and the middleware guard actually covers `/dashboard/submissions/[id]` (non-admin/unauth → redirect, admin → pass). A committed, annotated SQL-probe script proves the DB-layer RLS + column grants on demand. Two small #2/#3 edge gaps are closed. The test plan records the new gate, cookbook patterns, and Phase 1 completion.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Phase 1 scope | #1 net-new tests + 2 targeted #2/#3 edge asserts | #2/#3 already covered; max signal-per-test (test-plan §1) | Research → Plan |
| DB-layer verification | Manual SQL-probe gate (`SET LOCAL ROLE`) | Zero new tooling; directly proves policy/grant; matches lessons.md | Plan |
| #1 app-layer depth | `isAllowedAdmin` unit + mocked-`astro:middleware` `onRequest` test | Refutes "middleware on root is enough"; pure-node | Plan |
| Removed-admin | App-layer test + document DB `DELETE` in the gate | Covers browser-flow case cheaply; makes residual DB risk explicit | Research → Plan |
| Edge gaps | Add both (500-body no-echo; extra injected keys) | Only real #2/#3 gaps; one-liners | Research → Plan |
| DB column-grant | Verified via probe, **not** a CI test | The live insert is service-role and bypasses grants — fence, not live-path | Research |

## Scope

**In scope:** allow-list unit test; middleware guard test; SQL-probe script + gate docs; two #2/#3 edge asserts; test-plan cookbook/status update.

**Out of scope:** re-covering #2/#3; a DB test harness (pgTAP / vitest-pool-workers); refactoring `[id].astro`; E2E/auth-runtime/queue tests; changing risk strategy or gate definitions; automated coverage of the direct-PostgREST removed-admin path.

## Architecture / Approach

Three independent phases, highest-risk first. Phases 1 & 3 are pure-node automated tests using the existing module-edge `vi.mock` convention (mock `astro:middleware`/`@/lib/supabase`/`@/lib/auth/allowlist`; never the Astro runtime). Phase 2 is a committed `supabase/tests/access-control-probes.sql` run manually as a gate, each probe wrapped in `BEGIN … ROLLBACK`, setting both `ROLE` and `request.jwt.claims` for RLS.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. App-layer #1 tests | `allowlist.test.ts` + `middleware.test.ts` | `allowlist.ts` freezes its Set at import — needs `resetModules`+`doMock` per list |
| 2. SQL-probe gate | `access-control-probes.sql` + §5 gate + §6 docs | RLS probe needs both `SET LOCAL ROLE` and `request.jwt.claims`; admin email must be seeded |
| 3. Edge asserts + wrap-up | 500-body no-echo, extra injected keys, test-plan update | Trivial; risk is forgetting the test-plan §3/§6 record |

**Prerequisites:** A local/staging Supabase with a seeded admin (`npm run db:seed-admins`) for the Phase 2 manual probes; Phases 1 & 3 need nothing beyond the repo.
**Estimated effort:** ~1–2 sessions across 3 phases (Phase 1 the bulk; Phases 2–3 short).

## Open Risks & Assumptions

- The middleware test couples to Astro internals via `vi.mock("astro:middleware")`; if Astro changes `defineMiddleware`'s contract the mock must follow.
- The SQL probe is a **manual** gate (not CI) — its value depends on someone running it after Phase 1 lands and on schema changes.
- The column-grant probe tests a path the live endpoint bypasses (service-role insert); it is a regression fence, not proof of the live write path. Documented to avoid misreading.

## Success Criteria (Summary)

- A non-admin / removed-admin is provably blocked from the dashboard *and* the detail sub-route (redirect), and the allow-list is fail-closed — asserted in CI.
- The DB RLS policy and anon column grants behave as designed when the SQL probe is run, with the removed-admin `DELETE` documented so the app/DB allow-lists can't silently drift.
- The two #2/#3 edge gaps are closed; the test plan records Phase 1 as complete with reusable cookbook patterns.
