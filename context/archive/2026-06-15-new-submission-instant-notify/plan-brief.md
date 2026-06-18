# New-Submission Instant Notify (S-04 / FR-016) — Plan Brief

> Full plan: `context/changes/new-submission-instant-notify/plan.md`

## What & Why

Email the admins instantly whenever a new submission is created (FR-016, nice-to-have). It reuses the
email channel S-03 deliberately built generic for this exact slice — so the work is a thin add, not new
infrastructure. The value is glanceable triage: an admin learns a submission arrived (and roughly what
kind) without watching the dashboard.

## Starting Point

S-03 shipped a reusable, env-gated email channel: `sendEmail` (Resend) and `resolveAlertRecipients`
(`ALLOWED_ADMIN_EMAILS`, fail-closed), plus a pure-builder pattern (`fr018-alert.ts`) whose input type
carries only anonymity-safe fields. The submission insert lives at `src/pages/api/submissions.ts:46-50`
and already holds branch/topic/department + the new row id; `created_at` is one extra selected column away.

## Desired End State

A submitter gets their `201` in <1s exactly as today. After the response, one email goes to every
allow-list admin with time, branch, department (if given), topic, and a one-click link to the auth-gated
detail view. The email never contains `content` or `signature`. With Resend secrets unset, the whole
path no-ops silently.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Email content | Time + branch + department + topic | Glanceable triage; same data the trusted admin already sees in the gated app | Plan |
| Detail-view link | Include; base URL from request origin | One-click triage, link is auth-gated, no new secret needed | Plan |
| Burst handling | One email per submission | Trivial volume at this scale; coalescing would need durable state and break "instant" | Plan |
| Done-line | Code-complete + env-gated | Mirrors S-03's accepted precedent; logic fully unit/integration-covered | Plan |
| Dispatch mechanism | `cfContext.waitUntil` (deferred) | `runtime.ctx` was removed in this stack; preserves <1s NFR and guarantees the send runs | Research |
| Trigger location | Insert route only | Roadmap settles it — not the consumer, not the recovery cron | Roadmap |
| Anonymity | No content/signature, ever | Signature = chosen identity → deanonymization; enforced by the builder's input type | Guardrail |

## Scope

**In scope:** a pure `buildNewSubmissionNotification` builder, a `notifyNewSubmission` orchestrator
(recipients → build → send → swallow+log), a `created_at`-widened select + `waitUntil` dispatch in the
insert route, unit tests (incl. anonymity seal), route integration tests.

**Out of scope:** coalescing/debounce, notify from cron/consumer, a new base-URL env var, any schema
change, durable retry on send failure, a live-inbox merge gate.

## Architecture / Approach

Same separation S-03 used: pure builder owns wording + the anonymity seal (safe-fields-only input type),
a thin orchestrator owns recipient resolution + send + swallow, and the route owns only the dispatch.
The orchestrator returns `Promise<void>`; the route hands it to `context.locals.cfContext.waitUntil(...)`
so the send happens after the response without blocking the <1s NFR and without being cancelled.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Builder + orchestrator | `new-submission-alert.ts` + unit tests (content, anonymity seal, no-op/swallow) | Accidentally leaking content/signature — closed by a safe-fields-only input type |
| 2. Route wiring | `created_at` select + `cfContext.waitUntil` dispatch + integration tests | Blocking the 201 or firing on failure — closed by deferred dispatch + on-success-only placement |

**Prerequisites:** S-03 channel (shipped); `ALLOWED_ADMIN_EMAILS` already declared. Nothing new to provision for code-complete.
**Estimated effort:** ~1 session across 2 phases (~4 files, <150 LOC).

## Open Risks & Assumptions

- `context.locals.cfContext.waitUntil` is the supported deferred-work hook in Astro v6 + `@astrojs/cloudflare` v13 (verified against the adapter source); in any dev path where `cfContext` is absent the optional-chained dispatch simply skips — acceptable since dev has no Resend secrets anyway.
- Feature is silently off in prod until `RESEND_API_KEY` + `ALERT_FROM` are set and a Resend sender domain is verified — must be tracked as a deploy follow-up.
- Taxonomy values render as human-readable labels in the email (use the `taxonomies.ts` label map if stored values are codes).

## Success Criteria (Summary)

- New submission → exactly one admin email with the right fields + working gated link; never any content/signature.
- The `201` returns in <1s and is never affected by a notification send failure.
- Notification fires on successful insert only — never on a 400/500.
