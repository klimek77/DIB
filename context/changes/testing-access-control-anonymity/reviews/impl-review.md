<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Test Phase 1 — Access-Control & Anonymity Core

- **Plan**: context/changes/testing-access-control-anonymity/plan.md
- **Scope**: Full plan (Phases 1–3 of 3)
- **Date**: 2026-06-08
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS (test-only; N/A) |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Success criteria (re-run live)

- `npm test` → 7 files, 66 tests passed
- `npm run typecheck` (astro check) → 0 errors, 0 warnings
- `npm run lint` (eslint) → clean (only informational parser notices)

## Highlights

- **Empty-list fail-closed test genuinely re-imports** the module with empty env (`vi.resetModules` + `vi.doMock` + fresh `import`) — not a stale Set. Directly avoids the anti-pattern flagged in the plan's Critical Implementation Details.
- **500-body assertion pins the literal Polish string inline**, not a constant imported from `submissions.ts` — honors the change's "no assertion copied from implementation" rule.
- **SQL probes all wrapped `BEGIN…ROLLBACK`** (incl. the removed-admin `DELETE`); nothing persists. Probe 5 (removed-admin) is an EXTRA beyond the 4 named probes but operationalizes the removed-admin `DELETE` that §2.2 required the cookbook to document — in-scope, not creep.
- **No production code touched** (`[id].astro` guard left intact, per "What We're NOT Doing"). All "NOT doing" boundaries respected (no DB harness, no E2E/Playwright, no auth/Workers-runtime/queue tests, no risk-strategy/gate-definition edits).
- **7/7 planned items MATCH** (1.1, 1.2, 2.1, 2.2, 3.1, 3.2, 3.3); zero DRIFT/MISSING.

## Findings

### F1 — branch no-echo assertion is near-vacuous

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/submissions.test.ts:301
- **Detail**: The `#2 no-echo on error` test pins distinctive sentinels for `content` and `signature` (genuinely proving those free-text fields aren't echoed). The `branch` check (`expect(text).not.toContain(BRANCHES[0])`) tests a real enum value while `validPayload()` leaves `branch` un-sentineled; the static 500 body ("Nie udało się zapisać zgłoszenia. Spróbuj ponownie.") can never contain a branch name, so the assertion passed unconditionally. `branch` is enum-validated and cannot carry a sentinel, so the line still has weak value as a guard against a future change that templates the branch into the error body — but the comment overstated it as equivalent to the content/signature checks.
- **Fix**: Reworded the comment so each assertion's strength is honest (content/signature sentinel-pinned; branch line is a future-templating guard); kept the assertion.
- **Decision**: FIXED (Fix now) — comment reworded at submissions.test.ts:298–303; re-ran file, 12/12 pass.
