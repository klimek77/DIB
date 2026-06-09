# Auth & abuse-boundary tests (rollout Phase 3) — Plan Brief

> Full plan: `context/changes/testing-auth-abuse-boundary/plan.md`
> Research: `context/changes/testing-auth-abuse-boundary/research.md`

## What & Why

Phase 3 of the test-plan rollout ("Auth & granica nadużyć"). Two thin test slices that pin auth contracts
*already correct in the live code* — magic-link spam/enumeration (#5) and the cookie/PKCE session round-trip
on Cloudflare Workers (#6) — so a future change can't silently regress either. A failing assertion means a
regression, not a discovery.

## Starting Point

The signin endpoint already gates the allow-list *before* sending an OTP and returns one neutral redirect
for every branch (`signin.ts:18,34`); the callback uses a standard `@supabase/ssr` PKCE flow through a single
shared cookie adapter (`supabase.ts:13-24`). Neither behaviour has an automated test, and
`@cloudflare/vitest-pool-workers` (needed to exercise a real `workerd` Response) is absent.

## Desired End State

`npm test` includes a four-branch non-enumeration test for the signin endpoint. A separate, isolated
`workerd` test project asserts the session `Set-Cookie` shape on a real Workers Response for the `?code=`
callback path. The cookbook (§6.3) is filled, and the pre-pilot manual gates (custom SMTP, rate limit,
redirect URLs, preview smoke) are recorded.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| #5 throttle | Document, don't test | Built-in Supabase throttle is real but hosted/SMTP-dependent — not reproducible in the node harness. | Research |
| #5 path | Gating + non-enumeration, full branch matrix | The spam/enumeration risk lives in *who can trigger a send* and *response uniformity*, incl. the swallowed-error catch. | Research + Plan |
| #6 path under test | `?code=` / `exchangeCodeForSession` | The app has no OTP-entry UI; the visible email code is unused — only the link matters. | Research |
| #6 fidelity | Run the BUILT worker via `SELF.fetch` + `cloudflare:test` `fetchMock` | Set-Cookie append lives in the adapter App pipeline, not the route handler — only the built worker proves real headers; direct handler invocation = false green (plan-review F1). | Plan review |
| Pool tooling | Separate vitest workspace project | Keeps the everyday node suite fast; matches the research recommendation. | Research + Plan |
| CI gating | Deferred to test-plan Phase 4 | This change adds the project + local-run test; CI lands with the other quality gates. | Plan |

## Scope

**In scope:**
- `src/pages/api/auth/signin.test.ts` — four-branch non-enumeration matrix (node).
- `@cloudflare/vitest-pool-workers` isolated workspace + `src/pages/auth/callback.workers.test.ts` — Set-Cookie contract on real `workerd`.
- Cookbook §6.3 fill + §6.2 reference; manual pre-pilot gates recorded.

**Out of scope:**
- Custom rate-limiter / throttle assertion; CI wiring (Phase 4); live Supabase round-trip; browser/E2E; `token_hash` path; DB allow-list probes (Phase 1).

## Architecture / Approach

Cheap-and-isolated before tooling-and-runtime. Phase 1 reuses the node route-test harness (mock Supabase
client + `isAllowedAdmin` boolean, fabricated `APIContext`, real `Request`) with zero new deps — five-branch
matrix incl. the unconfigured-client branch. Phase 2 adds the `workerd` pool in a separate project
(`*.workers.test.ts`), runs the **BUILT worker** and drives it via `SELF.fetch` with the outbound Supabase
token call intercepted by `cloudflare:test` `fetchMock` (real `@supabase/ssr` adapter + real App pipeline in
the path), then asserts the `Set-Cookie` attributes (`Path=/; SameSite=Lax`, no `Secure`, chunked, ~400d)
on the returned Response.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. #5 non-enumeration | Five-branch signin integration test (node) | Writing happy-path copies instead of a real cross-branch identical-response assertion |
| 2. #6 Set-Cookie contract | `workerd` pool project + Set-Cookie contract test + cookbook + manual gates | Vitest-4 peer-compat gate (step zero); astro:env-in-built-bundle spike before assertions |

**Prerequisites:** research.md (done); access to the hosted Supabase project + a Cloudflare preview deploy for the Phase-2 manual gates.
**Estimated effort:** ~1–2 sessions (Phase 1 small; Phase 2 dominated by pool-workers wiring + the built-worker/SELF harness).

## Open Risks & Assumptions

- The real magic-link is assumed to carry `?code=` (PKCE default) — confirmed during the Phase-2 manual smoke; if it carries `?token_hash=`, the tested path is revisited.
- `@cloudflare/vitest-pool-workers` ↔ vitest 4 peer compatibility is unverified — Phase 2 step-zero gate before any wiring.
- `astro:env/server` reading miniflare-provided vars in the built bundle needs a step-zero spike before assertions are built on it.
- Manual gates (SMTP/rate-limit/redirect-URLs) are human pre-pilot actions; the phase's *code* does not block on them.

## Success Criteria (Summary)

- A non-admin (or malformed/erroring request) gets the same neutral `/auth/check-email` response as an admin — proven by the matrix.
- A real `workerd` Response carries the durable session `Set-Cookie` with the right attributes for the `?code=` path — proven in the pool test.
- An admin logs in via a real magic link on a preview deploy and the session persists — proven by the smoke.
