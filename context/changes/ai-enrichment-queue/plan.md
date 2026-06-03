# Async AI Enrichment Plumbing (F-03) Implementation Plan

## Overview

Build the asynchronous AI-enrichment path for the digital idea box: a Cloudflare Queue plus a consumer that pulls each submission job, calls OpenAI `gpt-4o-mini` (Structured Outputs) to produce a tone label, a classification, a short title, and a 1–2 sentence summary, then writes those back into the submission row. The consumer relies on native Cloudflare Queues retry with a dead-letter queue, stays idempotent under at-least-once redelivery, and on final failure marks the row `failed` and emits a structured FR-018 signal for a future notification change (S-03) to consume.

This is a **foundation** change (F-03, Stream A). It builds the plumbing that S-01 (the employee form) and S-03 (the failure-alert email) depend on — it does **not** build either of them.

## Current State Analysis

- **Output contract is already frozen by F-01.** `supabase/migrations/20260528000000_create_submissions.sql:46-77` defines the lifecycle columns (`enrichment_status` ∈ `pending|processing|done|failed`, `enrichment_attempts`, `enrichment_last_error`, `enrichment_attempted_at`) and the output columns (`ai_title`, `ai_tone` with a hard CHECK = `Pozytywny|Negatywny|Neutralny`, `ai_classification` = free `text` with no CHECK, `ai_summary`). **No migration is required for F-03 outputs.** The hardening follow-up (`20260529000000_…`) only touched `content`/`signature` length checks.
- **The consumer writes with the service-role key.** Migration lines 143-146 are explicit: `enrichment_*` and `ai_*` columns are deliberately *not* granted to `anon`/`authenticated`; the consumer uses `service_role`, which bypasses RLS and column grants. The existing client `src/lib/supabase.ts:7` is an SSR cookie/request-bound client (`createServerClient`) — unusable from a queue consumer, which has no request or cookies. A separate non-SSR service-role client is needed.
- **The adapter does not expose a queue handler by default.** `@astrojs/cloudflare` 13.5.0 runs on the new `@cloudflare/vite-plugin`; `wrangler.jsonc:4` points `main` at `@astrojs/cloudflare/entrypoints/server`, which exports only `{ fetch }`. The `workerEntryPoint` adapter option was removed; custom entrypoints are now specified via `wrangler.jsonc` `main`, and the custom file imports `handle` from `@astrojs/cloudflare/handler` (export confirmed present in 13.5.0) and exports a standard `ExportedHandler` with both `fetch` and `queue`.
- **`wrangler.jsonc` has no queue config.** It currently declares only `name`, `main`, `compatibility_date`, `nodejs_compat`, `assets`, and `observability`. F-03 adds `queues.producers` + `queues.consumers` (with a dead-letter queue).
- **Taxonomies are the single source of truth.** `src/lib/submissions/taxonomies.ts:46` already exports `TONES = [Pozytywny, Negatywny, Neutralny]`. There is **no** classification list yet — F-03 adds `CLASSIFICATIONS`, and the OpenAI Structured-Outputs JSON-schema enums must mirror both lists character-for-character (the lessons register flags diacritic drift as a silent production-breaker).
- **Env wiring.** `astro.config.mjs:17-23` declares `SUPABASE_URL`, `SUPABASE_KEY`, `ALLOWED_ADMIN_EMAILS` via `astro:env/server`. F-03 adds `OPENAI_API_KEY` and a service-role key. The `QUEUE` producer binding and queue-message type are runtime `Env` bindings, surfaced through the worker's `Env` type, not `astro:env`.
- **Producer (form endpoint) does not exist.** It is S-01. Per `context/foundation/lessons.md` ("Don't harden a consumer that doesn't exist yet"), F-03 ships a reusable enqueue helper + a dev verification harness, not the real endpoint.

### Key Discoveries:

