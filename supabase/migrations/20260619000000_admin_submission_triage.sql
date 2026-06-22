-- Migration: admin submission triage — review_status column + UPDATE/DELETE RLS
-- Change-id: admin-submission-triage
-- Follow-up to: 20260528000000_create_submissions.sql (table + REVOKE baseline + anon/auth grants),
--               20260605000000_s01_department_optional_and_admin_allowlist_rls.sql (is_allowed_admin())
-- Date: 2026-06-19
--
-- WHAT THIS DOES
--   Closes the admin CRUD loop on the dashboard. Adds a triage status the admin
--   sets from the detail view (`new → in_progress → reviewed/rejected`) and lets
--   the admin delete a submission (spam/off-topic moderation). Both mutations go
--   through the SSR session (cookie) client, so RLS enforces them at the DB layer
--   — defense-in-depth for the "zero leak past admins" guardrail (test-plan #1).
--
--   review_status is metadata-only. It deliberately does NOT feed list filtering,
--   the dashboard_aggregates RPC, or the weekly digest — those stay untouched.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE GRANTS ARE NARROW (do not widen without reading)
-- ─────────────────────────────────────────────────────────────────────────────
--   20260528 already did `REVOKE ALL ON public.submissions FROM anon, authenticated`,
--   so `authenticated` currently holds only SELECT. We add exactly two privileges
--   to `authenticated`, explicitly (never via PUBLIC — Supabase's baseline auto-grant
--   goes direct-to-role, so a PUBLIC grant/revoke would be a no-op; lessons.md):
--     * UPDATE (review_status) — COLUMN-SCOPED. This is the test-plan #3 backstop:
--       even a bug in the endpoint cannot write content/ai_*/enrichment_* through the
--       authenticated role — any other column in a SET raises 42501.
--     * DELETE — row-level; hard delete (no soft-delete column by design).
--   anon and PUBLIC get nothing here. service_role bypasses RLS + column grants by
--   design and needs no grant. RLS (enabled in 20260528) default-denies UPDATE/DELETE
--   until the two policies below add an allow-list-gated path for authenticated.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.submissions
    ADD COLUMN review_status text NOT NULL DEFAULT 'new'
    CONSTRAINT submissions_review_status_check
        CHECK (review_status IN ('new', 'in_progress', 'reviewed', 'rejected'));

-- Backfill is automatic: NOT NULL DEFAULT 'new' on ADD COLUMN stamps every existing row.

-- Column-scoped UPDATE backstop (test-plan #3): authenticated may change ONLY status.
GRANT UPDATE (review_status) ON public.submissions TO authenticated;
GRANT DELETE               ON public.submissions TO authenticated;

-- RLS UPDATE/DELETE gated by the same allow-list function the SELECT policy uses
-- (20260605). USING gates which rows the admin may act on; WITH CHECK (UPDATE only)
-- gates the post-image — both demand the caller's JWT email be an allow-listed admin.
CREATE POLICY submissions_admin_update
    ON public.submissions
    FOR UPDATE
    TO authenticated
    USING (public.is_allowed_admin())
    WITH CHECK (public.is_allowed_admin());

CREATE POLICY submissions_admin_delete
    ON public.submissions
    FOR DELETE
    TO authenticated
    USING (public.is_allowed_admin());
