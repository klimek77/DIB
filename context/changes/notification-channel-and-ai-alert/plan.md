# Notification Channel + FR-018 AI-Failure Alert (S-03) — Implementation Plan

## Overview

S-03 delivers FR-018 (must-have): when AI enrichment **terminally** fails, the admin is
*immediately* alerted by email with operational context (submission id, error type, time) —
so a backlog of un-enriched submissions can't grow in silence behind a dashboard that only
shows enriched rows (FR-008). The work has two halves: (1) build a small, reusable,
**env-gated email channel** (Resend HTTP) that S-04 (instant notify) and S-05 (weekly
digest) will later reuse, and (2) wire it into the enrichment consumer as an injected
`alertAdmin?` seam — first closing an inherited spurious-signal bug at its root so the alert
can't fire falsely.

## Current State Analysis

The failure **signal** already exists; only the **sender** is missing. F-03
(`ai-enrichment-queue`, archived) deliberately built a transport-agnostic, PII-safe,
greppable terminal-failure event and stopped there, deferring delivery to S-03.

- **Signal source** — `emitFailureSignal()` (`src/lib/enrichment/log.ts:45-48`) emits a
  body-free `console.log` `enrichment_failed` event with `submissionId`, `errorType`
  (`"permanent" | "retry_exhausted"`), `attempts`, optional `errorKind`/`errorStatus`,
  `timestamp`. The `enrichment_status='failed'` row + redacted `enrichment_last_error` is
  the second half. No email/webhook/outbox exists.
- **Two terminal points** — permanent (4xx/auth/schema) at `consumer.ts:141-154`;
  retry-exhaustion (DLQ) at `consumer.ts:176-218`. Transient failures self-heal and never
  signal.
- **Capture seam precedent** — `ConsumerContext.captureError?` (`consumer.ts:84-92`, wired
  in `worker.ts:43`) is an injected, SDK-free seam receiving a body-free descriptor + PII-safe
  tags. The alert seam mirrors it exactly.
- **Outbound-HTTP pattern** — OpenAI is called with raw `fetch` + an injectable `fetchImpl`
  (`src/lib/enrichment/openai.ts:42-66`); an email send follows this shape, not an SDK.
- **Recipient source** — `ALLOWED_ADMIN_EMAILS` parsed in `src/lib/auth/allowlist.ts:12-27`
  (the declared single source of truth, fail-closed). The `admin_allowlist` DB table is the
  RLS gate and is additive-only (lags on admin removal) — **not** a recipient source.
- **Secrets pattern** — declared on `Env` (`src/worker-env.d.ts:16-29`); `SENTRY_DSN?` is the
  optional-secret model (SDK no-ops when absent). Listed in `.env.example`/`.dev.vars`, set in
  prod via `wrangler secret put`.
- **Batch dispatch** — the `queue` handler builds `consumerCtx` once per batch then loops
  `batch.messages` (`worker.ts:40-53`) — the natural scope for per-invocation coalescing.

### Key Discoveries:

- The signal/sender split is intentional: `context/archive/2026-06-02-ai-enrichment-queue/plan.md:272-278`.
- **Spurious-signal clobber (inherited, deferred to S-03 by name)**: `markFailed` returns
  `void` (`consumer.ts:60`, impl `:311-324`), so `emitFailureSignal` + `captureError` + `ack`
  fire on "markFailed didn't throw", not "affected a row". A row re-claimed between
  `readStatus` and `markFailed` yields a **false** `enrichment_failed` for a row another
  invocation may be enriching successfully. Source: `lessons.md:61-66`;
  `.../follow-ups/markfailed-clobber-fix-2026-06-05.md:71-77`;
  `.../reviews/impl-review-phase-3.md:34-39`.
