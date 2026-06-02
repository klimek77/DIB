<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Auth Refit — Magic-Link + Admin Allow-List

- **Plan**: context/changes/auth-refit-magic-link/plan.md
- **Scope**: FULL PLAN (Phases 1–3 of 3)
- **Date**: 2026-06-01
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

All 16 planned changes MATCH (confirmed independently by both review agents + direct read of Phase 1 files). End-to-end security trace clean: no non-allow-listed principal can reach `/dashboard` or hold a session. Three gates (request in `signin.ts`, callback session-time in `callback.ts`, per-request in `middleware.ts`) all funnel through the single fail-closed `isAllowedAdmin()` helper — exact-match `Set`, trimmed + lowercased, empty entries dropped. 2.9 (Workers cookie round-trip) verified on live preview deploy `33defad5`.

**Automated (all green):** typecheck 0 errors · targeted eslint clean · build exit 0 · no `signInWithPassword`/`signUp`/`/auth/signup` refs in `src/` · all 5 delete targets gone.

## Findings

### F1 — Stale "sign up" copy on the landing page

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/Welcome.astro:74-77
- **Detail**: Feature card read "Built-in Supabase auth with sign in, sign up, and protected routes out of the box." After the refit there is no sign-up. Prose (not a `/auth/signup` link, so it passed 3.5) but user-visible and inaccurate on the public landing page.
- **Fix**: Reword to "Built-in Supabase auth with passwordless magic-link sign in and protected routes out of the box."
- **Decision**: FIXED — copy reworded; eslint clean.

### F2 — Allow-list changes need a redeploy to take effect

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — operational awareness; no code change
- **Dimension**: Safety & Quality
- **Location**: src/lib/auth/allowlist.ts:12
- **Detail**: The `Set` is built once at module load; on Cloudflare Workers the module is per-isolate, so editing the `ALLOWED_ADMIN_EMAILS` secret only applies after a redeploy / isolate recycle. This is the intended env-var "loud lockout" model (already in the plan's Open Risks), not a bug.
- **Fix**: None. Document the "edit secret → redeploy" step in ops notes.
- **Decision**: ACKNOWLEDGED — by-design; already in plan Open Risks.

### F3 — Topbar shows logged-in chrome for a (rare) non-allowed session

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — cosmetic; state not normally reachable
- **Dimension**: Safety & Quality
- **Location**: src/components/Topbar.astro:9
- **Detail**: Middleware keeps `locals.user` as the raw Supabase user, so the logged-in branch could render for an authenticated-but-not-allowed user. Not a security issue (Dashboard is hard-gated; the callback signs out non-allowed sessions before any page renders). Matches the plan's "locals.user stays raw; gate is purely access control."
- **Fix**: Gate the Topbar logged-in branch on `isAllowedAdmin` too.
- **Decision**: FIXED — added `isAllowedAdmin(user?.email)` check; logged-in branch now gated on `user && isAdmin`. typecheck + build green.
