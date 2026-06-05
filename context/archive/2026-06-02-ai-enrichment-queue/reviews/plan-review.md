<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Async AI Enrichment Plumbing (F-03)

- **Plan**: context/changes/ai-enrichment-queue/plan.md
- **Mode**: Deep
- **Date**: 2026-06-02
- **Verdict**: REVISE → SOUND (after fixes)
- **Findings**: 1 critical · 3 warnings · 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | WARNING |
| Architectural Fitness | PASS |
| Blind Spots | FAIL |
| Plan Completeness | WARNING |

## Grounding

8/8 paths ✓; symbols ✓ — `@astrojs/cloudflare/handler` export present in 13.5.0 with `handle(request, env, context)` matching the plan; `workerEntryPoint` adapter option confirmed removed; F-01 migration output/lifecycle columns frozen (`ai_tone` CHECK = Pozytywny|Negatywny|Neutralny, `ai_classification` free text); `src/lib/supabase.ts` is the SSR cookie client (unusable from a consumer); `TONES` SSOT present, `CLASSIFICATIONS` correctly to-be-added. brief↔plan ✓. Also surfaced by grounding: `@cloudflare/workers-types` not installed (→ F2); no test runner installed (→ F3).

## Findings

### F1 — Transient-retry path collides with the CAS "ack on no-claim" branch

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Blind Spots
- **Location**: Phase 3 §1 (Consumer handler) + Critical Implementation Details ("At-least-once + idempotency")
- **Detail**: On a transient error the handler calls `message.retry()` and leaves the row `processing`. The claim CAS re-claims a `processing` row only if `attempted_at < now() - stale_threshold`, so a retry succeeds only when `stale_threshold < retry_backoff`. But the threshold's idempotency job requires it to be *longer* than a real in-flight job. The intuitive long-threshold/short-backoff setting makes redelivery hit "no row claimed → ack() and return", ending the retry chain and wedging the row in `processing` forever — silently violating two success criteria.
- **Fix A ⭐ Recommended**: Reset row `processing → pending` (attempt-guarded) before `message.retry()`; the stale-`processing` reclaim then serves only as a crashed-handler backstop, decoupling retry from the threshold.
  - Strength: Threshold can be set generously long (> max processing) with zero risk of dropping a retry; makes the no-claim branch correct.
  - Tradeoff: A brief `pending` window; benign with `max_batch_size: 1` (worst case one idempotent re-enrich).
  - Confidence: HIGH — removes the timer-coupling that creates the hole.
  - Blind spot: Reset CAS must be attempt-guarded.
- **Fix B**: Keep `processing`, document `processing < threshold < first_backoff`, pick concrete numbers, and `message.retry()` (never ack) on a fresh-`processing` no-claim.
  - Strength: No status churn.
  - Tradeoff: Three interacting timers must stay ordered for every retry; fragile to OpenAI latency variance.
  - Confidence: MEDIUM — correct only within a narrow band.
  - Blind spot: First-retry backoff is the binding constraint; OpenAI p99 latency unmeasured.
- **Decision**: FIXED via Fix A — Phase 3 branch 4 now resets `processing → pending` (attempt-guarded) before `message.retry()`; idempotency note clarifies the stale threshold is a crash-only backstop, settable generously long.

### F2 — Worker runtime types not provisioned; typecheck gate will fail

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §3 + Critical Implementation Details snippet (`satisfies ExportedHandler<Env>`)
- **Detail**: The plan uses `Queue<EnrichmentMessage>`, `ExportedHandler<Env>`, `MessageBatch`, `ExecutionContext`, global `Env`. Verified `@cloudflare/workers-types` is absent and no `wrangler types` output exists; `tsconfig.json` `include: ["**/*"]` means `astro check` type-checks `src/worker.ts`, so gates 1.2/2.1/3.1 fail until these resolve. `wrangler types` would auto-generate `Env` (`QUEUE: Queue` untyped), colliding with the plan's hand-typed `Env`.
- **Fix**: Add a "provision worker types" step to Phase 1 — install `@cloudflare/workers-types` + tsconfig `types`, keep the hand-written typed `Env` (avoids the generated-`Env` collision).
- **Decision**: FIXED — Phase 1 §3 now installs `@cloudflare/workers-types`, adds it to tsconfig `types`, keeps the hand-written `Env`, and explicitly rejects `wrangler types` for `Env` to avoid the collision.

