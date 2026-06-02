<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Auth Refit — Magic-Link + Admin Allow-List

- **Plan**: context/changes/auth-refit-magic-link/plan.md
- **Scope**: Phase 2 of 3
- **Date**: 2026-06-01
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

All 6 planned changes MATCH (confirmed independently by both review agents). The
security property holds: a non-allow-listed principal cannot reach `/dashboard` or
keep a session — three gates (request-time in `signin.ts`, session-time in
`callback.ts`, per-request in `middleware.ts`) all funnel through the single
`isAllowedAdmin()` helper, and the callback signs out a non-allowed session before
redirecting.

**Automated verification (all green):** `npm run typecheck` 0 errors · targeted
`eslint` clean · `npm run build` exit 0 · `signup.ts` + `confirm-email.astro` deleted,
no `signInWithPassword`/`signUp` references in `src/`. Re-run green after triage fixes.

## Findings

### F1 — Unplanned supabase/config.toml change

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: supabase/config.toml:154-156
- **Detail**: Phase 2 bumped local Supabase dev redirect URLs (3000→4321, added `/**` entries). Benign and required for local magic-link manual checks (2.6/2.7); commit self-documents it as EXTRA. Gap: the plan didn't record it.
- **Fix**: Add a one-line addendum under Phase 2 "Changes Required" noting the local config.toml redirect-URL bump.
- **Decision**: FIXED — added item #6 (local Supabase dev config addendum) to plan.md Phase 2 Changes Required.

### F2 — Manual 2.9 (preview-deploy cookie round-trip) still pending

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🔎 MEDIUM — the one check that can pass locally but fail in prod
- **Dimension**: Success Criteria
- **Location**: plan.md:374 (Progress 2.9)
- **Detail**: 2.9 (Cloudflare preview cookie round-trip) is intentionally deferred to the deploy session. Phase 3 is UI-only and does not touch the callback cookie path, so starting Phase 3 is safe — but the callback's whole value depends on `setAll` cookies surviving Workers' streaming Set-Cookie model, which local dev does not prove. Highest-risk unverified item.
- **Fix**: No code change. Keep 2.9 open; treat as a hard ship-gate before the single Phase-3 deploy.
- **Decision**: ACKNOWLEDGED — kept as ship-gate; 2.9 stays `[ ]`.

### F3 — verifyOtp `type` is an unsound, attacker-controlled string

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/auth/callback.ts:21
- **Detail**: `type` came raw from the query string into `verifyOtp`; type-checked only because `EmailOtpType` ends in `(string & {})`. Not exploitable (verifyOtp still needs a valid Supabase-issued `token_hash`, and the result is re-gated by `isAllowedAdmin()`), but an unsound/clarity nit.
- **Fix**: Guard with an allowlist of expected types before calling verifyOtp.
- **Decision**: FIXED — `type` narrowed to `["magiclink","email","recovery","signup"]`; an unexpected value now falls into the null branch instead of reaching verifyOtp.

### F4 — Enumeration neutrality has a timing side-channel

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — conscious skip is valid
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/auth/signin.ts:18-29
- **Detail**: Both branches redirect to `/auth/check-email`, but the allowed branch awaits a Supabase network round-trip first while the non-allowed branch returns immediately. The response-time delta can weakly reveal allow-list membership. Low value against a tiny internal admin roster with no public signup.
- **Fix**: Equalize timing, or accept and document the residual signal.
- **Decision**: SKIPPED — accepted as a low-value residual signal for an internal admin tool.

### F5 — Supabase boundary calls not wrapped in try/catch

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/auth/signin.ts:20, src/pages/auth/callback.ts:18-22
- **Detail**: `signInWithOtp` / `exchangeCodeForSession` / `verifyOtp` were awaited without try/catch. Returned errors are already handled gracefully; the only failure mode was a thrown exception → 500 instead of the neutral redirect. supabase-js auth methods generally return rather than throw, so practical risk was low — defensive hardening.
- **Fix**: Wrap each awaited call in try/catch, falling through to the neutral redirect.
- **Decision**: FIXED — `signInWithOtp` wrapped (falls through to `/auth/check-email`); exchange/verify wrapped in an IIFE (throw → null → neutral redirect); cleanup `signOut` wrapped.
