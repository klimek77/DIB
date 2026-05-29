<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Submissions data-model hardening

- **Plan**: `context/changes/submissions-data-model-hardening/plan.md`
- **Mode**: Deep
- **Date**: 2026-05-29
- **Verdict**: SOUND (after fixes — F1 and F2 applied)
- **Findings**: 0 critical · 2 warnings · 0 observations

## Verdicts

| Dimension | Verdict (pre-fix) | Verdict (post-fix) |
|---|---|---|
| End-State Alignment | PASS | PASS |
| Lean Execution | PASS | PASS |
| Architectural Fitness | PASS | PASS |
| Blind Spots | WARNING | PASS |
| Plan Completeness | WARNING | PASS |

## Grounding

10/10 paths ✓, 3/3 symbols ✓, brief↔plan ✓. Deep verification via sub-agent:
- Phase 5 cookie-staleness fix CORRECT — supabase-ssr caches refreshed tokens in `setItems` map (`node_modules/@supabase/ssr/dist/main/cookies.js:267-273`); the same client's subsequent `auth.getUser()` reads from in-memory cache before re-calling `getAll`, so the shared-client refit closes the bug without any wrapper change.
- App.Locals additive extension safe — 2 out-of-scope readers (`src/pages/dashboard.astro:4`, `src/components/Topbar.astro:2`) only destructure `locals.user`, never `locals.supabase`.
- `src/lib/database.types.ts` has 1 importer (`src/lib/supabase.ts:5`); CLI-bump regen blast radius minimal.

## Findings

### F1 — No explicit CLI-changelog or pre-commit diff review for 2.98→2.101

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 4 (Build tooling + CLI bump + types regen)
- **Detail**: Phase 4 bumps `supabase` devDep from 2.98.2 → ^2.101.0 (3 minor versions). Brief's Open Risks flags the diff-noise risk but no Phase 4 Success Criterion enforces a CLI-changelog read or structured pre/post-regen diff before committing. If the regen substantively changes the `__InternalSupabase` shape OR adds new helper exports / removes deprecated ones, the change ships silently and downstream consumers face surprise type errors.
- **Fix**: Add a Phase 4 manual verification step requiring (a) reading the supabase CLI changelog from 2.98.2 through the bumped version, and (b) side-by-side comparison of the pre/post-regen `database.types.ts` before commit. If diff is substantive beyond the expected `__InternalSupabase` resolution, split the CLI bump into a separate change.
  - Strength: Forces the implementer to confront the diff while it can still be split off.
  - Tradeoff: 5–10 minutes of manual review per bump.
  - Confidence: HIGH — sub-agent confirmed only 1 importer, so the diff is scannable.
  - Blind spot: None significant.
- **Decision**: FIXED (Fix applied — Phase 4 Manual section gained 2 new bullets; Progress 4.8 + 4.9 added).

### F2 — Phase 2 row→UUID mapping is implicit

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 (Seed determinism), Contract section
- **Detail**: Phase 2 Contract says "Row content sourced from the same CSV rows the prior seed used (SUG-4/5/3/25/14 enriched + one synthetic pending)" but doesn't pin which deterministic UUID (`...001`..`...006`) maps to which logical row. Implementer must invent the ordering; future regression tests or doc references would have no canonical anchor.
- **Fix**: Add an explicit row→UUID→timestamp mapping table to Phase 2's Contract.
- **Decision**: FIXED (Fix applied — 7-column mapping table added to Phase 2 Contract; 6 rows pinned with SUG-N source, department/branch/topic/tone, and timestamps).

## Triage summary

- Fixed: F1 (Fix in plan), F2 (Fix in plan) — 2 of 2
- Skipped: 0
- Accepted as risk: 0
- Dismissed: 0

► Verdict after fixes: **SOUND** (both warnings closed; plan ready for `/10x-implement`).
