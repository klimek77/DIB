-- Migration: submissions constraint hardening (forward-only follow-up)
-- Change-id: submissions-data-model-hardening
-- Follow-up to: 20260528000000_create_submissions.sql
-- Date: 2026-05-29
--
-- Findings closed:
--   #1 content trim  — raw char_length(content) accepted whitespace-only
--                       bodies ('   '); btrim() makes them fail.
--   #2 signature cap — signature is the one anon-writable column without a
--                       length bound; cap it at 1..200 trimmed chars.
--
-- No TRUNCATE: these are pure schema statements. Locally db reset applies
-- migrations against an empty table before seeding; on cloud each ADD
-- CONSTRAINT validates against existing rows and fails closed (rolls back)
-- if any row violates it — it cannot silently corrupt data. The pre-apply
-- check returned 0 violating rows, so the ADDs pass without touching data.
-- Smoke-row cleanup, if desired, is a manual one-off
-- in Studio — deliberately decoupled so this migration stays safe to replay.
--
-- No GRANT/REVOKE, no DROP INDEX. The composite index does not serve a bare
-- ORDER BY created_at DESC, so the standalone index stays (see lessons.md).

-- #1: whitespace-only content must fail. Drop the raw-length CHECK, re-add it
-- over the trimmed value.
ALTER TABLE public.submissions
    DROP CONSTRAINT submissions_content_length_check;

ALTER TABLE public.submissions
    ADD CONSTRAINT submissions_content_length_check
    CHECK (char_length(btrim(content)) BETWEEN 1 AND 800);

-- #2: cap the anon-writable signature. NULL stays allowed (anonymity =
-- "no signature" is NULL, not ''); an empty/whitespace-only signature is
-- rejected, consistent with the content btrim rule.
ALTER TABLE public.submissions
    ADD CONSTRAINT submissions_signature_length_check
    CHECK (signature IS NULL OR char_length(btrim(signature)) BETWEEN 1 AND 200);
