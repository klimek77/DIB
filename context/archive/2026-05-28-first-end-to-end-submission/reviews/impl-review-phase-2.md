<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-01 first-end-to-end-submission

- **Plan**: context/changes/first-end-to-end-submission/plan.md
- **Scope**: Phase 2 of 5 (Backend — runtime wiring + submission endpoint)
- **Date**: 2026-06-05
- **Commit reviewed**: 8618a1a
- **Verdict**: APPROVED
- **Findings**: 0 critical, 2 warnings, 1 observation — all triaged FIXED

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING (test strength; code clean) |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Code upholds both load-bearing guarantees (closed field-by-field whitelist before the service-role
insert; no IP/header/cookie read or logged; AI never awaited; insert-fail→500 / enqueue-fail→success).
Zero drift, zero scope creep. The two adaptations (runtime-env.ts, vitest.config.ts) are sanctioned
(decision-E correction for Astro v6 + the `@` test alias). Both warnings were about test strength.

## Findings

### F1 — Anonymity test proves "not logged", not "not read"

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/submissions.test.ts:238-263
- **Detail**: The anonymity test asserted IP/cookie sentinels are never logged, but a future edit could read `context.clientAddress`/`cookies`/`headers` without logging it and the test would still pass. Code was clean; the test under-proved the guarantee.
- **Fix**: Added a "never reads client metadata" test — a context whose `clientAddress`/`cookies` getters throw; a valid POST still returns 201, proving neither accessor is read.
- **Decision**: FIXED (Fix now)

### F2 — Route whitelist test doesn't combine optionals + hostile keys

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/submissions.test.ts:116, :167
- **Detail**: The strict-key assertion ran on the no-optionals case; the case carrying department+signature did not also inject `id`/`ai_*`/`enrichment_*` and assert the exact inserted key set. The service-role bypass fires at the route boundary, so the strongest combined assertion belongs there.
- **Fix**: Added a route case combining valid `department`+`signature` with injected `id`/`ai_title`/`ai_classification`/`enrichment_status`/`enrichment_attempts`, asserting the inserted keys are exactly the 6-key whitelist `[branch, content, department, enrichment_status, signature, topic]`.
- **Decision**: FIXED (Fix now)

### F3 — Stale vitest.config.ts header comment

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: vitest.config.ts:5-9
- **Detail**: The header enumerated "drift-guard, enrich() mock, consumer idempotency/branching" — predating the submissions suites. The `src/**/*.{test,spec}.ts` glob already picks them up.
- **Fix**: Trimmed the by-name suite list to a stable, suite-agnostic description.
- **Decision**: FIXED (Fix now)

## Result

Post-fix: `npm run test` → 49 passed (was 47, +2 for F1/F2); lint clean. No code defects were found; all
fixes hardened the Phase 2 test suite.
