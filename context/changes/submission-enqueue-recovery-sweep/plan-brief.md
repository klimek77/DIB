# Pending-Rows Re-Enqueue Sweep — Plan Brief

> Full plan: `context/changes/submission-enqueue-recovery-sweep/plan.md`
> Research: `context/changes/submission-enqueue-recovery-sweep/research.md`

## What & Why

Add a `scheduled` cron Worker (every 15 min) that re-enqueues submission rows stranded in `enrichment_status='pending'` because their initial enqueue silently failed. Today such a row stays `pending` forever — never enriched, never on the `done`-gated dashboard. This is the production recovery the `KNOWN GAP` comment (`submissions.ts:58-63`) and test-plan Risk #4a promised; it makes "no silent loss" true rather than merely *recoverable in principle*.

## Starting Point

`src/pages/api/submissions.ts:64-68` inserts a `pending` row then enqueues in a try/catch that swallows failures and still returns 201. There is no `scheduled` handler in `src/worker.ts` and no `triggers.crons` in `wrangler.jsonc`. The enqueue helper, the service-role admin client, the composite index, and the consumer's idempotency CAS all already exist — only the recovery loop is missing.

## Desired End State

Every 15 min, a cron selects up to 100 `pending` rows older than 10 min (by `created_at`, oldest first) and re-sends each via `enqueueEnrichment`. The consumer claims and enriches them normally. A submission whose first enqueue failed reaches the dashboard within ~25 min instead of never. Each run logs one id-less `{ scanned, reenqueued, failed }` line.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Age column for "stranded" | `created_at`, not `enrichment_attempted_at` | A never-enqueued row has `enrichment_attempted_at = NULL`, so it would never match. | Research |
| Query form | `.eq('enrichment_status','pending')` | `.in([...])` defeats index-predicate proof; codebase-consistent. | Research / `lessons.md:33-38` |
| Cron cadence | Every 15 min (`*/15 * * * *`) | Balance recovery latency vs invocation noise; interval → DST-safe. | Plan |
| Age threshold N | 10 min | Comfortably above retry-backoff window; CAS makes any race harmless. | Plan |
| Batch bound | Cap 100, oldest first | Bounds each invocation; next tick handles the rest under backlog. | Plan |
| Stuck-row policy | Indefinite re-enqueue + id-less count log | No new state; platform/DLQ owns terminal `failed`; backlog visible in log. | Plan |
| Failure-signal decoupling | Defer + document residual | Forensic-only until S-03 email exists; keeps blast radius minimal. | Plan / `lessons.md:61-66,68-73` |
| Code structure | Pure `recovery-sweep.ts` + store read method | Unit-testable without Workers runtime; mirrors `queue → consumer.ts`. | Research |

## Scope

**In scope:** `scheduled` handler; `triggers.crons`; `recovery-sweep.ts` pure function; `selectStrandedPending` store method; unit tests; manual cron smoke.

**Out of scope:** `emitFailureSignal` gating fix; separate alert transport; schema/migration; marking stuck rows `failed`; `processing`-row recovery (consumer's 12-min stale-reclaim owns it); S-03 email.

## Architecture / Approach

Thin `scheduled(controller, env, ctx)` handler in `worker.ts` mirrors the existing `queue` handler: builds `createSupabaseStore(createAdminClient(env))`, then calls `runRecoverySweep(deps, { olderThanMs: 600_000, limit: 100 })`. All logic lives in the pure `recovery-sweep.ts` (selector + enqueue fn injected), so it is unit-tested with fakes. Idempotency is free: re-sending a `processing`/`done`/`failed` row is an ack-and-skip no-op at the consumer's CAS claim.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Recovery-sweep core | `recovery-sweep.ts` + `selectStrandedPending` + unit tests | Selector query must use the composite index (`.eq`, `created_at`) |
| 2. Cron wiring + smoke | `scheduled` handler + `triggers.crons` + manual verify | `triggers.crons` must propagate into `dist/server/wrangler.json`, else cron silently never registers |

**Prerequisites:** none — research complete, no schema change, all bindings present.
**Estimated effort:** ~1 session across 2 phases (small, well-scoped).

## Open Risks & Assumptions

- **Config propagation**: cron registers from the *built* `dist/server/wrangler.json`; the adapter must copy `triggers` there — verified in Phase 2 manual steps.
- **False failure-signal race** (residual, pre-existing): the sweep slightly raises the rate of the `lessons.md:61-66` unconditional-signal race; harmless until S-03 consumes it — deferred by decision.
- **Assumption**: enqueue-fail is rare, so 100/tick easily clears any realistic backlog; if not, parallelize sends later.

## Success Criteria (Summary)

- A stranded `pending` row (created_at > 10 min) is re-enqueued and reaches `done` after a cron tick, verified under `wrangler dev --test-scheduled`.
- Re-running the sweep never double-enriches a `done` row (ack-and-skip).
- The sweep logs an id-less summary every run; no submission id or body ever appears in logs.
