-- Migration: dashboard aggregates RPC (single round-trip for the S-02 dashboard)
-- Change-id: admin-dashboard-aggregates  (S-02 per context/foundation/roadmap.md)
-- Follow-up to: 20260528000000_create_submissions.sql (indices sized for these
-- exact queries), 20260605000000_s01_department_optional_and_admin_allowlist_rls.sql
-- (the is_allowed_admin() SELECT policy this function relies on)
-- Date: 2026-06-12
--
-- PRD touchpoints (context/foundation/prd.md):
--   FR-008 (aggregates count done rows only)
--   FR-010 (time-range counter)  FR-011 (topic split)  FR-012 (branch split)
--   FR-013 (the list itself goes through PostgREST, not this function)
--
-- WHY ONE FUNCTION
--   PostgREST cannot GROUP BY without an RPC, and Supabase's default max_rows
--   (1000) silently truncates a fetch-all — a year-range dashboard would count
--   wrong. One SQL function returns every aggregate in one round-trip.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY INVOKER IS THE POINT (do not "fix" to DEFINER)
-- ─────────────────────────────────────────────────────────────────────────────
-- The function runs with the CALLER's privileges, so the submissions SELECT
-- policy (USING public.is_allowed_admin()) keeps gating every row it reads:
--   * an allow-listed admin sees real counts,
--   * an authenticated non-admin gets zeros (RLS yields no rows — not an error),
--   * anon cannot EXECUTE at all (grants below).
-- SECURITY DEFINER would run as the function owner, bypass RLS, and hand the
-- aggregate counts to ANY authenticated principal — re-opening the exact gap
-- S-01 closed (test-plan risk #1). Defense-in-depth mirrors the detail view:
-- middleware route-guard stays the first gate, RLS stays the last.
--
-- WEEK MATH LIVES HERE AND ONLY HERE
--   by_week is zero-filled to EXACTLY 8 buckets in SQL (generate_series), keyed
--   by date_trunc('week', … AT TIME ZONE 'Europe/Warsaw') — DST-safe wall-clock
--   weeks, ISO week numbers from to_char(…, 'IW'). The TS mapper only validates
--   the length; it never re-computes buckets. Implementing week math on both
--   sides would silently zero a bucket on any key drift.
--
-- Rollback: DROP FUNCTION public.dashboard_aggregates(timestamptz, timestamptz, text);

CREATE OR REPLACE FUNCTION public.dashboard_aggregates(
    p_from   timestamptz,
    p_to     timestamptz,
    p_branch text DEFAULT NULL
) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
WITH range_rows AS (
    -- Done-only rows inside the half-open range [p_from, p_to), optional branch
    -- filter. Equality on enrichment_status keeps the partial indexes usable
    -- (submissions_topic_done_idx / submissions_branch_done_idx).
    SELECT topic, branch, ai_tone
    FROM public.submissions
    WHERE enrichment_status = 'done'
      AND created_at >= p_from
      AND created_at <  p_to
      AND (p_branch IS NULL OR branch = p_branch)
),
week_starts AS (
    -- Fixed window: the current Warsaw ISO week and the 7 before it, regardless
    -- of p_from/p_to. Wall-clock timestamps (no tz) — Monday 00:00 local.
    SELECT gs AS week_start
    FROM generate_series(
        date_trunc('week', now() AT TIME ZONE 'Europe/Warsaw') - interval '7 weeks',
        date_trunc('week', now() AT TIME ZONE 'Europe/Warsaw'),
        interval '1 week'
    ) AS gs
),
week_counts AS (
    SELECT date_trunc('week', created_at AT TIME ZONE 'Europe/Warsaw') AS week_start,
           count(*) AS cnt
    FROM public.submissions
    WHERE enrichment_status = 'done'
      AND (p_branch IS NULL OR branch = p_branch)
      -- Lower bound = the UTC instant of the earliest bucket's Warsaw midnight,
      -- so the created_at index can prune rows older than the 8-week window.
      AND created_at >= (
          (date_trunc('week', now() AT TIME ZONE 'Europe/Warsaw') - interval '7 weeks')
          AT TIME ZONE 'Europe/Warsaw'
      )
    GROUP BY 1
)
SELECT jsonb_build_object(
    'total_range', (SELECT count(*) FROM range_rows),
    'total_all',   (SELECT count(*)
                    FROM public.submissions
                    WHERE enrichment_status = 'done'
                      AND (p_branch IS NULL OR branch = p_branch)),
    'by_topic',    coalesce(
                       (SELECT jsonb_object_agg(topic, cnt)
                        FROM (SELECT topic, count(*) AS cnt
                              FROM range_rows GROUP BY topic) t),
                       '{}'::jsonb),
    'by_branch',   coalesce(
                       (SELECT jsonb_object_agg(branch, cnt)
                        FROM (SELECT branch, count(*) AS cnt
                              FROM range_rows GROUP BY branch) b),
                       '{}'::jsonb),
    'by_tone',     coalesce(
                       (SELECT jsonb_object_agg(ai_tone, cnt)
                        FROM (SELECT ai_tone, count(*) AS cnt
                              FROM range_rows
                              WHERE ai_tone IS NOT NULL
                              GROUP BY ai_tone) tn),
                       '{}'::jsonb),
    'by_week',     (SELECT jsonb_agg(
                        jsonb_build_object(
                            'week_start', to_char(w.week_start, 'YYYY-MM-DD'),
                            'iso_week',   to_char(w.week_start, 'IW'),
                            'count',      coalesce(wc.cnt, 0)
                        )
                        ORDER BY w.week_start
                    )
                    FROM week_starts w
                    LEFT JOIN week_counts wc ON wc.week_start = w.week_start)
);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grant hygiene — Supabase's baseline ALTER DEFAULT PRIVILEGES grants EXECUTE
-- DIRECTLY to anon/authenticated on every new function (not via PUBLIC), so a
-- bare REVOKE ... FROM PUBLIC would be a no-op (see lessons.md and the
-- 20260605000000 header). Revoke the roles explicitly, grant back only
-- authenticated (RLS still decides which rows count). service_role keeps its
-- default grant on purpose — S-05 (weekly digest) reuses this function through
-- the service-role client.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.dashboard_aggregates(timestamptz, timestamptz, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_aggregates(timestamptz, timestamptz, text)
    TO authenticated;
