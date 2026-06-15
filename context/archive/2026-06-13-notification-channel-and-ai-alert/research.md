---
date: 2026-06-13T09:40:25+0200
researcher: klimek77
git_commit: 6db721636c65605ff6bfcf47a1a8b207a9a66f59
branch: main
repository: klimek77/DIB
topic: "S-03 notification channel + FR-018 admin alert on AI enrichment failure"
tags: [research, codebase, enrichment, notifications, fr-018, email, sentry, anonymity]
status: complete
last_updated: 2026-06-13
last_updated_by: klimek77
---

# Research: S-03 — Notification channel + FR-018 alert on AI enrichment failure

**Date**: 2026-06-13T09:40:25+0200
**Researcher**: klimek77
**Git Commit**: 6db7216
**Branch**: main
**Repository**: klimek77/DIB

## Research Question

How should we implement S-03 (`notification-channel-and-ai-alert`)? FR-018 (must-have):
when AI enrichment terminally fails, *immediately* alert the admin in the notification
channel with operational context (submission id, error type, time). Scope decided by the
user before research: **compare both delivery paths** (app-owned email across
Resend/Cloudflare Email/Supabase SMTP **and** riding on the already-wired Sentry) and
recommend; and **include hardening the existing failure-signal emission** in the audit.

## Summary

**The hard part is already built.** F-03 (`ai-enrichment-queue`, archived) deliberately
emits the FR-018 signal and explicitly deferred *the sender* to S-03. So S-03 is: (1) a
delivery channel, (2) two consciously-deferred hardening fixes it inherits, (3) a payload
that respects the anonymity guardrail, (4) recipient resolution.

1. **Signal exists** — a body-free structured `console.log` `enrichment_failed` event
   (`src/lib/enrichment/log.ts:45-48`) carrying `submissionId`, `errorType`
   (`"permanent" | "retry_exhausted"`), `attempts`, optional `errorKind`/`errorStatus`,
   `timestamp`; plus the `enrichment_status='failed'` row with a redacted
   `enrichment_last_error`. The same two terminal points also push a PII-safe
   `captureError` to Sentry.

2. **Recommendation: app-owned email via Resend HTTP `fetch`, wired as an `alertAdmin?`
   injection seam** that mirrors the existing `captureError` seam. Treat a Sentry issue
   alert rule as a *free, zero-code secondary backstop* — **not** the FR-018 channel.
   Decisive facts: (a) Sentry groups all same-`errorType` failures into one issue and
   throttles to once per 5-min interval → a recurring model outage alerts **once then
   goes silent**, which is exactly the "queue grows in silence" failure FR-018 exists to
   prevent; (b) Sentry can't serve S-04 (new-submission notify) or S-05 (weekly digest),
   which are *not* error events — S-03 must build the reusable channel anyway; (c) the
   repo is already shaped for an app-owned send (raw-`fetch` + injectable `fetchImpl`
   pattern, the `captureError` seam, `ALLOWED_ADMIN_EMAILS` recipient already in env).

3. **Two pre-existing hardening items S-03 MUST own** (recorded as lessons + F-03
   follow-up + F-03 impl-review, all pointing at S-03 by name):
   - **Spurious-signal / clobber** — `markFailed` returns `void`; `emitFailureSignal` +
     `captureError` + `ack` fire on "markFailed didn't throw", not "affected a row". A row
     re-claimed between `readStatus` and `markFailed` yields a **false** `enrichment_failed`
     for a row another invocation may be enriching successfully. The Sentry capture
     inherits the same bug. The DB-write clobber is already fixed; the *signal* clobber is
     not. This was forensic-only noise until now — **S-03 is the moment it becomes a false
     email**.
   - **Total-outage silent drop** — if Supabase is unreachable for the whole retry window,
     the DLQ message exhausts its own `max_retries:3` (no DLQ-of-its-own) and is dropped:
     no `failed` write, **no signal fires**, and a `processing`-stranded row has no cron
     recovery. The alerter has nothing to send exactly when an alert matters most.