- Output + lifecycle columns frozen: `supabase/migrations/20260528000000_create_submissions.sql:46-77`.
- Service-role bypass is the intended write path: same file, `:143-146`.
- Adapter dual-handler pattern: custom `main` → `import { handle } from '@astrojs/cloudflare/handler'`, export `{ fetch, queue }` (Astro Cloudflare docs; `./handler` export verified in installed 13.5.0).
- Taxonomy SSOT + diacritic-drift trap: `src/lib/submissions/taxonomies.ts:1-54`.
- AI call is I/O wait, not CPU: external `fetch` to OpenAI does not accumulate Worker CPU-time, so a single Worker handling both `fetch` and `queue` is viable even under tight CPU limits (per `infrastructure.md` Devil's-Advocate #2 framing — the *scaling* pattern is two Workers, but the MVP fits one).
- Local non-HTTP triggers need `wrangler dev`, not `astro dev` (`infrastructure.md` Unknown-Unknowns; roadmap F-03 risk).

## Desired End State

A deployed Worker that, given a submission id on the queue, enriches the row exactly once and writes `enrichment_status='done'` with a valid `ai_tone`/`ai_classification`/`ai_title`/`ai_summary`; on transient AI failure it retries with backoff via the platform; on exhausted retries (or a permanent error) it sets `enrichment_status='failed'` + `enrichment_last_error` and emits a structured FR-018 log signal; redelivery of an already-processed message does not double-call the AI or clobber a good result. Verified by: a real row inserted as `pending`, enqueued through the dev harness, ends `done`; a forced-failure row ends `failed` with the signal logged; a duplicate delivery is a no-op.

## What We're NOT Doing

- **No employee form / submission endpoint** — that is S-01. F-03 stops at the `enqueueEnrichment()` helper + a dev-only test producer.
- **No email/notification delivery** — that is S-03. F-03 emits only the `failed` DB state + structured log signal.
- **No Anthropic failover wiring** — OpenAI only, behind a provider seam Anthropic can drop into later.
- **No schema migration** — the F-01 columns already cover every output; `ai_classification` stays free text (app-level enum only).
- **No cron / weekly digest** — that is S-05; this change adds a `queue` handler only, not a `scheduled` handler.
- **No dashboard read surface** — S-02.
- **No retention/delete logic** — parked.

## Implementation Approach

Single Worker, dual handler. The current Astro `fetch` path is preserved verbatim by delegating to `handle()`; a `queue` handler is added to the same exported object. Messages carry only `{ submissionId }`; the consumer re-reads the row via a service-role client (DB is the single source of truth). Idempotency is enforced by a compare-and-swap claim on `enrichment_status` (`pending → processing`) before any AI call. Retry/backoff is delegated to the platform (`message.retry({ delaySeconds })` + configured `max_retries` + DLQ); the consumer never sleeps in-handler. AI access goes through a thin `enrich()` seam with one OpenAI implementation using Structured Outputs whose JSON-schema enums are generated from the taxonomy SSOT.

## Critical Implementation Details

- **Worker entry mechanism (load-bearing).** Do NOT keep `main: "@astrojs/cloudflare/entrypoints/server"`. Point `main` at the new custom entry and delegate the HTTP path to the adapter's `handle`, so no Astro routing behavior is lost:

  ```ts
  // src/worker.ts (illustrative — the contract other phases depend on)
  import { handle } from "@astrojs/cloudflare/handler";
  export default {
    fetch: (request, env, ctx) => handle(request, env, ctx),
    async queue(batch, env, ctx) { /* Phase 3 */ },
  } satisfies ExportedHandler<Env>;
  ```

- **At-least-once + idempotency.** Cloudflare Queues is at-least-once; the same message can be delivered more than once and batches can overlap on retry. The CAS claim (`UPDATE … SET enrichment_status='processing', enrichment_attempts=enrichment_attempts+1, enrichment_attempted_at=now() WHERE id=$1 AND enrichment_status='pending'`) must return whether a row was actually claimed; if zero rows changed, the message is either already `done` (ack and skip) or mid-flight/stale `processing`. A stale-`processing` reclaim rule (e.g. `enrichment_attempted_at` older than a threshold) prevents a crashed mid-flight job from wedging a row forever. **The normal transient-retry path resets the row to `pending` before `message.retry()` (see Phase 3, branch 4), so retries never depend on this threshold** — stale-`processing` reclaim is purely a crash backstop. That decoupling lets the threshold be set generously long (comfortably greater than the worst-case `enrich()` duration, e.g. 10–15 min) with zero risk of dropping a legitimate retry; a fresh-`processing` row therefore genuinely means another active invocation, so the no-claim branch can safely `ack` and skip.

- **`message.retry()` vs CPU/cost burn.** Transient errors (OpenAI 429/5xx/timeout/network) call `message.retry({ delaySeconds })` with exponential backoff and return — the platform redelivers later. Never loop-with-sleep in the handler; that burns wall-clock and risks the uncapped-spend scenario from `infrastructure.md` Unknown-Unknowns. Permanent errors (4xx schema/auth, content that cannot be enriched) go straight to `failed` without retry.

- **Final-failure detection.** Retry exhaustion has ONE authority: the platform's `max_retries` + dead-letter queue. Transient errors `message.retry()` until `max_retries` is hit; the message then lands on the DLQ, whose consumer (same Worker, second consumer binding, or a guard inside the same handler keyed on the queue name) performs the terminal `failed` + `enrichment_last_error` write and emits the FR-018 signal. The consumer's normal handler writes `failed` ONLY for **permanent** errors (4xx/schema/auth); it deliberately carries **no** second app-level `enrichment_attempts ≥ cap` check — two caps would race (whichever value is lower wins, leaving the other path dead code). `enrichment_attempts` is incremented for observability/forensics, not as a control gate.

- **Structured-output schema must mirror the taxonomy SSOT.** The OpenAI JSON schema's `tone` enum is built from `TONES` and `classification` enum from `CLASSIFICATIONS` (imported, not re-typed). A drift between the schema enum and the DB CHECK on `ai_tone` makes a structurally-valid AI response fail the row UPDATE.

- **Local verification.** `astro dev` (the Vite plugin) does not run queue consumers. Use `wrangler dev` against the built worker and put a test message on the queue via the dev harness (Phase 1) to exercise the `queue` path.

## Phase 1: Queue infrastructure + dual-handler worker skeleton

### Overview

Stand up the queue plumbing and the dual-handler Worker with a no-op consumer, so a message can round-trip and be logged before any AI or DB logic exists. This isolates the adapter-entry and binding wiring (the riskiest mechanical step) from the enrichment logic.

### Changes Required:

#### 1. Cloudflare queue resources

**Where**: Cloudflare account (via `wrangler queues create`) + `wrangler.jsonc`.

**Intent**: Create the main enrichment queue and a dead-letter queue, then declare producer + consumer bindings so the Worker can both send and consume.

**Contract**: Two named queues (e.g. `dib-enrichment` and `dib-enrichment-dlq`). `wrangler.jsonc` gains a `queues` block — a `producers` entry binding the send side to `QUEUE`, and a `consumers` entry for the main queue with `max_batch_size: 1`, a `max_retries` cap, and `dead_letter_queue` pointing at the DLQ. Queue creation is a manual account-level gate (see Prerequisites); the binding declaration is the code change.

```jsonc
// wrangler.jsonc additions (contract shape)
"queues": {
  "producers": [{ "queue": "dib-enrichment", "binding": "QUEUE" }],
  "consumers": [{
    "queue": "dib-enrichment",
    "max_batch_size": 1,
    "max_retries": 5,
    "dead_letter_queue": "dib-enrichment-dlq"
  }]
}
```

#### 2. Custom worker entry

**File**: `src/worker.ts` (new) + `wrangler.jsonc` `main`.

**Intent**: Replace the default adapter entry with a custom one that preserves the Astro HTTP path and adds a (no-op for now) `queue` handler.

**Contract**: `main` in `wrangler.jsonc` changes from `@astrojs/cloudflare/entrypoints/server` to `src/worker.ts`. The file imports `handle` from `@astrojs/cloudflare/handler`, exports `fetch` delegating to `handle(request, env, ctx)`, and a `queue(batch, env, ctx)` that logs each message and `ack`s it. See the snippet in Critical Implementation Details for the exact import/export shape.

#### 3. Worker `Env` type + queue message type

**File**: `src/env.d.ts` (extend) or a new `src/worker-env.d.ts`; a small `src/lib/enrichment/types.ts`. **Plus**: provision the Cloudflare Workers runtime types — these are NOT currently installed (verified: no `@cloudflare/workers-types` in `node_modules`, no `wrangler types` output, and `tsconfig.json` `include: ["**/*"]` means `astro check` WILL type-check `src/worker.ts`).

**Intent**: Type the `QUEUE` binding and the message payload so the producer helper and consumer share one contract, AND make the global Workers types (`Queue<T>`, `ExportedHandler<T>`, `MessageBatch`, `ExecutionContext`) resolve so the typecheck gates (1.2/2.1/3.1) are real and not silently failing.

**Contract**: Install `@cloudflare/workers-types` (dev dep) and add it to `tsconfig.json` `compilerOptions.types` (e.g. `"types": ["@cloudflare/workers-types"]`). Hand-write the `Env` interface (in `src/worker-env.d.ts` or augmenting `src/env.d.ts`) exposing `QUEUE: Queue<EnrichmentMessage>` plus the secret names; `EnrichmentMessage = { submissionId: string }`. Keep this distinct from `App.Locals` in the existing `src/env.d.ts:1-5`. **Do NOT use `npx wrangler types` for `Env` here** — it auto-generates `QUEUE: Queue` (untyped message) from the bindings and would collide with this hand-typed `Queue<EnrichmentMessage>`; the explicit `@cloudflare/workers-types` + hand-written `Env` route avoids that collision. (If a generated `worker-configuration.d.ts` is later desired for the runtime globals, drop the `types` entry and reconcile the two `Env` definitions in the same step.)

#### 4. Enqueue helper

**File**: `src/lib/enrichment/enqueue.ts` (new).

**Intent**: One reusable function S-01 will call from its form POST to fire-and-forget a job.

**Contract**: `enqueueEnrichment(env: { QUEUE: Queue<EnrichmentMessage> }, submissionId: string): Promise<void>` wrapping `env.QUEUE.send({ submissionId })`. No DB access, no AI — pure send.

#### 5. Env schema additions

**File**: `astro.config.mjs` (env schema) + `.env.example` if present.

**Intent**: Register the new server secrets the consumer needs so build/typecheck see them.

**Contract**: Add `OPENAI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` as `envField.string({ context: "server", access: "secret", optional: true })` mirroring the existing entries at `astro.config.mjs:18-21`. Actual values are set via `wrangler secret put` (manual gate), never committed.

#### 6. Dev verification harness

**File**: `scripts/enqueue-test.*` or a documented `wrangler` command (new, dev-only).

**Intent**: A throwaway way to put `{ submissionId }` on the queue while `wrangler dev` runs, so the consumer path is exercisable without S-01.

**Contract**: Either a small node/wrangler script invoking the producer, or a documented `npx wrangler dev` + manual enqueue recipe. Not shipped to production, not an HTTP route.

#### 7. Test runner setup (vitest)

**File**: `vitest.config.ts` (new) + `package.json` (`test` script) + one smoke test.

**Intent**: Stand up the test harness the Phase 2/3 unit-test gates (2.3, 2.4, 3.4, 3.5) depend on — the repo currently has no runner (no vitest/jest, no `test` script), so those "automated" gates are unrunnable until this exists.

**Contract**: Add `vitest` (and `@cloudflare/vitest-pool-workers` for the consumer/queue-context tests that need the Workers runtime; pure-logic tests like the drift-guard and `enrich()` mock run in the default node environment) as dev deps, a `"test": "vitest run"` script, a minimal `vitest.config.ts`, and one trivial smoke test that passes. The actual enrichment/idempotency tests are written in Phases 2–3. NOTE: this is the test *harness* only — strategic testing/quality-gate policy remains a later (Module-3) concern; this step exists solely so this change's own automated gates are real.

### Success Criteria:

#### Automated Verification:

- [ ] Build succeeds with the new entry: `npm run build`
- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] `wrangler.jsonc` parses (queues + new `main`): `npx wrangler deploy --dry-run --outdir=tmp/`
- [ ] Vitest is wired and the smoke test runs green: `npm test`

