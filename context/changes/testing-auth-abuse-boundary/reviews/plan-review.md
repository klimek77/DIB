<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Auth & abuse-boundary tests (rollout Phase 3)

- **Plan**: context/changes/testing-auth-abuse-boundary/plan.md
- **Mode**: Deep
- **Date**: 2026-06-09
- **Verdict**: REVISE → **SOUND after triage** (all 5 findings fixed in plan)
- **Findings**: 1 critical, 3 warnings, 1 observation

## Verdicts

| Dimension | Verdict (pre-triage) |
|-----------|---------|
| End-State Alignment | FAIL → PASS after F1 fix |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING → PASS after F2 fix |
| Plan Completeness | WARNING → PASS after F3/F4/F5 fixes |

## Grounding

9/9 paths ✓, 3/3 symbols ✓, brief↔plan ✓. `docs/reference/contract-surfaces.md` absent — check skipped.
npm peer-range check for pool-workers UNVERIFIED during review (Bash classifier outage) — converted into
the plan's Phase-2 step-zero gate (F2). Sub-agent spawn failed (API thinking-mode error) — verification
performed inline in main context instead.

## Findings

### F1 — Direct handler invocation cannot yield real Set-Cookie; #6 contract didn't pin the path to a real Response

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: End-State Alignment
- **Location**: Phase 2 — Change #2 (callback.workers.test.ts)
- **Detail**: Set-Cookie headers are appended in the adapter App pipeline (`@astrojs/cloudflare`
  `handler.js:65-69`, `app.setCookieHeaders` → `headers.append`), NOT in the route handler; `callback.ts`
  returns a bare `context.redirect()` Response; `AstroCookies` is not publicly exported/constructible
  (verified against `node_modules/astro/package.json` exports). The plan's contract said "build a request
  to the callback … assert Set-Cookie on the Response" without pinning HOW the test obtains a Response
  with real headers. Path of least resistance (direct handler + cookie recorder) would satisfy criterion
  2.2 textually while keeping the exact false green the phase exists to kill.
- **Fix A ⭐ Recommended**: Run the BUILT worker under the pool; drive via `SELF.fetch` from
  `cloudflare:test`; intercept outbound Supabase token call with `fetchMock`; miniflare-provided env vars +
  queue bindings (worker exports a `queue` handler — module must load); `npm run build` as prerequisite.
  - Strength: Full fidelity — real adapter + real App pipeline + real workerd headers; the only route that
    actually kills the false green.
  - Tradeoff: Build prerequisite slows `test:workers`; pool config must mirror `wrangler.jsonc` bindings.
  - Confidence: MEDIUM — SELF+fetchMock is the documented pool-workers integration pattern; astro:env-from-
    runtime-env in the built bundle needs a step-zero spike.
  - Blind spot: vitest-4 peer compat (F2); astro:env/server reading miniflare vars (spike added to plan).
- **Fix B**: Direct handler + AstroCookies-compatible recorder in real workerd; assert (name,value,options)
  tuples from the real adapter.
  - Strength: Much lighter — no build, no SELF, no bindings.
  - Tradeoff: Does NOT prove headers land on the Response; partial false green remains.
  - Confidence: HIGH implementable; MEDIUM it satisfies the phase's intent.
  - Blind spot: astro:env/server still needs alias/mock in the pool config.
- **Decision**: FIXED via Fix A — plan edits: Critical Implementation Details (full-pipeline requirement +
  prohibition of direct invocation + step-zero astro:env spike), What We're NOT Doing (no prod seam needed),
  Phase 2 Change #1 contract (built-worker pool config, bindings, build prerequisite), Phase 2 Change #2
  contract (SELF.fetch + fetchMock).

### F2 — pool-workers ↔ vitest@4.1.8 peer compatibility unverified

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 2 — Change #1 (tooling)
- **Detail**: pool-workers historically pins narrow vitest peer ranges; repo has `vitest ^4.1.8`; npm
  registry unreachable during review. If vitest 4 is unsupported, a separate config doesn't help —
  package.json hosts ONE vitest version.
- **Fix**: Phase-2 step-zero gate: `npm view @cloudflare/vitest-pool-workers peerDependencies`; if
  incompatible → decide npm-alias of a second vitest for the workers project vs holding Phase 2.
- **Decision**: FIXED — gate added to Phase 2 Change #1 ("Gate (step zero, before any wiring)").

### F3 — #5 branch matrix missed the 5th branch: unconfigured client

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — Change #1 (branch matrix)
- **Detail**: `signin.ts:10-12` — `createClient` can return `null` → `302 → /auth/signin?error=…`, a
  DIFFERENT response than `/auth/check-email`. The cross-branch "identical response" assertion was false
  with this branch included. Non-enumeration still holds (branch is email-independent).
- **Fix**: Add case 5 (unconfigured → `/auth/signin?error=…` for ANY email = email-independence); scope the
  identical-response assertion to branches 1–4.
- **Decision**: FIXED — matrix now "all five" with branch 5 + scoped cross-branch assertion.

### F4 — Progress 2.5 (cookbook) had no matching Success Criteria bullet

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — Success Criteria vs ## Progress
- **Detail**: Progress entry "2.5 Cookbook §6.3 filled + §6.2 reference added" had no corresponding bullet
  in the Phase 2 Success Criteria block — Progress↔Phase contract drift.
- **Fix**: Add the bullet to Phase 2 Automated Verification.
- **Decision**: FIXED — bullet added; Phase 2 Automated bullets now map 1:1 onto Progress 2.1–2.5.

### F5 — Signin harness cited the wrong pattern reference for `redirect`

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — Change #1 (Contract)
- **Detail**: Plan said "context.redirect … per submissions.test.ts", but that harness's makeContext has
  only `{ request }`; the redirect pattern lives in `middleware.test.ts:34-49`. signin needs `redirect`
  (`signin.ts:11,34`) and `cookies` (`:9`, inert under the createClient mock).
- **Fix**: Cite the hybrid: Request per `submissions.test.ts:78-89` + redirect fn per `middleware.test.ts:34-49`.
- **Decision**: FIXED — contract reference corrected.

## Post-triage notes

- `plan-brief.md` synced with all fixes (decision table row "#6 fidelity" now sourced "Plan review";
  architecture, phases-at-a-glance, risks, effort updated).
- Verified safe (no findings): node `include` glob would catch `*.workers.test.ts` — plan already mandates
  the exclusion; `createClient` has 5 callers and the (now-dropped) optional-param idea was backwards-safe;
  lean scope and phase ordering unobjected.
