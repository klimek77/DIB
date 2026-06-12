<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Admin Dashboard z Agregatami (S-02)

- **Plan**: context/changes/admin-dashboard-aggregates/plan.md
- **Scope**: All 3 phases (full plan)
- **Date**: 2026-06-12
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Automated gates (re-run during this review)

| Gate | Result |
|------|--------|
| `npx vitest run src/lib/dashboard/` | 52 passed ✅ |
| `npm test` | 157 passed ✅ |
| `npm run typecheck` | 0 errors ✅ |
| `npm run lint` | clean ✅ |
| `npm run build` | Complete! ✅ |

Not re-run (need local Supabase): `npm run db:reset`, `npm run db:gen-types`, Probe 6 (RLS).
All marked `[x]` in Progress; generated types diff committed; typecheck over the generated
signature passes.

## Lessons-as-priors check (all honored)

- Partial-index `.eq("enrichment_status","done")` on both SQL and list builder; never `.in([...])`. The list-builder test omits `.in` so a regression throws.
- Explicit `REVOKE … FROM PUBLIC, anon, authenticated` then `GRANT … TO authenticated`; `service_role` keeps default for S-05; Probe 6c asserts anon → 42501.
- Week math lives only in SQL; the TS mapper validates `length === 8` and throws, never recomputes.
- Deferred-permissive-gate lesson satisfied: RPC is `SECURITY INVOKER`, RLS `is_allowed_admin()` already tightened — the read surface ships after the gate, not before.

## Findings

### F1 — Plan text still says donut linecap "round"; code uses "butt"

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/components/dashboard/DonutRing.astro:66 vs plan.md:377
- **Detail**: Plan §P3.2 specifies `strokeLinecap round`; the component uses `butt` with a documented rationale (round caps inflate small slices / overlap neighbours, breaking exact proportions) — deliberate fix in commit 2e1de64. Code is correct; the plan was never updated, so a future plan-vs-code diff reads as drift.
- **Fix**: Add an inline addendum to plan.md noting round→butt and why.
- **Decision**: FIXED (Fix now) — plan.md:377 updated with the round→butt addendum citing 2e1de64.

### F2 — SubmissionsList topic lookup lacks the fallback its sibling uses

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/dashboard/SubmissionsList.astro:48,64,66
- **Detail**: `TOPIC_META[item.topic as Topic]` then reads `.color`/`.icon`; an out-of-taxonomy topic would throw at render. Sibling `[id].astro:148` uses the safer `TONE_COLOR[...] ?? "#15377B"` idiom. Defended today by the DB CHECK + drift-guard test, so not a live defect — only a defensiveness inconsistency.
- **Fix**: Mirror the `?? fallback` idiom for the topic lookup.
- **Decision**: FIXED (Fix now) — `TOPIC_META[item.topic as Topic] ?? { icon: "💬", color: "#6b7280" }`; typecheck green.

### F3 — Zero-count week renders a 0px (invisible) bar

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (UX)
- **Location**: src/components/dashboard/WeeklyChart.astro:33
- **Detail**: `height = round(count/max×56)px`, so a zero-count week is 0px tall — only the "0" value and `T<week>` label show, no bar stub. Consistent with documented empty-state intent.
- **Fix**: Optional — set a 1–2px minimum bar height for zero weeks if a visible stub is preferred.
- **Decision**: SKIPPED — current behavior matches the documented empty-state intent.
