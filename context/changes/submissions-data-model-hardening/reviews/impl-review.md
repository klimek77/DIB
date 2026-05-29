<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Submissions data-model hardening

- **Plan**: context/changes/submissions-data-model-hardening/plan.md
- **Scope**: Full plan (Phase 1 + 2 of 2)
- **Date**: 2026-05-29
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Success criteria (re-verified 2026-05-29): typecheck exit 0; lint exit 0; build exit 0; db:reset exit 0 (6 seed rows); `\d+` lists both new constraints + retained `submissions_created_at_desc_idx`; grep ENRICHMENT_STATUSES = 2; manual 1.5/1.6 (rejection INSERTs) demonstrated; 1.7 cloud push succeeded; 2.5 narrowing confirmed.

## Findings

### F1 — .gitattributes CRLF fix was on the "NOT Doing" list

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: .gitattributes (new, commit cf692fc)
- **Detail**: The plan's "What We're NOT Doing" explicitly listed "No .gitattributes CRLF fix — out of scope." Phase 1 nonetheless added `.gitattributes` (`* text=auto eol=lf`) + ran `eslint --fix` to get step 1.4 (`npm run lint` exits 0) green. Surfaced as a mismatch and user-authorized mid-flight via AskUserQuestion. Benign, durable, well-formed, documented in commit body. The plan's source-of-truth still records it as out of scope.
- **Fix**: Record the conscious boundary-cross — a one-line plan addendum or a /10x-lesson on CRLF-vs-prettier gates. No code change.
- **Decision**: SKIPPED — authorized mid-flight and already documented in commit cf692fc body; no further record needed.

### F2 — taxonomies.ts header now under-counts its own lists

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/submissions/taxonomies.ts:1-9
- **Detail**: Header says "the four taxonomy lists" and enumerates four CHECK constraints (department/branch/topic/ai_tone). The file now exports a fifth list (ENRICHMENT_STATUSES) mirroring submissions_enrichment_status_check, which the header omits — its own "must update this file in the same commit" contract is under-documented. Plan said "header left as-is," so this is a plan gap, not implementation drift.
- **Fix**: Update the header to "five taxonomy lists" and add submissions_enrichment_status_check to the enumerated list.
- **Decision**: FIXED — header updated (four→five + submissions_enrichment_status_check added; caveats preserved).

### F3 — migration header wording on "existing rows already satisfy"

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260529000000_submissions_constraints_hardening.sql:12-16
- **Detail**: Header asserts existing rows "already satisfy both constraints." More precisely: ADD CONSTRAINT fails closed (rolls back) if a violating row exists — cannot silently corrupt. Empirically the cloud pre-check returned 0 and local db:reset validated the 6 seed rows. Single-transaction guarantee confirmed (HIGH confidence): DROP holds ACCESS EXCLUSIVE to COMMIT → no unvalidated-content window for concurrent writers (caveat: manual line-by-line apply in Studio breaks that). No defect — wording nit only.
- **Fix**: Optionally soften the header line to note "ADD CONSTRAINT fails closed if a violating row exists; pre-check returned 0."
- **Decision**: FIXED — header comment reworded to fail-closed framing + pre-check=0 note (comment-only; applied migration behavior unchanged).