- **Total-outage silent drop**: under a whole-window Supabase outage the DLQ message
  exhausts its own `max_retries:3` (no DLQ-of-its-own, `wrangler.jsonc:41-45`) and is dropped
  — no `failed` write, no signal. `lessons.md:68-73`; accepted "document for MVP" by F-03
  impl-review.
- **Anonymity boundary**: alert may carry `submissionId`, `errorType`, `attempts`,
  `errorKind`/`errorStatus`, `timestamp`, redacted descriptor — **never** content, signature,
  raw `err.message`, or IP/geo. Redaction already enforced at every seam.
- Channel decided email-only for MVP (roadmap S-03; PRD Q5 resolved 2026-06-02). Resend is GA;
  Cloudflare Email Service sending is public beta (2026-04-16) with an unpublished quota.

## Desired End State

A terminal enrichment failure produces exactly one coalesced FR-018 email per consumer
invocation to all allow-listed admins, carrying only anonymity-safe operational fields, sent
via a reusable Resend-backed `sendEmail()` helper. The spurious-signal clobber is closed at
the root: `emitFailureSignal`, the Sentry capture, and the new alert all fire only when
`markFailed` actually wrote a row. The channel is env-gated — with `RESEND_API_KEY`/
`ALERT_FROM` unset it no-ops cleanly (dev/test/local), activating once secrets + a verified
sender domain are configured. Verification: `src/lib/` unit suites green (incl. anonymity
shape-seal + the new zero-rows-affected gate case), `test:workers` green, and a local
forced double-failure produces a single "N submissions" alert.

## What We're NOT Doing

- **S-04 (instant new-submission notify) / S-05 (weekly digest)** — we build the reusable
  `sendEmail()` channel they consume, but implement neither (FR-016/FR-017 nice-to-have).
- **Slack / Teams / any non-email channel** — v2 per roadmap.
- **Cloudflare Email Service binding** — Resend (GA) for MVP; revisit the native binding at GA.
- **Store-independent alert transport for the total-outage case** — documented recovery path
  only (processing-stranded → re-enqueue); not a second transport.
- **Cross-invocation throttle / durable dedup (KV or table)** — coalescing is per-invocation
  only; no new binding or dedup store.
- **Dedicated alert address / per-admin routing config** — recipients = `ALLOWED_ADMIN_EMAILS`.
- **Reading `admin_allowlist` for recipients** — it's the RLS gate and drifts on removal.
- **Changing retry/backoff/`max_retries`/DLQ config** — the terminal-failure mechanics are
  unchanged; we only gate and consume the existing signal.
- **DB schema / migration changes** — `markFailed`'s store query gains a row count, code-only.

## Implementation Approach

Three phases, dependency-ordered. **Phase 1** builds the channel as pure, env-gated lib
modules under `src/lib/notifications/` (transport, recipient resolver, coalescing
payload-builder) with full unit coverage and no consumer wiring — shippable and testable in
isolation. **Phase 2** is a self-contained correctness fix to F-03 code: `markFailed` returns
rows-affected and the existing signal + Sentry capture are gated on it (fixes the clobber for
all sinks, independent of email). **Phase 3** wires the alerter: an `alertAdmin?` collector
seam on `ConsumerContext` (mirroring `captureError`) that the consumer calls at the two
terminal points gated on rows-affected; `worker.ts` buffers failures across the batch and
flushes one coalesced email after the loop. The consumer stays SDK/transport-free; all
coalescing *logic* lives in the Phase-1 pure builder so `worker.ts` only buffers and calls it.

## Critical Implementation Details

- **`markFailed` return-type change is a contract change** — the interface (`consumer.ts:60`),
  the Supabase store impl (`consumer.ts:311-324`, must surface rows-affected, e.g. `.select("id")`
  → `data.length`), both call sites (`:141-154`, `:197-217`), and `consumer.test.ts` all move
  together (lesson: change interface → update all callers in the same change).
