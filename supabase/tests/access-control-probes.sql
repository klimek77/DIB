-- ============================================================================
-- Access-control SQL probes  (MANUAL quality gate)
-- change-id: testing-access-control-anonymity  ·  rollout Phase 1  ·  risks #1/#3 (DB layer)
-- ============================================================================
--
-- WHAT THIS IS
--   A repeatable, annotated probe script that proves the DB-layer access
--   guarantees the pure-node Vitest harness cannot reach:
--     * the RLS SELECT policy on public.submissions gates on is_allowed_admin()
--     * the anon role's column grant blocks writes to enrichment_*/id/ai_* columns
--   Each probe states its expected outcome inline so a human can eyeball pass/fail.
--
-- HOW TO RUN
--   Against a LOCAL or STAGING Supabase: the `auth` schema and auth.jwt() must
--   exist (bare Postgres will NOT have them). Run as a privileged role -- the
--   Studio SQL editor's default `postgres`, or psql connected as the
--   service-role/postgres owner -- so each probe's seed INSERT can bypass RLS
--   and so SET LOCAL ROLE anon/authenticated is permitted.
--     * Supabase Studio: paste a single probe block, run it, read the result.
--     * psql:  psql "$DATABASE_URL" -f supabase/tests/access-control-probes.sql
--       Do NOT pass --set ON_ERROR_STOP=1 -- Probe 3 is EXPECTED to raise
--       42501, and ON_ERROR_STOP would abort the rest of the file.
--
-- SAFETY
--   Every probe runs inside BEGIN ... ROLLBACK; nothing it inserts ever persists.
--
-- IMPORTANT -- WHAT THE anon PROBES DO AND DO NOT TEST
--   Probes 3 and 4 SET ROLE anon to exercise the column GRANT. The LIVE submit
--   endpoint does NOT take this path: it inserts via the service-role client
--   (createAdminClient), which bypasses RLS *and* column grants by design
--   (supabase/migrations/20260528000000_create_submissions.sql:143-146; research.md).
--   So Probes 3/4 verify a regression *backstop* -- "if the app ever switched the
--   insert to the anon key, would the DB still protect us?" -- NOT the behaviour
--   of the current production path. The app-layer whitelist
--   (src/lib/submissions/submission-input.ts, unit + route tested) is the sole
--   live defense for #3.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Probe 1 -- RLS SELECT, NON-admin  ->  EXPECT 0 rows
--   An authenticated principal whose JWT email is NOT in admin_allowlist must
--   see zero submissions, even when rows exist. Seeding a row as the privileged
--   owner first means "0" can only mean "the policy denied", never "empty table".
-- ----------------------------------------------------------------------------
BEGIN;
  INSERT INTO public.submissions (branch, topic, content)
    VALUES ('Gliwice', 'Pomysł', 'probe-1 row (rolled back)');

  SET LOCAL request.jwt.claims = '{"email":"notadmin@example.com"}';
  SET LOCAL ROLE authenticated;

  SELECT count(*) AS nonadmin_visible_rows  -- EXPECT: 0
  FROM public.submissions;
ROLLBACK;


-- ----------------------------------------------------------------------------
-- Probe 2 -- RLS SELECT, ADMIN  ->  EXPECT >= 1 row
--   A principal whose JWT email IS in admin_allowlist sees the rows, proving the
--   gate ADMITS allow-listed principals (not a blanket deny). Self-seeds both the
--   admin email and a row so the probe is deterministic on a fresh DB.
-- ----------------------------------------------------------------------------
BEGIN;
  INSERT INTO public.admin_allowlist (email)
    VALUES ('probe-admin@example.com')
    ON CONFLICT (email) DO NOTHING;
  INSERT INTO public.submissions (branch, topic, content)
    VALUES ('Gliwice', 'Pomysł', 'probe-2 row (rolled back)');

  SET LOCAL request.jwt.claims = '{"email":"probe-admin@example.com"}';
  SET LOCAL ROLE authenticated;

  SELECT count(*) AS admin_visible_rows  -- EXPECT: >= 1
  FROM public.submissions;
ROLLBACK;


-- ----------------------------------------------------------------------------
-- Probe 3 -- anon column grant, FORBIDDEN columns  ->  EXPECT ERROR 42501
--   anon holds INSERT only on (department, branch, topic, content, signature).
--   Writing id / enrichment_status / ai_title is not granted -> permission denied
--   (SQLSTATE 42501). The required columns are valid, so the ONLY reason for
--   failure is the forbidden columns.   *** The ERROR is the PASS condition. ***
-- ----------------------------------------------------------------------------
BEGIN;
  SET LOCAL ROLE anon;

  INSERT INTO public.submissions (branch, topic, content, id, enrichment_status, ai_title)
    VALUES ('Gliwice', 'Pomysł', 'probe-3 row', '00000000-0000-0000-0000-000000000001', 'done', 'pwned');
  -- EXPECT: ERROR:  permission denied for table submissions   (SQLSTATE 42501)
ROLLBACK;


-- ----------------------------------------------------------------------------
-- Probe 4 -- anon column grant, ALLOWED columns  ->  EXPECT success (INSERT 0 1)
--   The five granted columns insert cleanly under the anon INSERT RLS policy
--   (WITH CHECK true). id / created_at / enrichment_status fill from DEFAULT and
--   need no grant (column privilege is required only for columns you assign).
-- ----------------------------------------------------------------------------
BEGIN;
  SET LOCAL ROLE anon;

  INSERT INTO public.submissions (department, branch, topic, content, signature)
    VALUES ('IT', 'Gliwice', 'Pomysł', 'probe-4 row (rolled back)', 'Jan K.');
  -- EXPECT: INSERT 0 1   (success)
ROLLBACK;


-- ----------------------------------------------------------------------------
-- Probe 5 -- REMOVED admin  ->  EXPECT >= 1 before DELETE, then 0 after
--   Operationalises the removed-admin divergence: `npm run db:seed-admins` is
--   additive-only and never deletes, so removing an admin is a deliberate manual
--   `DELETE FROM public.admin_allowlist`. Until that DELETE runs, the ex-admin's
--   JWT still passes RLS on a direct PostgREST read (the residual exposure in
--   research.md). This probe proves the DELETE closes it.
-- ----------------------------------------------------------------------------
BEGIN;
  INSERT INTO public.admin_allowlist (email)
    VALUES ('leaver@example.com')
    ON CONFLICT (email) DO NOTHING;
  INSERT INTO public.submissions (branch, topic, content)
    VALUES ('Gliwice', 'Pomysł', 'probe-5 row (rolled back)');

  SET LOCAL request.jwt.claims = '{"email":"leaver@example.com"}';
  SET LOCAL ROLE authenticated;
  SELECT count(*) AS before_removal_visible_rows  -- EXPECT: >= 1
  FROM public.submissions;

  RESET ROLE;  -- back to the privileged owner to mutate the allow-list
  DELETE FROM public.admin_allowlist WHERE email = 'leaver@example.com';

  SET LOCAL request.jwt.claims = '{"email":"leaver@example.com"}';
  SET LOCAL ROLE authenticated;
  SELECT count(*) AS after_removal_visible_rows  -- EXPECT: 0
  FROM public.submissions;
ROLLBACK;
