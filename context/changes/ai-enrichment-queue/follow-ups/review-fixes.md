# Review follow-ups — ai-enrichment-queue

Fixes queued from implementation reviews, to be addressed in a named phase.

## F1 (impl-review-phase-2) — Guard EnrichmentError.message in the Phase 3 consumer logging

- **Source**: Phase 2 review, finding F1 (Safety & Quality, WARNING).
- **Where it lands**: Phase 3 §4 (Structured logging) + §3 (FR-018 failure signal) — `src/lib/enrichment/consumer.ts`.
- **Problem**: `EnrichmentError.message` can carry up to 500 chars of the OpenAI error body (`src/lib/enrichment/openai.ts:73-78`); on a 4xx OpenAI commonly echoes a slice of the submission `content`, which may contain incidental PII. No leak exists yet — nothing in Phase 2 logs. It becomes live the moment the Phase 3 consumer logs a caught error.
- **Fix to apply in Phase 3**: structured logs carry `err.kind` + `err.status` + `submissionId`; treat `err.message` as potentially-PII (omit or redact). Never log the `env` object or the service-role key.
- **Status**: OPEN → close when Phase 3 logging lands.