- **Gate semantics**: on `rowsAffected > 0` → emit signal + capture + record alert, then
  `ack`. On `rowsAffected === 0` (row re-claimed / already `done`) → **skip** signal/capture/
  alert but still `ack` (another claim owns the row — it's handled, not a failure to report).
  This is the lessons.md "emit only when the write affected a row" rule applied to all sinks.
- **Coalescing lives at batch scope, logic in the pure builder**: `alertAdmin?(item)` is a
  *collector* (pushes one safe-field item), not a sender. `worker.ts` owns a batch-local
  array, passes a push-collector into `consumerCtx`, and after the `for` loop calls the
  Phase-1 builder + `sendEmail` once if the array is non-empty. Keeps the consumer
  transport-free and the coalescing math node-testable.
- **Env-gated no-op**: `sendEmail` reads `RESEND_API_KEY` + `ALERT_FROM`; if either is absent
  it no-ops (returns without a fetch), mirroring the `SENTRY_DSN?` pattern — no fake sends in
  dev/test, FR-018 activates by setting secrets + verifying a domain later.
- **One recipient parser**: extract the `ALLOWED_ADMIN_EMAILS` parsing (comma-split, trim,
  lowercase, drop empties) into a shared pure helper reused by both `src/lib/auth/allowlist.ts`
  and the new recipient resolver, so the app-side list stays a single source of truth (the
  resolver reads `env.ALLOWED_ADMIN_EMAILS` from the Worker `Env`, not `admin_allowlist`). The
  resolver reads the **raw Worker binding** rather than `astro:env/server` because the `queue`
  handler runs outside any Astro request context, where `astro:env` secret access can return
  `undefined` — both paths resolve the same Cloudflare secret. This requires `ALLOWED_ADMIN_EMAILS`
  to be declared on the `Env` interface (see Phase 1 §4).
- **Resend call**: raw `fetch` POST to `https://api.resend.com/emails`, `Authorization:
  Bearer ${RESEND_API_KEY}`, JSON `{ from, to, subject, text }`; injectable `fetchImpl` for
  tests (mirrors `openai.ts:42-66`). One subrequest per coalesced send.

---

## Phase 1: Email channel module + secrets

### Overview

Build the reusable, env-gated email channel as pure lib modules with full unit coverage. No
consumer changes — at the end of this phase the channel is callable and tested but not yet wired.

### Changes Required:

#### 1. Email transport (Resend)

**File**: `src/lib/notifications/email.ts` (new)

**Intent**: A single `sendEmail()` helper every notification feature (S-03/04/05) reuses;
env-gated so it no-ops without secrets, and SDK-free so it's bundle-lean and mockable.

**Contract**: `sendEmail(opts: { to: string[]; subject: string; text: string; env: Env; fetchImpl?: typeof fetch }): Promise<{ sent: boolean }>`.
Reads `env.RESEND_API_KEY` + `env.ALERT_FROM`; if either is missing → return `{ sent: false }`
without a network call (no throw). Otherwise POST to `https://api.resend.com/emails` with
`Authorization: Bearer`, body `{ from: ALERT_FROM, to, subject, text }`, using `fetchImpl ?? fetch`.
Non-2xx → throw (caller decides; the FR-018 flush will swallow+log so a provider blip never
breaks enrichment). Empty `to` → `{ sent: false }`.

#### 2. Recipient resolver + shared parser

**File**: `src/lib/notifications/recipients.ts` (new); `src/lib/email/parse-email-list.ts` (new — neutral shared parser); `src/lib/auth/allowlist.ts` (refactor)

**Intent**: Resolve alert recipients from the same single source of truth as auth, without
re-reading the drift-prone DB allowlist.

**Contract**: Extract the email-list parser (comma-split → trim → lowercase → drop empties)
into a shared pure helper `parseEmailList(raw: string | undefined): string[]` in a **neutral
module** (`src/lib/email/parse-email-list.ts`), NOT inside `notifications/` — so `auth/allowlist.ts`
does not end up importing from `notifications/` (`allowlist.ts` is load-bearing, imported by
middleware/signin/callback; the dependency direction auth→notifications would be wrong). Used by
both `allowlist.ts` (unchanged external behavior) and `recipients.ts`. `resolveAlertRecipients(env: Env): string[]`
returns `parseEmailList(env.ALLOWED_ADMIN_EMAILS)` — fail-closed (unset → `[]`).

#### 3. FR-018 coalescing payload-builder

**File**: `src/lib/notifications/fr018-alert.ts` (new)

**Intent**: Turn N terminal-failure items collected in one invocation into one anonymity-safe
email; the only place alert wording lives.

**Contract**: `type FailureAlertItem = { submissionId: string; errorType: "permanent" | "retry_exhausted"; attempts: number; errorKind?: string; errorStatus?: number; timestamp: string }`.
`buildEnrichmentFailureAlert(items: FailureAlertItem[]): { subject: string; text: string }` — subject
reflects count ("Wzbogacenie AI nie powiodło się — N zgłoszeń" / singular form for 1); body lists
each item's safe fields only. Constructs from the typed fields exclusively — there is no code
path to content/signature/raw error.

#### 4. Secrets declaration

**File**: `src/worker-env.d.ts`, `.env.example`, `.dev.vars` (local)

**Intent**: Make the two new secrets first-class + optional (no-op when absent), and surface the
existing `ALLOWED_ADMIN_EMAILS` secret on the Worker `Env` so the queue-path resolver can read it.

**Contract**: Add `RESEND_API_KEY?: string` and `ALERT_FROM?: string` to the `Env` interface
(optional, like `SENTRY_DSN?`); add both to `.env.example` (documented) and `.dev.vars` (local,
may stay blank until a domain is verified). **Also add `ALLOWED_ADMIN_EMAILS?: string` to `Env`**:
it is declared today only as an Astro `envField` secret (`astro.config.mjs:71`) consumed via
`astro:env/server` (`allowlist.ts:1`), so it is absent from the Worker `Env` interface
(`src/worker-env.d.ts:16-29`) and `resolveAlertRecipients(env)` would fail `npm run typecheck`
(Phase-1 gate 1.3) without it. It already exists as a Cloudflare secret (`.dev.vars` locally,
`wrangler secret put` in prod), so the raw `env` binding carries the value at runtime — the
Phase-3 forced-failure manual check (3.7) exercises this end-to-end, since a real send requires
recipients to resolve from the binding (empty binding ⇒ no recipients ⇒ no alert).

#### 5. Unit tests

**File**: `src/lib/notifications/email.test.ts`, `recipients.test.ts`, `fr018-alert.test.ts` (new)

**Intent**: Lock the env-gate, the fail-closed recipients, and the anonymity seal.

**Contract**: email — no-op (no fetch) when key/from absent; correct Resend request shape via
injected `fetchImpl` when present; throw on non-2xx; empty `to` → not sent. recipients — parse
list, empty/unset env → `[]`, trim/lowercase/dedupe-of-empties (mirrors `allowlist.test.ts`
module pattern). fr018-alert — 1 item → singular subject; N items → "N" subject listing all;
**shape-seal**: assert the rendered `text`/`subject` contain none of a planted `content`/
`signature`/raw-error string (anonymity).

### Success Criteria:

#### Automated Verification:

- Module tests green: `npx vitest run src/lib/notifications/`
- Full node suite green: `npm test`
- Typecheck passes: `npm run typecheck`
- Lint passes: `npm run lint`

#### Manual Verification:

- Optional (deferred until a sender domain is verified, NOT a merge blocker): with a real
  `RESEND_API_KEY` + verified `ALERT_FROM` in `.dev.vars`, a one-off `sendEmail` call delivers
  to the inbox (Resend dashboard shows the send).

**Implementation Note**: After automated gates pass, pause for manual confirmation before Phase 2.

---

## Phase 2: Gate the failure signal on rows-affected

### Overview

Close the inherited spurious-signal clobber at its root, independent of the email feature:
`markFailed` returns rows-affected, and `emitFailureSignal` + the Sentry capture are gated on
it. This alone removes false `enrichment_failed` log/Sentry events.

### Changes Required:

#### 1. `markFailed` returns rows-affected

**File**: `src/lib/enrichment/consumer.ts` (interface + Supabase store impl)

**Intent**: Let the caller distinguish "wrote the failed row" from "guarded UPDATE matched
zero rows (re-claimed/done)".

**Contract**: Change `markFailed(...): Promise<void>` (`consumer.ts:60`) to return the number
of rows affected (`Promise<number>`). The store impl (`consumer.ts:311-324`) surfaces the count
from the guarded UPDATE (e.g. `.select("id")` → `data.length`). No migration; query semantics
unchanged otherwise.

#### 2. Gate the two terminal points

**File**: `src/lib/enrichment/consumer.ts` (permanent `:141-154`, DLQ `:197-217`)

**Intent**: Emit the durable signal + Sentry capture only when the failed write actually
landed; always ack.

**Contract**: At both call sites, branch on the `markFailed` return: `> 0` → `emitFailureSignal(...)`
+ `captureError?(...)` then `ack`; `=== 0` → skip both, still `ack`. (Phase 3 adds the alert
collector to the same `> 0` branch.)

#### 3. Tests for the gate

**File**: `src/lib/enrichment/consumer.test.ts`

**Intent**: Pin the new behavior the existing suite can't model (mocked store now reports
rows-affected).

