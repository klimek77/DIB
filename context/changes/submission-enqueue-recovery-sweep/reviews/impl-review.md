<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Pending-Rows Re-Enqueue Sweep

- **Plan**: context/changes/submission-enqueue-recovery-sweep/plan.md
- **Scope**: Full plan (Phases 1-2 of 2)
- **Date**: 2026-06-09
- **Verdict**: APPROVED
- **Findings**: 0 critical · 0 warnings · 4 observations

Full-plan review. Phase 1 carries its own dedicated review (`impl-review-phase-1.md`, APPROVED); this sweep weighted Phase 2 (`src/worker.ts`, `wrangler.jsonc`) + cross-phase integration. Two parallel sub-agents read all six changed files; success-criteria commands re-confirmed this session (build exit 0 · typecheck 0 errors · lint exit 0 · `npm test` 86/86 · `dist/server/wrangler.json` carries `triggers.crons`). Plan drift: MATCH on every planned change; all six scope guardrails respected.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — Cron registration verified at build, not yet post-deploy

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (deploy reliability)
- **Location**: wrangler.jsonc:20-22 / dist/server/wrangler.json
- **Detail**: Manual item 2.5 is satisfied — the @astrojs/cloudflare adapter only rewrites `assets.directory` and does NOT strip `triggers`; `dist/server/wrangler.json` carries the cron (verified live). Residual: nothing re-checks it after the first `wrangler deploy`. A silently-unregistered cron makes the sweep a no-op — the exact silent-loss class this change closes.
- **Fix**: On first deploy, confirm the cron is live (Cloudflare dashboard → Workers → Triggers, or `wrangler deployments`); fold a one-line "crons registered" check into the deploy verification log.
- **Decision**: NOTED — no code action. Build propagation (2.5) is verified; the residual is a one-time post-deploy check recorded here.

### F2 — selectStrandedPending orders ASC against a DESC index

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture / Performance
- **Location**: src/lib/enrichment/consumer.ts:318-328
- **Detail**: Composite index is `(enrichment_status, created_at DESC)`; the sweep orders oldest-first (ascending). Postgres serves this with a backward index scan — leading equality + LIMIT 100 keeps it cheap. Already raised + closed in the Phase-1 review (F2, NOTED non-actionable).
- **Fix**: None. Re-noted for full-plan completeness.
- **Decision**: NOTED — non-actionable (verified in Phase-1 review F2).

### F3 — Sequential QUEUE.send per row vs Worker sub-request limit

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (performance)
- **Location**: src/lib/enrichment/recovery-sweep.ts:43-52
- **Detail**: Worst case per tick: 1 SELECT + 100 sequential sends = ~101 sub-requests, under the paid-plan 1000 ceiling. Serial (not `Promise.all`) is the safer choice — bounds peak concurrency, cap bounds total work. Only a concern on the Workers FREE tier (50 sub-request limit).
- **Fix**: None for paid tier. If deploying on free tier, lower `RECOVERY_BATCH_LIMIT` below ~45 or batch the sends.
- **Decision**: NOTED — no code action on the paid-plan path (per infrastructure.md). Revisit only if targeting the free tier.

### F4 — A store-query throw aborts the tick with zero observability

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (reliability)
- **Location**: src/lib/enrichment/recovery-sweep.ts:39 / src/worker.ts:52-66
- **Detail**: Per-row enqueue failures are isolated + tested. But if `selectStrandedPending` throws (Supabase down), it propagates out of `scheduled` with NO summary log emitted. Acceptable — cron retries next tick, rows stay pending/recoverable — but unlike the `queue` handler (which logs `claim_failed`), a persistently-failing sweep is silent in app logs (the thrown error is still visible as a CF invocation failure). Slightly ironic for a silent-loss-closing feature.
- **Fix**: Optional — wrap the sweep body in try/catch and emit an id-less `event: "enrichment_recovery_sweep_failed"` line so a chronically failing sweep is greppable, not just a raw CF error event.
- **Decision**: FIXED — wrapped the sweep body in try/catch in `scheduled` (`src/worker.ts:52-79`); emits an id-less `enrichment_recovery_sweep_failed` line on throw and re-throws so CF still records the invocation failure. Re-verified: build/typecheck/lint/test green (86/86), cron still propagates.
