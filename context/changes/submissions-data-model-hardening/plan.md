# Submissions data-model hardening — implementation plan

## Overview

Minimal, forward-only hardening of the submissions schema, scoped to the three findings that close real defects or complete an existing contract. One new SQL migration tightens two CHECK constraints (whitespace-only content; unbounded anon-writable signature); the taxonomy module gains the one missing list (`ENRICHMENT_STATUSES`). Two small phases, schema then TypeScript.

This plan was **trimmed from an earlier 6-phase / 15-finding version** after a finding-by-finding re-verification against the actual code (see `## What We're NOT Doing` and `## References`). The original plan is preserved in git history (commit `47afe76`).

## Current State Analysis

- Migration `supabase/migrations/20260528000000_create_submissions.sql` is applied to the local stack and to cloud project `ovwgoqhqbbgfodivwmwk`. `content` CHECK uses raw `char_length(content)` — accepts `'   '` (3 spaces) as valid. `signature` is `text NULL` with no length cap and is anon-INSERTable (grant at migration:135-136, RLS `WITH CHECK (true)` at :112-116).
- `src/lib/submissions/taxonomies.ts` exports `DEPARTMENTS`/`BRANCHES`/`TOPICS`/`TONES` (4 of the 5 CHECK lists). The 5th, `enrichment_status` (`pending|processing|done|failed`, migration:74-75), is not mirrored — the file's own header claims to be the single source of truth, so this is a coverage gap.
- `npm run typecheck` and `npm run build` currently pass (exit 0). `database.types.ts` is in sync with the live schema (verified byte-identical to a fresh `db:gen-types`).
- Cloud carries 2 smoke-test rows from the prior change's p1 verification (per `submissions-data-model/change.md`). They are dev artifacts, not production data.

## Desired End State

After this plan lands:

- A new migration `supabase/migrations/20260529000000_submissions_constraints_hardening.sql` is applied locally (`npm run db:reset`) and on cloud (`supabase db push`). It: (a) replaces the content CHECK with `char_length(btrim(content)) BETWEEN 1 AND 800` so whitespace-only content fails; (b) adds `submissions_signature_length_check` capping signature at 1–200 trimmed chars (NULL still allowed). No index changes, no data-changing statements.
- `src/lib/submissions/taxonomies.ts` additionally exports `ENRICHMENT_STATUSES` (as const) + the `EnrichmentStatus` type, mirroring `submissions_enrichment_status_check`.
- `npm run db:reset`, `npm run typecheck`, `npm run lint` (touched-file scope), `npm run build` all exit 0.

### Key Discoveries

- The new migration needs **no TRUNCATE**. Locally, `supabase db reset` applies migrations against an empty table before loading seed, so `ADD CONSTRAINT` validates against zero rows. On cloud, the 2 smoke rows have short non-empty `content` and NULL `signature`, so they satisfy the new constraints — `db push` succeeds without wiping anything. The 2 smoke rows, if you want them gone, are a one-off manual `DELETE` in Studio, decoupled from the migration (keeps the migration pure schema and safe to replay).
- `signature IS NULL OR char_length(btrim(signature)) BETWEEN 1 AND 200` intentionally also rejects an empty / whitespace-only signature — anonymity means "no signature" is `NULL`, not `''`. This is consistent with the content `btrim` rule. S-01's form must send `NULL`, not `''`, for the no-signature case.

## What We're NOT Doing

Trimmed from the original 6-phase plan after re-verification. Each dropped finding with its reason:

