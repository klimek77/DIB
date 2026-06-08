<!-- PLAN-REVIEW-REPORT -->
# Plan Review: S-01 first-end-to-end-submission

- **Plan**: `context/changes/first-end-to-end-submission/plan.md`
- **Mode**: Deep
- **Date**: 2026-06-05
- **Verdict**: SOUND (after triage; originally REVISE)
- **Findings**: 0 critical · 2 warnings · 3 observations — all triaged & fixed

## Verdicts

| Dimension | Verdict (initial) | After fixes |
|-----------|-------------------|-------------|
| End-State Alignment | PASS | PASS |
| Lean Execution | WARNING (F2) | PASS |
| Architectural Fitness | PASS | PASS |
| Blind Spots | WARNING (F1, F3, F5) | PASS |
| Plan Completeness | WARNING (F4) | PASS |

## Grounding

18/18 paths ✓, symbols ✓ (`enqueueEnrichment`, `TOPICS`/`BRANCHES`/`DEPARTMENTS`, `PROTECTED_ROUTES` startsWith-match, `Env` global+`QUEUE`), brief↔plan ✓. Deep verification: 6/6 riskiest claims CONFIRMED — service-role insert can `.select('id')` back; `DROP POLICY submissions_authenticated_select` target name exact; anon insert grant independent of the SELECT policy; taxonomy values + content/signature CHECKs match; `Env` ambient-global so `Runtime<Env>` compiles; blast radius minimal (no existing `.insert()` on `submissions`, no `department` non-null assertions, no stale `admin_allowlist`/`is_allowed_admin` references).

## Findings

### F1 — Insert succeeds but enqueue fails → orphaned `pending` row, no recovery path

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 2 — submission endpoint (plan.md:70, 163)
- **Detail**: The route inserts first (for `id`), then enqueues. If the insert succeeds but the enqueue fails: `await`+throw returns a misleading 500 on a durably-saved row (risking resubmit duplicates); `ctx.waitUntil` hides the failure entirely. Either way the row is stuck `pending` with no job — F-03's retry/DLQ only covers messages that reached the queue, not an enqueue that never happened. lessons.md:68-73 calls for documenting this recovery path; the plan didn't.
- **Fix A ⭐ Recommended**: After insert succeeds, return success regardless of enqueue outcome + name an un-enqueued-`pending` recovery path.
  - Strength: Submission is durable, so success is the honest answer; avoids resubmit-duplicates; matches F-03's "id is the contract, row is the truth" design.
  - Tradeoff: Needs a `pending`-sweep / re-enqueue path named (sweep itself deferrable to ops/S-02).
  - Confidence: HIGH — consistent with the existing async architecture.
  - Blind spot: Sweep ownership (S-01 vs ops) must be stated.
- **Fix B**: Retry the send inline once, then leave the row `pending` and document the "stuck pending → re-enqueue" recovery in Migration Notes.
  - Strength: Smaller change; keeps 500 semantics for true failures.
  - Tradeoff: Still 500s after a durable insert unless paired with A.
  - Confidence: MED — reduces but doesn't remove the orphan window.
  - Blind spot: Inline retry adds latency against the `<1s` budget.
- **Decision**: FIXED (Fix A) — Phase 2 contract now splits insert-failure (500) from enqueue-failure (return success); added an "Insert→enqueue ordering & orphan recovery" bullet in Critical Implementation Details naming the re-enqueue-by-`id` recovery path.

### F2 — Admin-allowlist seeding is manual prose; empty table locks out ALL admins

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Lean Execution
- **Location**: Phase 1 (plan.md:58, 119, 352) — decision D
- **Detail**: Decision D (allow-list RLS via `admin_allowlist` + SECURITY DEFINER `is_allowed_admin()`) is sound and lessons.md-backed. The weakness is the mechanism: a second source of truth (the table) must mirror `ALLOWED_ADMIN_EMAILS`, and the sync was a prose deploy step + a manual checkbox (1.7). An empty/unseeded table locks out every admin; drift silently breaks the gate.
- **Fix A ⭐ Recommended**: Mechanize the seed — a scripted idempotent step (`db:seed-admins` reading `ALLOWED_ADMIN_EMAILS`, upsert `ON CONFLICT DO NOTHING`); promote 1.7 from manual prose to a verified Phase-1 step. Env var stays SSOT.
  - Strength: "Migration applied" ⇒ "admins seeded"; removes the lockout footgun.
  - Tradeoff: One more script to write this phase.
  - Confidence: HIGH — standard seed pattern, no new concepts.
  - Blind spot: Run-order (seed must follow migration apply) to document.
- **Fix B**: Defer decision D — ship S-01 route-guard-only (RLS unchanged), add the allow-list policy in the slice that opens the pilot.
  - Strength: Less code/ops now; no sync obligation until a reader is reachable.
  - Tradeoff: Re-incurs the lessons.md "deferred permissive gate" risk.
  - Confidence: MED — depends on the "only allow-listed admins hold a session" invariant.
- **Decision**: FIXED (Fix A) — new Phase 1 change item #3 (`scripts/seed-admins.mjs` + `db:seed-admins`); seeding prose (Critical Details + Migration Notes run-order) and check 1.7 rewired to the scripted, idempotent step.

### F3 — Manual check 5.6 ("RLS re-verified at the route") isn't route-observable

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 5 manual 5.6 (plan.md:318)
- **Detail**: Middleware redirects a non-allow-listed authenticated session at `/dashboard*` (startsWith, fail-closed) before the page runs, so the RLS denial can't be observed through the detail page. The DB defense-in-depth is real but must be verified directly (SELECT as a non-allow-listed JWT). 5.6 also overlapped Phase-1 check 1.5, which already does this at the DB layer.
- **Fix**: Reword 5.6 to verify RLS via a direct SQL/PostgREST session; drop the "at the route" framing.
- **Decision**: FIXED — 5.6 reworded in both Success Criteria and Progress to verify at the DB layer.

### F4 — Phase 3/4/5 Progress headings drop the "(delegated build)" suffix

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Progress § (plan.md:398/412/428)
- **Detail**: Body headings were `## Phase 3/4/5: … (delegated build)`; the matching `### Phase N:` Progress rows omitted the suffix (Phases 1–2 matched exactly). Verified NON-breaking — `/10x-implement` navigates by phase number + first `- [ ]` in document order (10x-implement SKILL.md:54/58/308), not by full-title match — so cosmetic only.
- **Fix**: Make the `### Phase N:` titles match their `## Phase N:` bodies verbatim.
- **Decision**: FIXED — dropped `(delegated build)` from the three body headings; all five headings now align.

### F5 — Endpoint compose-logic (incl. the anonymity no-logging guarantee) is manual-only

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 testing (plan.md:169, 327-333)
- **Detail**: Only the pure validator (`submission-input.ts`) was unit-tested. The route's own behavior — applies whitelist before insert, injects `enrichment_status:'pending'`, never logs an identifier, correct 400/500 mapping, enqueues without awaiting AI — was manual-only. The anonymity guarantee (a top risk) was "verified" only by eyeballing a negative. Cross-process queue testing rightly stays manual, but the route's non-queue logic is testable with the admin client + queue mocked.
- **Fix**: Add a thin route test (mock admin client + `QUEUE`) asserting: injected `ai_*`/`id` stripped, `pending` default set, success shape, 400/500 paths, F1 enqueue-failure semantics, and no identifier in any log call.
- **Decision**: FIXED — new Phase 2 change item #5 (`src/pages/api/submissions.test.ts`); criterion 2.1 + Testing Strategy updated. (Phase 2 is now at the 5-file ceiling.)
