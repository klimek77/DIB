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
--     * the dashboard_aggregates() RPC (S-02) does not bypass RLS: SECURITY
--       INVOKER keeps the SELECT policy in force (Probe 6; change-id
--       admin-dashboard-aggregates)
--     * the RLS UPDATE/DELETE policies on public.submissions gate the admin
--       triage mutations (status change + delete) on is_allowed_admin(), and the
--       column-scoped GRANT UPDATE (review_status) blocks any write to other
--       columns even for an allow-listed admin (Probes 7-11; change-id
--       admin-submission-triage; risks #1/#3, DB layer)
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


-- ----------------------------------------------------------------------------
-- Probe 6 -- dashboard_aggregates() RPC respects RLS (S-02, risk #1)
--   The function is SECURITY INVOKER, so the submissions SELECT policy keeps
--   gating every row it counts. 6a/6b share one block (Probe 5 pattern: RESET
--   ROLE between principals). The seeded row must be enrichment_status='done'
--   (the function counts done rows only) and p_to must sit in the FUTURE:
--   created_at defaults to now(), now() is constant within the transaction,
--   and the range is half-open [p_from, p_to) -- p_to = now() would exclude
--   the row we just seeded.
--
--   6a NON-admin  ->  EXPECT total_range = 0   (zeros, not an error: RLS
--      yields no rows; EXECUTE itself is granted to authenticated)
--   6b ADMIN      ->  EXPECT total_range >= 1
-- ----------------------------------------------------------------------------
BEGIN;
  INSERT INTO public.admin_allowlist (email)
    VALUES ('probe-admin@example.com')
    ON CONFLICT (email) DO NOTHING;
  INSERT INTO public.submissions (branch, topic, content, enrichment_status)
    VALUES ('Gliwice', 'Pomysł', 'probe-6 row (rolled back)', 'done');

  SET LOCAL request.jwt.claims = '{"email":"notadmin@example.com"}';
  SET LOCAL ROLE authenticated;
  SELECT (public.dashboard_aggregates(
            now() - interval '30 days', now() + interval '1 hour', NULL
         ) ->> 'total_range')::int AS nonadmin_total_range;  -- EXPECT: 0

  RESET ROLE;  -- back to the privileged owner before switching principals

  SET LOCAL request.jwt.claims = '{"email":"probe-admin@example.com"}';
  SET LOCAL ROLE authenticated;
  SELECT (public.dashboard_aggregates(
            now() - interval '30 days', now() + interval '1 hour', NULL
         ) ->> 'total_range')::int AS admin_total_range;  -- EXPECT: >= 1
ROLLBACK;


-- ----------------------------------------------------------------------------
-- Probe 6c -- anon may not EXECUTE the RPC  ->  EXPECT ERROR 42501
--   The migration revokes EXECUTE from PUBLIC, anon, authenticated explicitly
--   and grants back only authenticated, so anon hits permission denied at the
--   function boundary -- it never reaches RLS. Separate block on purpose
--   (Probe 3 precedent): the raised error aborts the transaction and would
--   kill 6a/6b results in the same block.
--   *** The ERROR is the PASS condition. ***
-- ----------------------------------------------------------------------------
BEGIN;
  SET LOCAL ROLE anon;

  SELECT public.dashboard_aggregates(now() - interval '30 days', now(), NULL);
  -- EXPECT: ERROR:  permission denied for function dashboard_aggregates   (SQLSTATE 42501)
ROLLBACK;


-- ============================================================================
-- admin-submission-triage probes (Phase 5) -- RLS UPDATE/DELETE + column backstop
--   review_status triage and hard delete both flow through the admin SESSION
--   (authenticated role), so RLS must gate them on is_allowed_admin() exactly as
--   it gates SELECT. Probes 7-10 prove the gate; Probe 11 proves the column-scoped
--   GRANT UPDATE (review_status) is a hard backstop -- even an allow-listed admin
--   cannot write `content` (or any non-status column) through the authenticated
--   role, so an endpoint bug that put extra columns in the SET still cannot land.
--   UPDATE/DELETE return no rowset, so each probe counts affected rows via a CTE
--   (WITH ... RETURNING). The seeded row carries a unique content marker so the
--   count is deterministic regardless of what else is in the table.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Probe 7 -- RLS UPDATE review_status, NON-admin  ->  EXPECT 0 rows updated
--   review_status IS granted to authenticated, so this never errors on the column
--   privilege; it is the RLS UPDATE policy (USING is_allowed_admin() = false) that
--   filters the row out of the update set. 0 affected ⇒ the gate held.
-- ----------------------------------------------------------------------------
BEGIN;
  INSERT INTO public.submissions (branch, topic, content)
    VALUES ('Gliwice', 'Pomysł', 'probe-7 row (rolled back)');

  SET LOCAL request.jwt.claims = '{"email":"notadmin@example.com"}';
  SET LOCAL ROLE authenticated;

  WITH upd AS (
    UPDATE public.submissions
       SET review_status = 'reviewed'
     WHERE content = 'probe-7 row (rolled back)'
    RETURNING 1
  )
  SELECT count(*) AS nonadmin_rows_updated  -- EXPECT: 0
  FROM upd;
ROLLBACK;


-- ----------------------------------------------------------------------------
-- Probe 8 -- RLS UPDATE review_status, ADMIN  ->  EXPECT >= 1 row updated
--   Allow-listed principal: RLS USING/WITH CHECK is_allowed_admin() = true, so the
--   status mutation lands. Proves the gate ADMITS admins (not a blanket deny).
-- ----------------------------------------------------------------------------
BEGIN;
  INSERT INTO public.admin_allowlist (email)
    VALUES ('probe-admin@example.com')
    ON CONFLICT (email) DO NOTHING;
  INSERT INTO public.submissions (branch, topic, content)
    VALUES ('Gliwice', 'Pomysł', 'probe-8 row (rolled back)');

  SET LOCAL request.jwt.claims = '{"email":"probe-admin@example.com"}';
  SET LOCAL ROLE authenticated;

  WITH upd AS (
    UPDATE public.submissions
       SET review_status = 'reviewed'
     WHERE content = 'probe-8 row (rolled back)'
    RETURNING 1
  )
  SELECT count(*) AS admin_rows_updated  -- EXPECT: >= 1
  FROM upd;
ROLLBACK;


-- ----------------------------------------------------------------------------
-- Probe 9 -- RLS DELETE, NON-admin  ->  EXPECT 0 rows deleted
--   DELETE is granted to authenticated (table-level), so no column-privilege error;
--   the RLS DELETE policy (USING is_allowed_admin() = false) is the sole reason 0
--   rows match. 0 affected ⇒ a non-admin cannot moderate-delete.
-- ----------------------------------------------------------------------------
BEGIN;
  INSERT INTO public.submissions (branch, topic, content)
    VALUES ('Gliwice', 'Pomysł', 'probe-9 row (rolled back)');

  SET LOCAL request.jwt.claims = '{"email":"notadmin@example.com"}';
  SET LOCAL ROLE authenticated;

  WITH del AS (
    DELETE FROM public.submissions
     WHERE content = 'probe-9 row (rolled back)'
    RETURNING 1
  )
  SELECT count(*) AS nonadmin_rows_deleted  -- EXPECT: 0
  FROM del;
ROLLBACK;


-- ----------------------------------------------------------------------------
-- Probe 10 -- RLS DELETE, ADMIN  ->  EXPECT >= 1 row deleted (then ROLLBACK)
--   Allow-listed principal deletes the seeded row; the surrounding ROLLBACK undoes
--   it so nothing persists. Proves the gate ADMITS admin deletes.
-- ----------------------------------------------------------------------------
BEGIN;
  INSERT INTO public.admin_allowlist (email)
    VALUES ('probe-admin@example.com')
    ON CONFLICT (email) DO NOTHING;
  INSERT INTO public.submissions (branch, topic, content)
    VALUES ('Gliwice', 'Pomysł', 'probe-10 row (rolled back)');

  SET LOCAL request.jwt.claims = '{"email":"probe-admin@example.com"}';
  SET LOCAL ROLE authenticated;

  WITH del AS (
    DELETE FROM public.submissions
     WHERE content = 'probe-10 row (rolled back)'
    RETURNING 1
  )
  SELECT count(*) AS admin_rows_deleted  -- EXPECT: >= 1
  FROM del;
ROLLBACK;


-- ----------------------------------------------------------------------------
-- Probe 11 -- column-grant backstop: authenticated UPDATE content  ->  EXPECT ERROR 42501
--   authenticated holds UPDATE only on (review_status). Writing `content` is not
--   granted, so the column-privilege check raises 42501 BEFORE RLS row filtering
--   even runs. Done as an ALLOW-LISTED admin on purpose: RLS would ADMIT the row,
--   so the column grant is provably the ONLY thing that blocks the write -- the
--   test-plan #3 backstop. (Same shape as Probe 3 for anon.)
--   *** The ERROR is the PASS condition. ***   Separate block: the error aborts
--   the transaction (Probe 3/6c precedent).
-- ----------------------------------------------------------------------------
BEGIN;
  INSERT INTO public.admin_allowlist (email)
    VALUES ('probe-admin@example.com')
    ON CONFLICT (email) DO NOTHING;
  INSERT INTO public.submissions (branch, topic, content)
    VALUES ('Gliwice', 'Pomysł', 'probe-11 row (rolled back)');

  SET LOCAL request.jwt.claims = '{"email":"probe-admin@example.com"}';
  SET LOCAL ROLE authenticated;

  UPDATE public.submissions
     SET content = 'pwned'
   WHERE content = 'probe-11 row (rolled back)';
  -- EXPECT: ERROR:  permission denied for table submissions   (SQLSTATE 42501)
ROLLBACK;