#### Manual Verification:

- [ ] `wrangler queues create dib-enrichment` and the DLQ both succeed on the account
- [ ] Under `npx wrangler dev`, a test message put on the queue is received and logged by the `queue` handler
- [ ] The existing HTTP routes (`/`, `/auth/signin`, `/dashboard` redirect) still render via the custom entry — no Astro routing regression

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation that the test message round-trips and HTTP routing is intact before proceeding.

---

## Phase 2: Service-role client + AI enrichment module + classification taxonomy

### Overview

Build the pieces the consumer will orchestrate: the classification list, a non-SSR service-role DB client, and the provider-seam `enrich()` function with the OpenAI Structured-Outputs implementation. Each is independently testable before the state machine wires them together.

### Changes Required:

#### 1. Classification taxonomy

**File**: `src/lib/submissions/taxonomies.ts`.

**Intent**: Add the AI classification category set as a fourth SSOT list, distinct from the user-picked `topic`.

**Contract**: Export `CLASSIFICATIONS = ["pomysł", "zgłoszenie", "propozycja", "błąd", "skarga"] as const` and `type Classification`, following the existing `TONES`/`TOPICS` pattern at lines 44-54. This set powers the AI `ai_classification` output and FR-011's dashboard pie chart (S-02). It is NOT DB-enforced (`ai_classification` has no CHECK), so it stays app-level — but the OpenAI schema and any future dashboard grouping read from this one const.