- **#9 (drop `submissions_created_at_desc_idx`) — DROPPED, the premise is false.** A composite index leading with `enrichment_status` cannot serve a bare `ORDER BY created_at DESC` (created_at is the 2nd column, not a prefix). The standalone index is NOT redundant. Recorded as `context/foundation/lessons.md` entry "A composite index doesn't serve ORDER BY on its non-leading column".
- **#10 (consolidate 6 INSERTs into a multi-row INSERT) — DROPPED, already done.** `supabase/seed.sql` is already a single multi-row INSERT (one column list, six tuples, one terminator).
- **#15 (bump supabase CLI 2.98→2.101 to fix `Omit<Database,'__InternalSupabase'>`) — DROPPED, not a bug.** `Omit<T,K>` allows `K = keyof any`, so omitting an absent key is a valid no-op; typecheck/build already pass. A CLI bump would trade zero benefit for generated-file diff noise (the original plan-review's own F1 flagged this). If a bump ever happens, it rides a deliberate dependency-maintenance change.
- **#6 (auth shared-client refit across 5 files) — DROPPED at MVP.** The stale-token mechanism is real but does NOT manifest in any current flow (signin/signup are pre-session mutations, signout is freshness-agnostic, the only protected route builds no second client). Highest blast radius in the original plan for zero realized benefit. Defer until S-02 introduces a per-request authenticated reader. Recorded conceptually via lessons "Don't harden a consumer that doesn't exist yet".
- **#7 (signout null-config parity) — DROPPED.** Real 3-line consistency nit, but only on a deploy-misconfig (dead-in-prod) branch. If wanted later, apply as a standalone null-guard — do NOT bundle it into the #6 refit.
- **#12 (5 type-guard helpers) — DEFERRED.** `taxonomies.ts` has zero importers today (S-01/S-02/F-03 unbuilt). Write each guard with its first real consumer. Note: this is a different concern from SQL↔TS drift detection (see impl-review F2) — neither substitutes for the other.
- **#4 (gen-types.mjs atomic-write script) — DEFERRED.** Real footgun (`>` truncates on CLI failure; header stripped each regen) but developer-only and `git restore` recovers instantly. Optional tooling polish for a separate change.
- **#13 (trim taxonomy header) — DROPPED.** Cosmetic; the header's two load-bearing caveats (diacritic drift, supabase/cli#1433) stay.
- **#11 (delete the prior change.md "Phase 2 adaptations" block) — DROPPED, net-negative.** That block is the only audit trail for why p2 verification deviated (Docker outage → cloud push). A per-change identity file is the right home for per-change incidents.
- **#5 / seed determinism (literal UUIDs, staggered timestamps) — DEFERRED.** No test runner asserts on seed ordering; production rows have distinct timestamps. If strict ordering ever matters, it's a query-layer tiebreaker (`ORDER BY created_at, id`), not a seed concern.
- **#8 / #14 — already captured as lessons** in `context/foundation/lessons.md` (no plan action needed).
- **No test runner, no pg ENUM migration, no `.gitattributes` CRLF fix** — all out of scope, as before.

## Implementation Approach

Two small, independently-verifiable phases. Phase 1 is a pure-schema forward-only migration (no data statements, no index changes). Phase 2 is a 2-line additive export. Verification mirrors the prior change: `npm run db:reset` + psql/Studio smoke for the schema; `astro check` / `npm run build` for the type surface.

## Phase 1: Schema constraint hardening

### Overview

New forward-only migration tightening the content and signature CHECK constraints. No index changes, no data-changing statements.

### Changes Required

#### 1. Hardening migration

**File**: `supabase/migrations/20260529000000_submissions_constraints_hardening.sql`

**Intent**: Forward-only follow-up to `20260528000000_create_submissions.sql`. Drop+recreate the content CHECK with `btrim` so whitespace-only content fails; add a signature length CHECK (signature is anon-writable + nullable; the cap closes the one unbounded anon-writable column).

