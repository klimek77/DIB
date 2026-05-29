# Submissions data-model hardening — implementation plan

## Overview

Forward-only hardening of the submissions schema and surrounding TypeScript / build / auth surfaces, driven by 15 findings from the `/simplify` review of the original `submissions-data-model` change. One new SQL migration tightens constraints (whitespace-only content, signature length cap) and drops a redundant index; the taxonomy module gains the missing `ENRICHMENT_STATUSES` list and narrow-type guards; `db:gen-types` is rewritten as a Node script with atomic write + `@generated` header prepend; the auth-cookie path is refit to a shared client via `context.locals.supabase` so middleware-driven token refresh stays visible to route handlers; the prior change's identity file is trimmed and the truly reusable patterns flow into `context/foundation/lessons.md`. Six phases, isolated by surface area, with the riskiest (auth wrapper) deliberately last.

## Current State Analysis

- Migration `supabase/migrations/20260528000000_create_submissions.sql` is applied to both the local stack (after `npm run db:reset`) and to cloud project `ovwgoqhqbbgfodivwmwk` (via `supabase db push`). Existing constraints: `content` CHECK uses raw `char_length(content)` — accepts `'   '` (3 spaces) as valid; `signature` is `text NULL` with no length cap.
- Indices on `public.submissions`: four total. `submissions_created_at_desc_idx ON (created_at DESC)` is a prefix of the composite `submissions_enrichment_status_created_at_idx ON (enrichment_status, created_at DESC)`, so the planner already serves time-range ORDER BY queries from the composite; the standalone single-column index is wasted write cost.
- Cloud carries 2 smoke-test rows from p1 verification (per `submissions-data-model/change.md`); local stack is post-`db:reset` clean before each session.
- `supabase/seed.sql:5-89` writes 6 rows via 6 separate `INSERT INTO ... VALUES (...)` statements. UUIDs are `gen_random_uuid()` (non-deterministic across resets); three rows share `'2026-03-17 16:07:00+00'`; each enriched row copy-pastes the column list.
- `src/lib/submissions/taxonomies.ts:17-46` exports `DEPARTMENTS`/`BRANCHES`/`TOPICS`/`TONES` (4 of the 5 CHECK lists). `enrichment_status` (`pending|processing|done|failed`) is absent. No type-guard helpers exist; Row-side narrowing for `text + CHECK` columns is `string` (gen-types fallback for non-ENUM columns — supabase/cli#1433).
- `src/lib/database.types.ts:1-3` carries a hand-prepended `// @generated` header. `package.json:14` script `"db:gen-types": "supabase gen types typescript --local --schema public > src/lib/database.types.ts"` overwrites the file with raw CLI output — every regen strips the header AND a CLI failure (Docker offline) truncates the file. Lockfile pins `supabase` CLI at `2.98.2`; `db:reset` warns latest is `2.101.0`. The generated file references `Omit<Database, '__InternalSupabase'>` but the local `Database` type has no such key — version drift signal.
- `src/lib/supabase.ts:5-24` `createClient()` is invoked independently by middleware (`src/middleware.ts:7`), `src/pages/api/auth/signin.ts:9`, `src/pages/api/auth/signout.ts:5`, and `src/pages/api/auth/signup.ts` (analogous). Each call constructs a new `createServerClient<Database>` instance; `getAll()` only reads inbound request headers, so when middleware's instance refreshes a token (via `auth.getUser()`) and writes via `setAll → cookies.set(...)`, a separately-created client later in the same request still sees the old token.
- `src/pages/api/auth/signin.ts:10-12` returns `redirect(?error=Supabase is not configured)` when `createClient()` returns null. `src/pages/api/auth/signout.ts:6-9` silently `redirect('/')` for the same null case — inconsistent contract.
- `context/changes/submissions-data-model/change.md:9-19` carries a 40-line `## Phase 2 adaptations` block documenting session-specific incidents (Docker outage, Windows autocrlf, db:gen-types header UX) inside what is meant to be a stable identity file.
- `context/foundation/lessons.md` does not exist — `/10x-lesson` self-bootstraps it on first use. Both Phase 1 and Phase 6 of this plan append to it.

## Desired End State

After this plan lands:

- A new migration `supabase/migrations/20260529000000_submissions_constraints_hardening.sql` is applied locally (`npm run db:reset`) and on cloud (`supabase db push`). The migration: (a) wipes the 2 smoke-test rows on cloud (no-op locally); (b) replaces the content CHECK with a `char_length(btrim(content)) BETWEEN 1 AND 800` form so whitespace-only inputs fail; (c) adds `submissions_signature_length_check` capping signature at 200 trimmed chars; (d) drops `submissions_created_at_desc_idx` (redundant — composite covers it).
- `supabase/seed.sql` uses a single multi-row INSERT with 6 deterministic UUIDs (`'00000000-0000-0000-0000-00000000000{1..6}'::uuid`) and per-row `created_at` timestamps staggered by at least 1 second so ORDER BY is deterministic across resets.
- `src/lib/submissions/taxonomies.ts` has a ≤4-line header, exports `ENRICHMENT_STATUSES` + `EnrichmentStatus`, and 5 type-guard helpers (`isDepartment`, `isBranch`, `isTopic`, `isTone`, `isEnrichmentStatus`).
- `scripts/gen-types.mjs` exists, performs atomic write (tmp + rename) of `src/lib/database.types.ts` with the `@generated` header always prepended. `db:gen-types` calls it. `package.json`'s `supabase` devDep is `^2.101.0`; `npm install` and a regen run produce a `database.types.ts` whose helper types reference a `__InternalSupabase` key that now actually exists on the `Database` shape.
- `src/env.d.ts` extends `App.Locals` with `supabase: SupabaseClient<Database> | null`. `src/middleware.ts` constructs the supabase client once and stores it on `context.locals.supabase`. `signin.ts`, `signout.ts`, `signup.ts` read from `context.locals.supabase` instead of calling `createClient(...)` themselves. `signout.ts` returns `redirect('/?error=Supabase is not configured')` (or similar — symmetrical to signin) when the locals client is null.
- `context/changes/submissions-data-model/change.md` no longer carries the `## Phase 2 adaptations` block. `context/foundation/lessons.md` carries 4 entries: "Don't repeat baseline grants in migrations", "Postgres partial-index predicate must match query WHERE syntactically", "Adapt verification when Docker is offline", "Windows autocrlf=true baseline is broken for prettier — add `.gitattributes` in a separate change".
- `npm run typecheck` / `npm run lint` (for Phase-affected files) / `npm run build` / `npm run db:reset` / `npm run db:gen-types` all exit 0.

### Key Discoveries

- TRUNCATE in the new migration is the simplest way to land the smoke-row cleanup change.md flagged: locally it's a no-op (post-reset state is already empty before this migration applies), cloud-side it wipes the 2 known smoke rows. This is the only data-changing statement in the migration; it's load-bearing precisely because the migration is being shipped before any production data exists.
- The `ENRICHMENT_STATUSES` omission is the most actionable narrow-type gap. `enrichment_status` is the column F-03's state machine pivots on; a typo (`'procesing'`) on the Insert side without a narrow type passes typecheck and hits Postgres at runtime.
- The shared-client refit via `context.locals.supabase` is the canonical Astro middleware-first pattern. Middleware already runs on every request (`src/middleware.ts:6`) — storing the client there means all downstream handlers in the same request get the same in-memory cookie state that middleware's auth refresh wrote. The wrapper's `getAll()`/`setAll()` shape doesn't change; what changes is how many client instances exist per request (one, not four).
- The `__InternalSupabase` reference in `database.types.ts:86` was emitted by the OLD CLI but `Database` lacks the key — this is a known CLI vs supabase-js drift. Bumping the dep + regenerating fixes it transparently.

## What We're NOT Doing

- **No introduction of a test runner** (vitest / playwright). Continued reliance on `astro check` + manual smoke checks via psql / Studio / curl. The /simplify findings did not produce a test-runner-shaped requirement; bringing one in is a separate change.
- **No migration of `enrichment_status` / `ai_tone` / `topic` / `branch` / `department` to pg `CREATE TYPE ... AS ENUM`.** TS-only narrowing helpers (Phase 3) close the type gap without committing to ENUM semantics; deeper schema change deferred.
- **No partial-index schema rewrite.** Both `submissions_topic_done_idx` and `submissions_branch_done_idx` remain as partial indices on `WHERE enrichment_status = 'done'`. Finding #14 (partial-index predicate-match gotcha) is mitigated by a lessons.md entry so S-02 author writes `.eq('enrichment_status', 'done')` not `.in(...)`.
- **No removal of `GRANT USAGE ON SCHEMA public` from the original migration file.** Editing a migration that's already applied to cloud creates repo/cloud drift. Finding #8 becomes a lessons.md entry: "don't repeat baseline grants in new migrations". The redundant line in `20260528000000_create_submissions.sql:144` stays in history.
- **No `.gitattributes` to fix the project-wide CRLF baseline.** That's a separate change; the Windows autocrlf=true issue is captured as a lesson.
- **No PR for retroactively removing the `## Phase 2 adaptations` block via a /10x-implement on the prior change.** The block is excised via a normal edit in Phase 6 of THIS change, with a commit message that names the prior change.
- **No re-implementation of `db:gen-types` as a shell heredoc.** Cross-platform fragility is the reason we're refactoring; reintroducing it would defeat the purpose.

## Implementation Approach

Six phases, ordered by risk: schema first (forward-only, deterministic), seed (local-only, no cloud impact), TS taxonomy (additive, no consumer impact), build tooling + CLI bump (atomic — script can roll back), auth wrapper (most invasive, gated last so all earlier work is in a stable repo before any auth path mutation). Doc cleanup at the very end as a low-risk closeout that also lands lessons.

Verification per phase mirrors the established pattern from the prior change: `astro check` / `npm run lint` (where touched) / `npm run build` / `npm run db:reset` / manual smoke checks via Studio SQL + curl against the local Supabase. The auth phase additionally requires an end-to-end sign-in / sign-up / sign-out flow in a browser to catch any wrapper regression — automated checks cannot exercise the cookie round-trip.

The smoke-row cleanup is intentionally bundled with Phase 1's migration because: (a) it resolves the change.md TODO from the prior change; (b) the TRUNCATE statement is safe given the known cloud state (only test rows); (c) keeping the cleanup with the constraint-tightening means a future reader sees the single coherent intent ("we hardened constraints; the migration assumes a clean slate"). After 2026-10-30 (when Supabase's anon auto-grant default also sunsets), this migration becomes pure schema with no remaining data caveat.