#### 2. Service-role Supabase client

**File**: `src/lib/enrichment/supabase-admin.ts` (new).

**Intent**: A request-less client the consumer uses to read the row and write enrichment, bypassing RLS via the service-role key.

**Contract**: `createAdminClient(env): SupabaseClient<Database>` built from `@supabase/supabase-js` `createClient` (NOT `@supabase/ssr`), using `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, with auth persistence disabled (no sessions in a worker). Typed against the existing `Database` from `src/lib/database.types.ts`.

#### 3. AI enrichment module (provider seam + OpenAI impl)

**File**: `src/lib/enrichment/enrich.ts` + `src/lib/enrichment/openai.ts` (new).

**Intent**: A provider-agnostic `enrich()` seam with one OpenAI implementation, so Anthropic can drop in later without touching the consumer.

**Contract**: `enrich(content: string, opts): Promise<EnrichmentResult>` where `EnrichmentResult = { tone: Tone; classification: Classification; title: string; summary: string }`. The OpenAI impl calls `gpt-4o-mini` with Structured Outputs (`response_format` JSON schema, `strict: true`); the schema's `tone` enum is built from `TONES` and `classification` from `CLASSIFICATIONS` (imported from taxonomies — never re-typed). The input is the submission `content` ONLY — never the `signature` (anonymity guardrail per PRD). The function throws typed errors distinguishing transient (429/5xx/timeout/network) from permanent (4xx/auth/schema) so the consumer can decide retry vs fail. **Seam discipline (lessons: "don't harden a consumer that doesn't exist yet"):** the seam is exactly one exported function `enrich()` + one impl file (`openai.ts`) — NO provider registry, factory, or strategy map. Anthropic is out of scope; swapping it in later means writing a second impl and changing one call site, not building selection machinery now.

```ts
// JSON-schema enum sourcing (contract — prevents diacritic drift)
import { TONES, CLASSIFICATIONS } from "../submissions/taxonomies";
// response_format schema: { tone: { enum: TONES }, classification: { enum: CLASSIFICATIONS }, title, summary }
```

#### 4. Error taxonomy

**File**: `src/lib/enrichment/errors.ts` (new) or inline in `enrich.ts`.

**Intent**: A small transient-vs-permanent classifier the consumer keys its retry decision on.

**Contract**: A way to tag a thrown error as `transient` or `permanent` (e.g. a discriminated error type or a `isTransient(err)` predicate). HTTP 429 + 5xx + network/timeout = transient; 400/401/403 + structured-output validation failure = permanent.

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes (taxonomy + module types line up): `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] `CLASSIFICATIONS` values match the prompt/schema enum — a unit assertion that the schema enum array equals the const
- [ ] `enrich()` unit test against a mocked OpenAI response returns a schema-valid `EnrichmentResult` (tone ∈ `TONES`, classification ∈ `CLASSIFICATIONS`)

