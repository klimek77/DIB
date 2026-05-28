-- Migration: create submissions table (foundation schema)
-- Change-id: submissions-data-model  (F-01 per context/foundation/roadmap.md)
-- Date: 2026-05-28
--
-- PRD touchpoints (context/foundation/prd.md):
--   FR-001..004 (employee form fields)
--   FR-005..008 (AI enrichment + graceful degradation)
--   FR-009 / FR-013 / FR-014 (admin read path)
--   FR-018 (enrichment-failure alert path; lifecycle columns enable it)
--   Access Control + NFR (anonymity guardrails — no IP/UA/session columns by design)
-- Empirical taxonomy source: context/foundation/DIB_example_database.csv
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE REVOKE IS LOAD-BEARING (do not remove without reading)
-- ─────────────────────────────────────────────────────────────────────────────
-- Supabase historically auto-grants SELECT / INSERT / UPDATE / DELETE to the
-- anon, authenticated, and service_role roles on every new table in `public`
-- via ALTER DEFAULT PRIVILEGES.  Per Supabase changelog #45329 (effective
-- 2026-05-30):
--   • NEW projects no longer carry the auto-grant default.
--   • EXISTING projects (this one) retain the auto-grant behavior until
--     2026-10-30.
-- Without the REVOKE statement below, the narrow column-level GRANT INSERT
-- (department, branch, topic, content, signature) for the anon role would
-- layer ON TOP of the default table-wide INSERT grant — anon could still
-- write any column, including the enrichment_* and ai_* columns the consumer
-- Worker (F-03) owns.  The REVOKE wipes the baseline so only the narrow
-- grants apply.  After 2026-10-30 the REVOKE becomes belt-and-suspenders;
-- keep it anyway — it documents the intent for future readers.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.submissions (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at              timestamptz NOT NULL DEFAULT now(),

    -- User-supplied form fields (all required at INSERT)
    department              text NOT NULL,
    branch                  text NOT NULL,
    topic                   text NOT NULL,
    content                 text NOT NULL,

    -- Optional identity (set only when the employee explicitly types it
    -- into the form; AI never sees this field).
    signature               text NULL,

    -- Enrichment lifecycle — owned by F-03 consumer Worker
    enrichment_status       text NOT NULL DEFAULT 'pending',
    enrichment_attempts     integer NOT NULL DEFAULT 0,
    enrichment_last_error   text NULL,
    enrichment_attempted_at timestamptz NULL,

    -- AI enrichment outputs — written by F-03 when status -> 'done'
    ai_title                text NULL,
    ai_tone                 text NULL,
    ai_classification       text NULL,
    ai_summary              text NULL,

    CONSTRAINT submissions_department_check
        CHECK (department IN (
            'Sprzedaż', 'Handlowy', 'Magazyn', 'HR', 'Księgowość',
            'Sekretariat', 'IT', 'Operacyjny', 'Media',
            'Segment Konstrukcji', 'Segment Dachy'
        )),
    CONSTRAINT submissions_branch_check
        CHECK (branch IN (
            'Gliwice', 'Tarnowskie Góry', 'Oświęcim', 'Sosnowiec',
            'Katowice', 'Dąbrowa Górnicza', 'Chrzanów', 'Centrala',
            'Supermarket Dobromir'
        )),
    CONSTRAINT submissions_topic_check
        CHECK (topic IN ('Pomysł', 'Problem', 'Usprawnienie', 'Inne')),
    CONSTRAINT submissions_content_length_check
        CHECK (char_length(content) BETWEEN 1 AND 800),
    CONSTRAINT submissions_enrichment_status_check
        CHECK (enrichment_status IN ('pending', 'processing', 'done', 'failed')),
    CONSTRAINT submissions_ai_tone_check
        CHECK (ai_tone IS NULL OR ai_tone IN ('Pozytywny', 'Negatywny', 'Neutralny'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indices sized for the dashboard queries S-02 will write
-- ─────────────────────────────────────────────────────────────────────────────

-- FR-010: time-range counter ordered by created_at
CREATE INDEX submissions_created_at_desc_idx
    ON public.submissions (created_at DESC);

-- FR-008 + FR-013: list of done-only submissions ordered by created_at
CREATE INDEX submissions_enrichment_status_created_at_idx
    ON public.submissions (enrichment_status, created_at DESC);

-- FR-011: topic pie-chart (counted over done rows only)
CREATE INDEX submissions_topic_done_idx
    ON public.submissions (topic)
    WHERE enrichment_status = 'done';

-- FR-012: branch group-by (counted over done rows only)
CREATE INDEX submissions_branch_done_idx
    ON public.submissions (branch)
    WHERE enrichment_status = 'done';

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;

-- Anon role may INSERT submissions (the employee form path).  Column-level
-- grants below restrict WHICH columns anon may write — RLS WITH CHECK (true)
-- leaves row-level checks open because column grants enforce the column
-- scope.  RLS + column grants are AND-ed by Postgres.
CREATE POLICY submissions_anon_insert
    ON public.submissions
    FOR INSERT
    TO anon
    WITH CHECK (true);

-- Authenticated role may SELECT all submissions.  The allow-list check
-- (which authenticated user counts as admin) is enforced at the middleware
-- layer by F-02 (auth-refit-magic-link).  F-01's RLS deliberately stops
-- at "is authenticated" so F-02 can pick env-var vs table without F-01
-- pre-committing the wrong shape.
CREATE POLICY submissions_authenticated_select
    ON public.submissions
    FOR SELECT
    TO authenticated
    USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Role grants — REVOKE baseline first (see header comment), then GRANT narrowly
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON public.submissions FROM anon, authenticated;

GRANT INSERT (department, branch, topic, content, signature)
    ON public.submissions TO anon;

GRANT SELECT
    ON public.submissions TO authenticated;

GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- Note: enrichment_* and ai_* columns are intentionally NOT granted to anon
-- or authenticated.  The F-03 consumer Worker uses the service_role key,
-- which bypasses RLS and column-level grants by design — no explicit grant
-- needed.  Future retention cron uses the same path.
