# Pending-Rows Re-Enqueue Sweep — Implementation Plan

## Overview

Add a `scheduled` Cloudflare Worker handler (cron every 15 min) that finds submission rows stranded in `enrichment_status = 'pending'` — rows whose initial enqueue silently failed — and re-enqueues them through the existing `enqueueEnrichment`. This closes the live gap documented by the `KNOWN GAP` marker in `src/pages/api/submissions.ts:58-63` and makes the "no silent loss" durability contract (test-plan Risk #4a) actually true, rather than merely *recoverable in principle*.

## Current State Analysis

- The submission endpoint inserts a `pending` row, then enqueues in a try/catch that swallows the failure and still returns 201 (`src/pages/api/submissions.ts:64-68`, falls through to `:70`). A row whose `QUEUE.send` throws stays `pending` forever — never enriched, never on the `done`-gated dashboard.
- The failure log is deliberately id-less (`submissions.ts:19-22`, anonymity NFR), so stranded rows are findable **only** by a status-scan on `enrichment_status`, never by parsing logs.
- There is **no** `scheduled` handler in `src/worker.ts` (only `fetch` + `queue`, `:21-36`) and **no** `triggers.crons` in `wrangler.jsonc`.
- Re-enqueue is already safe: the consumer's atomic CAS claim (`src/lib/enrichment/consumer.ts:239-252`) claims only `pending` OR stale-`processing`; every terminal write is guarded on the per-claim `enrichment_attempted_at` token. Re-sending a row already `processing`/`done`/`failed` is an ack-and-skip no-op (`consumer.ts:93-99`).
- Full grounding: `context/changes/submission-enqueue-recovery-sweep/research.md`.

## Desired End State

A cron fires every 15 minutes. It selects up to 100 `pending` rows older than 10 minutes (by `created_at`), oldest first, and re-enqueues each via `enqueueEnrichment(env, id)`. The consumer then claims and enriches them exactly as for a normal submission. Each run emits one id-less summary log line (`{ scanned, reenqueued, failed }`). A submission whose first enqueue failed reaches the dashboard within ~25 minutes (10-min age threshold + ≤15-min cron interval) instead of never.

Verification: with a manually-seeded stranded `pending` row (created_at > 10 min ago), `wrangler dev --test-scheduled` triggers the sweep, the row transitions `pending → processing → done`, and the built `dist/server/wrangler.json` carries the `triggers.crons` entry.

### Key Discoveries

- **No schema change needed**: composite index `submissions_enrichment_status_created_at_idx (enrichment_status, created_at DESC)` already serves the scan (`supabase/migrations/20260528000000_create_submissions.sql:89-90`); enum `pending` exists (`:74-75`); service-role bypasses RLS (`src/lib/enrichment/supabase-admin.ts:6-8`); `created_at NOT NULL DEFAULT now()` (`:34`).
- **Age must come from `created_at`, NOT `enrichment_attempted_at`**: a never-enqueued row has `enrichment_attempted_at = NULL` (set only by the consumer's claim, `consumer.ts:242`), so filtering on it would never match a stranded row.
- **`.eq('enrichment_status','pending')`, never `.in([...])`** — `lessons.md:33-38` (single-element `IN` defeats partial-index predicate proof; also the codebase-consistent form).
- **Idempotency proof**: `consumer.ts:239-252` (claim) + token-guarded writes (`:266-268`, `:277-278`, `:289-292`). See research §3 per-case safety table.
- **Pattern to mirror**: the `queue` handler builds its deps from `env` (`worker.ts:24-35`: `createSupabaseStore(createAdminClient(env))`); the `scheduled` handler does the same.

## What We're NOT Doing

- **NOT fixing the unconditional `emitFailureSignal` gating** (`lessons.md:61-66`) — it is forensic-only until S-03 (email) consumes it; documented as residual risk. ("Don't harden a consumer that doesn't exist yet.")
- **NOT building a separate failure-signal transport** for the total-outage silent drop (`lessons.md:68-73`) — out of MVP scope; this sweep IS the documented recovery path for that scenario.
- **NOT changing any schema** — no migration.
- **NOT marking stuck rows `failed`** — indefinite re-enqueue is the policy; abandoning enrichment would contradict "no silent loss".
- **NOT recovering `processing` rows** — the consumer's own 12-min stale-reclaim (`consumer.ts:31`, `:244-246`) already owns crash recovery for those; the sweep targets `pending` only.
- **NOT changing the submission endpoint's 201-on-enqueue-fail contract** — that truthful contract is locked by Phase 2 tests; this change adds the recovery the endpoint's comment promises.

## Implementation Approach

Two phases. Phase 1 puts all logic in a pure, runtime-agnostic module (`recovery-sweep.ts`) plus one new store read method, fully unit-testable with fakes — no Workers runtime, mirroring how the queue consumer's logic is tested. Phase 2 wires that logic into a thin `scheduled` handler and the cron config, leaving only runtime registration + a manual smoke as non-automatable surface.

## Critical Implementation Details

- **Cron config must survive the build.** `astro build` (`@astrojs/cloudflare`) regenerates `dist/server/wrangler.json`; cron only registers if `triggers.crons` propagates there. Verify the built file after adding the trigger — this is the silent failure mode (config, not code).
- **`wrangler dev` serves the built bundle and does NOT hot-reload `src/worker.ts`** (`lessons.md:54-58`). Always `npm run build` before `npx wrangler dev --test-scheduled`.
- **Interval cron (`*/15 * * * *`) is DST-safe** — the `infrastructure.md:124-130` UTC caveat applies to time-of-day crons (the weekly digest), not fixed intervals; no in-handler time-window math needed here.
- **Do NOT run `wrangler types`** — `QUEUE` in `src/worker-env.d.ts:6-11` is hand-typed; regenerating would emit an untyped `Queue` and collide.
- **Per-row enqueue failure must not abort the batch** — the sweep catches each `enqueue` independently, counts failures, and continues; one un-enqueueable row never blocks the rest.

## Phase 1: Recovery-Sweep Core (logic + store query + unit tests)

### Overview

A pure function that, given a row-selector and an enqueue function, re-enqueues stranded pending rows and returns a count summary; plus the store read method it depends on; plus its unit tests. Zero Workers/cron surface — entirely `npm test`-verifiable.

### Changes Required:

#### 1. Recovery sweep module

**File**: `src/lib/enrichment/recovery-sweep.ts` (new)

**Intent**: Hold the entire sweep algorithm as a runtime-agnostic pure function so it is unit-testable without a Workers runtime or live Supabase. It computes the age cutoff, asks the injected selector for stranded rows, re-enqueues each (isolating per-row failures), and returns counts. No logging and no id/body in any context (anonymity); the caller logs the summary.

**Contract**: exported types + function. `now` is injected for deterministic cutoff tests; per-row enqueue is wrapped so one failure increments `failed` and continues.
```ts
export interface RecoverySweepDeps {
  selectStrandedPending(olderThanIso: string, limit: number): Promise<{ id: string }[]>;
  enqueue(submissionId: string): Promise<void>;
  now: () => number;
}
export interface RecoverySweepOptions { olderThanMs: number; limit: number; }
export interface RecoverySweepResult { scanned: number; reenqueued: number; failed: number; }
export async function runRecoverySweep(
  deps: RecoverySweepDeps,
  opts: RecoverySweepOptions,
): Promise<RecoverySweepResult>;
```
Cutoff = `new Date(deps.now() - opts.olderThanMs).toISOString()`. `scanned = rows.length`; each successful `enqueue` increments `reenqueued`, each thrown `enqueue` increments `failed` (caught individually).

#### 2. Store read method for stranded rows

**File**: `src/lib/enrichment/consumer.ts` (extend `createSupabaseStore` + its store interface)

**Intent**: Add the single read the sweep needs — ids of `pending` rows older than a cutoff, oldest first, bounded — reusing the service-role client the store already holds. Keep it on the existing store so the handler can build one store object for both consumer and sweep needs.

**Contract**: new method on the store interface and its implementation: `selectStrandedPending(olderThanIso: string, limit: number): Promise<{ id: string }[]>`. Query shape: `.from("submissions").select("id").eq("enrichment_status","pending").lt("created_at", olderThanIso).order("created_at",{ascending:true}).limit(limit)`. Uses `.eq` (not `.in`) and is served by `submissions_enrichment_status_created_at_idx`. Define as a closure over the captured `client` (no `this`), consistent with the existing store methods, so it can be passed by reference.

#### 3. Unit tests

**File**: `src/lib/enrichment/recovery-sweep.test.ts` (new)

**Intent**: Prove the sweep's behavior with fake deps (mirror the fake-client style of `consumer.test.ts`), with no live DB.

**Contract**: cases — (a) re-enqueues every row the selector returns, `reenqueued === rows.length`; (b) empty selector result → no `enqueue` calls, all counts 0; (c) one `enqueue` throws → `failed === 1`, remaining rows still enqueued, function resolves (no throw); (d) cutoff ISO passed to `selectStrandedPending` equals `now - olderThanMs` (inject fixed `now`); (e) `limit` forwarded verbatim.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- Test cases cover the per-row-failure isolation and the cutoff math (reviewer reads `recovery-sweep.test.ts`).

**Implementation Note**: After completing this phase and all automated verification passes, pause for human confirmation before proceeding to Phase 2.

---

## Phase 2: Cron Wiring + Runtime Smoke

### Overview

Wire the Phase 1 logic into a thin `scheduled` handler and register the cron, then verify it actually fires and recovers a row under `wrangler dev`.

### Changes Required:

#### 1. Scheduled handler

**File**: `src/worker.ts` (add `scheduled` to the default export)

**Intent**: On each cron tick, build the admin store + enqueue closure (mirroring the `queue` handler), run the sweep with a 10-minute age threshold and a 100-row cap, and emit one id-less summary log line for auditability.

**Contract**: `async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext)` added to the object that `satisfies ExportedHandler<Env, EnrichmentMessage>` (`worker.ts:21-36`). Builds `store = createSupabaseStore(createAdminClient(env))`; calls `runRecoverySweep({ selectStrandedPending: (iso,n) => store.selectStrandedPending(iso,n), enqueue: (id) => enqueueEnrichment(env, id), now: () => Date.now() }, { olderThanMs: 10*60_000, limit: 100 })`; then `console.log(JSON.stringify({ event: "enrichment_recovery_sweep", ...result, timestamp: new Date().toISOString() }))` — counts only, no id/body. Named consts for `olderThanMs`/`limit`.

#### 2. Cron trigger

**File**: `wrangler.jsonc` (add top-level `triggers`)

**Intent**: Register the 15-minute cron.

**Contract**: add `"triggers": { "crons": ["*/15 * * * *"] }` as a new top-level key (e.g. before `queues`). Interval expression → DST-irrelevant.

#### 3. Build-propagation verification

**File**: (verification step, no source change) — `dist/server/wrangler.json`

**Intent**: Confirm the adapter copies `triggers.crons` into the built config, since cron registers from the built file, not the root `wrangler.jsonc`.

**Contract**: after `npm run build`, `dist/server/wrangler.json` contains the `triggers.crons` entry. If absent, document the deploy-time remedy (deploy with the root config / adapter option) before shipping.

### Success Criteria:

#### Automated Verification:

- Build succeeds: `npm run build`
- Type checking passes (handler typechecks under `astro check`): `npm run typecheck`
- Linting passes: `npm run lint`
- Full test suite green (no regression): `npm test`

#### Manual Verification:

- `dist/server/wrangler.json` contains `triggers.crons: ["*/15 * * * *"]` after `npm run build`.
- `npm run build` then `npx wrangler dev --test-scheduled`; triggering the scheduled endpoint runs the sweep (summary log line appears with `{ scanned, reenqueued, failed }` and **no** id/body).
- A manually-seeded stranded row (`enrichment_status='pending'`, `created_at` > 10 min ago) is picked up by the sweep and transitions `pending → processing → done` (consumer must be running in the same Worker instance — enqueue from inside, per `lessons.md:54-58`).
- Re-running the sweep against an already-`done` row produces an ack-and-skip (no second AI call) — confirms idempotency end-to-end.

**Implementation Note**: After completing this phase and all automated verification passes, pause for human confirmation that the manual smoke succeeded.

---

## Testing Strategy

### Unit Tests:

- `recovery-sweep.test.ts`: re-enqueue-each, empty no-op, per-row-failure isolation + count, cutoff math, limit forwarding (fake deps).
- Existing `consumer.test.ts` stays green — `selectStrandedPending` is additive; no change to claim/retry/DLQ behavior.

### Integration Tests:

- None automated (no Workers-runtime test pool in this project per test-plan §4). Cron + queue interaction is covered by the manual smoke.

### Manual Testing Steps:

1. `npm run build`, then `npx wrangler dev --test-scheduled`.
2. Insert a stranded row via service-role (SQL or admin client): `enrichment_status='pending'`, `created_at = now() - interval '20 minutes'`, no enqueue.
3. Trigger the scheduled handler; confirm the summary log shows `reenqueued: 1` (id-less).
4. Confirm the consumer (same instance) enriches it to `done`.
5. Trigger again; confirm the now-`done` row is not re-processed (ack-and-skip).
6. Confirm `dist/server/wrangler.json` carries `triggers.crons`.

## Performance Considerations

- The scan is a single indexed query (`submissions_enrichment_status_created_at_idx`), `LIMIT 100`, oldest-first — bounded work per tick. Under a large backlog, recovery spans multiple ticks (100 rows / 15 min) rather than one unbounded burst, protecting both the Worker (sub-request/CPU limits) and the queue.
- Each re-enqueue is a sub-second `QUEUE.send`; 100 sequential sends per tick is well within Worker limits. (If a backlog ever makes this slow, batching/parallelizing sends is a future optimization — not needed for MVP rates.)

## Migration Notes

None — no schema or data migration. The change is code + `wrangler.jsonc` config only.

## References

- Research: `context/changes/submission-enqueue-recovery-sweep/research.md`
- Change identity: `context/changes/submission-enqueue-recovery-sweep/change.md`
- Parent (Phase 2, deferred this): `context/archive/2026-06-08-testing-submission-durability-taxonomy/plan.md:32-38,173-177`
- Idempotency contract: `src/lib/enrichment/consumer.ts:239-252`
- Enqueue helper: `src/lib/enrichment/enqueue.ts:7-9`
- Worker entry pattern: `src/worker.ts:24-35`
- Cron shape + UTC caveat + `--test-scheduled`: `context/foundation/infrastructure.md:124-132`
- Lessons: `context/foundation/lessons.md:54-58` (build-before-dev), `:61-66` / `:68-73` (deferred residuals)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Recovery-Sweep Core

#### Automated

- [x] 1.1 Unit tests pass: `npm test` — cb6d2a6
- [x] 1.2 Type checking passes: `npm run typecheck` — cb6d2a6
- [x] 1.3 Linting passes: `npm run lint` — cb6d2a6

#### Manual

- [x] 1.4 Tests cover per-row-failure isolation and cutoff math (reviewer reads `recovery-sweep.test.ts`) — cb6d2a6

### Phase 2: Cron Wiring + Runtime Smoke

#### Automated

- [x] 2.1 Build succeeds: `npm run build`
- [x] 2.2 Type checking passes: `npm run typecheck`
- [x] 2.3 Linting passes: `npm run lint`
- [x] 2.4 Full test suite green (no regression): `npm test`

#### Manual

- [x] 2.5 `dist/server/wrangler.json` contains `triggers.crons: ["*/15 * * * *"]` after build
- [x] 2.6 `wrangler dev --test-scheduled` runs the sweep; id-less summary log appears (no id/body)
- [x] 2.7 Seeded stranded `pending` row transitions `pending → processing → done`
- [x] 2.8 Re-run against a `done` row is an ack-and-skip (no second AI call)