#### Manual Verification:

- [ ] One real OpenAI call (live key, sample Polish submission content) returns a sensible tone/classification/title/summary
- [ ] The signature field is confirmed absent from the AI request payload (anonymity check)
- [ ] A simulated 429 is classified transient; a simulated 400 is classified permanent

**Implementation Note**: After automated verification passes, pause for manual confirmation of a live OpenAI round-trip and the anonymity check before wiring the consumer.

---

## Phase 3: Consumer state machine — claim → enrich → write-back → retry/DLQ → failure signal

### Overview

Wire the `queue` handler into the full lifecycle: claim the row idempotently, enrich, write back, retry transient failures via the platform, and on terminal failure mark `failed` + emit the FR-018 signal, with the DLQ as a backstop.

### Changes Required:

#### 1. Consumer handler

**File**: `src/worker.ts` (replace the Phase-1 no-op `queue`) + `src/lib/enrichment/consumer.ts` (new, holds the per-message logic).

**Intent**: Orchestrate one message end-to-end with idempotency and platform-delegated retry.

**Contract**: For each message `{ submissionId }`:
1. **Claim** — CAS `UPDATE submissions SET enrichment_status='processing', enrichment_attempts=enrichment_attempts+1, enrichment_attempted_at=now() WHERE id=$1 AND (enrichment_status='pending' OR (enrichment_status='processing' AND enrichment_attempted_at < now() - <stale-threshold>))`. If no row claimed → it is `done` or freshly mid-flight: `ack()` and return.
2. **Enrich** — call `enrich(row.content)`.
3. **Success** — `UPDATE … SET enrichment_status='done', ai_tone, ai_classification, ai_title, ai_summary, enrichment_last_error=NULL WHERE id=$1`; `ack()`.
4. **Transient error** — first CAS the row back `processing → pending`, guarded on the attempt just claimed (`UPDATE … SET enrichment_status='pending' WHERE id=$1 AND enrichment_status='processing' AND enrichment_attempts=<claimedAttempt>`), then `message.retry({ delaySeconds: <backoff> })`; do not write `failed`. Resetting to `pending` lets the redelivery re-claim cleanly through the `pending` branch instead of depending on the stale-`processing` threshold (see Critical Implementation Details — this is what keeps a transient failure from wedging the row in `processing`).
5. **Permanent error** (4xx/schema/auth only — NOT an attempts cap) — `UPDATE … SET enrichment_status='failed', enrichment_last_error=<message>`; emit FR-018 signal; `ack()`. Retry exhaustion is handled exclusively by `max_retries` → DLQ (see §2), never by an app-level attempts cap here.