## Critical Implementation Details

- **TRUNCATE in Phase 1 runs against cloud** — this is the only data-changing statement. It's safe today because change.md confirms only 2 smoke-test rows exist on cloud. If anyone has manually inserted data into cloud `public.submissions` between when this plan was written and when Phase 1 commits, that data WILL be wiped. Verify cloud state with `SELECT count(*) FROM public.submissions;` (via Studio SQL editor on the linked project) before running `supabase db push` in Phase 1's commit step.
- **CLI bump must precede regen** — Phase 4 sequences `npm install supabase@^2.101.0` → `npm install` → `npm run db:reset` (so local stack runs against new CLI) → `npm run db:gen-types` (regen with new CLI). Doing regen before install means the OLD CLI produces the file, defeating finding #15's fix.
- **Shared-client refit (Phase 5) must update env.d.ts AND middleware AND all three auth routes in a single phase** — splitting them risks an intermediate commit where `context.locals.supabase` is set but routes still call `createClient(...)` (no functional break) OR routes consume `locals.supabase` before middleware sets it (immediate null-deref). The phase is atomic by design.

## Phase 1: Schema hardening + smoke-row cleanup + lessons bootstrap

### Overview

New forward-only migration tightens content and signature CHECKs, drops the redundant single-column created_at index, and wipes the 2 cloud smoke-test rows. `context/foundation/lessons.md` is created with 2 entries (baseline grants; partial-index syntactic match).

