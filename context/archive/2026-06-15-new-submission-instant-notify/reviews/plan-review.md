<!-- PLAN-REVIEW-REPORT -->
# Plan Review: New-Submission Instant Notify (S-04 / FR-016)

- **Plan**: context/changes/new-submission-instant-notify/plan.md
- **Mode**: Deep
- **Date**: 2026-06-15
- **Verdict**: REVISE → SOUND after fixes
- **Findings**: 0 critical, 1 warning, 3 observations (all triaged)

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding

10/10 paths ✓ (email.ts, recipients.ts, fr018-alert.ts(+test), submissions.ts, _submissions.test.ts,
taxonomies.ts, submission-input.ts, cf-helpers.js, detail route `[id].astro`; new-submission-alert.ts
absent as expected). cfContext deferred-work mechanism verified in
`@astrojs/cloudflare/dist/utils/handler.js` (`handle()` → `createLocals(ctx)` → `{ cfContext }`, ctx
threaded from `worker.ts:37`) ✓. Taxonomy types ✓. Progress↔Phase mechanically consistent ✓. brief↔plan ✓.

## Findings

### F1 — Prescribed `cfContext?.waitUntil` fails the plan's own lint gate

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Critical Implementation Details + Phase 2 dispatch
- **Detail**: `App.Locals extends Runtime` types `cfContext` non-nullable (`cf-helpers.d.ts:2`), merged with
  the project's `{ user }` (`src/env.d.ts`). The repo runs `tseslint strictTypeChecked` (`eslint.config.js:15`),
  so `cfContext?.waitUntil` trips `no-unnecessary-condition` → `npm run lint` fails (gate 1.3/2.4). `handle()`
  populates cfContext unconditionally (dev+prod); it's absent only in synthetic unit contexts — so dropping
  `?.` forces the shared `makeContext`/`makeParanoidContext` helpers (used by all existing success-path tests)
  to carry a no-op `cfContext.waitUntil`, or those tests throw.
- **Decision**: FIXED (Fix A) — dispatch now non-optional `context.locals.cfContext.waitUntil(...)`; lint
  rationale added to Critical Implementation Details; Phase 2 test step now requires the synthetic
  `cfContext.waitUntil` on the shared helpers; corrected the "dev path where cfContext is absent" premise.

### F2 — Anonymity analysis omits the external-store dimension the cited lesson demands

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Current State Analysis (anonymity guardrail) + Desired End State
- **Detail**: Anonymity reasoning covers only content/signature, but the plan's own cited lesson ("audit PII
  on the event the external store holds — the inbox") is unaddressed: branch+department+topic+time+UUID now
  leave the gated dashboard into Resend (external SaaS) + forwardable admin inboxes. Defensible (trusted
  admins, same fields they see; content/signature sealed out), but the external-store sign-off wasn't written.
- **Decision**: FIXED — added an "External-store sign-off" bullet recording what leaves the gated surface,
  why it's acceptable, and the residual small-department `branch+department+time` narrowing risk. No payload change.

### F3 — Builder contract references a `taxonomies.ts` label map that doesn't exist

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 Contract
- **Detail**: Contract hedged "use the taxonomies.ts label map if stored values are codes" — no map exists
  and values are already display-ready Polish (Gliwice/Pomysł/IT). Phantom map risks an implementer hunting
  for or building one needlessly.
- **Decision**: FIXED — replaced the hedge with "values are already display-ready labels, render verbatim, no
  map exists or is needed; do not build one."

### F4 — Swallow wraps only the send, not recipient-resolution/build

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 Contract — notifyNewSubmission
- **Detail**: Only the send was wrapped in try/catch. The 201 is safe regardless (async fn → rejected promise
  to waitUntil), but a throw from resolve/build would escape the id-less-marker swallow as an unhandled
  rejection. Low likelihood (resolve fail-closed, builder pure).
- **Decision**: FIXED — contract now wraps the whole orchestrator body (resolve + build + send) so any failure
  logs the marker and the returned promise always resolves.
