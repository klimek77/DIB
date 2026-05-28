# Submissions data model — implementation plan

## Overview

Foundation schema for the digital-idea-box submissions store. One migration creates the `submissions` table with form fields, AI-enrichment fields, a 4-state enrichment lifecycle, CHECK constraints sourced from a single TypeScript taxonomy module, indices for the dashboard queries, and RLS policies (anon column-restricted INSERT, authenticated SELECT). A second pass generates `database.types.ts`, threads the `Database` generic through the existing Supabase client, and adds the npm scripts the rest of the workflow (S-01, S-02, F-03) will lean on. No API endpoint, no UI, no auth refit — F-01 is purely the data contract S-01 writes against, S-02 reads from, and F-03 mutates with enrichment results.

## Current State Analysis

- `supabase/config.toml` declares Postgres 17 (`db.major_version = 17`), `db.migrations.enabled = true`, `schema_paths = []` (default migrations directory at `supabase/migrations/`), `db.seed.sql_paths = ["./seed.sql"]`. No `supabase/migrations/` directory exists yet, no `seed.sql`, no `database.types.ts`.
- `src/lib/supabase.ts:9` calls `createServerClient<...>` without a `Database` generic — every query currently returns `any`.
- `astro.config.mjs:17-22` declares `SUPABASE_URL` and `SUPABASE_KEY` (server-side, secret, optional). F-01 does not change env shape; F-03 will add `SUPABASE_SERVICE_ROLE_KEY` when the consumer Worker arrives.
- `src/middleware.ts:4` route-guards `/dashboard` via `context.locals.user`. F-02 will refit to magic-link auth; F-01's RLS is intentionally aligned so F-02 can land without re-touching policies.
- `package.json` exposes `dev`, `build`, `preview`, `astro`, `lint`, `lint:fix`, `format`. No `typecheck`, no `db:gen-types`, no `db:reset`. Local CLIs available: `supabase` 2.98.2 (`node_modules/.bin/supabase`), `tsc` (via TypeScript devDep), `astro`.
- The example CSV at `context/foundation/DIB_example_database.csv` (45 rows) is the empirical source for: the four-value topic taxonomy, the three-value tone taxonomy, the 11-department list, the 9-branch list, and a workable seed-data shape (5–10 rows hand-picked for local dev).
- No test runner is installed (no `tests/` directory, no `vitest` / `playwright` deps). F-01 verification relies on `astro check` / `tsc --noEmit` for types and Supabase Studio + `psql` for schema/RLS smoke checks. Adding a test runner is out of scope.

## Desired End State

After this plan lands:

- `supabase db reset` applies one migration that produces a `public.submissions` table with: `id uuid PK`, `created_at timestamptz`, four required user-input columns (`department`, `branch`, `topic`, `content`) plus optional `signature`, four enrichment-lifecycle columns (`enrichment_status`, `enrichment_attempts`, `enrichment_last_error`, `enrichment_attempted_at`), four AI-output columns (`ai_title`, `ai_tone`, `ai_classification`, `ai_summary`), six CHECK constraints sourcing values from the TS taxonomy module, four indices sized for the dashboard queries, RLS enabled with one anon-INSERT policy and one authenticated-SELECT policy, plus column-level INSERT grants that prevent anon from writing enrichment fields.
- `src/lib/submissions/taxonomies.ts` is the single source of truth for the taxonomy values; the migration's CHECK lists mirror it character-for-character.
- `src/lib/database.types.ts` is generated and committed; `src/lib/supabase.ts` types `createServerClient<Database>` so every downstream query returns typed rows.
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run db:reset`, `npm run db:gen-types` all exit 0.
- Verification of RLS behavior is recorded in the manual smoke-check steps below; downstream changes (S-01, S-02, F-03) consume the result without re-deriving it.

### Key Discoveries

- The CSV resolves PRD Open Question Q7 (tone shape) — the live taxonomy is exactly three values: `Pozytywny`, `Negatywny`, `Neutralny`. Lock it in CHECK.
- The CSV also resolves the PRD ambiguity in FR-003 ("dział/oddział") — two distinct fields are needed, because FR-012's aggregation is by branch (`Oddział`) while FR-003's required selector is by department (`Dział`). Both are required at INSERT.
- The CSV's topic set (`Pomysł / Problem / Usprawnienie / Inne`) differs from the PRD's set (`pomysł / zgłoszenie / propozycja / błąd / skarga`). Decision: follow the CSV taxonomy (empirical evidence of company usage). A footnote update to the PRD's FR-003 / FR-011 wording is needed in a follow-up — captured in `## What We're NOT Doing` below.
- `wrangler.jsonc` shows `observability: { enabled: true }` and Workers Observability is already in use — `wrangler tail` works against deployed Workers. F-01 does not consume this; F-03 will.
- Postgres column-level INSERT grants (`GRANT INSERT (col1, col2) ON table TO anon`) are the canonical way to prevent anon from writing the enrichment fields. RLS policies cannot restrict columns; only role grants can. This is load-bearing for the PRD's twardo-anonimowa guardrail.
- Supabase generates the `Database` TypeScript shape from the live database; the `enrichment_status` column will materialize as `string` in the generated types because Postgres CHECK constraints (unlike `CREATE TYPE ... AS ENUM`) don't expose discriminated unions through the introspection path. The `as const` taxonomy module fills this gap at the application layer.

