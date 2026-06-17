<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: New-Submission Instant Notify (S-04 / FR-016)

- **Plan**: context/changes/new-submission-instant-notify/plan.md
- **Scope**: Phases 1–2 of 2 (full plan)
- **Date**: 2026-06-17
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 1 observation (fixed)

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Evidence

- **Anonymity by construction, two layers.** `NewSubmissionNotice` (`new-submission-alert.ts:17-23`) declares only safe fields — no `content`/`signature`; the route builds the notice by explicit field-pick, never `...validation.value` (`submissions.ts:74-80`). Sealed by tests on both sides (`new-submission-alert.test.ts:41-60`, `_submissions.test.ts:428-459`). Failure log is id-less (`new-submission-alert.ts:62`).
- **<1s NFR preserved.** Send deferred via `context.locals.cfContext.waitUntil(...)` (`submissions.ts:82`), never awaited inline; no optional chain (matches strictTypeChecked lint rationale).
- **Throw-proof orchestrator.** Whole body (resolve + build + send) wrapped in try/catch (`new-submission-alert.ts:54-63`) so the `waitUntil` promise always resolves.
- **Channel reused as-is.** `sendEmail` + `resolveAlertRecipients` imported and used unchanged; mirrors the `fr018-alert.ts` builder idiom. No re-implementation.
- **Scope clean.** All "What We're NOT Doing" boundaries respected; only additive test strengthening, no scope creep. Plan-review F2 (external-store PII sign-off) and F3 (phantom label map) resolved in the plan before implementation; F1 (no-`?.` dispatch) and F4 (whole-body swallow) confirmed implemented.
- **Gates green (2026-06-17):** `npm test` 18→ files / 193→194 tests pass; `npm run typecheck` 0 errors; `npm run lint` 0 errors.
- **Deferred (honest):** Progress 2.6 (live inbox delivery) is explicitly not a merge blocker, mirroring S-03; manual smoke 2.5 produced a new lesson (commit `5614c31`).

## Findings

### F1 — Independent-placement guarantee (enqueue ⊥ notify) was not test-pinned

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: src/pages/api/submissions.ts:82,90-94 / src/pages/api/_submissions.test.ts
- **Detail**: The plan promises "placement is independent of the enqueue block — an enqueue failure must not skip the notify and vice-versa." The code satisfies this structurally (notify dispatched via `waitUntil` at :82 before the enqueue try/catch at :90-94; the notify promise can't throw). Integration tests covered 400 / 500 / thrown-send, but not the combined case "enqueue throws AND `waitUntil(notify)` still called once." Covered by construction; a regression fence was missing.
- **Fix**: Added an integration test (`_submissions.test.ts`, instant-notify describe block, `row-n5`): mock `queueSend` to reject on a valid POST, assert 201 AND `queueSend` called once AND `waitUntil` called once. Pins the guarantee against a future reorder.
- **Decision**: FIXED — file now 19 tests, green (`npx vitest run src/pages/api/_submissions.test.ts`).
