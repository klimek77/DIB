---
date: 2026-06-08T10:12:24+02:00
researcher: klimek77
git_commit: 88bdf714321dd24bc15b452b758eb642fdab7059
branch: main
repository: DIB
topic: "Test Phase 1 — access-control & anonymity core (risks #1/#2/#3): where each guardrail is actually enforced, and at which layer a test gives signal"
tags: [research, codebase, access-control, rls, anonymity, whitelist, column-grants, test-plan, phase-1]
status: complete
last_updated: 2026-06-08
last_updated_by: klimek77
---

# Research: Test Phase 1 — access-control & anonymity core (risks #1/#2/#3)

**Date**: 2026-06-08T10:12:24+02:00
**Researcher**: klimek77
**Git Commit**: 88bdf714321dd24bc15b452b758eb642fdab7059
**Branch**: main
**Repository**: DIB

## Research Question

Ground rollout Phase 1 of `context/foundation/test-plan.md` ("Access-control & anonimowość core") in the live codebase, per the §2 Risk Response Guidance. For each risk, find *where the guardrail is actually enforced* (app layer vs DB layer), *which Supabase client each path uses* (RLS-enforced vs RLS-bypassing), and *at which test layer a check gives real signal* — challenging the plan's stated assumptions rather than confirming them.

- **#1** — logged-in non-admin (or removed admin) reads someone else's submission via the detail view, or RLS lets any authenticated principal SELECT.
- **#2** — de-anonymization: IP / sender identifier persisted, or PII/signature leaks into logs or error bodies, or signature sent to the AI.
- **#3** — anonymous sender injects enrichment/`id`/status fields and the server whitelist has a gap; DB column-grants are the intended backstop.

## Summary

The codebase is in materially better shape than a happy-path read would suggest, and **the highest-leverage finding is about test *scoping*, not a code defect**:

1. **Risks #2 and #3 are already strongly covered by the existing pure-node Vitest suite.** The whitelist is tested at *both* the unit layer and the service-role route boundary; the anonymity guard is tested for logs, headers/cookies, and the AI prompt. Phase 1 should **not** re-litigate these (cost×signal, test-plan §1 rule #1) — it should add the few missing edge assertions and stop.
2. **Risk #1 has zero automated coverage** and is the real net-new work — but it is also the part that *does not fit the existing harness*. The access guard lives in three places: a `.astro` middleware (Astro-runtime-only, not loadable in pure-node Vitest as-is), an `.astro` page (not unit-testable here at all), and the DB **RLS policy + column grants** (no DB test layer exists in this project). The plan's phrasing "integration (route + RLS)" does not map onto the code: **there is no API route for the detail view — it is an `.astro` page — and RLS cannot be exercised by the mocked-client Vitest pattern.** This is a research-is-source-of-truth moment (test-plan §1 rule #3).
3. **Two plan assumptions are factually off and must be corrected before planning:**
   - **#3's DB column-grant "backstop" is bypassed on the production path.** The anonymous insert runs through the **service-role** client (`createAdminClient`), which ignores RLS *and* column grants by design. The grant is real and correctly written, but it protects only a hypothetical anon-key insert that production never performs. So the app-layer whitelist is the **sole live defense** for #3; a DB-grant test is a *regression fence* for a future client swap, not a test of the live path.
   - **#1's RLS gate is genuinely closed at the DB layer** (good — `USING (public.is_allowed_admin())`, not `USING (true)`), **but the two enforcement layers can diverge on the "removed admin" case.** The app allow-list (env var → in-memory Set) and the DB allow-list (`admin_allowlist` table) are kept in sync by an **additive-only** seed script that never deletes rows. Removing an admin is immediate at the app layer (after a redeploy) but requires a *manual* `DELETE` at the DB layer.

## Detailed Findings

### Risk #1 — Access control (admin-only reads)