```sql
-- Claim contract (the idempotency core — counterintuitive enough to pin down)
UPDATE public.submissions
SET enrichment_status='processing',
    enrichment_attempts=enrichment_attempts+1,
    enrichment_attempted_at=now()
WHERE id=$1
  AND (enrichment_status='pending'
       OR (enrichment_status='processing' AND enrichment_attempted_at < now() - interval '<N> minutes'))
RETURNING id;  -- zero rows => skip (done or fresh in-flight)
```

#### 2. Dead-letter backstop

**File**: `wrangler.jsonc` (DLQ consumer binding) + handler branch in `src/worker.ts`.

**Intent**: This is the **sole authority for retry-exhaustion failures** (not just a safety net): a message that exhausts `max_retries` lands here and this is where its row becomes `failed`.

**Contract**: A consumer binding for `dib-enrichment-dlq` (second `consumers` entry, or a queue-name guard in the single handler) that performs the terminal `failed` write + FR-018 signal for the referenced `submissionId`, then `ack()`s. Idempotent with branch 5 above (a row already `failed` from a permanent error is a no-op). Because branch 5 no longer carries an attempts cap, this DLQ path is the only place a *transient*-exhausted row is failed — confirm it is reachable (i.e. `max_retries` is the only exhaustion gate) and not shadowed by an app-level cap.

