# Submissions data model — plan brief

> Full plan: `context/changes/submissions-data-model/plan.md`

## What & Why

F-01 from the roadmap — the foundation `submissions` table that every other change in the chain reads or writes. One Postgres table with form columns, AI-enrichment columns, a 4-state enrichment lifecycle, CHECK constraints sourced from a single TypeScript taxonomy module, RLS policies, column-level role grants, and a generated `database.types.ts`. The schema is the contract S-01 (employee submission) writes against, S-02 (admin dashboard) reads from, and F-03 (AI enrichment consumer) mutates with results — getting it wrong forces a migration plus code churn across three downstream changes.

## Starting Point

Astro 6 + Cloudflare Workers + Supabase is scaffolded; `supabase/config.toml` declares Postgres 17 and the default migrations path, but `supabase/migrations/` doesn't exist yet and `database.types.ts` is absent — every Supabase call currently returns `any`. The Supabase + supabase-CLI + TypeScript devDeps are installed; the only scripts in `package.json` are `dev`, `build`, `preview`, `astro`, `lint`, `lint:fix`, `format`. A 45-row example CSV at `context/foundation/DIB_example_database.csv` is the empirical source for the taxonomy values.

## Desired End State

`supabase db reset` applies one migration that produces a 15-column `submissions` table with CHECK constraints on topic / tone / department / branch / content-length / enrichment-status, four indices sized for the dashboard queries, RLS enabled with anon column-restricted INSERT and authenticated SELECT, plus a `seed.sql` of 6 representative rows. `src/lib/submissions/taxonomies.ts` is the single TS source for the taxonomy lists; `src/lib/database.types.ts` is generated and threaded into `createServerClient<Database>` so every downstream query is typed.

## Key Decisions Made

