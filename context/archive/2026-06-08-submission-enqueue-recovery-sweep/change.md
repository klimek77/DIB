---
change_id: submission-enqueue-recovery-sweep
title: Pending-rows re-enqueue sweep (submission durability follow-up)
status: archived
created: 2026-06-08
updated: 2026-06-09
archived_at: 2026-06-09T13:13:28Z
---

## Notes

> **LIVE EXPOSURE — prioritize.** This is a deferred gate, and per `lessons.md` ("A deferred
> permissive gate is live exposure until the tightening change lands") the gap is already live in
> production: an enqueue failure strands a `pending` row with no recovery *today*. The submission
> endpoint and dashboard ship without this sweep, so the longer it waits the more orphaned rows
> accumulate. Schedule this before submission volume grows.

Deferred production follow-up surfaced by `testing-submission-durability-taxonomy` Phase 2 (Risk #4a).
The submission endpoint (`src/pages/api/submissions.ts`) inserts a `pending` row, then enqueues
enrichment in a try/catch that swallows an enqueue failure and still returns 201. There is **no
recovery path today**: no `scheduled` handler in `src/worker.ts`, no `triggers.crons` in
`wrangler.jsonc`. A row whose enqueue failed stays `pending` forever — never enriched, never on the
`done`-gated dashboard. Phase 2 tests lock in this contract truthfully (row is durable + recoverable
by status-scan); making "no silent loss" fully true is THIS change's job.

Scope to plan here (run `/10x-research` → `/10x-plan` first):
- A `scheduled` Worker handler + `triggers.crons` in `wrangler.jsonc` that selects
  `enrichment_status = 'pending'` rows older than N minutes and re-sends them via
  `enqueueEnrichment(env, id)`.
- Consider the total-outage failure-signal decoupling (lessons.md: "A terminal queue + total-dependency
  outage drops messages silently — decouple the alert from the write") while here.
- Idempotency: re-enqueuing a row already claimed/processing must be safe — the F-03 consumer CAS
  already guards this (`consumer.ts` claim matches `pending` or stale-`processing` only).

References:
- `context/changes/testing-submission-durability-taxonomy/plan.md` (Phase 3, "What We're NOT Doing")
- `context/changes/testing-submission-durability-taxonomy/research.md` (§ Open Questions #1)
- KNOWN GAP comment marker in `src/pages/api/submissions.ts`