**Contract**:
- Header comment names: change-id `submissions-data-model-hardening`, follow-up to `20260528000000`, date `2026-05-29`, findings closed (#1 content trim, #2 signature cap). Also notes: no TRUNCATE (constraints validate against the existing rows, which satisfy them); smoke-row cleanup, if desired, is a manual one-off in Studio.
- `ALTER TABLE public.submissions DROP CONSTRAINT submissions_content_length_check;`
- `ALTER TABLE public.submissions ADD CONSTRAINT submissions_content_length_check CHECK (char_length(btrim(content)) BETWEEN 1 AND 800);`
- `ALTER TABLE public.submissions ADD CONSTRAINT submissions_signature_length_check CHECK (signature IS NULL OR char_length(btrim(signature)) BETWEEN 1 AND 200);`
- No GRANT/REVOKE, no DROP INDEX, no TRUNCATE.

### Success Criteria

#### Automated Verification

- Migration applies locally: `npm run db:reset` exits 0 with no `ERROR:` lines (and the 6 seed rows still load — they satisfy the new constraints).
- New constraints present: `docker exec supabase_db_10x-astro-starter psql -U postgres -d postgres -c "\d+ public.submissions"` lists `submissions_content_length_check` (with `btrim`) and `submissions_signature_length_check`.
- Index unchanged (sanity — we did NOT drop it): the same `\d+` output still lists `submissions_created_at_desc_idx`.
- `npm run lint` exits 0 (no TS touched in this phase; touched-file scope).

#### Manual Verification

- Local Studio SQL: `INSERT INTO public.submissions (department, branch, topic, content) VALUES ('HR','Centrala','Pomysł','   ');` fails with `submissions_content_length_check`.
- Local Studio SQL: `INSERT INTO public.submissions (department, branch, topic, content, signature) VALUES ('HR','Centrala','Pomysł','test', repeat('x',201));` fails with `submissions_signature_length_check`.
- Cloud: before `supabase db push`, confirm existing cloud rows satisfy the new constraints (`SELECT count(*) FROM public.submissions WHERE char_length(btrim(content)) NOT BETWEEN 1 AND 800 OR (signature IS NOT NULL AND char_length(btrim(signature)) NOT BETWEEN 1 AND 200);` returns 0); then push. Optionally `DELETE` the 2 smoke rows manually first.

**Implementation Note**: After automated checks pass, pause for manual confirmation before Phase 2. The cloud `supabase db push` must be confirmed by the human.

---

## Phase 2: Taxonomy module — add ENRICHMENT_STATUSES

### Overview

Add the one missing taxonomy list so `taxonomies.ts` mirrors all five CHECK constraints. Additive only.

### Changes Required

#### 1. Taxonomy const + type

**File**: `src/lib/submissions/taxonomies.ts`

**Intent**: Complete the file's stated single-source-of-truth contract. `enrichment_status` is the column F-03's state machine pivots on; a typed const is what downstream transitions narrow against.

**Contract**:
- Existing exports unchanged.
- New: `export const ENRICHMENT_STATUSES = ['pending', 'processing', 'done', 'failed'] as const;` — values identical to `submissions_enrichment_status_check` in `20260528000000_create_submissions.sql`.
- New: `export type EnrichmentStatus = (typeof ENRICHMENT_STATUSES)[number];`
- Header left as-is (its diacritic-drift and supabase/cli#1433 caveats are load-bearing).

### Success Criteria

#### Automated Verification

- `npm run typecheck` exits 0.
- `npx eslint src/lib/submissions/taxonomies.ts` returns 0 errors.
- `npm run build` exits 0.
- `grep -c "ENRICHMENT_STATUSES" src/lib/submissions/taxonomies.ts` returns ≥ 1.

#### Manual Verification

- In a scratch `.ts`, `EnrichmentStatus` narrows to the 4-value union (IntelliSense), and an out-of-set literal is a type error.

**Implementation Note**: After automated checks pass, pause for manual confirmation before declaring the hardening done.

---

## Testing Strategy

No test runner is installed (out of scope). Correctness is verified per phase via `npm run db:reset` + psql/Studio smoke (Phase 1) and `astro check` (Phase 2). Manual steps: run the two failing INSERTs (Phase 1 Manual Verification); confirm `EnrichmentStatus` narrows in a scratch file (Phase 2).

## Performance Considerations

None. No index changes; two CHECK constraints add negligible per-INSERT cost at MVP scale.

## Migration Notes

Phase 1's migration is forward-only and additive (DROP+ADD CONSTRAINT, ADD CONSTRAINT). It contains no data statements, so it is safe to replay against a populated table. A future revert is a trivial inverse migration (re-add the raw content CHECK, drop the signature CHECK) — not pre-generated.

## References

- Trim rationale: finding-by-finding re-verification (8-agent cross-check) reconciling this hardening against `context/changes/submissions-data-model/reviews/impl-review.md`. Kept #1/#2/#3; dropped #9/#10/#15 (invalid), #6/#7/#12/#4/#13/#11/#5 (premature or cosmetic).
- Recurring rules surfaced: `context/foundation/lessons.md` (6 entries, incl. the composite-index, partial-index, and baseline-grant lessons that replace findings #9/#14/#8).
- Original migration: `supabase/migrations/20260528000000_create_submissions.sql`
- PRD: `context/foundation/prd.md` (FR-002 employee submission body, NFR anonymity — both load-bearing for the signature cap).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema constraint hardening

#### Automated

- [x] 1.1 `npm run db:reset` exits 0 with no `ERROR:` lines; 6 seed rows load. — cf692fc
- [x] 1.2 `\d+ public.submissions` lists `submissions_content_length_check` (with btrim) and `submissions_signature_length_check`. — cf692fc
- [x] 1.3 `\d+ public.submissions` still lists `submissions_created_at_desc_idx` (index NOT dropped). — cf692fc
- [x] 1.4 `npm run lint` exits 0 (touched-file scope). — cf692fc

#### Manual

- [x] 1.5 Whitespace-only content INSERT fails with `submissions_content_length_check`. — cf692fc
- [x] 1.6 Oversize signature (201 chars) INSERT fails with `submissions_signature_length_check`. — cf692fc
- [x] 1.7 Cloud: existing rows satisfy new constraints; `supabase db push` succeeds (human-confirmed). — cf692fc

### Phase 2: Taxonomy module — add ENRICHMENT_STATUSES

#### Automated

- [x] 2.1 `npm run typecheck` exits 0. — 5e69b09
- [x] 2.2 `npx eslint src/lib/submissions/taxonomies.ts` returns 0 errors. — 5e69b09
- [x] 2.3 `npm run build` exits 0. — 5e69b09
- [x] 2.4 `grep -c "ENRICHMENT_STATUSES" src/lib/submissions/taxonomies.ts` returns ≥ 1. — 5e69b09

#### Manual

- [x] 2.5 `EnrichmentStatus` narrows to the 4-value union in a scratch file; out-of-set literal is a type error. — 5e69b09
