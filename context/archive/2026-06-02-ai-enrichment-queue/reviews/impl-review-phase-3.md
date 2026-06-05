<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Async AI Enrichment Plumbing (F-03)

- **Plan**: context/changes/ai-enrichment-queue/plan.md
- **Scope**: Phase 3 of 3
- **Date**: 2026-06-05
- **Verdict**: APPROVED
- **Findings**: 0 critical · 0 warnings · 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS (2 observations) |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated success criteria re-verified 2026-06-05: 3.1 typecheck ✅ (astro check, 0 errors / 0 warnings — the 4 hints are pre-existing `tseslint.config` deprecation notices in `eslint.config.js`), 3.2 lint ✅ (eslint clean), 3.3 build ✅ (server built, complete), 3.4/3.5 tests ✅ (`vitest run` 19/19; consumer suite covers the idempotent no-claim ack, success→done, transient→reset+retry, permanent→failed+signal, write-back-fail→retry, the three DLQ branches, and the three real-store per-claim guard tests). Manual 3.6–3.10 marked `[x]` in Progress (SHA `bbebd94`); the lessons.md entry "Test a Cloudflare Queue consumer by enqueueing from inside the Worker" was authored from a real trap hit during this manual testing, which is strong evidence the manual gates were genuinely exercised, not rubber-stamped.

Plan adherence: all four planned Phase 3 changes MATCH — consumer handler (`src/worker.ts` queue dispatch + `src/lib/enrichment/consumer.ts` 5-branch state machine), DLQ backstop (`wrangler.jsonc` second consumer + `processDeadLetterMessage`), FR-018 signal (`emitFailureSignal` in `log.ts`), and structured logging (`logEnrichment` per transition). No DRIFT, no MISSING, no EXTRA. Scope discipline: none of the "What We're NOT Doing" boundaries crossed (no form, no email sender, no Anthropic wiring, no migration, no cron, no dashboard).

Both prior follow-ups verified closed in code + tests:
- **F1 (PII guard, impl-review-phase-2)** — `redactError()` writes a body-free descriptor to `enrichment_last_error`; `errorTelemetry()` feeds logs/signal only `kind`+`status`; `log.ts` header documents the guard; `consumer.test.ts` asserts a content-bearing OpenAI error body ("PARKING PROPOSAL") reaches neither the logs nor `markFailed`.
- **F2 (markFailed clobber, pre-push review)** — `markFailed` now guards on the per-claim token `enrichment_attempted_at`; permanent branch passes its own claim, DLQ passes the token observed via `readStatus` (optimistic concurrency); 3 new `createSupabaseStore` guard tests exercise the real store. Committed `b2a97ad`.

## Findings

### F1 — Spurious retry_exhausted signal when the DLQ markFailed no-ops

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; deferred to S-03
- **Dimension**: Safety & Quality / Reliability
- **Location**: src/lib/enrichment/consumer.ts:177-188 (processDeadLetterMessage)
- **Detail**: When the DLQ's `markFailed` no-ops because a fresh claim re-stamped the row between `readStatus` and `markFailed` (the optimistic-concurrency guard correctly suppresses the DB clobber), the handler still unconditionally calls `emitFailureSignal({errorType:"retry_exhausted"})` and `ack()`. The durable FR-018 signal fires for a row another invocation may be processing successfully. No data corruption — the row write IS suppressed — but S-03 (the future failure-alert email) would consume this event and could send a false "enrichment failed" alert. Already noted as accepted/out-of-scope in `follow-ups/markfailed-clobber-fix-2026-06-05.md` (§ Residual / accepted).
- **Fix**: Defer to S-03. When the alert sender lands, gate the signal on `markFailed` reporting rows-affected > 0, or dedup `enrichment_failed` events against the row's final status.
- **Decision**: ACCEPTED-AS-RULE: "Gate a durable failure signal on the guarded write actually applying" (appended to context/foundation/lessons.md 2026-06-05). No code change — deferred to S-03 per triage.

### F2 — Total DB outage can drop a message with the row stuck `pending`

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — accept for MVP
- **Dimension**: Reliability
- **Location**: src/lib/enrichment/consumer.ts:84-91 (claim catch) + :159-165 (DLQ readStatus catch); wrangler.jsonc (DLQ `max_retries:3`, no further DLQ — terminal by design)
- **Detail**: If Supabase is unreachable for the whole retry window, the main queue exhausts (claim throws → retry ×5) → DLQ; the DLQ's `readStatus` also throws → retry ×3 → message dropped (the DLQ is terminal). The row never reaches `failed`, no FR-018 signal fires, and it stays `pending` with no record that enrichment was attempted-and-abandoned. No data loss and the row is re-enqueueable, but the failure is silent.
- **Fix**: Accept for MVP; document the "row stuck pending under total DB outage → re-enqueue" recovery path, or have the DLQ emit the FR-018 signal on a store-independent transport even when it cannot write the row.
- **Decision**: ACCEPTED-AS-RULE: "A terminal queue + total-dependency outage drops messages silently — decouple the alert from the write" (appended to context/foundation/lessons.md 2026-06-05). No code change — accepted for MVP per triage.
