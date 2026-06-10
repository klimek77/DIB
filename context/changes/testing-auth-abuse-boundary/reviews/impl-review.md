<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Auth & abuse-boundary tests (rollout Phase 3)

- **Plan**: context/changes/testing-auth-abuse-boundary/plan.md
- **Scope**: Full plan (Phases 1–2 of 2)
- **Date**: 2026-06-10
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING (EXTRA exist — all user-approved mid-flight: callback.ts fix, `_` renames, §4 path correction) |
| Safety & Quality | WARNING (F1) |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS (node 92/92, workers 3/3, typecheck 0 errors, lint exit 0; manual 2.6–2.10 evidenced) |

## Findings

### F1 — Real secrets from .dev.vars live in the workers test isolate

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: vitest.workers.config.ts:23-27
- **Detail**: Build copies `.dev.vars` → `dist/server/.dev.vars`; the pool loads it as worker secrets. Miniflare bindings override only 3 of 7 keys — `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_PROJECTID` stay REAL inside the isolate. Egress is blocked today only by the fail-closed fetch stub in the single test file, not by config — a future `*.workers.test.ts` without the stub could hit real APIs with real keys.
- **Fix**: Add dummy overrides for the remaining keys to `miniflare.bindings` (e.g. `SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key"`, `OPENAI_API_KEY: "test"`, `ANTHROPIC_API_KEY: "test"`, `SUPABASE_PROJECTID: "testref"`).
- **Decision**: FIXED — dummy overrides for all four keys added to `miniflare.bindings`; comment documents the .dev.vars loading caveat.

### F2 — Stale "fetchMock" comment in workers config

- **Severity**: 👁 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Pattern Consistency
- **Location**: vitest.workers.config.ts:21
- **Detail**: Comment says "intercepted with fetchMock" while the mechanism is a `globalThis.fetch` stub (fetchMock removed in pool-workers 0.16.x; the test file documents this correctly).
- **Fix**: Reword to "intercepted by stubbing global fetch".
- **Decision**: FIXED — folded into the F1 edit (same comment block).

### F3 — Theoretical indexOf("=") === -1 edge in cookie-name extraction

- **Severity**: 👁 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Safety & Quality (reliability)
- **Location**: src/pages/auth/callback.ts:47
- **Detail**: A header without "=" would slice(0, -1); the anchored regex then skips the cookie. Unreachable in practice (cookie serialization always emits `name=value`), but a one-line guard is cheaper than re-reasoning on every read.
- **Fix**: `const eq = header.indexOf("="); if (eq === -1) continue;`
- **Decision**: FIXED — guard added in callback.ts; suites re-verified green after rebuild.

### F4 — Test pins "never Secure/HttpOnly" as the contract

- **Severity**: 👁 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Plan Adherence (awareness, not a defect)
- **Location**: src/pages/auth/_callback.workers.test.ts:185-186
- **Detail**: `expect(attrs.has("secure")).toBe(false)` encodes "never Secure". A future `secure: true` hardening (standard on always-HTTPS Workers) will intentionally break this test — an intended tripwire worth knowing about.
- **Fix**: None — intentional pin; update the assertion when/if Secure hardening lands.
- **Decision**: SKIPPED — acknowledged as an intentional tripwire.

### F5 — Stale §4 test-plan row: "Workers runtime pool: none yet"

- **Severity**: 👁 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Plan Adherence (doc freshness)
- **Location**: context/foundation/test-plan.md:97
- **Detail**: After this change the pool IS installed (^0.16.14); the §4 row "none yet — see Phase 3" is now a false fact in a living document. §4 edits were outside the plan's cookbook contract, hence untouched.
- **Fix**: Update the row to "@cloudflare/vitest-pool-workers ^0.16.14 (separate project, CI in Phase 4)".
- **Decision**: FIXED — §4 row updated (version, separate project, CI-in-Phase-4 pointer to §6.3).
