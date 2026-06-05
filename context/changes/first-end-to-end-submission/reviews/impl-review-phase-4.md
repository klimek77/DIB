<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-01 first-end-to-end-submission

- **Plan**: context/changes/first-end-to-end-submission/plan.md
- **Scope**: Phase 4 of 5 (Frontend — submission form wizard island)
- **Date**: 2026-06-06
- **Verdict**: APPROVED
- **Findings**: 0 critical, 2 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

Automated success criteria re-run during review: `npm run build` ✅, `npm run typecheck` ✅ (0 errors), `npm run lint` ✅ (0 problems). Manual criteria (4.4–4.8) were marked complete at commit 049f2e9 with code-supported evidence (gating logic, taxonomy SSOT, POST→redirect); visual gate 4.8 is a delegated-build review.

## Findings

### F1 — CharCounter counts raw length; submit gate counts trimmed

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (correctness/UX)
- **Location**: src/components/submissions/SubmissionForm.tsx:216 vs :57-58
- **Detail**: Counter was fed `content.length` (raw code units) while `contentValid` uses `content.trim().length` and the payload sends `content.trim()`. Display and gate disagreed at the boundary (e.g. red "802/800" while submit stayed enabled; positive count while submit blocked on whitespace-only). Stored data was always correct (trimmed, matches validator + DB btrim CHECK) — purely a display-vs-gate mismatch. Flagged independently by both review sub-agents.
- **Fix**: Feed the counter `content.trim().length` so the displayed number equals the value validated and inserted.
- **Decision**: FIXED — `count={content.length}` → `count={content.trim().length}` at SubmissionForm.tsx:216. Re-verified typecheck/lint clean.

### F2 — FormField/SubmitButton reimplemented inline; claimed spinner duplication

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/submissions/SubmissionForm.tsx:30-43, 309-319
- **Detail**: Plan said "reuses FormField/SubmitButton patterns." `ServerError` IS reused (line 277) and the `SignInForm.tsx` island pattern is copied, but `FormField`/`SubmitButton` are reimplemented inline. The reimplementation is justified: the auth primitives are hardwired to the light/purple auth theme, render only `<input>` (no `<select>`/`<textarea>`), and `SubmitButton` derives state from `useFormStatus()` — none of which fit the dark/emerald multi-step wizard. The sub-agent additionally claimed "~13 lines of spinner SVG duplicated"; on inspection the actual residue is a **single** CSS-spinner `<span>` (SubmissionForm.tsx:311 ≡ SubmitButton.tsx:22), not 13 lines and not an SVG.
- **Fix**: Record the deliberate divergence in plan.md Progress. (Spinner extraction not warranted — single line, below the project's >10-line dedup threshold.)
- **Decision**: FIXED (partial) — Added a "Phase 4 adaptation" note to plan.md Progress documenting the divergence. Spinner extraction DROPPED: the duplication is one line, not the claimed ~13, so extracting a shared `<span>` across the auth↔submissions boundary would be over-engineering against the project's own >10-line rule. No fix applied on the false premise (per lessons.md "verify every finding against the code").

### F3 — content <textarea> has no maxLength while signature <input> does

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality / Pattern Consistency
- **Location**: src/components/submissions/SubmissionForm.tsx:218-228 (textarea) vs :263 (signature input)
- **Detail**: The signature input sets `maxLength={SIGNATURE_MAX}` but the content textarea sets no `maxLength`. The 800 cap is enforced by the disabled submit button + live counter, not a hard input cap, so the two fields behave inconsistently. The plan only requires "blocks submit past 800," which IS satisfied — hence observation, not warning.
- **Fix**: Either add `maxLength={CONTENT_MAX}` to the textarea for symmetry, or leave it off (intentional).
- **Decision**: SKIPPED — soft cap + live counter is the better UX (a hard cap would silently truncate paste and block editing down from an overflow). Intentional; no change.

## Triage Summary

- **Fixed**: F1 (CharCounter trimmed length), F2 (divergence documented in plan)
- **Skipped**: F3 (textarea maxLength — intentional UX choice)

Working-tree changes (uncommitted at review time): `src/components/submissions/SubmissionForm.tsx` (F1), `context/changes/first-end-to-end-submission/plan.md` (F2 doc note).
