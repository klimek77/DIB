<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Submissions data model — implementation plan

- **Plan**: `context/changes/submissions-data-model/plan.md`
- **Mode**: Deep (two parallel subagents)
- **Date**: 2026-05-28
- **Verdict**: REVISE
- **Findings**: 0 critical · 2 warnings · 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | PASS (1 observation) |
| Plan Completeness | WARNING (2 warnings + 1 observation) |

## Grounding

4/4 existing paths ✓, 4/4 new paths correctly absent ✓, `createServerClient` symbol present in `src/lib/supabase.ts` ✓, brief↔plan consistent ✓, Progress↔Phase counts align (Phase 1: 4 automated + 7 manual; Phase 2: 5 automated + 4 manual; all 25 bullets have matching Progress entries).

Sub-agent verification (codebase): 4 callers of `createClient` all use only `.auth.*` namespace — threading `<Database>` is safe. Path aliases (`@/*` → `src/*`) resolve via tsconfig. Supabase config assumptions (Postgres 17, port 54322, schema_paths defaults, seed paths) all hold. No parallel `Database` pattern exists; F-01 is the first.

Sub-agent verification (external): Postgres column-level grants AND-ed with RLS WITH CHECK is documented and load-bearing. Supabase auto-grant baseline removal for new projects flipped 2026-05-30; existing projects (this one) keep auto-grant until 2026-10-30 → REVOKE is load-bearing today. `createServerClient<Database>` signature from `@supabase/ssr/dist/main/createServerClient.d.ts:8,64` accepts `<Database, SchemaName>` with `SchemaName` defaulting to `"public"` — plan's usage is correct. `supabase gen types typescript` emits plain `string` (not literal union) for `text + CHECK` columns — supabase/cli#1433 still open; taxonomies.ts is the canonical mitigation. `SET ROLE` in Studio does NOT populate `request.jwt.claims`, but F-01's policies don't reference `auth.*` so verification matrix is sound.

## Findings

### F1 — `typecheck` script should use `astro check`, not `tsc --noEmit`

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — Changes Required #4 (Package scripts)
- **Detail**: Plan adds `"typecheck": "tsc --noEmit"`, but `@astrojs/check ^0.9.8` is already installed in `package.json:15`. `astro check` is the idiomatic Astro typecheck — runs `tsc` under the hood AND validates `.astro` template expressions. Phase 2's own manual verification step 2.7 says "in a scratch `.astro` file, typing `supabase.from('submissions')…` returns rows typed with the new columns" — that's a `.astro` validation `tsc --noEmit` won't perform.
- **Fix**: Change `"typecheck": "tsc --noEmit"` to `"typecheck": "astro check"`.
- **Decision**: FIXED (Auto-applied)

### F2 — Phase 2 doesn't document the "import taxonomy types, not Row types" contract

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — Changes Required #1 + Critical Implementation Details
- **Detail**: Plan acknowledges generated types emit `string` for `text + CHECK` columns (confirmed against supabase/cli#1433). The `taxonomies.ts` module is set up as mitigation. But the plan never explicitly tells downstream consumers (S-01 form code, S-02 dashboard, F-03 consumer) that they MUST import `Topic`, `Tone`, `Department`, `Branch` type aliases from `@/lib/submissions/taxonomies` for narrow typing — and NOT rely on `Database['public']['Tables']['submissions']['Row']['topic']`, which is plain `string`. Without this contract documented, downstream code silently widens types and the mitigation rots.
- **Fix**: Add a 1-2 sentence note to Phase 2 #1 (taxonomy module Contract) and mirror it in Critical Implementation Details.
- **Decision**: FIXED (Auto-applied)

### F3 — Migration SQL header should explain why REVOKE is load-bearing

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — Changes Required #1 (migration)
- **Detail**: Critical Implementation Details calls out REVOKE-then-narrow-GRANT ordering, but the migration's own header comment doesn't explain WHY. Supabase's auto-grant default for new tables in `public` flipped 2026-05-30 for new projects; existing projects (this one) keep auto-grant until 2026-10-30. A future reader in 2027+ may see the REVOKE, note defaults have changed, and silently delete it — leaking anon INSERT permissions on enrichment columns.
- **Fix**: Add a SQL comment to the migration header noting the Supabase baseline rationale and the 2026-10-30 cutoff.
- **Decision**: FIXED (Auto-applied)

### F4 — `SET ROLE` in Studio doesn't simulate `auth.uid()`-based policies

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Blind Spots
- **Location**: Phase 1 — Manual Verification
- **Detail**: Plan's manual verification matrix uses `SET ROLE anon; SELECT …`. This works correctly for F-01's policies because none reference `auth.uid()` / `auth.jwt()`. But `SET ROLE` alone does NOT populate `request.jwt.claims` — once F-02 tightens admin SELECT with allow-list checks that depend on `auth.uid()`, the same verification recipe returns zero rows and looks like a regression. Not a defect in F-01; a forward-looking pitfall.
- **Fix**: Once `context/foundation/lessons.md` exists, record the gotcha. Until then, capture in F-02's `change.md` Notes.
- **Decision**: NOTED (forward-looking; no plan edit needed for F-01)

## Sources

- PostgreSQL 17 docs: [GRANT](https://www.postgresql.org/docs/17/sql-grant.html), [Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)
- PostgREST: [DB Authorization](https://postgrest.org/en/stable/explanations/db_authz.html), [Authentication](https://postgrest.org/en/stable/references/auth.html)
- Supabase: [changelog #45329 (default-grants removal)](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically), [Postgres Roles and Privileges](https://supabase.com/blog/postgres-roles-and-privileges)
- supabase-cli: [#1433 — CHECK constraint TypeScript support](https://github.com/supabase/cli/issues/1433)
- Supabase community: [discussion #22482 — testing RLS in SQL editor](https://github.com/orgs/supabase/discussions/22482)
- Files inspected: `node_modules/@supabase/ssr/dist/main/createServerClient.d.ts:8,64`, `tsconfig.json:8-10`, `package.json:15`, `src/middleware.ts`, `src/pages/api/auth/{signin,signout,signup}.ts`, `supabase/config.toml`