### F3 — Unit-test "automated" gates with no test runner installed

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 2 (2.3, 2.4) + Phase 3 (3.4, 3.5), Testing Strategy
- **Detail**: Four checkboxes under "Automated Verification" plus five Testing-Strategy unit tests, but `package.json` has no `test` script and no vitest/jest. The implementer hits an automated gate with nothing to run it. Project CLAUDE.md notes strategic testing is a Module-3 concern.
- **Fix A ⭐ Recommended**: Add a vitest setup step to Phase 1 (vitest + `@cloudflare/vitest-pool-workers`, `test` script, one smoke test) so the 2.x/3.x gates are runnable.
  - Strength: The drift-guard and idempotency tests are cheap, high-value checks worth having before ship.
  - Tradeoff: Adds test-harness scope to a foundation change.
  - Confidence: HIGH — these tests are pure-logic and easy to run once a runner exists.
  - Blind spot: Queue/Worker-context tests may need the workers pool, not plain node.
- **Fix B**: Reclassify 2.3/2.4/3.4/3.5 as manual/deferred to the Module-3 testing change; keep build/typecheck/lint as the real automated gates.
  - Strength: Keeps F-03 lean.
  - Tradeoff: Idempotency/drift logic ships without an automated guard.
  - Confidence: HIGH — matches the project's "testing in Module 3" line.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix A — Phase 1 §7 (test runner setup) added: vitest + `@cloudflare/vitest-pool-workers`, `test` script, smoke test; new automated gate 1.5 (`npm test`); manual items renumbered to 1.6–1.8; Testing Strategy names the runner. Scoped as harness-only (strategic testing stays Module-3).

### F4 — Two failure-caps with unspecified relationship

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Lean Execution
- **Location**: Critical Implementation Details ("Final-failure detection") + Phase 3 §1 branch 5 + §2 (DLQ)
- **Detail**: Terminal failure has two backstops — app-level `enrichment_attempts ≥ cap` (branch 5) and platform `max_retries: 5` + DLQ. Their relative values are never reconciled: if app-cap ≤ max_retries the DLQ is dead code; if app-cap > max_retries branch 5 is unreachable. One path is always dead, left to chance.
- **Fix**: Make `max_retries` + DLQ the single exhaustion authority; DLQ branch is the only terminal `failed` writer for exhaustion; branch 5 handles only permanent errors; `enrichment_attempts` becomes observability.
- **Decision**: FIXED — "Final-failure detection", Phase 3 branch 5, and §2 (DLQ) all updated: platform `max_retries`+DLQ is the sole exhaustion authority, branch 5 fails only on permanent errors, `enrichment_attempts` is forensic-only.

### F5 — Provider seam for a single, out-of-scope second provider

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Lean Execution
- **Location**: Phase 2 §3 (enrich.ts + openai.ts), Approach
- **Detail**: Anthropic is out of scope and the lessons register flags "don't harden a consumer that doesn't exist yet." The plan already says "thin seam," so this is a guardrail: keep `enrich()` to one function + one impl; no registry/factory/strategy map.
- **Fix**: Add a one-line guardrail to Phase 2 §3 — single exported function + one impl file, no provider-selection machinery.
- **Decision**: FIXED — Phase 2 §3 now carries the seam-discipline guardrail (one `enrich()` function + `openai.ts`; swapping Anthropic later = a second impl + one call-site change, no selection machinery).