**Contract**: Extend the store mock to return a configurable rows-affected. **First update the
shared `makeStore` default `markFailed` from `Promise.resolve()` to `Promise.resolve(1)`**
(`consumer.test.ts:26-38`): the existing success-path assertions — `:144` (permanent ⇒
`captureError` fires once), `:237` (retry-exhausted ⇒ `captureError` fires once), plus the
`emitFailureSignal` log-line asserts — drive markFailed-success and expect the signal/capture to
FIRE; under the new `rowsAffected > 0` gate they go red if the default mock still resolves
`undefined`. Then add cases: re-claimed row (markFailed → 0) ⇒ neither `emitFailureSignal` nor
`captureError` called, message still ack'd; normal terminal failure (→ 1) ⇒ both called once.
Keep the existing markFailed-throws → retry cases green.

### Success Criteria:

#### Automated Verification:

- Enrichment suite green incl. new gate cases: `npx vitest run src/lib/enrichment/`
- Full node suite green: `npm test`
- Typecheck passes: `npm run typecheck`
- Lint passes: `npm run lint`

#### Manual Verification:

- Code review confirms the gate semantics: on `rowsAffected === 0` neither signal nor capture
  fire and the message is still ack'd; on `> 0` both fire exactly once (matches `lessons.md:61-66`).

