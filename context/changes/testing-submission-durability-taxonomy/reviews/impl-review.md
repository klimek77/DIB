<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Submission Durability & Taxonomy Integrity (Test Rollout Phase 2)

- **Plan**: context/changes/testing-submission-durability-taxonomy/plan.md
- **Scope**: Phases 1–3 (full plan)
- **Date**: 2026-06-08
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 2 observations (all triaged & fixed)

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Success criteria gates: `npm test` 81/81 pass (8 files); `npm run typecheck` (astro check) 0 errors / 0 warnings; `npm run lint` clean. All 6 manual plan checkboxes carry observable supporting evidence (drift guard non-vacuous w/ real diacritic values + parse-success guard; fake-store CAS mirrors `consumer.ts:240-295` method-by-method; comment-only edit verified via diff; follow-up stub exists with back-links).

## Findings

### F1 — prompt.md scratch file committed to the repo

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: prompt.md (repo root), entered in commit a5cd2f7
- **Detail**: An 18-line scratch file holding the verbatim `/10x-new testing-submission-durability-taxonomy` kickoff prompt was swept into the Phase-1 commit by a stage-all. Tracked, not in plan, duplicates change.md `## Notes`, no value to a future reader. Only true EXTRA in the diff (test-plan.md one-line change is legitimate orchestrator bookkeeping).
- **Fix**: `git rm prompt.md` + add `prompt.md` to `.gitignore`.
- **Decision**: FIXED — `prompt.md` staged for deletion; `.gitignore` updated with an "agent scratch prompts" entry.

### F2 — Durability gap is now truthful but LIVE until the sweep lands

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — decision already made & tracked; priority flag
- **Dimension**: Safety & Quality (reliability/durability)
- **Location**: src/pages/api/submissions.ts:56-63
- **Detail**: This change correctly turned a FALSE comment ("recovered by the pending-rows re-enqueue sweep") into a truthful "KNOWN GAP … NOT yet built" and opened `submission-enqueue-recovery-sweep`. Per lessons.md ("a deferred gate is live exposure until the tightening lands"), an enqueue-fail strands a `pending` row with no recovery today. Pre-existing, not introduced here — flagging the ordering dependency.
- **Fix**: Add a "LIVE EXPOSURE — prioritize" note to the follow-up change so the ordering risk is explicit there.
- **Decision**: FIXED — priority note added to `context/changes/submission-enqueue-recovery-sweep/change.md`.

### F3 — Drift-guard parser doesn't handle `DROP CONSTRAINT IF EXISTS <name>`

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — fails safe today; no live trigger
- **Dimension**: Pattern Consistency / Test Quality
- **Location**: src/lib/submissions/taxonomies.drift.test.ts:54-60
- **Detail**: The constraint-name regex `(?:DROP|ADD)?\s*CONSTRAINT\s+(\w+)` would capture `IF` as the name for a `DROP CONSTRAINT IF EXISTS <name>` statement. Self-documented and fails SAFE (the "parsed all five" presence assertion fails loudly rather than passing falsely). No current migration uses that form.
- **Fix**: Extend the regex to tolerate the optional `IF EXISTS` before the constraint name.
- **Decision**: FIXED — regex now `(?:DROP|ADD)?\s*CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\w+)`; comment updated; 7/7 drift tests still green.
