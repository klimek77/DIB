<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-01 first-end-to-end-submission

- **Plan**: context/changes/first-end-to-end-submission/plan.md
- **Scope**: Phase 1 of 5 (Data layer — department optional + allow-list admin RLS)
- **Date**: 2026-06-05
- **Commit reviewed**: 9e2fe45
- **Verdict**: NEEDS ATTENTION → all findings triaged & FIXED (re-verified)
- **Findings**: 0 critical · 3 warnings · 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING (F1, F2) → fixed |
| Architecture | PASS |
| Pattern Consistency | WARNING (F3) → fixed |
| Success Criteria | PASS |

## Findings

### F1 — is_allowed_admin() EXECUTE granted beyond authenticated

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260605000000_s01_department_optional_and_admin_allowlist_rls.sql (function grants)
- **Detail**: Postgres + Supabase baseline `ALTER DEFAULT PRIVILEGES` granted EXECUTE directly to `anon`, `authenticated`, `service_role`. The migration's REVOKE on the allow-list *table* was explicit, but the *function* relied on defaults — leaving `anon` able to call it (harmless: it only reveals the caller's own admin status, returns false for anon). Inconsistent with the file's own belt-and-suspenders REVOKE ethos.
- **Fix**: `REVOKE EXECUTE ON FUNCTION public.is_allowed_admin() FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO authenticated;`. Note: a first pass revoking only `FROM PUBLIC` was a no-op against the direct role grants (same footgun as the F-01 table REVOKE) — corrected to revoke the roles explicitly.
- **Decision**: FIXED — re-verified: function ACL now `{postgres, service_role, authenticated}`; anon EXECUTE → `permission denied`; authenticated + RLS allow/deny intact.

### F2 — .env.example missing the two vars this change requires

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (onboarding / reliability)
- **Location**: .env.example
- **Detail**: Listed only `SUPABASE_URL` / `SUPABASE_KEY`; the new `db:seed-admins` needs `SUPABASE_SERVICE_ROLE_KEY` and `ALLOWED_ADMIN_EMAILS`. A fresh dev hits "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" with no example to copy.
- **Fix**: Added `SUPABASE_SERVICE_ROLE_KEY=###` and `ALLOWED_ADMIN_EMAILS=###` to `.env.example`.
- **Decision**: FIXED.

### F3 — Seed-script comments named the wrong node flag

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency (docs accuracy)
- **Location**: scripts/seed-admins.mjs (header comment + error string)
- **Detail**: Comments said "loads .env via node --env-file" while package.json wires `--env-file-if-exists`. The two differ (hard-fail vs continue-if-missing); the wired choice is the better one, only the comments lagged.
- **Fix**: Updated the comment and the error-message string to `--env-file-if-exists`.
- **Decision**: FIXED.

### F4 — Bare CREATE FUNCTION (not CREATE OR REPLACE)

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (replay safety)
- **Location**: supabase/migrations/20260605000000_...rls.sql (function definition)
- **Detail**: Hand-replay against an already-migrated DB (without db:reset) would error "function already exists".
- **Fix**: Changed to `CREATE OR REPLACE FUNCTION`.
- **Decision**: FIXED.

### F5 — Seed success message could read as a bug when count > N

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: scripts/seed-admins.mjs (final console.log)
- **Detail**: Script never deletes, so the cumulative count can exceed "mirrored N email(s)" — slightly misleading juxtaposition.
- **Fix**: Reworded to "admin_allowlist now has {count} total row(s) (removal is manual)".
- **Decision**: FIXED.