| Decision                                                | Choice                                                                              | Why (1 sentence)                                                                                                                       | Source |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| AI enrichment columns: inline vs separate table         | Inline on `submissions` (4 AI columns + 4 lifecycle columns)                        | One join-free query for dashboard and detail view; FR-008 invisibility filter reduces to `WHERE enrichment_status = 'done'`.           | Plan   |
| Topic representation                                    | text + CHECK (CSV's 4-value set)                                                    | CSV is empirical evidence of the company's live taxonomy; DB-enforced but easy to evolve via migration.                                | Plan   |
| Topic values                                            | `Pomysł / Problem / Usprawnienie / Inne` (CSV), not PRD's 5-value set               | CSV is the live data shape; PRD diverges and should be updated in a follow-up.                                                         | Plan   |
| Location modeling (PRD ambiguity in FR-003)             | Two required fields — `department` and `branch`, each text + CHECK + hardcoded list | CSV shows two distinct fields; FR-012 aggregates by branch while FR-003 selector is by department.                                     | Plan   |
| Tone storage (closes PRD Open Question Q7)              | text + CHECK (`Pozytywny / Negatywny / Neutralny`)                                  | CSV resolves Q7 with a stable 3-value scale; CHECK constrains AI output for F-03.                                                      | Plan   |
| AI enrichment column set                                | `ai_title`, `ai_tone`, `ai_classification`, `ai_summary` (4 columns)                | PRD's three plus `ai_title` for FR-013 list scannability; keywords/cluster (empty in 100% of CSV rows) deferred to v2.                 | Plan   |
| Primary key shape                                       | `uuid` (`gen_random_uuid`)                                                          | Non-enumerable IDs in URLs preserve the PRD's twardo-anonimowa guardrail; bigserial would leak total submission count via `/admin/47`. | Plan   |
| Departments source (PRD Open Q6)                        | Hardcoded TS const + text + CHECK                                                   | MVP-fast; PRD explicitly says hardcoded is sensible; admin-edit feature is a non-goal for MVP.                                         | Plan   |
| Enrichment lifecycle state machine                      | `pending → processing → done | failed` + attempts counter + last_error              | F-03 needs `processing` to deduplicate queue retries; FR-018 alert distinguishes failed-after-N-attempts from in-flight.               | Plan   |
| Admin-read RLS (F-01 / F-02 boundary)                   | `SELECT TO authenticated USING (true)`; allow-list enforced at middleware (F-02)    | Keeps F-01 / F-02 boundary clean; F-02 picks env-var vs table without F-01 pre-committing.                                             | Plan   |
| Anonymity-by-absence                                    | No `ip_address`, `user_agent`, `session_id`, `submitter_user_id` columns            | Defensive: the only identity link is the optional `signature` set explicitly by the employee.                                          | Plan   |
| Anon column restriction                                 | Postgres column-level `GRANT INSERT (col1..col5) TO anon` after `REVOKE ALL`        | RLS cannot restrict columns; only role grants can — load-bearing for the enrichment-fields-only-from-consumer invariant.               | Plan   |

## Scope

**In scope:**

- `supabase/migrations/<ts>_create_submissions.sql` — table + 6 CHECK constraints + 4 indices + RLS + 2 policies + role grants.
- `supabase/seed.sql` — 6 CSV-derived rows (5 enriched, 1 pending).
- `src/lib/submissions/taxonomies.ts` — TS source of truth for the 4 taxonomy lists.
- `src/lib/database.types.ts` — generated, committed.
- `src/lib/supabase.ts` — thread `<Database>` generic through `createServerClient`.
- `package.json` — add `typecheck`, `db:gen-types`, `db:reset` scripts.

**Out of scope:**

- No API endpoint for submissions (S-01).
- No employee form UI (S-01).
- No admin dashboard UI or queries (S-02).
- No magic-link auth refit (F-02).
- No AI enrichment, queue, or consumer Worker (F-03).
- No retention cron (PRD Q2 DPO-TBD).
- No PRD update to align FR-003 / FR-011 wording with CSV taxonomy — follow-up change.
- No test runner introduction.
- No `SUPABASE_SERVICE_ROLE_KEY` env wiring (F-03 will add it).

## Architecture / Approach

Single migration, single TypeScript taxonomy module — both committed in lock-step so the CHECK constraints and the form's `<select>` values cannot drift. Anonymity is enforced at three redundant layers: (1) schema absence (no IP/UA/session columns), (2) column grants (anon writes only user-input columns), (3) RLS (authenticated-only SELECT). F-02 will layer a fourth check (allow-list) at the middleware level when it refits auth.

The enrichment-lifecycle state machine (`pending → processing → done | failed`) is owned by F-03's consumer Worker; F-01 ships the columns + default + indices so F-03 has nothing to migrate when it lands.

## Phases at a Glance

| Phase                                                                    | What it delivers                                                                                                                                              | Key risk                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1. Migration + RLS + column grants + seed                                | First migration file, 6 seed rows, RLS + role grants live, manual smoke verified.                                                                             | Postgres-side: any drift between the CHECK lists and the TS taxonomy module is a silent INSERT failure in production.               |
| 2. TypeScript taxonomy module + types generation + typed Supabase client | `src/lib/submissions/taxonomies.ts`, `src/lib/database.types.ts`, threaded `<Database>` generic, three new npm scripts (`typecheck`, `db:gen-types`, `db:reset`). | `supabase gen types` requires the local Supabase stack to be running; idempotency check catches any non-deterministic output. |

**Prerequisites:**

- Local Supabase stack runnable (`supabase start` once per machine).
- `node_modules` installed (`npm install`).
- No upstream change blockers — F-01 is `ready` per roadmap.

**Estimated effort:**

- ~1 working session for both phases (single migration + single TS module + script additions + manual smoke). The bulk of the time is in the manual verification matrix (anon vs authenticated, CHECK violations, RLS, column grants).

## Open Risks & Assumptions

- **CSV taxonomy is treated as authoritative over PRD wording.** Assumption: the CSV reflects the company's live classification language and the PRD will be updated to match in a follow-up. Risk: if the PRD is later edited to keep its original 5-value topic set, this migration needs an `ALTER` to add the missing values.
- **No `enrichment_status = 'processing'` reaper exists yet.** F-03 will own the reaper that resets stale `processing` rows to `pending` on consumer restart. F-01 ships the column but no reaper; if F-03 is delayed and stale rows accumulate during testing, manual `UPDATE` cleanups are required.
- **Generated `database.types.ts` may type `enrichment_status` as plain `string`.** Postgres CHECK constraints (unlike `CREATE TYPE ... AS ENUM`) don't expose discriminated unions to the Supabase type-gen path. The `as const` taxonomy module fills the type-narrowness gap at the application layer — any downstream code that narrows must import from `taxonomies.ts`, not rely on `Database['public']['Tables']['submissions']['Row']`.
- **Supabase studio role-switching (`SET ROLE anon`) behaves differently from real anon/authenticated traffic in some edge cases.** The manual verification matrix is best-effort; the true RLS surface is fully verified only when S-01's endpoint and F-02's auth land. Captured as a residual risk; not gating.

## Success Criteria (Summary)

- `npm run db:reset && npm run typecheck && npm run lint && npm run build` all exit 0 from a clean state.
- The migration enforces all six CHECK constraints (department, branch, topic, content length, enrichment status, AI tone); column grants enforce that anon cannot write enrichment fields; RLS enforces that anon cannot SELECT and authenticated can.
- `src/lib/database.types.ts` is generated, committed, and idempotent; `createServerClient<Database>` returns typed rows for every downstream consumer.
