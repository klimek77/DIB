<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Submissions data model (F-01)

- **Plan**: `context/changes/submissions-data-model/plan.md`
- **Scope**: Phase 1 + 2 of 2 (full plan)
- **Date**: 2026-05-29
- **Verdict**: APPROVED
- **Findings**: 0 critical · 1 warning · 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Grounding

- **Plan adherence**: All 7 changed files match their contracts. Migration has 15 columns in the exact required order, 6 named CHECK constraints, 4 indices, RLS + 2 policies, REVOKE→GRANT ordering and column list — all exact. seed.sql: 6 rows (5 done with all AI fields + attempts=1 + attempted_at=created_at+1min, covering every topic and tone; 1 pending with AI fields NULL). package.json: 3 scripts exact. supabase.ts: `<Database>` generic threaded.
- **Taxonomy parity (highest-priority check)**: migration CHECK lists ↔ `taxonomies.ts` arrays = **27/27 exact**, diacritics included (Sprzedaż, Księgowość, Oświęcim, Tarnowskie Góry, Dąbrowa Górnicza, Pomysł, …). No silent-INSERT-failure risk today.
- **Anonymity-by-absence verified**: no `ip_address`/`user_agent`/`session_id`/`submitter_user_id` columns; `signature` is the only optional, employee-controlled identity link; uuid PK (enumeration-safe).
- **Security**: REVOKE-before-GRANT ordering correct and complete; anon cannot read (no SELECT policy/grant) or write enrichment/AI fields (not in column grant). No `TO public`, no DELETE/UPDATE policy (deny-by-omission under RLS).
- **Success criteria (live verification, Docker up)**: `npm run typecheck` (astro check) exit 0, 0 errors (2.1); `npm run build` exit 0 (2.3); `db:gen-types` output contains `submissions:` (2.4); committed `database.types.ts` is byte-identical to a fresh generation against the live local schema, header aside — proving migration applied (1.1), 15-col schema match (1.2/2.6), and idempotency (2.5); scoped eslint on the change's own TS files exit 0 (1.4/2.2).
- **Extras (out of plan, benign, documented in change.md)**: `.prettierignore` + `eslint.config.js` each exclude the generated `database.types.ts` (standard); `DIB_example_database.csv` added as the taxonomy/seed data source.

### Success-criteria caveats (not failures)
- **1.3 (seed count = 6)**: deferred per change.md — seed loads only on `supabase db reset`; the 6-row content was verified by inspection. Run `npm run db:reset` for the live count.
- **Lint (1.4 / 2.2)**: project-wide `npm run lint` exits non-zero on this Windows host due to a pre-existing CRLF baseline (1120 errors at HEAD a12fe73, untouched files; `core.autocrlf=true`). NOT introduced by this change; the change's own files are lint-clean. `.gitattributes` normalization is a separate change.

## Findings

