-- Migration: department optional + allow-list-gated admin SELECT (RLS defense-in-depth)
-- Change-id: first-end-to-end-submission  (S-01 per context/foundation/roadmap.md)
-- Follow-up to: 20260528000000_create_submissions.sql, 20260529000000_submissions_constraints_hardening.sql
-- Date: 2026-06-05
--
-- Two changes S-01 needs before the form + admin detail view land:
--   #1 department becomes optional — roadmap Q6 makes "dział" an optional field;
--      F-01 created it NOT NULL. Drop the constraint; regenerate database.types.ts
--      so the Insert type stops claiming `department: string`.
--   #2 admin-read RLS defense-in-depth — F-01 shipped a deliberately permissive
--      `submissions_authenticated_select USING (true)` and deferred the allow-list
--      gate to the application layer (allowlist.ts + middleware). S-01 ships the
--      first real read surface (the detail view), so per lessons.md ("a deferred
--      permissive gate is live exposure") we move the gate into the DB too: an
--      allow-list table read through a SECURITY DEFINER function, referenced by a
--      replacement SELECT policy. Route guard stays; RLS becomes belt-and-suspenders.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- EMPTY ALLOW-LIST TABLE LOCKS OUT EVERY ADMIN (do not forget the seed step)
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration creates admin_allowlist empty. With the new policy, an empty
-- table means is_allowed_admin() returns false for everyone and NO admin can
-- read any submission. The table is mirrored from ALLOWED_ADMIN_EMAILS (the
-- app-side single source of truth) by the idempotent `npm run db:seed-admins`
-- script — run it immediately after this migration applies, after every
-- `db:reset`, and on any change to ALLOWED_ADMIN_EMAILS.
-- ─────────────────────────────────────────────────────────────────────────────

-- #1: dział is optional.
ALTER TABLE public.submissions
    ALTER COLUMN department DROP NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- #2a: admin allow-list table. Emails stored lower-cased (the CHECK enforces it
-- so an accidental upper-case row can never silently fail to match the function's
-- lower(jwt email) comparison). RLS is enabled with NO permissive policy: only
-- the SECURITY DEFINER function below reads it, and the service_role seed script
-- (which bypasses RLS) writes it. The REVOKE is belt-and-suspenders against the
-- Supabase baseline auto-grant (see 20260528000000 header) — RLS-with-no-policy
-- already denies anon/authenticated, but a sensitive list earns the extra lock.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.admin_allowlist (
    email text PRIMARY KEY,
    CONSTRAINT admin_allowlist_email_lowercase_check
        CHECK (email = lower(email))
);

ALTER TABLE public.admin_allowlist ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.admin_allowlist FROM anon, authenticated;

-- #2b: the allow-list check. SECURITY DEFINER lets the policy read admin_allowlist
-- without granting anon/authenticated any access to the list itself; STABLE marks
-- it safe to evaluate once per query; the pinned search_path closes the standard
-- SECURITY DEFINER hijack vector. It reveals only whether the CALLER's own JWT
-- email is an admin.
CREATE OR REPLACE FUNCTION public.is_allowed_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.admin_allowlist
        WHERE email = lower(auth.jwt() ->> 'email')
    );
$$;

-- Lock EXECUTE to authenticated only — consistent with the table REVOKE above.
-- Supabase's baseline ALTER DEFAULT PRIVILEGES grants EXECUTE DIRECTLY to anon and
-- authenticated (the same auto-grant mechanism documented for tables in the
-- 20260528000000 header), so a bare REVOKE ... FROM PUBLIC is a no-op — anon keeps
-- its direct grant. Revoke both roles, then grant back only authenticated (which
-- needs it to evaluate the submissions SELECT policy). service_role is left
-- untouched, mirroring F-01's table REVOKE.
REVOKE EXECUTE ON FUNCTION public.is_allowed_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_allowed_admin() TO authenticated;

-- #2c: replace the permissive admin SELECT policy with the allow-list-gated one.
-- Same name (still "authenticated SELECT", now additionally allow-list-gated);
-- the anon INSERT policy and the narrow column GRANT from F-01 are untouched.
DROP POLICY submissions_authenticated_select ON public.submissions;

CREATE POLICY submissions_authenticated_select
    ON public.submissions
    FOR SELECT
    TO authenticated
    USING (public.is_allowed_admin());
