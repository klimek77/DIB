# Review follow-ups — ai-enrichment-queue

Fixes queued from implementation reviews, to be addressed in a named phase.

## F1 (impl-review-phase-2) — Guard EnrichmentError.message in the Phase 3 consumer logging

- **Source**: Phase 2 review, finding F1 (Safety & Quality, WARNING).
- **Where it lands**: Phase 3 §4 (Structured logging) + §3 (FR-018 failure signal) — `src/lib/enrichment/consumer.ts`.
- **Problem**: `EnrichmentError.message` can carry up to 500 chars of the OpenAI error body (`src/lib/enrichment/openai.ts:73-78`); on a 4xx OpenAI commonly echoes a slice of the submission `content`, which may contain incidental PII. No leak exists yet — nothing in Phase 2 logs. It becomes live the moment the Phase 3 consumer logs a caught error.
- **Fix to apply in Phase 3**: structured logs carry `err.kind` + `err.status` + `submissionId`; treat `err.message` as potentially-PII (omit or redact). Never log the `env` object or the service-role key.
- **Status**: CLOSED (Phase 3). `src/lib/enrichment/log.ts` only accepts `errorKind`/`errorStatus`/`reason` (never `err.message`); `src/lib/enrichment/consumer.ts` `redactError()` writes a body-free descriptor to `enrichment_last_error` (which feeds the S-03 email), and `errorTelemetry()` feeds logs/signal only `kind`+`status`. The `env`/service-role key are never logged. `consumer.test.ts` asserts a content-bearing OpenAI error body reaches neither the logs nor `markFailed`.

## F2 (pre-push review) — `markFailed` lacked the per-claim guard (clobber risk)

- **Source**: pre-push review of the Phase 3 consumer diff vs `origin/main`.
- **Where it lands**: `src/lib/enrichment/consumer.ts` — `createSupabaseStore.markFailed` + both callers.
- **Problem**: `markFailed` guarded only on `.neq(done)` while `markDone`/`resetToPending` guard on the per-claim token `enrichment_attempted_at`, so a stale-reclaimed (or DLQ-raced) invocation could flip a freshly re-claimed `processing` row to `failed` and drop a result the fresh claim might still produce — violating the file's own stated invariant.
- **Fix applied**: optional `claimedAt` on `markFailed` (guards `.eq(attempted_at)` when supplied); permanent branch passes its claim, DLQ passes the token observed via `readStatus` (optimistic concurrency); `readStatus` now returns `attemptedAt`. Added `createSupabaseStore` guard tests (the SQL guards were previously untested).
- **Status**: CLOSED. Tests 19/19, typecheck + lint clean. Full detail: `markfailed-clobber-fix-2026-06-05.md`.
