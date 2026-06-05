<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Async AI Enrichment Plumbing (F-03)

- **Plan**: context/changes/ai-enrichment-queue/plan.md
- **Scope**: Phase 2 of 3
- **Date**: 2026-06-03
- **Verdict**: APPROVED
- **Findings**: 0 critical · 1 warning · 0 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated success criteria re-verified 2026-06-03: 2.1 typecheck ✅ (0 errors), 2.2 lint ✅ (clean), 2.3/2.4 tests ✅ (8/8 pass — drift guard + enrich() schema-valid). Manual 2.5–2.7 confirmed in the implement session: 2.5 live OpenAI round-trip returned sensible Polish fields (tone `Pozytywny`, classification `propozycja`, tight title + accurate 1-sentence summary); 2.6 anonymity covered by an automated assertion (payload never contains `signature`); 2.7 covered by automated 429→transient / 400→permanent tests.

Both review dimensions (plan-drift + safety/quality/pattern) ran as independent sub-agents. Plan-drift: all four planned changes MATCH, no DRIFT/MISSING/EXTRA. Safety/quality: no CRITICAL; AbortSignal.timeout typechecks and prevents a wedged worker, no `any` leak from `Response.json()`, no circular import (enrich↔openai back-edge is type-only), off-SSOT values rejected as permanent, no Node globals under the exhaustive `workers-types`.

## Findings

### F1 — EnrichmentError.message may carry submission content; guard the Phase 3 consumer's logging

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/enrichment/openai.ts:73-78 (forward-looking → Phase 3 consumer)
- **Detail**: On a non-OK OpenAI response, `safeReadBody()` reads up to 500 chars of the response body into `EnrichmentError.message` (`OpenAI returned ${status}: ${detail}`). OpenAI 4xx bodies commonly echo a slice of the offending request — here the submission `content`, which is user-authored free text that may contain incidental PII. Anonymity itself is intact (`signature` is never sent). Nothing leaks in Phase 2: no enrichment file logs anything. The risk materializes only when the Phase 3 consumer logs a caught error. Same family: the consumer must not log `env`/secrets or the service-role key.
- **Fix**: In the Phase 3 consumer's structured logs, log `err.kind` + `err.status` (+ `submissionId`) but treat `err.message` as potentially-PII — omit or redact it, and never log the `env` object. No Phase 2 code change. (Guardrail note added to plan Phase 3 §4 and to `follow-ups/review-fixes.md`.)
- **Decision**: DEFERRED-TO-PHASE-3 — note added to plan §4 logging contract + follow-ups; no Phase 2 change.
