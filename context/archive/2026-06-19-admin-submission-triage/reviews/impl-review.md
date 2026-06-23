<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Admin Submission Triage (status + delete)

- **Plan**: context/changes/admin-submission-triage/plan.md
- **Scope**: Phases 1–5 of 5 (full plan)
- **Date**: 2026-06-23
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Verification re-run (this review)

- 27/27 change-scoped tests pass (validator + endpoint matrix + drift-guard).
- `npm run typecheck` — 0 errors.
- `npm run lint` — clean.
- DB-dependent automated checks (`db:reset`, `db:gen-types`, psql probes) and all
  manual gates were verified during implementation (Progress `[x]` with SHAs) and
  require a running local Supabase — not re-run here.

## Findings

### F1 — Triage 500 paths have no observability; sibling endpoint does

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/pages/api/submissions/[id].ts:71, :100
- **Detail**: `submissions.ts:53-64` reports DB-write failures via `captureServerError` + `console.error` (static descriptor, no PII). The new PATCH/DELETE endpoint returned 500 on a Supabase error with zero observability — a triage mutation failing in prod was silent. Not plan drift (plan only required static PII-free errors), but a divergence from the established sibling pattern.
- **Fix**: Add `captureServerError` on the two DB-error branches (PATCH :71, DELETE :100), mirroring `submissions.ts:60` — static descriptor + reason tag only, no submission id / body / headers (preserves the id-less anonymity posture).
- **Decision**: FIXED (Fix now) — added `captureServerError("Triage status update failed", …)` and `captureServerError("Triage delete failed", …)` with `errorType`/`reason` tags only, plus the import. Typecheck 0 errors; endpoint test 14/14 pass. Change is in the working tree, **not yet committed**.

### F2 — ADD COLUMN NOT NULL DEFAULT takes ACCESS EXCLUSIVE (informational)

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — informational; no change required
- **Dimension**: Safety & Quality (Data safety)
- **Location**: supabase/migrations/20260619000000_admin_submission_triage.sql:33-36
- **Detail**: `ADD COLUMN review_status text NOT NULL DEFAULT 'new'` uses a constant default → on PG 11+ it is metadata-only (no table rewrite; the backfill comment is accurate). It still takes a brief ACCESS EXCLUSIVE lock. Benign on this MVP table; noted only because the migration is applied manually to prod via `supabase db push`.
- **Decision**: SKIPPED (acknowledged — informational, no change warranted).

## Summary

Clean, well-engineered change. Both review sub-agents independently found zero plan
drift across all five phases, and every "What We're NOT Doing" guardrail held (hard
delete, no list/aggregate/digest filtering, no inline list actions, no audit columns,
same-origin-only CSRF, native `window.confirm`, insert path untouched, no workers test).
The three-layer authz (same-origin → app `isAllowedAdmin` → RLS via the SSR cookie-client)
is correctly ordered, the UPDATE SET is sealed to `review_status` only (validator +
double-asserted tests + column-grant backstop), and error responses are PII-free. The one
warning (F1, observability parity on the 500 branches) was fixed during triage.