#### 3. FR-018 failure signal

**File**: `src/lib/enrichment/consumer.ts` (signal emission) + a tiny `src/lib/enrichment/log.ts` if a structured-log helper is warranted.

**Intent**: Emit the durable signal S-03 will consume, without building S-03's sender.

**Contract**: On terminal failure, emit one structured, greppable log event (single JSON line via `console`, surfaced by Workers Observability) carrying at least `event: "enrichment_failed"`, `submissionId`, `errorType`, `attempts`, `timestamp`. The `enrichment_status='failed'` + `enrichment_last_error` row state is the second half of the signal. No email, no webhook.

#### 4. Structured logging across the path

**File**: `src/lib/enrichment/consumer.ts`.

**Intent**: Make claim/enrich/done/retry/fail observable in `wrangler tail`.

**Contract**: One structured log line per state transition (claimed, done, retrying with attempt count, failed), consistent key shape with the FR-018 event. No PII beyond `submissionId` (never log `content` or `signature`).

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] Build succeeds: `npm run build`
- [ ] Unit test: a redelivered message whose row is already `done` performs no AI call and acks (idempotency)
- [ ] Unit test: transient error triggers `message.retry`, not a `failed` write; permanent error / attempts-at-cap triggers the `failed` write + signal

#### Manual Verification:

- [ ] Happy path via `wrangler dev` + harness: insert a `pending` row, enqueue, consumer ends it `done` with valid `ai_tone` ∈ `TONES` and `ai_classification` ∈ `CLASSIFICATIONS`
- [ ] Forced-failure path (bad key / cap reached): row ends `failed` with `enrichment_last_error` set and the `enrichment_failed` event visible in `wrangler tail`
- [ ] Redelivery (enqueue the same id twice): only one AI call occurs; the row is not clobbered
- [ ] Stale-`processing` reclaim: a row stuck in `processing` past the threshold is reclaimed on the next delivery
- [ ] DLQ backstop: a message exhausting `max_retries` results in a `failed` row via the DLQ branch

**Implementation Note**: After automated verification passes, pause for manual confirmation of the happy path, the forced-failure path, and the idempotency check before declaring F-03 done.

---

## Testing Strategy

> Runner: vitest (set up in Phase 1 §7; `@cloudflare/vitest-pool-workers` for any test needing the Workers runtime, default node env otherwise). `npm test` runs the suite.

### Unit Tests:

- `enrich()` returns a schema-valid result for sample content; tone/classification constrained to the SSOT lists.
- Error classifier: 429/5xx/timeout → transient; 400/401/403/schema-invalid → permanent.
- Consumer idempotency: already-`done` row → no AI call, ack.
- Consumer branching: transient → retry; permanent/cap → failed + signal.
- Schema-enum-equals-const assertion (diacritic-drift guard).

### Integration Tests:

- End-to-end via `wrangler dev` + dev harness: `pending` → enqueue → `done` with valid outputs.
- Forced failure → `failed` + `enrichment_last_error` + `enrichment_failed` log event.
- Duplicate enqueue → single AI call, no clobber.

### Manual Testing Steps:

1. `npx wrangler dev`; enqueue a real `pending` submission id via the harness; confirm the row reaches `done` in Supabase Studio with sensible AI fields.
2. Temporarily break the OpenAI key; enqueue; confirm retries in `wrangler tail`, then a `failed` row + the structured FR-018 event after the cap.
3. Enqueue the same id twice; confirm one AI call and no result clobber.
4. Verify the AI request payload never contains `signature`.