### Changes Required

#### 1. Hardening migration

**File**: `supabase/migrations/20260529000000_submissions_constraints_hardening.sql`

**Intent**: Forward-only follow-up to `20260528000000_create_submissions.sql`. Wipes existing rows (safe — only smoke-test rows exist on cloud), then drop+recreate the content CHECK with `btrim` so whitespace-only content fails, add a signature length CHECK (signature is anon-writable + nullable; the cap prevents anon DoS), and drop the now-verified-redundant `submissions_created_at_desc_idx` (composite `(enrichment_status, created_at DESC)` covers ORDER BY created_at DESC scans as a prefix).

**Contract**:
- Header comment names: change-id `submissions-data-model-hardening`, follow-up to `20260528000000`, date `2026-05-29`, and the four /simplify findings closed (#1, #2, #9 schema; #8 documented via lessons).
- `TRUNCATE public.submissions;` — the only data-changing statement. Header comment explains it's safe given current cloud state (2 smoke rows from p1 verification per `submissions-data-model/change.md`).
- `ALTER TABLE public.submissions DROP CONSTRAINT submissions_content_length_check;` followed by `ALTER TABLE public.submissions ADD CONSTRAINT submissions_content_length_check CHECK (char_length(btrim(content)) BETWEEN 1 AND 800);`
- `ALTER TABLE public.submissions ADD CONSTRAINT submissions_signature_length_check CHECK (signature IS NULL OR char_length(btrim(signature)) BETWEEN 1 AND 200);`
- `DROP INDEX public.submissions_created_at_desc_idx;`
- No GRANT/REVOKE statements — schema USAGE and column-level grants from the prior migration remain in force.

#### 2. Lessons file bootstrap

**File**: `context/foundation/lessons.md`

**Intent**: First two entries cover patterns surfaced by this plan that apply to future schema work. The skill `/10x-lesson` is the canonical creator, but it self-bootstraps the file on first use — equivalent to writing the H1 header + entries directly. Each entry follows the Context / Problem / Rule / Applies-to shape.

**Contract**: File starts with `# Lessons Learned` H1 then two H2 entries:
- `## Don't re-assert baseline grants on `public.submissions`-like tables` — Context: Supabase auto-grants USAGE on `public` schema to anon/authenticated for existing projects until 2026-10-30; the prior migration re-asserted it as belt-and-suspenders. Problem: a re-asserted grant in a new migration adds cognitive load (reader must reason whether it's load-bearing). Rule: Don't repeat baseline grants. If you need to constrain a baseline, REVOKE explicitly and document why. Applies to: `plan`, `plan-review`, `implement`, `impl-review`.
- `## Postgres partial-index predicate must match query WHERE syntactically` — Context: `submissions_topic_done_idx ON (topic) WHERE enrichment_status = 'done'` won't be used by a query that filters via `.in('enrichment_status', ['done'])` (emits `IN ('done')` not `= 'done'`). Problem: planner doesn't normalize `IN (singleton)` to `=` for partial-index matching. Rule: When a query targets a partial index, the WHERE predicate must be syntactically identical to the index's WHERE. Use `.eq()` not `.in()` for single-value matches. Applies to: `plan`, `plan-review`, `implement`, `impl-review`.

### Success Criteria

#### Automated Verification

- Migration applies cleanly locally: `npm run db:reset` exits 0 with no `ERROR:` lines.
- New constraints visible: `docker exec supabase_db_10x-astro-starter psql -U postgres -d postgres -c "\d+ public.submissions"` lists `submissions_content_length_check` (with btrim) and `submissions_signature_length_check`.
- Dropped index gone: `docker exec ... psql -U postgres -d postgres -c "SELECT indexname FROM pg_indexes WHERE tablename = 'submissions';"` does NOT list `submissions_created_at_desc_idx`.
- `npm run lint` exits 0 (no new lint surface introduced; baseline CRLF noise remains pre-existing).
- `context/foundation/lessons.md` exists and contains the H1 + 2 H2 entries.

#### Manual Verification

- Studio SQL editor (cloud project): `SELECT count(*) FROM public.submissions;` returns 0 after `supabase db push` lands this migration on cloud.
- Studio SQL editor (local): `INSERT INTO public.submissions (department, branch, topic, content) VALUES ('HR', 'Centrala', 'Pomysł', '   ');` fails with `submissions_content_length_check` violation.
- Studio SQL editor (local): `INSERT INTO public.submissions (department, branch, topic, content, signature) VALUES ('HR', 'Centrala', 'Pomysł', 'test', repeat('x', 201));` fails with `submissions_signature_length_check` violation.

**Implementation Note**: After automated checks pass, pause for manual confirmation before proceeding to Phase 2. The cloud `supabase db push` step must also be confirmed by the human (TRUNCATE is irreversible).

---

## Phase 2: Seed determinism

### Overview

Rewrite `supabase/seed.sql` to use deterministic UUIDs, staggered timestamps, and a single multi-row INSERT (closing findings #5 and #10).

### Changes Required

#### 1. Deterministic seed data

**File**: `supabase/seed.sql`

**Intent**: 6 rows total (5 enriched + 1 pending) as before, but every row's id is a stable literal UUID and `created_at` values are unique-by-second so any future test asserting ORDER BY ordering is deterministic across `npm run db:reset` runs. Consolidate the 6 separate INSERTs into one multi-row INSERT.

**Contract**:
- Single `INSERT INTO public.submissions (id, created_at, department, branch, topic, content, signature, enrichment_status, enrichment_attempts, enrichment_attempted_at, ai_title, ai_tone, ai_classification, ai_summary) VALUES (...), (...), ..., (...);` statement.
- 6 rows with ids `'00000000-0000-0000-0000-000000000001'::uuid` through `'00000000-0000-0000-0000-000000000006'::uuid`.
- created_at values monotonic, spaced ≥1 second apart: pick a sensible spread (e.g., `2026-03-17 16:00:00+00`, `:01:00+00`, `:02:00+00`, `:03:00+00`, `:04:00+00`, `:05:00+00`).
- 5 enriched rows: `enrichment_status='done'`, `enrichment_attempts=1`, `enrichment_attempted_at=<created_at + 1 minute>` (still per-row, but the entire row is one line in VALUES so the duplication cost from finding #10 collapses).
- 1 pending row (id `...006`): `enrichment_status='pending'`, `enrichment_attempts=0`, `enrichment_attempted_at=NULL`, all `ai_*` NULL, `signature=NULL`. Topic value chosen to keep "covers all 4 topics" invariant from the prior seed (use the topic that has only one done-row instance otherwise — likely `Pomysł` given the prior seed; verify against the actual rewritten data set).
- Row content sourced from the same CSV rows the prior seed used (SUG-4/5/3/25/14 enriched + one synthetic pending); preserves the dashboard-fixture realism.

  | id suffix | logical row | department | branch | topic | tone | created_at | enrichment_attempted_at |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | `...000001` | SUG-4 enriched | Sprzedaż | Gliwice | Pomysł | Pozytywny | `2026-03-17 16:00:00+00` | `2026-03-17 16:01:00+00` |
  | `...000002` | SUG-5 enriched | Magazyn | Oświęcim | Problem | Negatywny | `2026-03-17 16:01:00+00` | `2026-03-17 16:02:00+00` |
  | `...000003` | SUG-3 enriched | HR | Sosnowiec | Usprawnienie | Negatywny | `2026-03-17 16:02:00+00` | `2026-03-17 16:03:00+00` |
  | `...000004` | SUG-25 enriched | Operacyjny | Chrzanów | Usprawnienie | Neutralny | `2026-03-17 16:03:00+00` | `2026-03-17 16:04:00+00` |
  | `...000005` | SUG-14 enriched | Magazyn | Oświęcim | Inne | Pozytywny | `2026-03-17 16:04:00+00` | `2026-03-17 16:05:00+00` |
  | `...000006` | synthetic pending | IT | Katowice | Pomysł | _(NULL)_ | `2026-03-17 16:05:00+00` | _(NULL)_ |

  All `id` values prefixed with `00000000-0000-0000-0000-` for the full UUID. Topic distribution across done rows: `Pomysł / Problem / Usprawnienie / Usprawnienie / Inne` = 4 distinct topics (preserves Phase 2 success criterion 2.5). Each enriched row's `enrichment_attempted_at` is exactly `created_at + interval '1 minute'`. Content / `ai_title` / `ai_summary` / `ai_classification` strings are inherited verbatim from the prior `supabase/seed.sql` for the matching SUG row; only `id` and `created_at` are restructured. The pending row carries no signature and no `ai_*` fields.

### Success Criteria

#### Automated Verification

- `npm run db:reset` exits 0; `docker exec supabase_db_10x-astro-starter psql -U postgres -d postgres -tc "SELECT count(*) FROM public.submissions;"` returns 6.
- `docker exec ... psql -U postgres -d postgres -tc "SELECT count(DISTINCT id), count(DISTINCT created_at) FROM public.submissions;"` returns `6 | 6`.
- Two consecutive `npm run db:reset` runs leave `docker exec ... psql -tc "SELECT id FROM public.submissions ORDER BY id;"` byte-identical between runs (deterministic).

#### Manual Verification

- Studio (local) Table Editor shows 6 rows with the new ids in `00000000-0000-0000-0000-00000000000{1..6}` shape.
- Studio (local) shows 4 distinct topics across done rows.

**Implementation Note**: After automated checks pass, pause for manual confirmation.

---

## Phase 3: TS taxonomy + narrowing helpers

### Overview

Extend `src/lib/submissions/taxonomies.ts` with the missing `ENRICHMENT_STATUSES` list + `EnrichmentStatus` type, add 5 type-guard helpers, and trim the file header. Closes findings #3, #12 (TS-only narrowing), and #13.

### Changes Required

#### 1. Taxonomy module extension

**File**: `src/lib/submissions/taxonomies.ts`

**Intent**: Close the "single source of truth" gap for `enrichment_status`. Add user-callable type guards so downstream consumers (S-01 form, S-02 dashboard queries, F-03 worker) can narrow Row-side reads (which gen-types collapses to `string`) at the query-result boundary. Trim the file header to ~3 lines — the diacritic-drift warning and supabase/cli#1433 caveat are load-bearing; the FR enumeration and detailed paragraph restate the migration's own header.

**Contract**:
- Header trimmed to ≤4 lines: file purpose (one line), migration filename it mirrors (one line), supabase/cli#1433 caveat (one line, optional 2nd line).
- Existing exports unchanged: `DEPARTMENTS`, `BRANCHES`, `TOPICS`, `TONES` (as const arrays), plus `Department`, `Branch`, `Topic`, `Tone` type aliases.
- New export: `ENRICHMENT_STATUSES = ['pending', 'processing', 'done', 'failed'] as const;` matching `submissions_enrichment_status_check` in the original migration.
- New type: `EnrichmentStatus = (typeof ENRICHMENT_STATUSES)[number];`
- Five type-guard helpers exported. Pattern (one per taxonomy):

  ```ts
  export function isDepartment(value: unknown): value is Department {
    return typeof value === "string" && (DEPARTMENTS as readonly string[]).includes(value);
  }
  ```

  Repeat for `isBranch`, `isTopic`, `isTone`, `isEnrichmentStatus`. The `(X as readonly string[])` widening is required because `.includes` on a literal-string-tuple won't accept `string` arg.

### Success Criteria

#### Automated Verification

- `npm run typecheck` exits 0.
- `npm run lint` exits 0 for the touched file: `npx eslint src/lib/submissions/taxonomies.ts` returns 0 errors.
- `npm run build` exits 0.
- The module exports the 5 type guards: `grep -c "^export function is" src/lib/submissions/taxonomies.ts` returns 5.

#### Manual Verification

- In a scratch `.astro` or `.ts` file, `isTopic('Pomysł')` narrows correctly (IntelliSense shows `Topic`).
- `isEnrichmentStatus('procesing')` (typo) returns `false`; `isEnrichmentStatus('processing')` returns `true`.

**Implementation Note**: After automated checks pass, pause for manual confirmation.

---

## Phase 4: Build tooling refactor + CLI bump + types regen

### Overview

Replace the fragile `db:gen-types` shell redirect with a Node script that atomically writes `database.types.ts` and always prepends the `@generated` header. Bump the `supabase` devDep from 2.98.2 → 2.101.0 so the regenerated types match what supabase-js v2.99 expects (closes #15 `__InternalSupabase` drift). Closes findings #4 and #15.

### Changes Required

#### 1. New gen-types script

**File**: `scripts/gen-types.mjs`

**Intent**: One-purpose Node ESM script: runs `supabase gen types typescript --local --schema public`, prepends the `@generated` header to its stdout, writes the result to a temp file, then renames atomically over `src/lib/database.types.ts`. On CLI failure (non-zero exit, e.g. Docker offline) the temp file is unlinked and the committed file is left untouched — fixes the truncation footgun. Cross-platform via `process.platform === 'win32' ? 'npx.cmd' : 'npx'`.

**Contract**:
- ESM module (`.mjs`); imports `execFileSync` from `node:child_process`, `renameSync` / `writeFileSync` / `unlinkSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`.
- Const `OUT = "src/lib/database.types.ts"` (relative to `cwd`).
- Const `TMP` = `join(tmpdir(), `database.types.${process.pid}.ts`)`.
- Const `HEADER` = two-line comment naming the script as the generator + a do-not-edit notice + trailing blank line.
- `try { execFileSync(...) }` with `{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }` so stderr from the CLI streams to the user but stdout is captured.
- On success: `writeFileSync(TMP, HEADER + cliOutput)` → `renameSync(TMP, OUT)` → `console.log('Wrote ' + OUT)`.
- On failure: `unlinkSync(TMP)` (inside a nested try/catch, ignore "not exists" errors) → `console.error(...)` → `process.exit(1)`.

#### 2. Package.json script + dep updates

**File**: `package.json`

**Intent**: Wire `db:gen-types` to the new script and update the Supabase CLI dep to the latest tested version (`2.101.0`). The script's body becomes a single command; the locking complexity moves into the Node script.

**Contract**:
- `"db:gen-types": "node scripts/gen-types.mjs"`
- `devDependencies.supabase`: `^2.101.0` (or whatever the current latest is at implementation time — see `npm view supabase version`).
- No other scripts modified.

#### 3. Install + regenerate types

**Intent**: Install the bumped CLI; re-create the local stack to pick up the new CLI version where relevant; regenerate `src/lib/database.types.ts` so the helper types reference a `__InternalSupabase` key that now actually exists.

**Contract**: Sequence: `npm install` → `npx supabase --version` returns 2.101.x → `npm run db:reset` (rebuilds local stack with new CLI) → `npm run db:gen-types` (regen). After regen, `src/lib/database.types.ts` is updated; the header is present; the Database type now carries `__InternalSupabase` (or the new equivalent shape). Commit includes both `package.json`, `package-lock.json`, `scripts/gen-types.mjs`, and the regenerated `src/lib/database.types.ts`.

### Success Criteria

#### Automated Verification

- `npm install` exits 0.
- `npx supabase --version` returns `2.101.x` (or higher).
- `npm run db:gen-types` exits 0 and produces a file whose first line starts with `// @generated by`.
- A second `npm run db:gen-types` produces a byte-identical file: `cp src/lib/database.types.ts /tmp/a && npm run db:gen-types && diff src/lib/database.types.ts /tmp/a` returns no output (idempotency holds across re-runs).
- Atomic-write smoke check (`supabase stop` then `npm run db:gen-types` must NOT truncate the committed file): pre-state checksum, run script (expect non-zero exit and stderr), verify file checksum unchanged. Re-`supabase start` after the check.
- `npm run typecheck` / `npm run build` exit 0.

#### Manual Verification

- Inspect `src/lib/database.types.ts`: header present; new internal-type shape visible (or `__InternalSupabase` reference now resolves).
- Read the supabase CLI changelog from 2.98.2 through the bumped version (release notes on GitHub `supabase/cli` releases). Flag any breaking changes affecting `gen types typescript` output (`__InternalSupabase` shape, helper-type renames, deprecated exports).
- Side-by-side diff: before bumping the CLI (i.e. before step 3 of "Install + regenerate types"), snapshot the current `src/lib/database.types.ts` as `/tmp/db-types-pre.ts`; after the bump + regen, run `diff /tmp/db-types-pre.ts src/lib/database.types.ts`. Any change beyond the expected `__InternalSupabase` resolution (e.g. new top-level keys on `Database`, removed exports, altered Row/Insert/Update shapes for `submissions`) must be reviewed in conversation before commit — if substantive, split the CLI bump into a separate change.

**Implementation Note**: After automated checks pass, pause for manual confirmation. Note: the atomic-write smoke check intentionally stops the local stack; remember to `npx supabase start` again before Phase 5 to keep manual auth testing possible.

---

## Phase 5: Auth wrapper shared-client refit + signout consistency

### Overview

Refit the auth path so middleware constructs a single supabase client per request and stores it on `context.locals.supabase`. Routes consume the locals client instead of calling `createClient(...)` themselves — fixing the stale-token bug from finding #6 (middleware's setAll-written cookies become visible to all later-in-request consumers because they're the same client). `signout.ts` is updated to return an explicit error message when the locals client is null, matching `signin.ts` (finding #7). Closes #6 and #7. This is the most invasive phase; it is gated last so all earlier work is committed before auth surface mutates.

### Changes Required

#### 1. App.Locals type extension

**File**: `src/env.d.ts`

**Intent**: Declare the shared supabase client on `App.Locals` so TypeScript surfaces the new contract everywhere routes / middleware read `context.locals`.

**Contract**: Within the existing `namespace App { interface Locals { ... } }`, add a `supabase: SupabaseClient<Database> | null;` field (alongside the existing `user`). Import the type via `import type { SupabaseClient } from '@supabase/supabase-js'` and `import type { Database } from './lib/database.types'`. The field is non-optional (always set by middleware) but nullable (env vars missing).

#### 2. Middleware sets locals.supabase

**File**: `src/middleware.ts`

**Intent**: Construct the supabase client once at the top of the middleware function, store on `context.locals.supabase`, then continue with the existing user-fetching logic but reading from `context.locals.supabase` instead of the local `supabase` var.

**Contract**: Body becomes:

```ts
const supabase = createClient(context.request.headers, context.cookies);
context.locals.supabase = supabase;

if (supabase) {
  const { data: { user } } = await supabase.auth.getUser();
  context.locals.user = user ?? null;
} else {
  context.locals.user = null;
}
// existing protected-routes redirect logic unchanged
return next();
```

The `createClient` import from `@/lib/supabase` remains. No changes to the wrapper itself (`src/lib/supabase.ts`) — the wrapper's per-call contract is unchanged; we just call it once per request instead of once per route handler.

#### 3. Signin reads from locals.supabase

**File**: `src/pages/api/auth/signin.ts`

**Intent**: Replace the in-handler `createClient(...)` call with `context.locals.supabase`. Keep the existing null guard (return signin redirect with error message). No behavioral change apart from the source of the client.

**Contract**: `const supabase = context.locals.supabase;` replaces `const supabase = createClient(context.request.headers, context.cookies);`. Rest of the handler unchanged.

#### 4. Signout reads from locals.supabase + returns explicit error

**File**: `src/pages/api/auth/signout.ts`

**Intent**: Same locals-based switch as signin, plus: when `locals.supabase` is null, return a redirect to `/?error=...` (or similar) instead of the silent `redirect('/')`. The exact error route is up to the implementer (signin redirects to `/auth/signin?error=...`; signout has no obvious "back" page — `/` with an error query param matches the user's "logout failed" mental model).

**Contract**: Handler becomes:

```ts
const supabase = context.locals.supabase;
if (!supabase) {
  return context.redirect(`/?error=${encodeURIComponent("Supabase is not configured")}`);
}
await supabase.auth.signOut();
return context.redirect("/");
```

#### 5. Signup reads from locals.supabase

**File**: `src/pages/api/auth/signup.ts`

**Intent**: Same locals-based switch as signin. Existing error handling (which presumably mirrors signin) unchanged.

**Contract**: Replace the in-handler `createClient(...)` with `context.locals.supabase`. Keep the existing null guard.

### Success Criteria

#### Automated Verification

- `npm run typecheck` exits 0 (App.Locals extension picks up everywhere).
- `npm run lint` exits 0 for touched files: `npx eslint src/env.d.ts src/middleware.ts src/pages/api/auth/signin.ts src/pages/api/auth/signout.ts src/pages/api/auth/signup.ts` returns 0 errors.
- `npm run build` exits 0.
- `grep -c "createClient" src/pages/api/auth/*.ts` returns 0 (all three route handlers should no longer call createClient directly).

#### Manual Verification

- Browser smoke (local dev server `npm run dev`): sign up a new test user → confirm verification (Studio auth → Users) → sign in with the new user → verify redirect home with the user displayed → sign out → verify redirect home with user cleared. No errors in the browser console or terminal.
- Browser smoke (env-missing): temporarily unset `SUPABASE_URL` in `.env`, restart dev server, attempt sign-in → expect `?error=Supabase is not configured` on `/auth/signin`. Sign-out → expect `?error=Supabase is not configured` on `/`. Restore env after.
- Token-refresh trace: in a long-running session, observe that middleware-triggered token refresh (visible via Studio auth audit log) does not produce duplicate refresh events from later-in-request handlers. (Empirical — best-effort verification; the bug's symptom is occasional "session expired" so absence-of-bug evidence is necessarily probabilistic.)

**Implementation Note**: After automated checks pass, pause for manual confirmation. Sign-in/sign-up/sign-out browser smoke is mandatory before committing — Astro typecheck/build do not exercise the cookie round-trip.

---

## Phase 6: Doc cleanup + lessons capture

### Overview

Trim the `## Phase 2 adaptations` block from `context/changes/submissions-data-model/change.md` and append two reusable patterns from that block as lessons in `context/foundation/lessons.md`. Closes finding #11.

### Changes Required

#### 1. Prior change.md trim

**File**: `context/changes/submissions-data-model/change.md`

**Intent**: Remove the host-specific incident log (Docker outage, autocrlf baseline, db:gen-types header UX gap) from the prior change's identity file. The frontmatter stays (`status: implemented`, dates, archived_at). The original `## Notes` block stays (CSV-driven taxonomy decisions, Phase 1 verification path adaptation — these are cross-change context useful for review/archival). Only the `## Phase 2 adaptations` block — written during /10x-implement Phase 2 — is removed.

**Contract**: Delete the `## Phase 2 adaptations` H2 section and all bullets beneath it, leaving the `## Notes` section ending at its prior content (lines ~13-30 of the current file).

#### 2. Lessons.md extension

**File**: `context/foundation/lessons.md`

**Intent**: Append two entries (the file was bootstrapped in Phase 1 with 2 entries; this brings it to 4 total). The patterns: how to adapt verification when Docker is offline mid-session; the Windows autocrlf=true broken-prettier baseline that future Windows contributors will hit until a separate `.gitattributes` change lands.

**Contract**: Two H2 entries appended after the existing 2:
- `## Adapt verification when Docker is offline` — Context: local Supabase CLI requires Docker; `db:reset` / `db:gen-types --local` fail. Problem: planning assumes Docker, sessions that don't have it stall. Rule: When Docker is unavailable, route verification through `supabase --linked` (cloud CLI) + cleanup of any rows landed during smoke testing. Applies to: `implement`, `impl-review`.
- `## Windows autocrlf=true breaks `npm run lint` baseline` — Context: Project ships without `.gitattributes`; `git config core.autocrlf=true` (Windows default) writes CRLF on checkout while prettier defaults to `endOfLine: 'lf'`. Problem: `npm run lint` produces ~1000 CRLF errors on untouched files — false signal during phase verification. Rule: When `npm run lint` shows project-wide CRLF errors, lint only the phase's touched files via `npx eslint <files>`; record the project-wide baseline issue as a separate change rather than fix as a side effect. Applies to: `implement`, `impl-review`.

### Success Criteria

#### Automated Verification

- `context/changes/submissions-data-model/change.md` no longer contains the string `Phase 2 adaptations`: `grep -c "Phase 2 adaptations" context/changes/submissions-data-model/change.md` returns 0.
- `context/foundation/lessons.md` exists and has exactly 4 H2 entries: `grep -c "^## " context/foundation/lessons.md` returns 4.
- `npm run lint` exits 0 (markdown lint is not in the eslint flat config; this is a no-op but confirms nothing regressed).

#### Manual Verification

- Read the trimmed `submissions-data-model/change.md`: notes section reads coherently without orphaned references to the removed block.
- Read `context/foundation/lessons.md`: 4 entries, each follows Context / Problem / Rule / Applies-to shape; no entry restates another.

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before declaring the hardening change done.

---

## Testing Strategy

### Unit Tests

Not applicable — no test runner installed; introducing one is out of scope. Correctness is verified per phase via `astro check` (type narrowing), `psql` smoke checks (schema constraints + RLS), and browser smoke (Phase 5 auth flow).

### Integration Tests

Same — see above. S-02 dashboard and F-03 consumer will eventually need integration tests against the schema, but those land with their own changes once a test runner is in scope.

### Manual Testing Steps

1. **Phase 1 cloud push**: After `supabase db push` lands the migration on cloud, Studio SQL editor on the linked project: `SELECT count(*) FROM public.submissions;` returns 0. Confirms TRUNCATE landed.
2. **Phase 1 constraint validation**: locally, run the two failing INSERTs (whitespace content, oversize signature) listed under Phase 1 Manual Verification. Both should fail with the expected CHECK violations.
3. **Phase 2 seed determinism**: after Phase 2 lands, run `npm run db:reset` twice; confirm a `SELECT id, created_at FROM public.submissions ORDER BY id;` returns byte-identical output across the two runs.
4. **Phase 3 type guards**: in a scratch `.ts`, exercise the type guards on representative valid + invalid values; confirm narrowing in IntelliSense.
5. **Phase 4 atomic-write**: stop Docker (`docker stop supabase_db_10x-astro-starter`), run `npm run db:gen-types`, confirm it exits non-zero with stderr message; confirm `src/lib/database.types.ts` is byte-identical to its pre-script state.
6. **Phase 5 auth flow**: full sign-up → sign-in → protected route access → sign-out cycle in a browser; both with valid env and with env temporarily unset.
7. **Phase 6 lessons sanity**: read `context/foundation/lessons.md` end-to-end; ensure entries flow without forward references.

## Performance Considerations

Dropping `submissions_created_at_desc_idx` (Phase 1) reduces INSERT cost by one index entry per row — measurable but small at MVP scale. The remaining three indices (composite `(enrichment_status, created_at DESC)`, partial `topic where done`, partial `branch where done`) continue to serve all currently-projected dashboard queries with no additional changes. No performance regression expected from any other phase.

## Migration Notes

Phase 1's migration is forward-only and additive (TRUNCATE + ADD CONSTRAINT + DROP INDEX). Rollback strategy: a separate `supabase/migrations/<later-timestamp>_revert_submissions_hardening.sql` that re-creates the original CHECK + drops the signature CHECK + recreates the dropped index. Not generated as part of this plan because the migration is small enough that any future revert author can read it and write the inverse in <10 minutes; pre-generating a revert that may never be used is over-engineering.

## References

- /simplify session findings (top 15, in conversation context of the planning session): drives every phase here
- Prior change plan: `context/changes/submissions-data-model/plan.md`
- Prior change identity: `context/changes/submissions-data-model/change.md`
- Original migration: `supabase/migrations/20260528000000_create_submissions.sql`
- Roadmap: `context/foundation/roadmap.md` (F-01 hardening is a subordinate concern; no roadmap row)
- PRD: `context/foundation/prd.md` (FR-002 employee submission body, NFR anonymity — both load-bearing for Phase 1's signature length CHECK)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema hardening + smoke-row cleanup + lessons bootstrap

#### Automated

- [ ] 1.1 `npm run db:reset` exits 0 with no `ERROR:` lines.
- [ ] 1.2 `docker exec ... psql -c "\d+ public.submissions"` lists `submissions_content_length_check` (with btrim) and `submissions_signature_length_check`.
- [ ] 1.3 `docker exec ... psql -c "SELECT indexname FROM pg_indexes WHERE tablename='submissions';"` does NOT list `submissions_created_at_desc_idx`.
- [ ] 1.4 `npm run lint` exits 0 (touched-file scope).
- [ ] 1.5 `context/foundation/lessons.md` exists with H1 + 2 H2 entries.

#### Manual

- [ ] 1.6 Cloud Studio SQL: `SELECT count(*) FROM public.submissions;` returns 0 after `supabase db push`.
- [ ] 1.7 Local Studio SQL: whitespace-only content INSERT fails with `submissions_content_length_check` violation.
- [ ] 1.8 Local Studio SQL: oversize signature INSERT fails with `submissions_signature_length_check` violation.

### Phase 2: Seed determinism

#### Automated

- [ ] 2.1 `npm run db:reset` exits 0; row count = 6.
- [ ] 2.2 Distinct id count = 6 AND distinct created_at count = 6.
- [ ] 2.3 Two consecutive `npm run db:reset` runs produce byte-identical ORDER BY id output.

#### Manual

- [ ] 2.4 Studio Table Editor shows 6 rows with ids in `00000000-0000-0000-0000-00000000000{1..6}` shape.
- [ ] 2.5 Studio confirms 4 distinct topics across done rows.

### Phase 3: TS taxonomy + narrowing helpers

#### Automated

- [ ] 3.1 `npm run typecheck` exits 0.
- [ ] 3.2 `npx eslint src/lib/submissions/taxonomies.ts` returns 0 errors.
- [ ] 3.3 `npm run build` exits 0.
- [ ] 3.4 `grep -c "^export function is" src/lib/submissions/taxonomies.ts` returns 5.

#### Manual

- [ ] 3.5 In scratch file, `isTopic('Pomysł')` narrows to `Topic` in IntelliSense.
- [ ] 3.6 `isEnrichmentStatus('procesing')` returns false; `'processing'` returns true.

### Phase 4: Build tooling refactor + CLI bump + types regen

#### Automated

- [ ] 4.1 `npm install` exits 0.
- [ ] 4.2 `npx supabase --version` returns ≥ 2.101.0.
- [ ] 4.3 `npm run db:gen-types` exits 0; file first line starts with `// @generated by`.
- [ ] 4.4 Idempotency: second `npm run db:gen-types` produces byte-identical file.
- [ ] 4.5 Atomic-write smoke: stop Docker, run script, expect non-zero exit, committed file unchanged. Restart Docker after.
- [ ] 4.6 `npm run typecheck` and `npm run build` exit 0.

#### Manual

- [ ] 4.7 Inspect `src/lib/database.types.ts`: header present; new internal-type shape visible.
- [ ] 4.8 Read supabase CLI changelog 2.98.2 → bumped version; no breaking-change blockers identified.
- [ ] 4.9 Side-by-side diff of pre/post-regen `database.types.ts` shows only expected `__InternalSupabase` resolution; any substantive shape change pulled into a separate change before Phase 4 commits.

### Phase 5: Auth wrapper shared-client refit + signout consistency

#### Automated

- [ ] 5.1 `npm run typecheck` exits 0.
- [ ] 5.2 `npx eslint src/env.d.ts src/middleware.ts src/pages/api/auth/*.ts` returns 0 errors.
- [ ] 5.3 `npm run build` exits 0.
- [ ] 5.4 `grep -c "createClient" src/pages/api/auth/*.ts` returns 0.

#### Manual

- [ ] 5.5 Browser smoke: sign-up → sign-in → protected route → sign-out, no errors.
- [ ] 5.6 Browser smoke (env-missing): signin and signout both surface the explicit error.
- [ ] 5.7 Token-refresh trace: no duplicate refresh events from later-in-request handlers (best-effort).

### Phase 6: Doc cleanup + lessons capture

#### Automated

- [ ] 6.1 `grep -c "Phase 2 adaptations" context/changes/submissions-data-model/change.md` returns 0.
- [ ] 6.2 `grep -c "^## " context/foundation/lessons.md` returns 4.
- [ ] 6.3 `npm run lint` exits 0 (touched-file scope).

#### Manual

- [ ] 6.4 Trimmed change.md reads coherently without orphaned references.
- [ ] 6.5 lessons.md reads end-to-end; 4 distinct entries, no restatement.