## What We're NOT Doing

- **No API endpoint** for inserting submissions — that's S-01's job. F-01 only proves anon INSERT works via Studio / `psql`.
- **No employee form UI** — S-01.
- **No admin dashboard UI or queries** — S-02. F-01 only proves authenticated SELECT works.
- **No magic-link auth refit** — F-02. F-01 keeps the current `email+password` auth in place; the admin SELECT RLS only requires `auth.uid() IS NOT NULL`, which F-02 will tighten with an allow-list at the middleware layer.
- **No AI enrichment, no queue, no consumer Worker** — F-03. F-01 only writes the columns the consumer will fill.
- **No retention cron** — out of MVP scope per PRD Open Question Q2 (DPO TBD). The `created_at` column is enough; a future cron uses it.
- **No PRD update** in this change. The CSV-driven topic taxonomy diverges from PRD wording; a small follow-up change should update PRD FR-003 and FR-011 to match. Out of scope for this plan; logged in `change.md`.
- **No test runner introduction** (`vitest`, `playwright`, etc.). The project has no test infrastructure; bringing it in is a separate change.
- **No `SUPABASE_SERVICE_ROLE_KEY` env wiring.** F-03 needs it; F-01 does not.
- **No `compatibility_date` bump in `wrangler.jsonc`.** Per `infrastructure.md` risk register — never bumped outside a planned dep-review PR.

## Implementation Approach

Single migration, single TypeScript taxonomy module, two phases. The migration is the load-bearing artifact; the TS module is the application-side mirror of the same taxonomy lists. Both are committed in lock-step: a change to one without the other is a contract violation that downstream code reviews must catch.

Anonymity is enforced at three layers, intentionally redundant: (1) **schema absence** — no `ip_address`, no `user_agent`, no `session_id`, no `submitter_user_id` columns; (2) **column grants** — anon can only INSERT into user-input columns, never the enrichment columns; (3) **RLS** — authenticated-SELECT requires `auth.uid() IS NOT NULL`. F-02 layers a fourth check (allow-list) on top at the middleware level.

The enrichment-lifecycle state machine (`pending → processing → done | failed`) is owned by F-03's consumer Worker. F-01 ships the columns and the default (`enrichment_status DEFAULT 'pending'`), nothing more. The dashboard's FR-008 "hide pending submissions" reduces to a `WHERE enrichment_status = 'done'` clause that S-02 writes; F-01 makes that clause cheap with a composite index.

## Critical Implementation Details

- **Column grants override default Supabase role baseline.** Supabase pre-grants permissions to `anon` and `authenticated` on tables in `public` by default. The migration must `REVOKE ALL ON public.submissions FROM anon, authenticated` *before* granting the narrow set, otherwise anon retains the ability to write any column. Order matters: REVOKE → GRANT (anon insert columns) → GRANT (authenticated select). **The migration SQL header comment must explain why the REVOKE is load-bearing today**: Supabase's auto-grant default for new tables in `public` flipped 2026-05-30 for new projects, but existing projects (this one) keep auto-grant until 2026-10-30 (changelog #45329). Without that header note, a future reader in 2027+ may see the REVOKE, assume defaults have changed and remove it — silently leaking anon INSERT permissions on enrichment columns.
- **RLS policies + column grants are AND-ed, not OR-ed.** An anon INSERT must satisfy both the policy WITH CHECK and the column grant. Anon trying to write `enrichment_status` fails the column-grant check before RLS even runs.
- **Postgres CHECK constraints on `text` columns store the literal Polish strings with diacritics.** The migration's CHECK lists must use exact UTF-8 strings (`'Sprzedaż'`, `'Księgowość'`, `'Oświęcim'`). The TS const in `taxonomies.ts` must do the same — diacritic drift between the two breaks INSERTs silently in production.
- **`supabase gen types typescript` requires the local Supabase stack to be running** (`supabase start`). The `db:gen-types` script assumes Postgres is reachable at `db.port = 54322`. Document this in the script comment.

