# New-Submission Instant Notify (S-04 / FR-016) Implementation Plan

## Overview

Send an instant email to the admin allow-list every time a **new** submission is inserted, reusing
the email channel S-03 built (`sendEmail` + `resolveAlertRecipients`). This is the FR-016
nice-to-have, distinct from S-03's FR-018 *failure* alert. The work is a new pure message builder, a
thin send orchestrator, and a non-blocking dispatch hooked into the insert route. No schema change,
no new secret, no new infra.

## Current State Analysis

- **The channel already exists and was built generic for this slice.** S-03's plan explicitly names
  S-04 as the next consumer of `sendEmail`. Reusable as-is:
  - `sendEmail(opts: { to, subject, text, env, fetchImpl? }): Promise<{ sent: boolean }>` —
    `src/lib/notifications/email.ts:27`. Resend via raw `fetch`. **Env-gated no-op**: returns
    `{ sent: false }` without a network call when `RESEND_API_KEY` or `ALERT_FROM` is absent, or when
    `to` is empty. Throws on non-2xx.
  - `resolveAlertRecipients(env): string[]` — `src/lib/notifications/recipients.ts:16`. Parses
    `ALLOWED_ADMIN_EMAILS`; **fail-closed → `[]`**. Reads the raw Worker `env`, not `astro:env/server`.
  - Pure-builder pattern to mirror: `buildEnrichmentFailureAlert` — `src/lib/notifications/fr018-alert.ts:43`.
    Its anonymity seal (the input type carries *only* safe fields, so there is no code path to
    `content`/`signature`/raw error) is the model for this slice's builder.
- **Trigger site:** `src/pages/api/submissions.ts:46-50` — the successful service-role insert. The
  handler already holds `branch` / `topic` / `department` in `validation.value`, plus `data.id` from
  `.select("id").single()`. `created_at` is DB-defaulted and not currently selected.
- **The <1s NFR is real and the route must not block on Resend.** The enqueue is `await`ed only
  because `QUEUE.send` is a sub-second write (`submissions.ts:66-71`); a Resend HTTP round-trip is not
  guaranteed sub-second.
- **Deferred work primitive:** `Astro.locals.runtime.ctx` was **removed** in Astro v6 +
  `@astrojs/cloudflare` v13 (it throws). The supported replacement is **`Astro.locals.cfContext`** —
  the raw Cloudflare `ExecutionContext` (`node_modules/@astrojs/cloudflare/dist/utils/cf-helpers.js:23-52`).
  `cfContext.waitUntil(promise)` defers work past the response and guarantees it completes (an
  un-awaited promise without `waitUntil` may be cancelled when the request ends).
- **Anonymity guardrail:** `submission-input.ts:19-26` whitelists `branch/topic/content/department?/signature?`.
  `content` and `signature` must never leave the gated app surface; `signature` is a chosen identity →
  including it would deanonymize. No IP/headers/cookies are stored or logged anywhere on this path.
- **External-store sign-off (per lessons: "audit PII on the event the external store holds").** This
  email moves submission *attributes* — branch, department, topic, the DB timestamp, and the submission
  UUID — out of the auth-gated dashboard into Resend (an external SaaS that logs/retains) and into
  forwardable admin inboxes. Accepted because: (a) these are submission attributes, not submitter
  identity — the real deanonymizers (`content`/`signature`) are sealed out by the builder's input type;
  (b) recipients are trusted allow-list admins who already see these exact fields in the gated app; (c)
  no submitter IP/identity rides the email or its envelope (`to` = admins, `from` = `ALERT_FROM`). Residual
  risk acknowledged: in a small department, `branch + department + time` could narrow the submitter, and
  the email is searchable/forwardable outside the gated surface — judged acceptable at this scale, not
  overlooked. (Mirrors S-03's FR-018 alert, which already mails `submissionId` + error metadata to the
  same inbox.)
- **One insert = one submission.** Unlike S-03 (which coalesces a queue *batch* into one email), each
  HTTP request creates exactly one row → exactly one email. No buffering/coalescing needed.

### Key Discoveries:

- `Astro.locals.cfContext.waitUntil(...)` is the reachable deferred-work hook here — `runtime.ctx` throws.
- The insert handler has all needed fields without a second query: `validation.value` (branch/topic/department)
  + `data.id`; add `created_at` to the `.select()`.
