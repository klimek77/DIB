<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-05 Weekly Digest

- **Plan**: context/changes/weekly-digest/plan.md
- **Scope**: Phases 1–2 of 3 (Phase 1 covered separately in impl-review-phase-1.md; this pass adds Phase 2 + the 1↔2 integration seam)
- **Date**: 2026-06-19
- **Commits reviewed**: 56ee586, 8bbf244 (p1) · a6a9fee (p2)
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated criteria re-run live this session: unit 45/45 (range + weekly-digest +
route-cron) · `astro check` 0 errors · `eslint .` exit 0 · `test:workers` 3/3 (exit 0) ·
`dist/server/wrangler.json` carries both `*/15 * * * *` and `0 7 * * 1`.

Phase 2 plan-adherence: all 4 planned changes MATCH intent — wrangler.jsonc
triggers.crons == plan literal; `routeScheduledCron` pure mapper; worker.ts branches
on `controller.cron`, both branches awaited, no `waitUntil`; router test covers both
known crons + unknown + near-miss `0 7 * * 0`. No scope creep. Integration verified:
`sendWeeklyDigest(env, new Date())` signature matches and the orchestrator wraps its
whole body in try/catch (returns `{sent:false}`), so worker.ts:102 "never throws" is
accurate — no redelivery-via-rejection, consistent with the deliberate no-dedup design.

## Findings

### F1 — Cron ↔ router lockstep enforced only at runtime, not at test time

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency / Reliability
- **Location**: src/lib/scheduled/route-cron.ts:15-18 · wrangler.jsonc:25
- **Detail**: The cron strings are duplicated across wrangler.jsonc `triggers.crons` and `SWEEP_CRON`/`DIGEST_CRON` in route-cron.ts (JSONC can't import the TS constants). The dispatch now gates the sweep on an exact match (previously it ran for any cron); a drift degrades to "unknown" → no-op + log marker. If the sweep cron is ever edited in wrangler.jsonc without updating `SWEEP_CRON`, the recovery sweep silently stops — and that sweep is the backstop for "no silent submission loss" (test-plan risk #4). The only thing catching the drift today is someone reading prod logs.
- **Fix**: Add a guard test reading wrangler.jsonc `triggers.crons` that asserts (a) both `SWEEP_CRON`/`DIGEST_CRON` are registered and (b) every registered cron routes to a non-"unknown" job — turning the lockstep into a test-time failure instead of a runtime log line.
  - Strength: Catches config drift in either direction before deploy; ~25 lines, no new dependency, co-located with the router.
  - Tradeoff: Reads wrangler.jsonc via a targeted regex (no JSONC parser available); robust because entries are plain quoted strings.
  - Confidence: HIGH — extraction + assertions verified green and non-vacuous.
  - Blind spot: None significant.
- **Decision**: FIXED — added `src/lib/scheduled/wrangler-cron-sync.test.ts` (2/2 green, lint exit 0). Asserts both known crons are registered and every registered cron maps to a known job.