**Implementation Note**: After automated gates pass, pause for manual confirmation before Phase 3.

---

## Phase 3: Wire the alerter + per-invocation coalescing

### Overview

Connect the channel to the consumer: an injected `alertAdmin?` collector seam, called at the
gated terminal points; `worker.ts` buffers failures across the batch and flushes one coalesced
FR-018 email after the loop. Document the total-outage recovery path.

### Changes Required:

#### 1. `alertAdmin?` collector seam

**File**: `src/lib/enrichment/consumer.ts` (`ConsumerContext` + both terminal points)

**Intent**: Let the consumer record a terminal failure for alerting without knowing about
email — mirrors `captureError`.

**Contract**: Add `alertAdmin?: (item: FailureAlertItem) => void` to `ConsumerContext`
(`consumer.ts:70-93`). Call `ctx.alertAdmin?.({ submissionId, errorType, attempts, errorKind?, errorStatus?, timestamp })`
in the **`rowsAffected > 0`** branch at both terminal points (alongside the now-gated signal +
capture). Pure record; no send here. Tests omit it → no-op (mirrors `captureError`).

#### 2. Buffer + flush in the queue handler

**File**: `src/worker.ts` (`queue` handler, `:36-54`)

**Intent**: Coalesce all of one invocation's terminal failures into a single email; keep the
send out of the consumer.