4. **Anonymity boundary** — alert may carry `submissionId`, `errorType`, `attempts`,
   `errorKind`/`errorStatus`, `timestamp`, and the already-redacted error descriptor.
   It must **never** carry `content`, `signature`, raw `err.message`, or any IP/geo.
   Redaction is already enforced at every seam (`redactError`, Sentry `beforeSend`).

5. **Recipient** — read from `ALLOWED_ADMIN_EMAILS` via `src/lib/auth/allowlist.ts` (the
   declared single source of truth, fail-closed). Do **not** read the `admin_allowlist`
   DB table — it's the RLS gate and is additive-only, so it lags on admin removal and
   could email a removed admin. Recipient set = all allow-listed admins.

## Detailed Findings

### Area 1 — Enrichment terminal-failure path & the FR-018 signal

- **Two terminal deciders, by design** (`src/lib/enrichment/consumer.ts:8-13,173-175`):
  - *Permanent per-attempt failure* (`processEnrichmentMessage`, `consumer.ts:128-156`):
    `enrich()` throws → `isTransient(err)` (`errors.ts:35-38`). Transient (429 / 5xx /
    network) → `resetToPending` + `message.retry()` (`consumer.ts:129-136`), **no failed
    write, no signal**. Permanent (4xx/auth/schema, `classifyHttpStatus` `errors.ts:26-29`)
    → `markFailed(...'failed')` → `emitFailureSignal` → `ack()` (`consumer.ts:142-154`).
  - *Retry-exhaustion failure* (`processDeadLetterMessage`, `consumer.ts:176-218`) — the
    sole authority for "retries exhausted". No app-level attempts cap in the main handler
    (`enrichment_attempts` is forensic only, `consumer.ts:11-13,122`); exhaustion is owned
    by the platform: `max_retries:5` on `dib-enrichment` → `dead_letter_queue:
    dib-enrichment-dlq` (`wrangler.jsonc:34-40`).
- **CAS claim** `pending → processing` (`consumer.ts:106`, store impl `:268-281`): single
  conditional UPDATE matching `pending` OR stale-`processing`. `STALE_PROCESSING_THRESHOLD_MS
  = 12*60*1000` (`consumer.ts:31`) — a crash backstop only.
- **The signal** (`src/lib/enrichment/log.ts:45-48`, `emitFailureSignal`): a single
  structured `console.log` JSON line surfaced by Workers Observability — **not** an email,
  webhook, or DB outbox. There is **no `enrichment_failed` table** anywhere. Fields
  (`FailureSignalFields`, `log.ts:36-43`): `submissionId`, `errorType`, `attempts`,
  `errorKind?`, `errorStatus?`, `timestamp`. Emitted at `consumer.ts:150` (permanent) and
  `consumer.ts:211` (DLQ; no errorKind/status). No content/signature/IP — `errorTelemetry`
  (`consumer.ts:240-245`) extracts only `kind`+`status`; `redactError` (`consumer.ts:250-257`)
  strips the OpenAI body.
- **Sentry capture** (`consumer.ts:153,213` via injected `captureError`; impl
  `src/lib/observability/sentry-server-options.ts:93-105`): `captureException(new
  Error(descriptor))` with PII-safe tags `{errorType, submissionId, errorKind?,
  errorStatus?}`. The consumer swallows its terminal failures (ack/retry, never throws), so
  `withSentry` auto-capture never sees them — the injected seam is the only path
  (`worker.ts:37-43`).

### Area 2 — Gating audit (the clobber bug) — VERDICT: signal clobber PRESENT, deferred to S-03

- `markFailed` returns **`Promise<void>`** (interface `consumer.ts:60`, impl `:311-324`).
  The DB layer guards correctly (`.neq("enrichment_status","done")` + `.eq(
  "enrichment_attempted_at", claimedAt)`, `consumer.ts:314-321`) so a clobber **write** is
  prevented — but the caller can't tell whether 0 or 1 rows matched.
