<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Notification Channel + FR-018 AI-Failure Alert (S-03)

- **Plan**: context/changes/notification-channel-and-ai-alert/plan.md
- **Scope**: Phases 1–3 of 3 (full plan)
- **Commits**: 7dacc1f..3a6c609
- **Date**: 2026-06-14
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 2 observations
- **Method**: 4 parallel review lenses (drift, safety, anonymity, pattern) → adversarial verification (6 candidates raised, 1 confirmed, 5 rejected as confirmation-notes/false-positives). All automated gates re-run green: lint, typecheck (astro check, 0 errors), `npm test` 179/179, build, `test:workers` 3/3.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — FailureAlertItem.errorKind typed as wide `string`, not the ErrorKind enum

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; the fix touches the plan's dependency-direction discipline
- **Dimension**: Safety & Quality (anonymity guardrail / type safety)
- **Location**: src/lib/notifications/fr018-alert.ts:12 (declaration) → :33 (rendered into the email body)
- **Detail**: `errorKind?: string` was wider than its only legitimate value space (`ErrorKind = "transient" | "permanent"`, src/lib/enrichment/errors.ts:8). `formatItem` renders it verbatim into the outbound email (`rodzaj: ${item.errorKind}`). No live leak existed — both producers (consumer.ts:171, :247) source it only via `errorTelemetry()`, which returns the enum or omits it. The risk was the contract surface: a future caller could pass a free-form string into the email, bypassing the by-construction redaction every other seam enforces. The shape-seal test only planted *undeclared* keys, so it would not have caught a regression on this declared field. (Adversarial verify: CONFIRMED, HIGH confidence.)
- **Fix applied**: Narrowed to `errorKind?: "transient" | "permanent"` — self-contained inline union matching how `errorType` is already declared in the same file; no new cross-module import, no type cycle. The change surfaced an out-of-domain test fixture (`fr018-alert.test.ts:9` used `errorKind: "auth"`, which the loose `string` type had permitted); corrected to the realistic `"permanent"` (the `errorStatus: 401` still conveys the auth detail). No assertion depended on the literal `"auth"`.
- **Decision**: FIXED via Fix A (inline union)

### F2 — Two manual verification gates deferred (not a defect — correctly tracked)

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — acknowledgment only; nothing to change in code
- **Dimension**: Success Criteria
- **Location**: plan.md Progress 1.5, 3.7
- **Detail**: Gate 1.5 (real-key inbox delivery) and 3.7 (live `wrangler dev` forced double-failure smoke) are correctly left `[ ]`, both awaiting a verified Resend sender domain. Their underlying logic is covered by green units (env-gate no-op, anonymity shape-seal, N-item coalescing/Polish noun forms, rows-affected gate matrix). Plan explicitly marks 1.5 "NOT a merge blocker." Documented, intentional deferral — flagged so it is not forgotten, not a gap.
- **Decision**: ACKNOWLEDGED — left pending (re-run 1.5/3.7 once a Resend sender domain is verified)