## Performance Considerations

`max_batch_size: 1` keeps each invocation to one AI call; the OpenAI request is I/O wait (not Worker CPU), so it does not strain CPU limits even on a single Worker. At MVP volume (≈2–4 submissions/week, hard ceiling ~270 employees) the Free-tier queue limit (10k ops/day) is never approached. Exponential backoff + a `max_retries` cap + an account-level Spend Limit (manual, panel) bound the worst-case cost of a sustained transient-error loop.

## Migration Notes

No DB migration. All output and lifecycle columns already exist from F-01. The only "migration"-like steps are account-level resource creation (`wrangler queues create` × 2) and secret provisioning (`wrangler secret put OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`), both manual gates listed in Prerequisites.

## References

- Roadmap: `context/foundation/roadmap.md` (F-03, Stream A)
- Schema contract: `supabase/migrations/20260528000000_create_submissions.sql:46-77,143-146`
- Taxonomy SSOT: `src/lib/submissions/taxonomies.ts`
- Platform constraints + risks: `context/foundation/infrastructure.md` (Devil's-Advocate #2, Unknown-Unknowns, Risk Register)
- Lessons: `context/foundation/lessons.md` ("Don't harden a consumer that doesn't exist yet")
- Adapter dual-handler pattern: Astro Cloudflare integration docs ("Update Custom Cloudflare Worker Entry File"); `@astrojs/cloudflare/handler` export verified in installed 13.5.0

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Queue infrastructure + dual-handler worker skeleton

#### Automated

- [x] 1.1 Build succeeds with the new entry: `npm run build` — 9928218
- [x] 1.2 Type checking passes: `npm run typecheck` — 9928218
- [x] 1.3 Linting passes: `npm run lint` — 9928218
- [x] 1.4 `wrangler.jsonc` parses (queues + new `main`): `npx wrangler deploy --dry-run --outdir=tmp/` — 9928218
- [x] 1.5 Vitest is wired and the smoke test runs green: `npm test` — 9928218

#### Manual

- [x] 1.6 `wrangler queues create` for main + DLQ both succeed — 9928218
- [x] 1.7 Under `wrangler dev`, a test message is received and logged by the `queue` handler — 9928218
- [x] 1.8 Existing HTTP routes still render via the custom entry (no routing regression) — 9928218

### Phase 2: Service-role client + AI enrichment module + classification taxonomy

#### Automated

- [ ] 2.1 Type checking passes: `npm run typecheck`
- [ ] 2.2 Linting passes: `npm run lint`
- [ ] 2.3 Schema enum equals `CLASSIFICATIONS`/`TONES` const (drift guard assertion)
- [ ] 2.4 `enrich()` unit test returns a schema-valid `EnrichmentResult`

#### Manual

- [ ] 2.5 One live OpenAI call on sample Polish content returns sensible fields
- [ ] 2.6 Signature confirmed absent from the AI request payload
- [ ] 2.7 Simulated 429 → transient; simulated 400 → permanent

### Phase 3: Consumer state machine — claim → enrich → write-back → retry/DLQ → failure signal

#### Automated

- [ ] 3.1 Type checking passes: `npm run typecheck`
- [ ] 3.2 Linting passes: `npm run lint`
- [ ] 3.3 Build succeeds: `npm run build`
- [ ] 3.4 Redelivered already-`done` message → no AI call, ack (idempotency unit test)
- [ ] 3.5 Transient → retry, permanent/cap → failed + signal (branching unit test)

#### Manual

- [ ] 3.6 Happy path: `pending` → enqueue → `done` with valid tone/classification
- [ ] 3.7 Forced-failure: row → `failed` + `enrichment_last_error` + `enrichment_failed` log event
- [ ] 3.8 Redelivery: one AI call, no clobber
- [ ] 3.9 Stale-`processing` reclaim works past threshold
- [ ] 3.10 DLQ backstop: exhausted-retries message yields a `failed` row