- Both `emitFailureSignal` calls (and `ack`, and the `captureError`) fire on the
  markFailed-didn't-throw path, **not** the affected-a-row path (`consumer.ts:141-154`,
  `:197-217`). A fresh claim re-stamping `enrichment_attempted_at` between `readStatus`
  (`:184`) and `markFailed` (`:201`) → guarded UPDATE matches **zero rows** but resolves
  without error → a **false** `enrichment_failed` / Sentry event.
- Explicitly accepted as residual and deferred: `context/archive/2026-06-02-ai-enrichment-queue/
  follow-ups/markfailed-clobber-fix-2026-06-05.md:71-77` ("Candidate follow-up if S-03 alert
  noise becomes a concern"), and `.../reviews/impl-review-phase-3.md:34-39` ("Defer to S-03.
  When the alert sender lands, gate the signal on `markFailed` reporting rows-affected > 0,
  or dedup against the row's final status").
- **Fix for S-03**: make `markFailed` return rows-affected and gate `emitFailureSignal` +
  `captureError` + the new alert on `rowsAffected > 0` (return-type change touching both
  call sites + `consumer.test.ts`); or dedup the alert against the row's final `failed`
  state. The existing tests only cover the markFailed-*throws* case
  (`consumer.test.ts:164-180,256-271`), not zero-rows-affected.

### Area 3 — Total-outage silent drop — CONFIRMED

- Under whole-window Supabase outage: main queue retries ×5 → DLQ; DLQ `readStatus`/
  `markFailed` also throw → `message.retry()` (`consumer.ts:184-188,207-209`);
  `dib-enrichment-dlq` has `max_retries:3` and **no DLQ of its own** (`wrangler.jsonc:41-45`)
  → message dropped. Row never reaches `failed`, **no signal fires**.
- Cron `runRecoverySweep` (`worker.ts:56-88`, `wrangler.jsonc:20-22`) re-enqueues only rows
  still **`pending`** > 10 min (`selectStrandedPending`, `consumer.ts:342-354`). A
  **`processing`**-stranded row is not swept and has no automatic recovery.
- Prescription (`lessons.md:68-73`): decouple the alert transport from the DB write (emit
  even when the DB write fails) and/or document the "`processing`-stranded → re-enqueue"
  recovery path. F-03 impl-review accepted "document for MVP" as sufficient
  (`.../impl-review-phase-3.md:47-49`).

### Area 4 — Channel mechanisms (compare both paths)

External facts checked 2026-06-13:

| Mechanism | Workers feasibility | Setup | Free limit | Reuse S-04/S-05 | Status |
|---|---|---|---|---|---|
| **Resend (HTTP)** | plain `fetch` POST, mirrors `openai.ts` | 1 verified domain (DKIM/SPF/DMARC) + `RESEND_API_KEY` | 100/day, 3000/mo | High (one `sendEmail` helper) | **GA** |
| **Cloudflare Email Service** | native `send_email` binding, no API key | `send_email` block in `wrangler.jsonc` + verified domain on CF DNS | reputation-scaled, **unpublished** | High | **PUBLIC BETA (2026-04-16)** |
| **Supabase SMTP/Auth** | n/a for arbitrary mail | would need own provider + Edge Function anyway | n/a | Low (not a real shortcut) | auth-only |
| **Sentry alert rule** | zero new code (event already captured) | UI alert rule only | included in plan | **Low** (errors only) | GA, but see caveat |

- **Resend over CF Email Service for MVP** on one fact: CF Email Service sending is public
  beta with an unpublished, reputation-scaled daily quota — the project's infra discipline
  flags beta/unpublished-limit dependencies as risk. Resend is GA, 100/day far exceeds the
  expected "tens-to-hundreds submissions/week" volume, and is Cloudflare's own currently
  recommended path. Revisit the native binding at GA (removes the API-key secret entirely).
- **MailChannels** free Workers integration was sunset **2024-08-31** — not an option.
- **Sentry-as-channel caveat**: issue alerts have a **5-min minimum action interval** and
  fire **once per issue group**; the descriptor is static per `errorType`, so all failures
  of a kind group into one issue → after the first email, subsequent failures don't re-alert
  unless you alert on "every occurrence" (still 1/5-min) or push `submissionId` into the
  fingerprint (destroys the aggregate view + re-introduces a grouping PII vector).

### Area 5 — Architecture seam, secrets, recipient

- **Seam**: the consumer is SDK-free; add an injected `alertAdmin?` to `ConsumerContext`
  (`consumer.ts:84-92`) mirroring `captureError`, with the real impl wired in `worker.ts:43`
  and a no-op in node tests. The send follows the raw-`fetch` + injectable `fetchImpl`
  convention from `src/lib/enrichment/openai.ts:42-66`.
- **Secrets pattern**: add `RESEND_API_KEY` (+ a verified `FROM`/sender address) to
  `.env.example` and `.dev.vars`, declare on `Env` in `src/worker-env.d.ts:16-29`
  (`SENTRY_DSN?` is the optional-secret model → no-op when absent), set prod via
  `wrangler secret put`. No `vars`/`secrets` block in `wrangler.jsonc` today (only the CF
  Email path would add a binding there). `ALLOWED_ADMIN_EMAILS` recipient is already present.
- **Recipient**: `src/lib/auth/allowlist.ts:12-27` parses `ALLOWED_ADMIN_EMAILS`
  (comma-split, trim/lowercase, frozen `Set`, fail-closed) and declares itself the single
  source of truth. The `admin_allowlist` table (migration `20260605000000_...:42-62`,
  seeded additively by `scripts/seed-admins.mjs:32-60,78`) is the **RLS gate** and lags on
  removal (`test-plan.md:266` §6.7) — do **not** resolve recipients from it.

### Area 6 — Test posture

- **Unit** (matches `test-plan.md` §6.1/§6.2): a **payload-builder** (FR-018 fields → email
  body; assert `content`/`signature`/raw-error are *absent* — shape-sealing like
  `submission-input.test.ts`) and a **recipient-resolver** (env → list; empty env → no
  recipients, fail-closed — `loadAllowlist()` module-reset pattern from `allowlist.test.ts`).
- **Email seam mocked at the edge** (Resend client) per "mockuj tylko na krawędzi"
  (§6.2) — assert *what* is sent and *to whom*, never a live provider.
- The signal-gating fix lives in worker-runtime code → exercised by `consumer.test.ts`
  (`npm run test:workers`), not the default node suite. **No E2E** (test-plan §7 — no
  browser-needing risk). **No new quality gate** (§5 — existing `npm test` pre-push covers it).

## Code References

- `src/lib/enrichment/log.ts:33-48` — `emitFailureSignal` + the body-free `enrichment_failed` event S-03 consumes
- `src/lib/enrichment/consumer.ts:128-156` — permanent-failure branch (markFailed → signal → ack)
- `src/lib/enrichment/consumer.ts:176-218` — DLQ branch (sole "retries exhausted" authority)
- `src/lib/enrichment/consumer.ts:311-324` — `markFailed` impl, `Promise<void>` (root of the gating gap)
- `src/lib/enrichment/consumer.ts:84-92` — `ConsumerContext` (where `captureError` is injected; add `alertAdmin?` here)
- `src/lib/enrichment/consumer.ts:240-257` — `errorTelemetry` + `redactError` (PII guard)
- `src/lib/enrichment/openai.ts:42-66` — raw-`fetch` + injectable `fetchImpl` pattern an email send follows
- `src/lib/observability/sentry-server-options.ts:93-105` — `captureServerError` seam (same gating position)
- `src/worker.ts:36-54` — queue dispatch + seam wiring; `:56-88` — cron recovery sweep
- `src/lib/auth/allowlist.ts:12-27` — canonical recipient source (`ALLOWED_ADMIN_EMAILS`)
- `src/worker-env.d.ts:16-29` — `Env` interface (where `RESEND_API_KEY?` is declared)
- `wrangler.jsonc:32-46` — `max_retries` + DLQ config (no DLQ-of-its-own on the DLQ)
- `supabase/migrations/20260605000000_*.sql:42-62` — `admin_allowlist` + `is_allowed_admin()` (RLS gate, not the recipient list)

## Architecture Insights

- **The signal/sender split is deliberate**: F-03 built a transport-agnostic, PII-safe,
  greppable terminal-failure event and stopped there; S-03 owns delivery. This keeps the
  consumer SDK-free and testable — the alert send belongs behind an injected seam, not
  inline in the state machine.
- **One reusable `sendEmail(to, subject, body)` helper is the real deliverable** — S-04
  (FR-016 instant notify) and S-05 (FR-017 weekly digest) reuse it; FR-018 is just its
  first caller. This is why a Sentry-only solution is a dead end for the stream.
- **Anonymity is enforced by construction at the seams already** — S-03 inherits the guard
  by building the payload only from the redacted signal fields, never from the raw row text.

## Historical Context (from prior changes)

- `context/archive/2026-06-02-ai-enrichment-queue/plan.md:272-278` — FR-018 signal contract:
  "emit the durable signal S-03 will consume, without building S-03's sender… No email, no
  webhook."
- `context/archive/2026-06-02-ai-enrichment-queue/change.md:14-17` — "FR-018 fail-alert sink:
  email only (MVP)… Slack/Teams → v2" (decision locked 2026-06-02).
- `context/archive/2026-06-02-ai-enrichment-queue/follow-ups/markfailed-clobber-fix-2026-06-05.md:71-77`
  — residual spurious-signal explicitly deferred to S-03.
- `context/archive/2026-06-02-ai-enrichment-queue/reviews/impl-review-phase-3.md:34-49` — both
  hardening items (signal gate, outage decouple) accepted-as-rule and deferred to S-03.
- `context/archive/2026-06-11-sentry-observability/plan.md:44-52` — "No alerting/notification
  wiring… Sentry's own default issue alerts are enough for MVP." Sentry is positioned
  observability-only; FR-018 alerting was **not** assigned to it.
- `context/foundation/roadmap.md:156-167,213` — S-03 slice, email-only resolution (PRD Q5,
  2026-06-02), Slack→v2 risk note.
- `context/foundation/lessons.md:61-66` (gate signal on rows-affected — *first seen on this
  exact S-03 boundary*), `:68-73` (decouple alert from store write), `:103-122` (PII/geo in
  telemetry).

## Related Research

- None prior under `context/changes/**/research.md`. F-03's `research.md` and `plan.md`
  (archived) are the closest upstream artifacts; this document supersedes them for the
  sender side.

## Open Questions

1. **Resend vs Cloudflare Email Service** — recommend Resend (GA) for MVP; revisit the
   native `send_email` binding when it reaches GA. Confirm at plan time.
2. **Sender / FROM domain** — which verified domain hosts the alert sender? Needs the
   company's DNS (DKIM/SPF/DMARC). Owner: user/IT.
3. **`markFailed` return-type change** — gating the signal correctly means changing
   `markFailed` to return rows-affected (touches F-03 code + `consumer.test.ts`). This edits
   "previous" code — confirm the scope is acceptable in S-03 (the lessons/follow-up say yes,
   this is its intended home).
4. **Burst / coalescing policy** — a model outage fails many submissions at once. "Immediately
   notify" (FR-018) vs. inbox flood: send one email per failure, or coalesce into a single
   "enrichment is failing (N submissions)" alert with a short window? A genuine design call
   for the plan — leaning toward a small debounce/coalesce to honor "react quickly" without
   N emails.
5. **Total-outage transport** — for MVP, document the `processing`-stranded re-enqueue
   recovery path (F-03's accepted answer), or invest in a store-independent alert transport?
   Recommend: document for MVP, revisit only if outages recur.
