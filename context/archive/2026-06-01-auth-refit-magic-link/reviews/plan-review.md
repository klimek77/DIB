<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Auth Refit — Magic-Link + Admin Allow-List

- **Plan**: `context/changes/auth-refit-magic-link/plan.md`
- **Mode**: Deep
- **Date**: 2026-06-01
- **Verdict**: REVISE → SOUND after triage (all 4 findings fixed)
- **Findings**: 0 critical · 3 warnings · 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING (F1, F4) → addressed |
| Plan Completeness | WARNING (F2, F3) → addressed |

## Grounding

14/14 paths ✓ (10 existing confirmed, 4 new confirmed absent), 6/6 symbols ✓ (`createClient`, `signInWithPassword`, `signUp`, `PROTECTED_ROUTES`, `missingConfigs`, `envField`), brief↔plan ✓. `docs/reference/contract-surfaces.md` absent → surface check skipped. Progress↔Phase: counts matched; only the phase-name parenthetical mismatch (F3) found.

## Findings

### F1 — Callback assumes ?code= without addressing the flow/template dependency

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 2 — #2 PKCE callback
- **Detail**: Callback relied only on `?code=` + `exchangeCodeForSession`. If the Supabase email template emits `{{ .TokenHash }}` (or the project isn't on the PKCE flow), the link carries `token_hash`/`type` and no `code`, so the exchange silently bounces to signin. Plan documented the happy path but neither the email-template precondition nor the `verifyOtp` fallback.
- **Fix A ⭐ Recommended**: Handle both `?code=` and `token_hash` in callback.ts (`verifyOtp` fallback).
  - Strength: Works regardless of template/flow config; matches existing defensive style.
  - Tradeoff: ~6 extra lines + one branch.
  - Confidence: HIGH — both APIs stable/documented.
  - Blind spot: Live project's email template not inspected; Fix A makes that moot.
- **Fix B**: Document the PKCE email-template precondition as a manual gate.
  - Strength: Zero code.
  - Tradeoff: Manual step, drifts if template customized.
  - Confidence: MED.
  - Blind spot: Template state not version-controlled.
- **Decision**: FIXED (Fix A — dual-path callback contract + Critical Implementation Details note on delivery-shape dependency)

### F2 — Deletion of /auth/signup leaves a dead link in Welcome.astro

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 — link/copy cleanup
- **Detail**: Phase 3 removed the Sign-up link from `signin.astro` and `Topbar.astro` but missed a third caller — `Welcome.astro:47-52` renders a "Sign Up" button to `/auth/signup`. After `signup.astro` is deleted it 404s and leaves a visible self-registration entry point.
- **Fix**: Add `Welcome.astro` to Phase 3; remove the Sign Up button. Add a `grep -rn "/auth/signup" src/` automated guard.
- **Decision**: FIXED (added Phase 3 change item #5 + grep guard `3.5` + renumbered Progress)

### F3 — Progress phase names don't match the ## Phase headers

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: `## Progress` vs `## Phase N` headers
- **Detail**: Body headers carried a parenthetical the Progress headers dropped (`(additive)`/`(security cut)`/`(cosmetic)`). progress-format.md wants them identical. Not a parse-breaker (parser keys on phase number + checkbox order), but should align.
- **Fix**: Drop the parentheticals from the three `## Phase N:` body headers.
- **Decision**: FIXED (headers now match Progress exactly; meaning retained in each phase Overview)

### F4 — callback.ts doesn't handle createClient returning null

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 — #2 PKCE callback
- **Detail**: `createClient` returns null when Supabase env is unset; `signin.ts:10` and `middleware.ts:9` guard for it, the callback contract didn't. Low likelihood, but inconsistent with the established pattern.
- **Fix**: Mirror the null guard — redirect `/auth/signin?error=...` when `createClient` returns null.
- **Decision**: FIXED (null guard added to callback contract)
