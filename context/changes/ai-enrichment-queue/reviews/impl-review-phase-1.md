<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Async AI Enrichment Plumbing (F-03)

- **Plan**: context/changes/ai-enrichment-queue/plan.md
- **Scope**: Phase 1 of 3
- **Date**: 2026-06-03
- **Verdict**: APPROVED
- **Findings**: 0 critical · 1 warning · 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated success criteria re-verified 2026-06-03: 1.1 build ✅, 1.2 typecheck ✅, 1.3 lint ✅, 1.4 dry-run ✅ (QUEUE binding present), 1.5 test ✅. Manual 1.6–1.8 confirmed in the implement session (queue names verified, QUEUE binding live in `wrangler dev`, clean Astro 404 on `/robots.txt` proving routing intact; magic-link sign-in deferred by a local Supabase port issue, unrelated to this change).

## Findings

### F1 — `tsconfig types` array is now exhaustive (silent-failure footgun)

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: tsconfig.json:8
- **Detail**: `"types": ["@cloudflare/workers-types"]` switches TS from auto-including every `@types/*` in scope to including ONLY this list. Verified safe today: Astro globals arrive via triple-slash in `.astro/types.d.ts`, vitest is imported explicitly (not `globals:true`), and no `src/**/*.ts` uses Node globals. Risk is future and silent — using `process.env`/`Buffer` or flipping vitest to `globals:true` would fail to resolve with a non-obvious cause.
- **Fix**: Add a one-line comment in tsconfig.json noting the `types` array is now exhaustive so future additions are remembered. Do NOT pre-add `"node"` unless a later phase introduces Node globals (`@types/node` may not be resolvable by name and would error).
  - Strength: Zero-risk; preserves the deliberate no-`wrangler types` decision (plan.md:112).
  - Tradeoff: Doesn't prevent the failure, only makes it diagnosable.
  - Confidence: HIGH — grep-confirmed no current Node-global usage.
  - Blind spot: Phase 2's supabase-js/OpenAI fetch path is isomorphic and likely needs no Node globals, but unverified until built.
- **Decision**: FIXED — added the exhaustiveness comment to tsconfig.json:8; typecheck re-verified green (2026-06-03).

### F2 — `@cloudflare/vitest-pool-workers` not installed (sanctioned deviation)

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: vitest.config.ts:3-7 / package.json
- **Detail**: Plan §7's contract listed both `vitest` and `@cloudflare/vitest-pool-workers`; only `vitest` was installed. Deliberate lean call — all planned tests are pure-logic with mocked queue messages/clients (default node env). Documented in vitest.config.ts, flagged at the Phase 1 commit gate, and consistent with the plan's own hedge plus the lessons rule "don't harden a consumer that doesn't exist yet."
- **Fix**: None needed. If a Phase 3 test genuinely needs the live Workers runtime, add the pool then.
- **Decision**: ACCEPTED — deviation accepted as a deliberate lean choice; add the pool later only if a Phase 3 test needs the live runtime.

### F3 — `queue` handler is synchronous (Phase 3 forward-note)

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/worker.ts:16
- **Detail**: The no-op handler is synchronous and returns void — correct for a pure `message.ack()` loop. Plan.md:55 shows Phase 3 as `async queue(...)`. Flagged so the Phase 3 swap makes the handler `async`; an awaited enrich()/DB call inside a non-async handler would be a silent bug.
- **Fix**: None now. Make the handler `async` when Phase 3 adds awaited work.
- **Decision**: SKIPPED — Phase-3 reminder only; plan.md:55 already specifies `async queue(...)`. No Phase 1 change.
