<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Pending-Rows Re-Enqueue Sweep

- **Plan**: context/changes/submission-enqueue-recovery-sweep/plan.md
- **Scope**: Phase 1 of 2
- **Date**: 2026-06-09
- **Verdict**: APPROVED
- **Findings**: 0 critical · 0 warnings · 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS (1 observation) |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS (1 observation) |
| Success Criteria | PASS |

Evidence: two parallel sub-agents (plan-drift + safety/quality/pattern) read all four changed source files; success-criteria commands re-run independently (`npm test` → 86/86, `typecheck` → 0 errors, `lint` → exit 0). All three Phase-1 changes verified **MATCH** against the plan contract — exact cutoff expression, per-row enqueue-failure isolation, no-logging/no-id anonymity, `.eq` (not `.in`) index discipline. No drift, no missing pieces, no source-level scope creep.

## Success Criteria

- **1.1** `npm test` → exit 0, 86/86 passed
- **1.2** `npm run typecheck` → exit 0, 0 errors
- **1.3** `npm run lint` → exit 0
- **1.4** manual — `[x]` with strong evidence: mutation testing this session (mutation A `catch{ throw }` broke *only* the isolation test; mutation B `now()+olderThanMs` broke *only* the cutoff test). Not rubber-stamped.

## Findings

### F1 — `return data` vs siblings' explicit data-shape inspection

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/enrichment/consumer.ts:329
- **Detail**: Agent flagged that `selectStrandedPending` does `return data` raw, while siblings `claim` (`if (data.length===0) return null`) and `readStatus` (`return data ? {...} : null`) inspect `data` first. Verified against code + lint config — non-actionable. Siblings inspect `data` because their semantics require it (null-on-empty / field mapping); this method just returns the array. The suggested parity fix `return data ?? []` would trip `@typescript-eslint/no-unnecessary-condition` (strictTypeChecked): after `if (error) throw error`, `data` is narrowed to a non-null array. Current form is the lint-clean, type-correct one — confirmed by typecheck + lint passing on it.
- **Fix**: None. Leave as-is (the "parity" guard would break lint).
- **Decision**: NOTED — non-actionable (verified)

### F2 — `ORDER BY created_at ASC` against a `created_at DESC` index

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture / Performance
- **Location**: src/lib/enrichment/consumer.ts:326
- **Detail**: Composite index is `(enrichment_status, created_at DESC)` but the sweep orders oldest-first (`ascending: true`). Postgres serves this with a backward index scan — no sort, no full scan — and at `LIMIT 100` the cost is negligible. Already analyzed in research.md:104 and plan.md:23 as serving the predicate (leading equality + range). No correctness or performance concern.
- **Fix**: None.
- **Decision**: NOTED — non-actionable (verified)

### F3 — Phase-1 commit bundles unrelated 10x-cli tooling

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: commit cb6d2a6
- **Detail**: The commit carries 8 files outside the plan: the new `10x-e2e` skill (`SKILL.md` + 5 references), `.claude/.10x-cli-manifest.json`, and `CLAUDE.md`. These are 10x-cli tooling-sync artifacts, not part of the enrichment change. User authorized bundling them via "Stage all" during the commit ritual, and the commit body documents it. No code impact; noted only for commit-hygiene awareness.
- **Fix**: None (already authorized + documented). For Phase 2, the default "stage only the planned set" keeps feature commits clean.
- **Decision**: NOTED — non-actionable (authorized)
