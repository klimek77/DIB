# Notification Channel + FR-018 AI-Failure Alert (S-03) — Plan Brief

> Full plan: `context/changes/notification-channel-and-ai-alert/plan.md`
> Research: `context/changes/notification-channel-and-ai-alert/research.md`

## What & Why

FR-018 (must-have): when AI enrichment **terminally** fails, immediately alert the admin by
email with operational context (submission id, error type, time) — so a backlog of
un-enriched submissions can't grow in silence behind a dashboard that only shows enriched
rows. We build the reusable email channel S-04/S-05 will later reuse, and wire it into the
enrichment consumer.

## Starting Point

F-03 already emits the failure **signal** (a body-free `enrichment_failed` log event +
`failed` row) and deliberately deferred the **sender** to S-03. There's an injected
`captureError` Sentry seam to mirror, a raw-`fetch` OpenAI pattern to copy, and
`ALLOWED_ADMIN_EMAILS` already in env. No email-sending code exists yet, and the signal has a
known spurious-fire bug inherited from F-03.

## Desired End State

A terminal failure produces exactly one coalesced FR-018 email per consumer invocation to all
allow-listed admins, carrying only anonymity-safe fields, via a reusable `sendEmail()` helper.
The spurious-signal bug is closed at the root (signal + Sentry capture + alert all fire only
when `markFailed` wrote a row). Env-gated: no secrets → clean no-op; activates once
`RESEND_API_KEY` + a verified `ALERT_FROM` domain are set.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Channel | Email-only (Resend HTTP) | GA, mirrors `openai.ts` fetch, reusable by S-04/S-05 | Research + Plan |
| Resend vs CF Email | Resend | CF Email Service sending is public beta w/ unpublished quota | Research |
| Sentry as channel? | No (backstop only) | Grouping + 5-min throttle → recurring outage alerts once then silent | Research |
| Spurious-signal fix | `markFailed` returns rows-affected, gate all sinks | Fixes log + Sentry + email at the root (lessons.md) | Research + Plan |
| Burst behavior | Coalesce per consumer invocation | Honors "react quickly" without inbox flood / 100-day cap; stateless | Plan |
| Recipients | All allow-listed admins (`ALLOWED_ADMIN_EMAILS`) | Single source of truth, fail-closed, no DB-list drift | Research + Plan |
| Total-outage | Document recovery path (MVP) | Matches F-03 impl-review; avoids over-building a 2nd transport | Plan |
| Sender domain | Env-gated no-op until configured | Unblocks code/tests; mirrors `SENTRY_DSN?` pattern | Plan |

## Scope

**In scope:** reusable `sendEmail()` (Resend, env-gated); recipient resolver
(`ALLOWED_ADMIN_EMAILS`); FR-018 coalescing payload-builder (anonymity-sealed); `markFailed`
rows-affected + gating of signal/Sentry; `alertAdmin?` seam + batch-scoped coalesced flush;
secrets declaration; unit + workers tests.

**Out of scope:** S-04/S-05 (channel reuse only); Slack/Teams; CF Email binding;
store-independent outage transport; cross-invocation throttle/dedup store; dedicated alert
address; reading `admin_allowlist`; retry/DLQ config changes; any DB migration.

## Architecture / Approach

New pure lib under `src/lib/notifications/` (transport + recipients + coalescing builder), all
node-testable. Consumer gains an injected `alertAdmin?` *collector* (mirrors `captureError`) it
calls at the two terminal points, gated on `markFailed` rows-affected `> 0`. `worker.ts`
buffers the invocation's failures and flushes one coalesced email after the batch loop — the
send stays out of the SDK-free consumer, the coalescing math stays in the pure builder.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Email channel module + secrets | Reusable env-gated `sendEmail` + recipients + payload-builder, unit-tested | Anonymity leak in payload (mitigated by shape-seal test) |
| 2. Gate signal on rows-affected | `markFailed` returns count; signal + Sentry gated; clobber closed | Editing concurrency-sensitive consumer + interface change ripples |
| 3. Wire alerter + coalescing | `alertAdmin?` seam + batch flush; FR-018 live (env-gated); outage doc | Coalescing correctness; worker-runtime wiring (test:workers) |

**Prerequisites:** none beyond the existing F-03 enrichment path (shipped). A verified Resend
sender domain + secrets are needed to make FR-018 *live*, but not to complete/merge the code.
**Estimated effort:** ~2-3 sessions across 3 phases.

## Open Risks & Assumptions

- FR-018 is not *live* until a sender domain is verified + secrets set (deploy-time follow-up,
  by design — code no-ops cleanly until then).
- Total Supabase outage remains a documented blind spot (no alert fires); accepted for MVP.
- `markFailed` return-type change touches F-03 code + its tests — confirmed in-scope (this is
  the lesson's intended home).

## Success Criteria (Summary)

- A terminal enrichment failure (provider/model error or retry exhaustion) reaches the admin's
  inbox as one coalesced email with only safe operational fields.
- No false alerts: signal/Sentry/email fire only when the `failed` write actually landed.
- With secrets unset, the whole channel no-ops cleanly and enrichment is unaffected.