## Phase 1: Migration + RLS + column grants + seed

### Overview

Author the first SQL migration. The file defines the table, six CHECK constraints, four indices, RLS enablement + two policies, role grant adjustments (REVOKE + narrow GRANTs), and a `seed.sql` with 5–10 rows derived from the CSV to make local-dev productive for downstream changes.

### Changes Required

#### 1. Submissions migration

**File**: `supabase/migrations/20260528000000_create_submissions.sql`

**Intent**: Create `public.submissions` with all columns, CHECK constraints sourced from the CSV taxonomy, indices for FR-010/011/012/013 queries, RLS policies, and column-level role grants. This is the load-bearing schema artifact; every downstream change reads or writes against it.

**Contract**:
- Table `public.submissions` with columns (in order): `id uuid PK DEFAULT gen_random_uuid()`, `created_at timestamptz NOT NULL DEFAULT now()`, `department text NOT NULL`, `branch text NOT NULL`, `topic text NOT NULL`, `content text NOT NULL`, `signature text NULL`, `enrichment_status text NOT NULL DEFAULT 'pending'`, `enrichment_attempts integer NOT NULL DEFAULT 0`, `enrichment_last_error text NULL`, `enrichment_attempted_at timestamptz NULL`, `ai_title text NULL`, `ai_tone text NULL`, `ai_classification text NULL`, `ai_summary text NULL`.
- CHECK constraints (named, for migration-history clarity):
  - `submissions_department_check` — `department IN ('Sprzedaż','Handlowy','Magazyn','HR','Księgowość','Sekretariat','IT','Operacyjny','Media','Segment Konstrukcji','Segment Dachy')`
  - `submissions_branch_check` — `branch IN ('Gliwice','Tarnowskie Góry','Oświęcim','Sosnowiec','Katowice','Dąbrowa Górnicza','Chrzanów','Centrala','Supermarket Dobromir')`
  - `submissions_topic_check` — `topic IN ('Pomysł','Problem','Usprawnienie','Inne')`
  - `submissions_content_length_check` — `char_length(content) BETWEEN 1 AND 800`
  - `submissions_enrichment_status_check` — `enrichment_status IN ('pending','processing','done','failed')`
  - `submissions_ai_tone_check` — `ai_tone IS NULL OR ai_tone IN ('Pozytywny','Negatywny','Neutralny')`
