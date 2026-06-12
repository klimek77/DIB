<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Sentry Error Monitoring (Astro + Cloudflare Workers)

- **Plan**: context/changes/sentry-observability/plan.md
- **Mode**: Deep
- **Date**: 2026-06-11
- **Verdict**: REVISE → SOUND (all findings fixed in triage)
- **Findings**: 0 critical, 2 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | WARNING (F1 — fixed) |
| Blind Spots | WARNING (F2, F3 — fixed) |
| Plan Completeness | PASS |

## Grounding

7/7 paths ✓ (package.json, astro.config.mjs, worker-env.d.ts, .env.example, worker.ts, consumer.ts, submissions.ts), symbols ✓ (redactError consumer.ts:226, emitFailureSignal, ConsumerContext consumer.ts:70-77, SELF-driven built worker in _callback.workers.test.ts), brief↔plan ✓, Progress↔Phase mechanical contract ✓ (all `- [ ]` confined to the Progress section, lines 337–400), contract-surfaces.md absent (check skipped).

## Findings

### F1 — Direct @sentry/cloudflare import in node-pool-tested modules

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architectural Fitness / Blind Spots
- **Location**: Phase 2 — changes #3 (consumer.ts) and #4 (submissions.ts)
- **Detail**: Phase 2 placed `Sentry.captureException` directly in `consumer.ts` and `submissions.ts` — pure-logic modules unit-tested in the NODE pool (`consumer.test.ts`, `_submissions.test.ts`), not workerd. A top-level `@sentry/cloudflare` import risks import-time/test failure (gate 2.2) and breaks the file's clean DI seam (`ConsumerContext` already injects `store`/`enrichFn`/`staleThresholdMs`).
- **Fix A ⭐ Recommended**: Inject the capture seam, don't import the SDK
  - Strength: Matches the existing DI pattern exactly; consumer.ts stays node-testable with zero new mocks; SDK import lives only in the workerd entry.
  - Tradeoff: One extra optional field + wiring in worker.ts.
  - Confidence: HIGH — mirrors store/enrichFn injection already in the file.
  - Blind spot: None significant.
- **Fix B**: Import directly + mock @sentry/cloudflare in node tests
  - Strength: Fewer moving parts in worker.ts.
  - Tradeoff: Couples pure-logic modules to a workerd SDK; every future node-pool test must remember the mock.
  - Confidence: MED — depends on whether the import loads under node.
  - Blind spot: Unverified whether @sentry/cloudflare throws at import in node.
- **Decision**: FIXED (Fix A) — added `ConsumerContext.captureError?` seam; SDK import confined to `worker.ts` + `sentry-server-options.ts`; updated Phase 2 #1/#2/#3/#4 and the Critical Implementation Details "capture seam" bullet.

### F2 — Preview-scope of secrets/build-env not enumerated for Phase 4

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 1 (setup runbook) ↔ Phase 4 (preview verification)
- **Detail**: Gating is "prod + preview" and Phase 4 verifies events at the `preview` environment, requiring `SENTRY_DSN` (runtime) + `SENTRY_AUTH_TOKEN`/`PUBLIC_SENTRY_DSN`/org/project (build-env) on PREVIEW builds/deploys (Workers Builds scopes prod vs preview separately). Phase 1's runbook didn't state this → likely Phase-4 blocker.
- **Fix**: Phase 1 runbook now explicitly requires all of these scoped to BOTH production and preview builds; added a dependency note on Phase 4 gate 4.7.
  - Strength: Removes a likely Phase-4 blocker; one runbook line.
  - Tradeoff: None.
  - Confidence: HIGH — Workers Builds env scoping is a known split.
  - Blind spot: Exact CF UI labels for the scope toggle unverified.
- **Decision**: FIXED — edited Phase 1 change #5 runbook + Phase 4 manual gate 4.7.

### F3 — `WORKERS_CI_COMMIT_SHA` is an unverified external dependency

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Critical Implementation Details + Phase 3 change #3
- **Detail**: The release-consistency mechanism (and thus symbolication) hinges on the exact CF Workers Builds variable name. Wrong name → `release` undefined → stacks never symbolicate, caught only at gate 4.8.
- **Fix**: Verify the var name against current CF docs in Phase 1; log the resolved release at build so a wrong/empty value is loud at build time.
- **Decision**: FIXED — appended verify + loud-on-empty guidance to the `release` consistency bullet in Critical Implementation Details.
