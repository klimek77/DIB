<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Auth & abuse-boundary tests (rollout Phase 3)

- **Plan**: context/changes/testing-auth-abuse-boundary/plan.md
- **Scope**: Phase 1 of 2
- **Date**: 2026-06-09
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Evidence: `npm test` 92/92 green (re-run during review) · `npm run typecheck` 0 errors ·
`npm run lint` clean · drift agent: all 5 branches + mocks + driver MATCH, cross-branch
assertion confirmed real (Set-identity over serialized shapes, not independent copies) ·
manual 1.4 user-confirmed · only EXTRA: an added `isAllowedAdmin` call assertion in branch 2
(strengthens the test, benign).

Filtered as noise: `mockReturnValueOnce` style preference in the matrix test; redundant
`?error=` assertion (deliberate intent documentation); no direct assertion on the `redirect`
spy (the response shape is the contract).

## Findings

### F1 — Non-enumeration matrix omits the missing-email variant

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/auth/signin.test.ts:111-149
- **Detail**: The cross-branch Set-identity check covers 4 variants (allowed / denied /
  malformed / erroring). The "missing email field" variant is asserted independently in the
  first describe block but does not enter the identity matrix — the property "identical shape
  for EVERY request variant" is pinned for 4 of 5 variants.
- **Fix**: Add a fifth collect() to the matrix: stub + isAllowedAdmin false +
  `collect(await invoke(makeContext(null)))`.
- **Decision**: FIXED — branch 5 (missing email) added to the identity matrix; test title updated.

### F2 — Dead isAllowedAdmin mock values in the unconfigured-client test

- **Severity**: 👁 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/auth/signin.test.ts:151-165
- **Detail**: With createClient → null the handler returns before the gate (signin.ts:10-12),
  so the mockReturnValue(true)/(false) values are never consulted — a reader may believe the
  test exercises the gate. The "config-check before gate" ordering is not pinned.
- **Fix**: Add `expect(isAllowedAdmin).not.toHaveBeenCalled()` — turns the dead mock values
  into a real ordering sentinel.
- **Decision**: FIXED — ordering sentinel assertion added.

### F3 — Missing-email → "" normalization not pinned

- **Severity**: 👁 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/pages/api/auth/signin.test.ts:81-94
- **Detail**: The "malformed or missing" test does not assert what argument the handler
  passes to the gate when the email field is absent (signin.ts:7 normalizes null → "").
  A normalization regression (passing null/undefined through) would be invisible.
- **Fix**: After `invoke(makeContext(null))` add `expect(isAllowedAdmin).toHaveBeenCalledWith("")`.
- **Decision**: FIXED — normalization argument pinned.