- `sendEmail` and `resolveAlertRecipients` are both already env-gated / fail-closed, so the whole path
  is a clean no-op in dev/test and until prod secrets land — matching the chosen done-line.
- Mocking policy (test-plan §6.2): mock only at the edge (Supabase client, QUEUE, Resend `fetch`), never internal modules.

## Desired End State

A submitter posts the form; the route returns `201` in <1s exactly as today. After the response, a
single email is dispatched to every admin on `ALLOWED_ADMIN_EMAILS` carrying: time, branch, department
(if given), topic, and a one-click link to `/dashboard/submissions/<id>` (auth-gated). The email never
contains `content` or `signature`. With Resend secrets unset (dev/test/pre-activation prod) the whole
path no-ops silently and the `201` is unaffected. Verified by: green unit tests on the builder +
orchestrator (incl. anonymity seal), green route integration tests (fires once on success, never on
400/500, send-failure can't break the 201), full `npm test` green, typecheck + lint clean.

## What We're NOT Doing

- **No coalescing/debounce** — one email per submission (chosen). Cross-request batching would need
  durable state (KV/DO); unjustified at this scale and it would break the "instant" promise.
- **No notification from the recovery cron or the enrichment consumer** — insert path only (roadmap S-04).
- **No new env var** — detail-link base URL comes from the request origin, not a `PUBLIC_APP_URL` secret.
- **No schema/migration** — `created_at` already exists; we only add it to a `SELECT`.
- **No content/signature in the email — ever** (anonymity guardrail).
- **No durable retry/recovery for a failed notify** — best-effort log-and-swallow (nice-to-have).
- **No live inbox-delivery gate as a merge blocker** — deferred to prod activation (chosen done-line, mirrors S-03).

## Implementation Approach

Mirror S-03's separation: a **pure builder** owns wording + the anonymity seal, a **thin orchestrator**
owns recipient resolution + send + swallow, and the **route** owns only the `waitUntil` dispatch. The
orchestrator returns a `Promise<void>` so the route can hand it to `cfContext.waitUntil` without
awaiting — keeping the <1s NFR while guaranteeing the deferred send runs. The builder's input type
carries only safe fields, so leaking `content`/`signature` is impossible by construction (not by a
runtime filter), exactly like `fr018-alert.ts`.

## Critical Implementation Details

- **Deferred dispatch:** use `context.locals.cfContext.waitUntil(notifyNewSubmission(...))` — **no
  optional chain**. `App.Locals extends Runtime` (`@astrojs/cloudflare`) types `cfContext` as a
  non-nullable `ExecutionContext`, and the adapter's `handle()` populates it unconditionally via
  `createLocals(ctx)` for every rendered route (dev AND prod). Under this repo's
  `tseslint strictTypeChecked` config, `cfContext?.waitUntil` would be flagged by
  `no-unnecessary-condition` (the chain is provably unnecessary) → `npm run lint` fails. So call it
  straight. Do **not** use `Astro.locals.runtime.ctx` (throws in this stack). Do **not** `await` the
  send inline (adds Resend RTT to the response, risking the <1s NFR) and do **not** fire-and-forget
  without `waitUntil` (the promise may be cancelled after the response). `cfContext` is absent only in
  synthetic unit contexts — so the shared test context helper(s) (`makeContext`/`makeParanoidContext`
  in `_submissions.test.ts`) must each carry a no-op `cfContext.waitUntil`, or every existing
  success-path test throws on the now-unconditional call.
- **Anonymity by construction:** the builder's input type must include only `submissionId, branch,
  topic, department?, createdAt` (+ a `detailUrl`/`baseUrl`). The route must explicitly pick these from
  `validation.value` — never spread `validation.value` (which carries `content`/`signature`) into the notice.

## Phase 1: Notification builder + orchestrator

### Overview

Author the pure message builder and the send orchestrator, both env/recipient-gated, with full unit
coverage including the anonymity seal. No route changes yet.

### Changes Required:

#### 1. New-submission alert module

**File**: `src/lib/notifications/new-submission-alert.ts` (new)

**Intent**: Provide a pure builder that turns one new submission's safe fields into a Polish
`{ subject, text }` email (time + branch + department-if-present + topic + a gated detail link), and a
thin orchestrator that resolves recipients and sends via the existing channel, swallowing+logging any
failure. Mirrors `fr018-alert.ts` (builder) and the FR-018 flush (orchestration/swallow).

**Contract**:
- `interface NewSubmissionNotice { submissionId: string; branch: Branch; topic: Topic; department?: Department; createdAt: string }`
  — the seal: **only** safe fields, no `content`/`signature`. Reuse the taxonomy types from
  `@/lib/submissions/taxonomies`. The stored values ARE already display-ready Polish labels
  (`BRANCHES` = "Gliwice"/"Centrala", `TOPICS` = "Pomysł"/"Problem", `DEPARTMENTS` = "IT"/"HR") — render
  them verbatim. There is no label map in `taxonomies.ts` and none is needed; do not build one.
- `buildNewSubmissionNotification(notice: NewSubmissionNotice, baseUrl: string): { subject: string; text: string }`
  — pure. Subject includes the topic for glanceability (e.g. `Nowe zgłoszenie — <topic>`). Body lists
  czas/oddział/[dział]/tematyka and a line linking to `${baseUrl}/dashboard/submissions/${submissionId}`.
  Department line omitted when `department` is undefined.
- `notifyNewSubmission(env: Env, notice: NewSubmissionNotice, baseUrl: string): Promise<void>` —
  resolve `resolveAlertRecipients(env)`; if empty, return (no-op). Else build + `sendEmail({ to, subject,
  text, env })`. Wrap the **whole body** (resolve + build + send) in try/catch — not just the send — so
  ANY failure logs an **id-less** marker (`{ event: "new_submission_notify_failed", timestamp }`) and the
  returned promise always resolves; never throw. (Rationale: the route hands this promise to
  `waitUntil`; a throw escaping the swallow would surface as an unhandled rejection, not the intended
  logged marker. `resolveAlertRecipients` is fail-closed and the builder is pure, so this is belt-and-braces.)

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npx vitest run src/lib/notifications/new-submission-alert.test.ts`
- Typecheck passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- The rendered sample email (subject + body) reads naturally in Polish, includes the detail link, and shows the department line only when a department was provided.

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation before Phase 2.

---

## Phase 2: Wire the trigger into the insert route

### Overview

Dispatch the notification from the successful-insert path via `cfContext.waitUntil`, and prove the
route contract (fires once on success, never on failure, never blocks the 201) with integration tests.

### Changes Required:

#### 1. Insert route dispatch

**File**: `src/pages/api/submissions.ts`

**Intent**: After a successful insert, dispatch the new-submission notification without blocking the
response. Add `created_at` to the row read so the email can carry the real DB timestamp.

**Contract**:
- Change `.select("id")` → `.select("id, created_at")` (line 49). Insert *payload* is unchanged.
- After the `if (error)` early return (i.e. only on success), build a `NewSubmissionNotice` by **picking**
  `branch`/`topic`/`department` from `validation.value` + `data.id` + `data.created_at`; derive `baseUrl`
  from `new URL(context.request.url).origin`; dispatch via `context.locals.cfContext.waitUntil(notifyNewSubmission(env, notice, baseUrl))`
  (no `?.` — see Critical Implementation Details: `cfContext` is non-nullable + always populated; `?.` fails strictTypeChecked lint).
- Placement is independent of the enqueue block; an enqueue failure must not skip the notify and vice-versa.

#### 2. Route integration tests

**File**: `src/pages/api/_submissions.test.ts`

**Intent**: Lock the route's dispatch contract. Update the admin-client mock so `.select(...).single()`
returns `{ id, created_at }`. Add a synthetic `locals.cfContext.waitUntil` to the **shared** context
helpers (`makeContext` *and* `makeParanoidContext`) — a `vi.fn` that runs/awaits the promise — so every
existing success-path test survives the now-unconditional `cfContext.waitUntil` call (the dispatch has
no `?.`; see F1). Tests asserting the send-edge can capture the promise from the fn and await it.

**Contract**: Assert — (a) on a valid POST, `waitUntil` is called once; awaiting its promise hits the
Resend `fetch` edge with the safe body **only** (no `content`/`signature`) when recipients+secrets are
mocked present; (b) with no recipients/secrets, the send no-ops and the `201` still returns; (c) on a
validation 400 and an insert-error 500, `waitUntil`/notify is **not** called; (d) a thrown send does not
change the `201`. Keep mocking at the edge (Supabase, QUEUE, Resend `fetch`) — do not mock the internal notify module.

### Success Criteria:

#### Automated Verification:

- Route integration tests pass: `npx vitest run src/pages/api/_submissions.test.ts`
- Full node suite passes: `npm test`
- Typecheck passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- Local `wrangler dev` smoke: submitting the form returns `201` in <1s; with Resend secrets unset, an id-less `new_submission_notify_failed`/no-op path leaves the response unaffected.
- **[Deferred — not a merge blocker]** Live inbox delivery: with `RESEND_API_KEY` + `ALERT_FROM` set and a verified Resend sender domain in prod, a real submission lands an email at an allow-list address with the correct fields + working link (mirrors S-03's deferred gate).

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation.

---

## Testing Strategy

### Unit Tests (`new-submission-alert.test.ts`):

- Subject includes the topic; body lists czas/oddział/tematyka and the detail link.
- Department line present when given, omitted when absent.
- **Anonymity seal**: an object carrying extra `content`/`signature` keys never renders them (mirror `fr018-alert.test.ts:59-79`).
- `notifyNewSubmission`: empty recipients → `sendEmail` not invoked / no send; recipients present → `sendEmail` called with the built payload; `sendEmail` throws → swallowed (no throw), id-less marker logged.

### Integration Tests (`_submissions.test.ts`):

- Fires once via `waitUntil` on success; never on 400/500; 201 unaffected by a send failure; Resend edge receives safe body only.

### Manual Testing Steps:

1. `wrangler dev`, submit the public form, confirm `201` in <1s.
2. Without Resend secrets: confirm no crash, response unaffected (no-op path).
3. (Deferred, prod) With secrets + verified domain: confirm an email arrives with the right fields and the link opens the auth-gated detail view.

## Performance Considerations

The send is deferred via `waitUntil`, so it adds zero latency to the `201`. The insert read gains one
column (`created_at`) — negligible.

## Migration Notes

None — no schema change. `created_at` already exists; only a `SELECT` is widened.

## References

- Change notes: `context/changes/new-submission-instant-notify/change.md`
- Reused channel: `src/lib/notifications/email.ts:27`, `src/lib/notifications/recipients.ts:16`
- Builder pattern to mirror: `src/lib/notifications/fr018-alert.ts:43` (+ `fr018-alert.test.ts:59-79` anonymity seal)
- Trigger site: `src/pages/api/submissions.ts:46-50`
- `cfContext` (deferred work): `node_modules/@astrojs/cloudflare/dist/utils/cf-helpers.js:23-52`
- S-03 prior decisions: `context/archive/2026-06-13-notification-channel-and-ai-alert/`
- Relevant lessons: `context/foundation/lessons.md` — "Audit PII on the event stored by the telemetry backend" (the inbox is an external store), "Gate a durable failure signal on the guarded write actually applying"

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Notification builder + orchestrator

#### Automated

- [x] 1.1 Unit tests pass: `npx vitest run src/lib/notifications/new-submission-alert.test.ts` — ad4f617
- [x] 1.2 Typecheck passes: `npm run typecheck` — ad4f617
- [x] 1.3 Linting passes: `npm run lint` — ad4f617

#### Manual

- [x] 1.4 Rendered sample email reads naturally in Polish, includes the link, and omits the department line when absent — ad4f617

### Phase 2: Wire the trigger into the insert route

#### Automated

- [x] 2.1 Route integration tests pass: `npx vitest run src/pages/api/_submissions.test.ts`
- [x] 2.2 Full node suite passes: `npm test`
- [x] 2.3 Typecheck passes: `npm run typecheck`
- [x] 2.4 Linting passes: `npm run lint`

#### Manual

- [x] 2.5 `wrangler dev` smoke: 201 in <1s, response unaffected with secrets unset
- [ ] 2.6 [Deferred — not a merge blocker] Live inbox delivery with prod Resend secrets + verified domain