- Indices: `submissions_created_at_desc_idx ON (created_at DESC)`, `submissions_enrichment_status_created_at_idx ON (enrichment_status, created_at DESC)`, `submissions_topic_done_idx ON (topic) WHERE enrichment_status = 'done'`, `submissions_branch_done_idx ON (branch) WHERE enrichment_status = 'done'`.
- RLS: `ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;` plus policies `submissions_anon_insert` (FOR INSERT TO anon WITH CHECK (true)) and `submissions_authenticated_select` (FOR SELECT TO authenticated USING (true)). The "true" predicates are intentional — column grants do the column-level restriction; RLS does the row-level restriction (none required here beyond role).
- Role grants (must run AFTER the table exists and BEFORE the migration ends): `REVOKE ALL ON public.submissions FROM anon, authenticated; GRANT INSERT (department, branch, topic, content, signature) ON public.submissions TO anon; GRANT SELECT ON public.submissions TO authenticated; GRANT USAGE ON SCHEMA public TO anon, authenticated;` (schema USAGE may already be granted by the Supabase baseline but re-asserting is harmless).
- A header comment in the SQL file naming the change-id (`submissions-data-model`) and the PRD/roadmap references (`F-01`, FR-001..018 touchpoints), PLUS a paragraph explaining why the `REVOKE ALL ON public.submissions FROM anon, authenticated` is load-bearing today (Supabase default-grants behavior for new tables in `public` — auto-granted on existing projects until 2026-10-30 per changelog #45329; without REVOKE the narrow GRANTs that follow are not constraining).

#### 2. Seed data for local dev

**File**: `supabase/seed.sql`

**Intent**: Populate 6 representative rows derived from the CSV so local-dev work on S-02 (dashboard aggregates) and downstream UI work has realistic data. Six rows: 5 in `enrichment_status = 'done'` with all AI fields populated (covering each topic and each tone at least once), 1 in `enrichment_status = 'pending'` with no AI fields (proves the FR-008 invisibility default works).

**Contract**: Six `INSERT INTO public.submissions (...) VALUES (...);` statements. Source rows from the CSV: SUG-4 (Pomysł / Sprzedaż / Gliwice / Pozytywny), SUG-5 (Problem / Magazyn / Oświęcim / Negatywny), SUG-3 (Usprawnienie / HR / Sosnowiec / Negatywny), SUG-25 (Usprawnienie / Operacyjny / Chrzanów / Neutralny), SUG-14 (Inne / Magazyn / Oświęcim / Pozytywny). Plus one synthetic `enrichment_status = 'pending'` row for the invisibility case (Pomysł / IT / Katowice, no signature, no AI fields). Use the CSV's `Tytuł wpisu` → `ai_title`, `Parafraza` → `ai_summary`, `Sentyment` → `ai_tone`, `Sugerowany proces` → `ai_classification`, `Treść` → `content`. For the 5 enriched rows set `enrichment_attempts = 1`, `enrichment_attempted_at = created_at + interval '1 minute'`.

#### 3. Supabase config alignment

**File**: `supabase/config.toml`

**Intent**: Confirm the existing config picks up the new migration and seed without edits. No file changes expected — `schema_paths = []` already uses `supabase/migrations/` by default, and `db.seed.sql_paths = ["./seed.sql"]` already points at the seed.

**Contract**: Read-only inspection. If any edit becomes necessary during implementation (e.g., explicit `schema_paths`), document it as a deviation in commit message.

### Success Criteria

#### Automated Verification

- Migration applies cleanly: `npx supabase db reset` exits 0 and prints no `ERROR:` lines.
- Schema dump confirms structure: `npx supabase db dump --local --data-only=false` includes the `submissions` table with all 15 columns, 6 CHECK constraints, 4 indices, RLS enabled, and 2 policies.
- Seed loads: after `db reset`, `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "SELECT count(*) FROM public.submissions"` returns 6.
- Lint clean for any non-SQL files touched: `npm run lint` exits 0.

#### Manual Verification

- In Supabase Studio (`http://127.0.0.1:54323`, Table Editor → submissions), the 6 seed rows are visible with the expected topic/tone/branch values.
- In Studio SQL editor, running `SET ROLE anon; INSERT INTO public.submissions (department, branch, topic, content) VALUES ('HR', 'Centrala', 'Pomysł', 'test');` succeeds.
- Running `SET ROLE anon; INSERT INTO public.submissions (department, branch, topic, content, enrichment_status) VALUES ('HR', 'Centrala', 'Pomysł', 'test', 'done');` fails with a column-grant or RLS error (the anon role cannot write `enrichment_status`).
- Running `SET ROLE anon; SELECT count(*) FROM public.submissions;` returns 0 (RLS blocks).
- Running `SET ROLE authenticated; SELECT count(*) FROM public.submissions;` returns 6 (RLS allows).
- Running `INSERT INTO public.submissions (department, branch, topic, content) VALUES ('HR', 'Centrala', 'NotATopic', 'test');` (as postgres role) fails with `submissions_topic_check` violation — confirms CHECK is live.
- Running an INSERT with 801 characters of content fails with `submissions_content_length_check`.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to Phase 2.

---

## Phase 2: TypeScript taxonomy module + types generation + typed Supabase client

### Overview

Mirror the migration's CHECK lists in a TypeScript module, generate `database.types.ts` from the running Supabase stack, thread the `Database` generic into `createServerClient`, and add the three npm scripts the rest of the workflow leans on (`typecheck`, `db:gen-types`, `db:reset`).

### Changes Required

#### 1. Taxonomy module

**File**: `src/lib/submissions/taxonomies.ts`

**Intent**: Single source of truth for the four taxonomy lists (departments, branches, topics, tones) the form and the DB share. The values must character-for-character match the migration's CHECK constraints. Future migrations adding/removing values must update this file in the same commit.

**Contract**: Export four `as const` arrays of literal strings (`DEPARTMENTS`, `BRANCHES`, `TOPICS`, `TONES`) plus their corresponding type aliases (`Department`, `Branch`, `Topic`, `Tone`) derived via `typeof X[number]`. Values: identical to the CHECK lists in the migration above. A short file-header comment names the migration the lists mirror.

**Downstream-consumer contract**: All consumers of these fields (S-01 form code, S-02 dashboard queries, F-03 consumer Worker) MUST import the type aliases from this module for narrow typing — e.g. `import { type Topic } from "@/lib/submissions/taxonomies"`. Do NOT rely on `Database['public']['Tables']['submissions']['Row']['topic']` for narrow types: `supabase gen types typescript` falls back to plain `string` for `text + CHECK` columns (supabase/cli#1433 still open). The `Row` types are correct for query results; the `as const` taxonomy types are correct for narrowing.

#### 2. Generated database types

**File**: `src/lib/database.types.ts`

**Intent**: Generated TypeScript representation of the `public` schema. Produced by `npx supabase gen types typescript --local --schema public`. Committed verbatim — never hand-edited.

**Contract**: Standard `supabase gen types` output. Must include `Database['public']['Tables']['submissions']` with `Row`, `Insert`, `Update` types. Regenerating must produce the same file (idempotent given the schema). File-header comment must include the `// @generated` marker so reviewers know not to edit it by hand.

#### 3. Typed Supabase client

**File**: `src/lib/supabase.ts`

**Intent**: Thread the `Database` generic through `createServerClient` so every downstream call returns typed rows. No runtime change — purely a TypeScript signature improvement.

**Contract**: `import type { Database } from "@/lib/database.types";` plus `createServerClient<Database>(SUPABASE_URL, SUPABASE_KEY, { ... })`. The function's return type changes from `SupabaseClient<any, ...>` to `SupabaseClient<Database, 'public', ...>`. No call site needs to update — narrower return type is structurally compatible.

#### 4. Package scripts

**File**: `package.json`

**Intent**: Add three workflow scripts so contributors (and future agents) don't need to remember the exact CLI invocations. `typecheck` runs `tsc --noEmit` (uses the installed TypeScript devDep); `db:gen-types` writes `src/lib/database.types.ts` from the running local stack; `db:reset` re-runs the full migration + seed flow.

**Contract**: Three new entries under `"scripts"`:
- `"typecheck": "astro check"`
- `"db:gen-types": "supabase gen types typescript --local --schema public > src/lib/database.types.ts"`
- `"db:reset": "supabase db reset"`

`astro check` (powered by `@astrojs/check ^0.9.8` already in `package.json`) is preferred over `tsc --noEmit` because it validates `.astro` template expressions in addition to `.ts` files — Phase 2's manual verification step 2.7 explicitly exercises an `.astro` import.

Each script must be runnable via `npm run <name>` from the repo root. `db:gen-types` and `db:reset` require the local Supabase stack to be running (`npm run db:start` does NOT exist — contributors run `supabase start` once per machine).

### Success Criteria

#### Automated Verification

- `npm run typecheck` exits 0.
- `npm run lint` exits 0.
- `npm run build` (Astro build) exits 0 — proves the threaded `Database` generic doesn't break any downstream import.
- `npm run db:gen-types` produces a `src/lib/database.types.ts` that contains the string `submissions:` in the `Tables` block (smoke check for completeness).
- `git diff src/lib/database.types.ts` is empty after a second run of `npm run db:gen-types` (idempotency).

#### Manual Verification

- Opening `src/lib/database.types.ts` shows a `Database` type with `public.Tables.submissions.Row` matching the 15 columns from the migration.
- In a scratch `.astro` file, typing `supabase!.from('submissions').select('*')` (where `supabase` came from `createClient(...)`) returns rows typed with the new columns — IntelliSense shows `enrichment_status`, `ai_title`, etc.
- Attempting `supabase!.from('submissions').select('does_not_exist')` produces a TypeScript error at build time.
- The `@generated` comment is present at the top of `src/lib/database.types.ts` so reviewers don't touch it.

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before declaring F-01 done. F-01 unblocks F-03 and S-01 — both will start consuming `Database` and the taxonomy module immediately.

---

## Testing Strategy

### Unit Tests

Not applicable — no test runner installed, F-01 introduces none. Schema correctness is verified by the migration applying cleanly and the manual smoke checks above.

### Integration Tests

Same — see above. F-03 and S-01 will need integration tests against the schema once a test runner lands (separate change).

### Manual Testing Steps

1. `supabase start` (one-time per machine setup).
2. `npm run db:reset` — confirm exit 0, six seed rows loaded.
3. Open Supabase Studio (`http://127.0.0.1:54323`), Table Editor → submissions, verify 6 rows with expected taxonomy values.
4. Studio → SQL editor, run the role-based INSERT/SELECT checks from Phase 1 manual verification.
5. `npm run db:gen-types` — confirm `src/lib/database.types.ts` produced.
6. `npm run typecheck` — confirm exit 0.
7. `npm run build` — confirm exit 0 (the typed client passes through the build).

## Performance Considerations

At MVP scale (~270 employees, projected low qps, small data volume per `prd.md` frontmatter), the four indices are sized for the dashboard queries S-02 will write:
- `created_at DESC` for the time-range counter (FR-010).
- `(enrichment_status, created_at DESC)` composite for the FR-008-filtered list (`WHERE enrichment_status = 'done' ORDER BY created_at DESC`).
- Partial indices on `topic` and `branch` filtered by `enrichment_status = 'done'` keep the indexed set small while supporting FR-011 (topic pie chart) and FR-012 (branch group-by).

No expected hotspots — Postgres handles this row volume trivially.

## Migration Notes

This is the first migration. There is no prior schema to migrate; `supabase db reset` will run it from a clean state. Downstream changes (F-02, F-03, S-01) will add their own migrations on top — the next migration file should be named `20260529000000_*.sql` or later, never reordering this one.

## References

- Roadmap: `context/foundation/roadmap.md` — F-01 row (`submissions-data-model`).
- PRD: `context/foundation/prd.md` — Business Logic, Access Control, NFR (anonymity + retention), FR-001..018.
- Tech stack: `context/foundation/tech-stack.md` — Astro 6 + Cloudflare Workers + Supabase.
- Infrastructure: `context/foundation/infrastructure.md` — risk register (Supabase Set-Cookie quirks deferred to F-02, AI enrichment async pattern deferred to F-03).
- Example data: `context/foundation/DIB_example_database.csv` — source of taxonomy values and seed-row content.
- Existing files touched: `src/lib/supabase.ts`, `package.json`, `supabase/config.toml` (no change expected).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Migration + RLS + column grants + seed

#### Automated

- [x] 1.1 Migration applies cleanly: `npx supabase db reset` exits 0 and prints no `ERROR:` lines. — 14f2871
- [x] 1.2 Schema dump confirms structure: `npx supabase db dump --local --data-only=false` includes the `submissions` table with all 15 columns, 6 CHECK constraints, 4 indices, RLS enabled, and 2 policies. — 14f2871
- [ ] 1.3 Seed loads: `psql ... -c "SELECT count(*) FROM public.submissions"` returns 6.
- [x] 1.4 Lint clean: `npm run lint` exits 0. — 14f2871

#### Manual

- [ ] 1.5 In Supabase Studio, the 6 seed rows are visible with expected topic/tone/branch values.
- [x] 1.6 Anon INSERT into allowed columns succeeds. — 14f2871
- [x] 1.7 Anon INSERT attempting to set `enrichment_status` fails (column-grant violation). — 14f2871
- [x] 1.8 Anon SELECT returns 0 rows (RLS blocks). — 14f2871
- [ ] 1.9 Authenticated SELECT returns 6 rows (RLS allows).
- [x] 1.10 INSERT with invalid topic value fails with `submissions_topic_check` violation. — 14f2871
- [x] 1.11 INSERT with 801-character content fails with `submissions_content_length_check`. — 14f2871

### Phase 2: TypeScript taxonomy module + types generation + typed Supabase client

#### Automated

- [ ] 2.1 `npm run typecheck` exits 0.
- [ ] 2.2 `npm run lint` exits 0.
- [ ] 2.3 `npm run build` exits 0.
- [ ] 2.4 `npm run db:gen-types` produces `src/lib/database.types.ts` containing `submissions:` in the `Tables` block.
- [ ] 2.5 `git diff src/lib/database.types.ts` is empty after a second run of `npm run db:gen-types` (idempotency).

#### Manual

- [ ] 2.6 Generated `Database` type's `public.Tables.submissions.Row` matches the 15 columns.
- [ ] 2.7 In a scratch `.astro`, `supabase.from('submissions').select('*')` returns rows typed with the new columns (IntelliSense check).
- [ ] 2.8 Selecting a non-existent column produces a TypeScript error.
- [ ] 2.9 The `@generated` comment is present at the top of `src/lib/database.types.ts`.