**Contract**: Before the message loop, create a batch-local `FailureAlertItem[]` and set
`consumerCtx.alertAdmin = (item) => buffer.push(item)`. After the loop, if `buffer.length > 0`,
resolve recipients (`resolveAlertRecipients(env)`), build the email (`buildEnrichmentFailureAlert(buffer)`),
and `await sendEmail({ to, ...payload, env })` inside try/catch — a send failure is logged
(id-less, anonymity-safe) and swallowed so it never fails the batch or re-drives enrichment.
No recipients (empty allow-list) or env-gated no-op → skip silently.

#### 3. Document the total-outage recovery path

**File**: `src/worker.ts` (comment near the flush) + this plan's Migration Notes

**Intent**: Make the known blind spot explicit rather than silent.

**Contract**: A short comment: under a full Supabase outage the DLQ message is dropped and no
alert fires; recovery is the cron sweep for `pending` rows plus a manual "processing-stranded →
re-enqueue" step. No code beyond the comment.

### Success Criteria:

#### Automated Verification:

- `src/lib/` suites green: `npx vitest run src/lib/`
- Full node suite green: `npm test`
- Typecheck passes: `npm run typecheck`
- Lint passes: `npm run lint`
- Build passes: `npm run build`
- Workers-runtime suite green (build is prerequisite): `npm run test:workers`

#### Manual Verification:

- Local: `npm run build` + `wrangler dev`; force ≥2 terminal enrichment failures in one batch
  via a temporary in-worker dev hook (per `lessons.md` queue-testing rule — enqueue from inside
  the Worker, revert before commit); confirm exactly ONE coalesced "N zgłoszeń" alert is
  produced (sent when secrets set; clean no-op otherwise).
- Alert payload contains only safe fields (submissionId / errorType / attempts / errorKind /
  errorStatus / timestamp) — no content, signature, or raw error.
- Env-gated: with `RESEND_API_KEY`/`ALERT_FROM` unset the flush no-ops (no send attempted) and
  enrichment completes normally.
- Total-outage recovery path is documented (worker comment + plan) — reviewer confirms.

---

## Testing Strategy

### Unit Tests:

- `email.test.ts` — env-gate no-op, correct Resend request via injected `fetchImpl`, throw on
  non-2xx, empty-recipients skip.
- `recipients.test.ts` — parse/empty/fail-closed (shared parser; mirrors `allowlist.test.ts`).
- `fr018-alert.test.ts` — singular vs N-item subject/body; anonymity shape-seal (planted
  content/signature/raw-error never appears in output).
- `consumer.test.ts` — rows-affected gate matrix (0 ⇒ no signal/capture/alert + ack; >0 ⇒ all
  fire once); existing transient/permanent/throw cases stay green.

### Integration / Workers Tests:

- `npm run test:workers` exercises the worker-runtime wiring (queue handler + consumer) after
  build; the coalescing *logic* is covered in node via the pure builder, so the worker test
  only needs to confirm the seam is wired, not re-test math.

### Manual Testing Steps:

1. `npm run build` + `wrangler dev`; in-worker dev hook enqueues 2 submissions that force
   terminal failure (e.g. a permanent 4xx from a stubbed OpenAI) → confirm ONE coalesced alert.
2. Unset `RESEND_API_KEY`/`ALERT_FROM` → confirm clean no-op (enrichment unaffected).
3. Inspect the produced payload/log → confirm only safe fields present.

No E2E (test-plan §7 — no browser-needing risk). No Stryker (outside top-risk modules).

