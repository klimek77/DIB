<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-05 Weekly Digest

- **Plan**: context/changes/weekly-digest/plan.md
- **Scope**: Phase 1 of 3
- **Date**: 2026-06-18
- **Commit reviewed**: 56ee586
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated criteria green: vitest 42/42 · typecheck 0 errors · lint exit 0.
All 4 planned changes MATCH plan intent; no drift, no scope creep. Extras
(richer event logging with `channel_unconfigured` reason, service-role-client
RPC test, recipient-address log-anonymity test, cross-month/year label tests)
all strengthen coverage.

## Findings

### F1 — Weekly total counts only enrichment_status='done' rows

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (correctness of the reported number)
- **Location**: src/lib/notifications/weekly-digest.ts:81 (via reused dashboard RPC, migration 20260612…:52)
- **Detail**: The week's total comes from `fetchDashboardAggregates` → `dashboard_aggregates` RPC, which hard-filters `enrichment_status = 'done'`. Submissions received in the target week but still pending/failed enrichment at send time (Mon 07:00 UTC) are silently excluded — and, because the window is a fixed past week, never counted in any later digest either. Deliberate and plan-documented (reuse the aggregate; plan.md:295-296), so NOT drift. But FR-017 phrases the metric as "liczba zgłoszeń z minionego tygodnia", which a stakeholder may read as ALL received submissions. The plan's "What We're NOT Doing" never states this exclusion as a product decision.
- **Fix A ⭐ Recommended**: Accept as-is — digest mirrors the dashboard.
  - Strength: One consistent mental model — the mail's number equals what the admin sees on /dashboard for the same range; no new query/RPC surface; enrichment is fast and the weekly cadence buffers it.
  - Tradeoff: A late/failed enrichment permanently drops a real submission from the week's reported count.
  - Confidence: HIGH — RPC filter verified; dashboard parity is the existing contract.
  - Blind spot: Whether stakeholders expect "received" vs "enriched" semantics for FR-017 — a product call.
- **Fix B**: Count all submissions in the window regardless of status.
  - Strength: "Submissions last week" means every submission; no silent undercount.
  - Tradeoff: Needs a separate count query (RPC won't give it without a new param); breaks the reuse-the-aggregate approach; mail total then diverges from dashboard.
  - Confidence: MEDIUM — straightforward query, but scope the plan explicitly avoided.
  - Blind spot: Whether a count-all query needs its own RLS/grant path under service-role.
- **Decision**: ACCEPTED — Fix A (accept as-is; digest mirrors the dashboard's single number). No code change. FR-017 "received vs enriched" semantics flagged for product confirmation if it ever matters.

### F2 — Anonymity test is a keyword denylist, not a structural seal

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency (test quality)
- **Location**: src/lib/notifications/weekly-digest.test.ts:77-81
- **Detail**: The no-PII assertion matched `text` against `/podpis|signature|ai_summary|treść/i` — a denylist that wouldn't catch a leak via an unexpected key/wording. The real protection is structural (the builder has no content parameter; it reads only integer aggregates), so the denylist was sound belt-and-suspenders, not a gap.
- **Fix**: Seal the output — assert the full set of emitted text lines equals an expected array (built from the imported TOPICS/BRANCHES), so every line is accounted for and nothing un-enumerated can appear. Kept the denylist regex as a fast readable intent guard.
- **Decision**: FIXED — output seal added (`text.split("\n")` deep-equals the enumerated expected lines). 9/9 weekly-digest tests green.

### F3 — Section-title casing differs from plan's literal example

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence (cosmetic wording)
- **Location**: src/lib/notifications/weekly-digest.ts:43,45
- **Detail**: Plan prose wrote the sections lowercase ("wg tematyki" / "wg oddziału"); the code uses sentence-case "Wg tematyki:" / "Wg oddziału:". Capitalized at line start is correct Polish; `byTopic`/`byBranch` sources match exactly. The plan's lowercase was prose, not a literal string spec.
- **Fix**: None needed — sentence-case reads better.
- **Decision**: SKIPPED — left as-is (correct Polish).
