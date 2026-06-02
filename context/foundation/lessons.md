# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Verify every /simplify finding against the code before turning it into a plan

**Context:** Planning phase, when a `/simplify` (or any code-smell sweep) report feeds `/10x-plan`. First seen: `submissions-data-model-hardening`.
**Problem:** A 15-finding `/simplify` report grew into a 535-line, 6-phase plan that passed `plan-review` with a SOUND verdict — while carrying 3 factually wrong findings: a drop-index call built on a false Postgres "prefix" theory (#9), a "consolidate 6 INSERTs" fix for a seed that was already a single multi-row INSERT (#10), and a CLI bump to fix a harmless no-op `Omit<>` that typecheck/build already accepted (#15). A snapshot smell-sweep has no ground truth — it manufactures confident false positives, and turning its raw output into plan scope launders them past review.
**Rule:** Treat `/simplify` output as triage candidates, not plan scope. Before a finding enters a plan, confirm it against the actual file (read the line, run typecheck/build) and reject INVALID ones. The number of findings never sets the number of phases.
**Applies to:** `plan`, `plan-review`

## A deferred permissive gate is live exposure until the tightening change lands

**Context:** RLS/authz review when a permissive predicate (`USING (true)`, open SELECT) is deliberately deferred to a later change. First seen: `submissions-data-model` F1 (admin SELECT open to any authenticated user until F-02).
**Problem:** `submissions_authenticated_select USING (true)` is correct per the F-01 plan, but becomes live data exposure the moment a read surface (S-02 dashboard) ships before F-02 tightens the gate. A code-smell sweep sees a valid policy; a plan-adherence review sees "matches plan" — the risk only surfaces when you reason about change ORDERING.
**Rule:** When a change deliberately defers an authz tightening, record the ordering dependency: the consuming read/write surface must not ship before the tightening change. In review, after confirming "code = plan", ask whether the deliberate deferral creates a leak if the next change lands out of order.
**Applies to:** `plan`, `plan-review`, `impl-review`

## Don't harden a consumer that doesn't exist yet

**Context:** Planning/review of foundation changes (schema, shared modules) whose consumers (UI, workers, dashboard queries) aren't built yet. First seen: `submissions-data-model-hardening` (S-01/S-02/F-03 unbuilt).
**Problem:** Half the hardening plan optimized code that doesn't exist: 5 type guards with zero importers (#12), index decisions with no query written (#9/#14), and an auth shared-client refit for a bug that doesn't manifest in any current flow (#6) — the largest blast radius in the plan for zero realized benefit.
**Rule:** A finding that fixes a not-yet-written consumer is premature. Defer it until the consumer exists and its shape is known; write the guard/index/refit together with its first real caller so the shape stays honest.
**Applies to:** `plan`, `plan-review`, `implement`

## A composite index doesn't serve ORDER BY on its non-leading column

**Context:** Postgres schema/query work; judging whether an index is redundant. First seen: `submissions-data-model-hardening` #9. (Candidate for removal after the S-02/F-03 session if it proves a one-off.)
**Problem:** A finding claimed `idx ON (created_at DESC)` was redundant against the composite `idx ON (enrichment_status, created_at DESC)` because it "covers it as a prefix." False: the composite is ordered by `enrichment_status` first, so it cannot serve a bare `ORDER BY created_at DESC` without a full scan + sort. The single-column index was the only one serving the unfiltered time-range query.
**Rule:** A composite index provides ordering on column N only if every column before N is equality-constrained in the query. Never call a single-column index redundant against a composite unless the composite's leading column(s) are fixed by the query's WHERE.
**Applies to:** `plan`, `plan-review`, `implement`, `impl-review`

## A partial index is only used when the query WHERE matches its predicate syntactically

**Context:** Postgres schema/query work with partial indexes (`... WHERE col = 'x'`); writing Supabase queries against them. First seen: `submissions-data-model` `submissions_topic_done_idx` / `submissions_branch_done_idx` (#14).
**Problem:** Partial indexes `... WHERE enrichment_status = 'done'` are only used when the query's WHERE implies the index predicate. The planner does NOT normalize `IN ('done')` (single element) to `= 'done'` for partial-index predicate proof, so a Supabase `.in('enrichment_status', ['done'])` misses the index while `.eq('enrichment_status', 'done')` matches it.
**Rule:** When a query targets a partial index, make its WHERE syntactically match the index predicate. Use `.eq()` for a single-value match against a partial index, never `.in([...])`.
**Applies to:** `plan`, `plan-review`, `implement`, `impl-review`

## Don't re-assert Supabase baseline grants in a migration

**Context:** Writing Supabase migrations that touch role grants on `public` tables. First seen: `submissions-data-model` migration line 141 (#8).
**Problem:** The migration re-asserted `GRANT USAGE ON SCHEMA public TO anon, authenticated`, which Supabase already grants in every project's baseline — a no-op that adds cognitive load (a future reader must reason whether it's load-bearing, unlike the REVOKE on the same table, which genuinely is).
**Rule:** Don't repeat baseline grants in a migration. If you need to constrain a baseline privilege, REVOKE it explicitly and document why; otherwise omit it.
**Applies to:** `plan`, `plan-review`, `implement`, `impl-review`

## Reset a claimed row to its re-claimable state before re-enqueueing a retry

**Context:** Any plan or consumer that claims a row/job into an intermediate state (e.g. `pending → processing`) via a compare-and-swap before doing work, then relies on platform redelivery/retry (at-least-once queues, job runners). First seen: `ai-enrichment-queue` F-03 plan-review F1.
**Problem:** A transient failure that calls `message.retry()` while leaving the row in the claimed (`processing`) state means redelivery re-runs the CAS claim, which only matches `pending` (or stale-`processing`). If the row isn't stale yet, the claim matches zero rows and the handler acks-and-skips — silently dropping the retry and wedging the row in `processing` forever (never `done`, never `failed`, no error). The idempotency claim swallows the very retry it was meant to coordinate.
**Rule:** When a retry/redelivery path leaves a row in an intermediate claimed state, reset it to the re-claimable state (e.g. `processing → pending`, attempt-guarded) BEFORE re-enqueueing, so the next delivery re-claims cleanly. Keep stale-state reclaim as a crash-only backstop, never the normal retry mechanism — don't make the idempotency claim depend on a timing window between the retry backoff and the stale threshold.
**Applies to:** `plan`, `plan-review`, `implement`, `impl-review`