**Allow-list source of truth (app layer).** `src/lib/auth/allowlist.ts:12-27` — `ALLOWED_ADMIN_EMAILS` (from `astro:env/server`) is parsed once into an in-memory `Set<string>`; `isAllowedAdmin(email)` is a pure, case-insensitive, fail-closed membership test (empty list → nobody is admin). This is the single SSOT used by the magic-link request endpoint, the auth callback, and the middleware (per the file's own doc comment, lines 3-11).

**Middleware guard.** `src/middleware.ts:5,22-25` — `PROTECTED_ROUTES = ["/dashboard"]` matched with `pathname.startsWith(route)`, so the guard **does** cover `/dashboard/submissions/[id]` (not root-only — this directly answers the "middleware on /dashboard root wystarczy" challenge: the prefix match covers sub-routes). A missing user *or* an authenticated-but-not-allow-listed email both `return context.redirect("/auth/signin")` (`:24`) — **redirect, not 403**, and the same target for both cases. `supabase.auth.getUser()` (`:13`) validates the JWT on every request (not a stale cookie read).

**Detail page has no independent guard.** `src/pages/dashboard/submissions/[id].astro:15-26` — the frontmatter has **no `isAllowedAdmin()` call**. It relies on (a) the middleware having blocked non-admins, and (b) the DB RLS policy. It reads via `createClient(Astro.request.headers, Astro.cookies)` — the **anon/session SSR client** from `src/lib/supabase.ts` (anon key) — so RLS *is* active on this read. `.maybeSingle()` (`:21`) collapses "no such row" and "RLS denied (0 rows)" and invalid-UUID into the same `null` → 404 surface (`:24-25`). The doc comment (`:5-9`) explicitly frames this as defense-in-depth: "a non-allow-listed JWT yields zero rows even if it somehow reaches this route."

**RLS is DB-gated, not open.** `supabase/migrations/20260605000000_...rls.sql:78-84` replaces the original permissive policy with:
```sql
DROP POLICY submissions_authenticated_select ON public.submissions;
CREATE POLICY submissions_authenticated_select
    ON public.submissions FOR SELECT TO authenticated
    USING (public.is_allowed_admin());
```
`is_allowed_admin()` (`:57-63`) is `SECURITY DEFINER STABLE SET search_path = public, pg_temp`, reading `public.admin_allowlist` against `lower(auth.jwt() ->> 'email')`. EXECUTE is correctly locked: `REVOKE ... FROM PUBLIC, anon, authenticated` then `GRANT ... TO authenticated` (`:72-73`) — the migration explicitly documents the Supabase FROM-PUBLIC no-op pitfall (`:66-71`), matching `lessons.md`. The original open policy was `USING (true)` at `20260528000000_create_submissions.sql:123-127` (now dropped).

**Removed-admin divergence (the real failure mode for #1).** Two layers, asymmetric removal semantics:
- *App layer*: in-memory Set from the env var; an env-var change takes effect on the next Worker deploy/cold-start. After that, the ex-admin is redirected by middleware before any DB query runs (normal browser flow).
- *DB layer*: `is_allowed_admin()` reads `admin_allowlist`, seeded by `npm run db:seed-admins`. Per the seed script ("Never deletes rows: removing an admin stays a deliberate manual decision"), re-seeding after an env-var removal does **not** drop the row. RLS keeps permitting that JWT until a manual `DELETE FROM admin_allowlist`.
- *Net*: for the browser flow, middleware is the effective gate and closes the case after deploy. The residual exposure is an attacker holding a still-valid JWT who calls PostgREST **directly**, bypassing Astro middleware — there, stale `admin_allowlist` is the only thing standing, and it permits the read. (Lower-probability path, but it is the concrete shape of "removed admin still reads.")

### Risk #2 — Anonymity (no IP / signature / PII leak)

**Insert payload — no identifiers.** `src/pages/api/submissions.ts:25-48` reads **only** `context.request.json()` (`:28`); it never touches `request.headers`, `clientAddress`, or `cookies`. The insert (`:46`) is `{ ...validation.value, enrichment_status: "pending" }` where `validation.value` is the 5-field `ValidatedSubmission` only. No IP/UA/cookie/session. (The endpoint doc comment `:15-17` states the anonymity NFR.)

**The signature is persisted — by design.** `submission-input.ts:25,80-93` accepts an optional `signature`; it lands in the row (`database.types.ts:43` `signature: string | null`) and is shown only in the admin detail view (`[id].astro:106-111`). Anonymity for the signature is enforced *downstream* (it must not reach logs or the AI), not by dropping it. A test must encode this: signature persists, but **never** appears in logs or the OpenAI payload.

**Logs carry only event codes + ids.** `submissions.ts:18-21` (`logSubmissionEvent`) logs `{ event, reason, timestamp }` — static literals only; called on insert-fail (`:53`) and enqueue-fail (`:65`). `src/lib/enrichment/log.ts` allows only `{ event, submissionId, attempts?, errorKind?, errorStatus?, reason? }` and its header forbids passing `err.message`/`content`/`signature`/`env`. Consumer call sites (`consumer.ts:88,96,102,113,125,145`) honor this; `errorTelemetry()` returns only `{ errorKind?, errorStatus? }` (never `.message`).

**AI prompt receives content only.** `src/lib/enrichment/enrich.ts:31-35` takes `content: string` only; the consumer selects just `id, content, enrichment_attempts` for the claim (`consumer.ts:247`) and calls `enrich(claimed.content, ...)` (`:106`). `openai.ts:54-60` puts the submission `content` as the sole user message — signature/branch/topic/department/id all excluded. (Existing test `enrich.test.ts:62` already asserts this.)

**Error paths don't echo input.** `submissions.ts` returns static Polish strings on parse error (`:30`), insert error (`:54`), and uses a bare `catch {}` for enqueue (`:64-66`) — no bound error, nothing interpolated. In the consumer, the only place an upstream body could surface (`openai.ts:73-74`, up to 500 chars of OpenAI's error) is redacted before any DB/log write by `redactError()` (consumer → `enrichment_last_error` becomes `"Enrichment <kind> error (HTTP <status>)"`). Residual `EnrichmentError.message` exists only in-memory and never reaches a sink.

**Verdict #2: SAFE across insert / logs / AI prompt / error bodies.** No code change needed; the gap is purely *test assertions* (some already exist — see Architecture / Existing Coverage).

### Risk #3 — Field-injection whitelist + DB grants

**App whitelist is an explicit allow-list (safe construction).** `submission-input.ts:40-96` destructures named fields one by one and hand-builds `value: ValidatedSubmission` — **no `...body` spread**. Allowed fields: `branch`, `topic`, `content` (required), `department`, `signature` (optional). The caller adds `enrichment_status: "pending"` (`submissions.ts:46`). Any `id`/`enrichment_*`/`ai_*`/unknown key is ignored by construction (never read). The file header (`:1-10`) documents this and the service-role bypass.

**DB column-grant — real, correct, but bypassed on the live path.** `20260528000000_create_submissions.sql:133-139`:
```sql
REVOKE ALL ON public.submissions FROM anon, authenticated;   -- named roles, NOT the FROM-PUBLIC no-op
GRANT INSERT (department, branch, topic, content, signature) ON public.submissions TO anon;
GRANT SELECT ON public.submissions TO authenticated;
```
`enrichment_*`/`ai_*`/`id`/`created_at`/`enrichment_status` are **not** granted to `anon` (`:143-146`). So an *anon-key* insert setting those columns would be rejected (`42501 insufficient_privilege`). **However**, the production insert uses `createAdminClient(env)` (service-role) — `submissions.ts:40-48`, comment `:42-43`, and `submission-input.ts:3-5` — which **bypasses RLS and column grants entirely**. The migration itself says the consumer/service-role path "bypasses RLS and column-level grants by design" (`:143-146`).
- **Consequence for the plan:** the test-plan #3 row claims "column-grants w DB blokują zapis nawet przy luce w whitelist." That is true *only for an anon-key insert*, which the live endpoint does not perform. On the production path the **app whitelist is the only active defense**. A DB-grant test is therefore a *regression fence* ("if someone ever switches this insert to the anon client, does the DB still protect us?"), not a test of the current live path — and it requires a DB test layer that doesn't exist yet.

## Code References

- `src/lib/auth/allowlist.ts:12-27` — env-var → in-memory Set; `isAllowedAdmin()` pure, fail-closed, case-insensitive
- `src/middleware.ts:5,22-25` — `/dashboard` prefix guard; non-admin/unauth → redirect `/auth/signin`; `getUser()` per request
- `src/pages/dashboard/submissions/[id].astro:15-26` — anon/session client read, RLS-gated, no per-page admin check, `maybeSingle()`→404
- `src/lib/supabase.ts` — SSR client uses anon `SUPABASE_KEY` (RLS-enforced) for dashboard reads
- `supabase/migrations/20260605000000_...rls.sql:42-84` — `admin_allowlist` table, `is_allowed_admin()` SECURITY DEFINER, replacement SELECT policy `USING (public.is_allowed_admin())`, FROM-PUBLIC-pitfall-aware function REVOKE
- `supabase/migrations/20260528000000_create_submissions.sql:112-146` — anon INSERT policy `WITH CHECK (true)`, original (now-dropped) `USING (true)` SELECT, `REVOKE ALL FROM anon, authenticated`, column-level `GRANT INSERT (...)`, the service-role bypass note
- `src/pages/api/submissions.ts:25-69` — anon endpoint: json-only read, `validateSubmissionInput`, **service-role** insert, fire-and-forget enqueue, static-string errors, identifier-free logging
- `src/lib/submissions/submission-input.ts:40-96` — explicit named-field whitelist (no spread)
- `src/lib/enrichment/log.ts` / `consumer.ts` / `enrich.ts:31-35` / `openai.ts:54-60` — content-only AI input, id/event-only logs, redacted errors
- `vitest.config.ts:1-22` — node env, `include: src/**/*.{test,spec}.ts`, `@`→`src` alias; no jsdom / no `@cloudflare/vitest-pool-workers` / no msw / no DB

### Existing test coverage (inventory — do NOT re-write)

- **#3 whitelist (covered):** `src/lib/submissions/submission-input.test.ts:23` (unit: strips injected `id`/`enrichment_*`/`ai_*`/unknown) + `src/pages/api/submissions.test.ts:139,171` (route boundary: exact 6-key whitelist at the service-role insert).
- **#2 anonymity (covered):** `submissions.test.ts:297` (never logs IP/header/cookie on success + insert-fail paths), `:322` (never reads `clientAddress`/`cookies` — getter traps throw), `enrich.test.ts:62` (only content → OpenAI, never signature).
- **#1 access control (ZERO coverage):** no test exercises `isAllowedAdmin()`, the middleware guard, `[id].astro`, or the RLS policy / column grants.

## Architecture Insights

- **Defense-in-depth is real but layer-asymmetric.** Read protection = middleware (app) **AND** RLS (DB), AND-ed. Write protection (#3) is *not* AND-ed on the live path: service-role insert removes the DB leg, leaving only the app whitelist. Tests should mirror this truth, not the symmetric ideal in the plan.
- **`.astro`-runtime logic is not unit-testable in this harness.** Vitest runs pure node; `astro:middleware` / `astro:env/server` virtual modules and `Astro.*` globals aren't available. The project's established convention (Agent-confirmed) is "extract testable logic into `.ts`, test that; treat `.astro` as a thin shell." `isAllowedAdmin()` is already pure `.ts` and trivially unit-testable. `src/middleware.ts`'s `onRequest` is importable if `astro:middleware` (`defineMiddleware`), `@/lib/supabase`, and `@/lib/auth/allowlist` are `vi.mock`'d — feasible, and the highest-signal way to prove the `/dashboard` prefix covers `[id]` and that non-admin → redirect.
- **RLS + column grants need a DB layer that does not exist.** The mocked-client Vitest pattern cannot exercise a Postgres policy. Options for the plan to weigh: (a) a SQL-probe test (`SET LOCAL ROLE anon/authenticated; SELECT/INSERT ...`, asserting `42501`/0-rows) run against a local `supabase db` / pgTAP — consistent with the `lessons.md` "confirm with a SET LOCAL ROLE probe" rule; (b) accept RLS/grant verification as a documented **manual SQL-probe gate** for MVP (cheapest, lowest tooling cost); (c) add `@cloudflare/vitest-pool-workers` — but that gives a Workers runtime, **not** a Postgres, so it does *not* solve RLS testing. Recommendation to surface in planning: don't introduce a DB test layer just for a grant that the live path bypasses; prove #1 at the app layer (unit `isAllowedAdmin` + mocked middleware) and treat RLS/grants as a SQL-probe gate.
- **Route-test mock skeleton is established** (`submissions.test.ts`): `vi.hoisted` for the QUEUE stub, `vi.mock("@/lib/runtime-env")` and `vi.mock("@/lib/enrichment/supabase-admin")`, a hand-built chainable Supabase stub that records `inserts`, and a `{ request } as Parameters<typeof POST>[0]` context (plus a "paranoid" variant whose `clientAddress`/`cookies` getters throw). New tests copy this.
- **Commands:** `npm test` = `vitest run`; `npm run typecheck` = `astro check`; `npm run lint` = `eslint .`.

## Historical Context (from prior changes)

- `context/archive/2026-06-4-first-end-to-end-submission/` (S-01) — shipped the detail view + the RLS-gating migration `20260605...`; the impl-review there surfaced the FROM-PUBLIC no-op (now in `lessons.md`).
- `context/archive/2026-05-28-submissions-data-model/` (F-01) — created the table, the anon column-grant INSERT, and the deliberately-permissive `USING (true)` SELECT (deferred allow-list to the app layer → the "deferred permissive gate is live exposure" lesson).
- `context/archive/2026-06-01-auth-refit-magic-link/` (F-02) — middleware allow-list guard + `isAllowedAdmin`.
- `context/archive/2026-06-02-ai-enrichment-queue/` (F-03) — consumer/redaction/log discipline that keeps the signature and content out of logs and the AI error path.

## Related Research

- `context/foundation/test-plan.md` §2 (Risk Map + Risk Response Guidance), §3 (Phase 1 row), §6 (cookbook references: `submissions.test.ts`, `submission-input.test.ts`).
- `context/foundation/lessons.md` — "deferred permissive gate is live exposure" (#1 ordering); "REVOKE FROM PUBLIC is a no-op... confirm with SET LOCAL ROLE" (#3 grant verification method).

## Open Questions

1. **#1 RLS/grant test layer — decide before planning.** Manual SQL-probe gate (cheapest, fits MVP + `lessons.md`) vs a real DB test harness (`supabase db`/pgTAP)? Recommendation: SQL-probe gate, since the live insert bypasses grants anyway.
2. **Middleware test depth.** Unit-test `onRequest` with mocked `astro:middleware`/Supabase/allowlist (proves prefix coverage + redirect), or limit #1's automated layer to `isAllowedAdmin()` and cover middleware/detail-view in the manual preview smoke? Trade-off: mocking `astro:middleware` is feasible but couples the test to Astro internals.
3. **#3 DB-grant regression fence — worth it?** Given the app whitelist is already tested at unit + route boundary and is the sole live defense, is a DB-grant test (requiring a DB layer) justified, or is a code-comment + the existing whitelist tests sufficient, with the grant verified once via SQL probe?
4. **Removed-admin: in-scope for Phase 1?** Should a test encode the app-layer "removed admin → redirect" (cheap, via `isAllowedAdmin` returning false), and should the manual gate document the DB `DELETE` step so the two layers can't silently diverge?
5. **Small #2/#3 edge gaps to add (cheap):** (a) assert the 500 insert-fail response body is the exact static string (no echo); (b) add `enrichment_last_error` / `enrichment_attempted_at` to the injected-keys whitelist unit test for completeness.