## Performance Considerations

One extra Resend subrequest per *batch that had failures* (coalesced), far under Workers
subrequest limits and the Resend free cap (100/day) at MVP volume. `markFailed` gains a row
count — negligible. No new queries on hot paths.

## Migration Notes

No DB schema or data migration. `markFailed`'s store query gains a row-count return
(code-only). **Total-outage recovery (documented gap)**: under a whole-window Supabase outage
the DLQ message is dropped with no `failed` write and no alert; recovery is the 15-min cron
sweep for `pending` rows plus a manual `processing`-stranded → re-enqueue. Rollback: clear
`RESEND_API_KEY`/`ALERT_FROM` (channel no-ops) and/or revert the `alertAdmin` wiring; the
Phase-2 gate is a strict correctness improvement and stays.

## References

- Research: `context/changes/notification-channel-and-ai-alert/research.md`
- Roadmap S-03 + email-only decision: `context/foundation/roadmap.md:156-167,213`
- PRD FR-018 / FR-008 / NFR anonymity: `context/foundation/prd.md:115-116,123,138-140`
- Signal source + seam precedent: `src/lib/enrichment/log.ts:33-48`, `src/lib/enrichment/consumer.ts:60,70-93,141-154,176-218,311-324`, `src/worker.ts:40-53`
- Outbound-HTTP pattern: `src/lib/enrichment/openai.ts:42-66`
- Recipient source: `src/lib/auth/allowlist.ts:12-27`
- Lessons binding S-03: `context/foundation/lessons.md:61-66` (gate signal on rows-affected), `:68-73` (decouple/outage), `:103-122` (PII/geo)
- Prior art: `context/archive/2026-06-02-ai-enrichment-queue/` (plan.md:272-278, follow-ups/markfailed-clobber-fix-2026-06-05.md:71-77, reviews/impl-review-phase-3.md:34-49)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Email channel module + secrets

#### Automated

- [x] 1.1 Module tests green: `npx vitest run src/lib/notifications/` — 7dacc1f
- [x] 1.2 Full node suite green: `npm test` — 7dacc1f
- [x] 1.3 Typecheck passes: `npm run typecheck` — 7dacc1f
- [x] 1.4 Lint passes: `npm run lint` — 7dacc1f

#### Manual

- [ ] 1.5 Optional (deferred until sender domain verified): real-key `sendEmail` delivers to inbox

### Phase 2: Gate the failure signal on rows-affected

#### Automated

- [x] 2.1 Enrichment suite green incl. new gate cases: `npx vitest run src/lib/enrichment/` — 8ad0372
- [x] 2.2 Full node suite green: `npm test` — 8ad0372
- [x] 2.3 Typecheck passes: `npm run typecheck` — 8ad0372
- [x] 2.4 Lint passes: `npm run lint` — 8ad0372

#### Manual

- [x] 2.5 Code review confirms gate semantics (0 ⇒ no signal/capture + ack; >0 ⇒ both once) — 8ad0372

### Phase 3: Wire the alerter + per-invocation coalescing

#### Automated

- [x] 3.1 `src/lib/` suites green: `npx vitest run src/lib/`
- [x] 3.2 Full node suite green: `npm test`
- [x] 3.3 Typecheck passes: `npm run typecheck`
- [x] 3.4 Lint passes: `npm run lint`
- [x] 3.5 Build passes: `npm run build`
- [x] 3.6 Workers-runtime suite green: `npm run test:workers`

#### Manual

- [ ] 3.7 Local forced double-failure produces exactly ONE coalesced alert (`wrangler dev` + in-worker hook)
- [x] 3.8 Alert payload contains only safe fields (no content/signature/raw error)
- [x] 3.9 Env-gated no-op confirmed when `RESEND_API_KEY`/`ALERT_FROM` unset
- [x] 3.10 Total-outage recovery path documented (worker comment + plan)