### F1 — Admin SELECT is open to ANY authenticated user until F-02

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260528000000_create_submissions.sql:123-127
- **Detail**: Policy `submissions_authenticated_select` uses `USING (true)` for role `authenticated`. INTENTIONAL per plan — the F-01/F-02 boundary defers the admin allow-list to F-02's middleware layer (migration comment lines 118-122 document it). Plan-adherent, not drift. Residual risk: until F-02, every authenticated Supabase account can read all submissions; it becomes a live exposure only once S-02 ships an admin read surface. Plan-review F4 and change.md already flag the boundary. This review confirms it's correct, but the gate must land in the right order.
- **Fix**: No F-01 code change. Confirm F-02 lands the admin allow-list (middleware) BEFORE S-02's dashboard read surface reaches prod. Best captured as an accepted risk + a recurring rule (`/10x-lesson`) so the sequencing dependency isn't lost.
  - Strength: Keeps the F-01/F-02 boundary clean (the plan's stated design) while making the cross-change ordering an explicit, durable constraint instead of tribal knowledge.
  - Tradeoff: Relies on F-02 actually landing before S-02 ships to prod; no F-01-level enforcement.
  - Confidence: HIGH — boundary is documented in plan, plan-review F4, and change.md.
  - Blind spot: Whether S-02 might ship a prod read surface before F-02; verify the roadmap ordering.
- **Decision**: ACCEPTED (risk) — Intentional F-01/F-02 boundary. The ordering constraint is recorded in `context/foundation/lessons.md` ("A deferred permissive gate is live exposure until the tightening change lands"). No F-01 code change. Carried forward: F-02 must land its admin allow-list before S-02's read surface reaches prod.

### F2 — Taxonomy lists duplicated in SQL + TS with no automated drift guard

- **Severity**: 🟦 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Pattern Consistency
- **Location**: src/lib/submissions/taxonomies.ts ↔ migration CHECK lists
- **Detail**: The 27 taxonomy values are maintained by hand in two places — the migration's CHECK constraints and `taxonomies.ts`. Currently EXACT (27/27, diacritics included). The plan itself names this a "contract violation downstream reviews must catch," i.e. the only guard today is human review. A single diacritic drift (e.g. Sprzedaż → Sprzedaz) is a silent production INSERT failure. Risk is low now (fresh, exact) and rises each time the taxonomy evolves.
- **Fix**: Add a lightweight CI/test assertion that the four TS arrays match the SQL `IN (...)` lists. Strong candidate for `/10x-lesson` so the "edit both in lock-step" rule is enforced for every future migration.
  - Strength: Converts a human-review-only invariant into a mechanical check; catches diacritic drift before it reaches prod.
  - Tradeoff: No test runner installed yet (out of F-01 scope) — a CI assertion needs a small harness or a parse-and-compare script.
  - Confidence: MED — exact match today; the value is preventive, for future taxonomy edits.
  - Blind spot: None significant.
- **Decision**: DEFERRED — no test runner installed (out of scope). The "edit migration CHECK + taxonomies.ts in lock-step" rule is captured in `context/foundation/lessons.md`; build the mechanical SQL↔TS assertion when a test runner lands (Module 3). Distinct from hardening #3 (ENRICHMENT_STATUSES = coverage gap, not drift detection).

### F3 — Seed rows share identical created_at → non-deterministic ordering

- **Severity**: 🟦 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (data)
- **Location**: supabase/seed.sql:18,31,44 (3 done-rows share the 16:07:00 timestamp; the 2026-03-18 pair differs by a minute)
- **Detail**: Several seed rows reuse the same `created_at` literal. Harmless for a dev seed, but S-02's dashboard sorts by `created_at DESC` — tied timestamps make row order non-deterministic, which could make future S-02 ordering tests flaky.
- **Fix**: Give each seed row a distinct `created_at` (stagger by minutes).
- **Decision**: DEFERRED — no test asserts seed ordering today. The real fix is a query-layer tiebreaker (`ORDER BY created_at, id`) when S-02 lands, not a seed concern. Also tracked in `submissions-data-model-hardening` plan `## What We're NOT Doing` (#5).

### F4 — `// @generated` marker is stripped on every db:gen-types re-run

- **Severity**: 🟦 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: package.json:14 (db:gen-types) → src/lib/database.types.ts:1
- **Detail**: Criterion 2.9 verifies a `// @generated` header on `database.types.ts`, but the `supabase gen types ... > file` script doesn't emit it — it's hand-added once and lost on the next regeneration. change.md already documents this as a known UX gap. So the marker that 2.9 checks silently disappears the next time anyone runs the script.
- **Fix**: Harden `db:gen-types` to prepend the marker (Node one-liner piping the CLI output) so the `@generated` header survives regeneration.
  - Strength: Makes criterion 2.9 self-sustaining instead of relying on a manual re-add.
  - Tradeoff: Slightly more complex script; cross-platform quoting needs care on Windows.
  - Confidence: HIGH — mechanical change, already proposed in change.md as a follow-up candidate.
  - Blind spot: None significant.
- **Decision**: DEFERRED — dev-only footgun; `git restore` recovers a truncated file instantly. Revisit as a standalone tooling change (`scripts/gen-types.mjs`, /simplify #4) if it bites. Deferred from the trimmed hardening plan.
