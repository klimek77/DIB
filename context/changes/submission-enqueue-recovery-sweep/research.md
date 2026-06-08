---
date: 2026-06-08 (CEST, UTC+2)
researcher: klimek77
git_commit: 23bf1bccc3b2e35704e7998fe42f0a6845b507fd
branch: main
repository: klimek77/DIB
topic: "Pending-rows re-enqueue sweep — current enqueue gap, safe re-enqueue path, and which test-plan phase it belongs to"
tags: [research, codebase, enrichment-queue, cloudflare-workers, scheduled-cron, idempotency, submission-durability]
status: complete
last_updated: 2026-06-08
last_updated_by: klimek77
---

# Research: `submission-enqueue-recovery-sweep`

**Date**: 2026-06-08 (CEST, UTC+2)
**Researcher**: klimek77
**Git Commit**: 23bf1bccc3b2e35704e7998fe42f0a6845b507fd
**Branch**: main
**Repository**: klimek77/DIB

## Research Question

Build the deferred pending-rows re-enqueue sweep surfaced by `testing-submission-durability-taxonomy` Phase 2 (Risk #4a): a `scheduled` Worker handler + `triggers.crons` that re-sends submission rows stranded in `enrichment_status='pending'` because their initial enqueue silently failed. Plus the orientation question the user asked: **does this change belong to test-plan Phase 3?**

## Summary

- **Phase classification: NO — this is not test-plan Phase 3.** It is a *production* follow-up to test-plan **Phase 2** (Risk #4, sub-risk #4a). Test-plan Phase 3 is "Auth & granica nadużyć" (Risks #5/#6 — magic-link spam/enumeration + Workers session round-trip), `not started`, unrelated. The "Phase 3" cited in `change.md:36` is the *internal plan phase* of the now-archived `testing-submission-durability-taxonomy` change (its "Phase 3: Submission Insert/Enqueue Durability"), whose sub-task #3 opened this follow-up. See [§ Phase Classification](#phase-classification-the-disambiguation).
- **The gap is real and live today.** `src/pages/api/submissions.ts:64-68` inserts a `pending` row, then enqueues in a try/catch that swallows the failure and still returns 201. There is **no** `scheduled` handler in `src/worker.ts` and **no** `triggers.crons` in `wrangler.jsonc`. A row whose enqueue failed stays `pending` forever. A `KNOWN GAP` comment (`submissions.ts:58-63`) names this exact change-id.
- **No schema change is needed.** The required composite index, the `pending` enum value, the service-role bypass path, and the right age column (`created_at`) all already exist. The work is entirely code + config: a `scheduled` handler + a `triggers.crons` block.
- **Re-enqueue is provably safe.** The consumer's atomic CAS claim (`consumer.ts:239-252`) only claims `pending` OR stale-`processing`; every terminal write is guarded on the per-claim `enrichment_attempted_at` token. Re-sending a row that is already `processing`/`done`/`failed` is an ack-and-skip no-op — no double AI call, no clobber, no wedge. The sweep just becomes another at-least-once redelivery source the existing machinery already absorbs.
- **Two pre-existing residual risks are amplified, not introduced, by the sweep** (carry into the plan): (1) the unconditional DLQ failure signal (`lessons.md:61-66`) can fire a false `enrichment_failed` if the sweep races an exhausted DLQ delivery; (2) the total-outage silent-drop (`lessons.md:68-73`) — this sweep is the documented recovery path for it.

## Phase Classification (the disambiguation)

Two different "Phase 3"s collide. They are not the same thing.

| Layer | "Phase 3" means | Relevance to this change |
|---|---|---|
| **Test-plan rollout** (`context/foundation/test-plan.md:79-84`) | Phase 3 = "Auth & granica nadużyć", Risks **#5** (magic-link spam/enumeration), **#6** (Workers session round-trip). Status `not started`. | **None.** Different risks, different surface (auth, not enrichment). |
| **Archived change's internal plan** (`testing-submission-durability-taxonomy/plan.md`) | Phase 3 = "Submission Insert/Enqueue Durability" (Risk #4a), the third *plan* phase. Its sub-task #3 (`plan.md:173-177`) ran `/10x-new` to open `submission-enqueue-recovery-sweep`. | **This is the parent.** The "Phase 3" in `change.md:36` points here. |

Where this change actually sits in the test plan:

- **Test-plan Phase 2** ("Trwałość submisji & integralność taksonomii", Risks #4/#7) is `complete` — archived as `context/archive/2026-06-08-testing-submission-durability-taxonomy/`. Its tests locked in the **truthful** contract: an enqueue-fail returns 201 and leaves a row that is *recoverable by status-scan*. That phase deliberately deferred *building* the recovery (`plan.md:32-34`, honoring `lessons.md` "don't harden a consumer that doesn't exist yet").
- **This change makes "no silent loss" actually true** — it is the production feature the Phase 2 tests documented as a known gap. It is itself **not a test-rollout phase**; the test plan's phases are about *tests*, this is about *building behavior*.
- Compounding trap (worth noting for future readers): inside the archived plan, "Phase 3" is *also* used in the test-plan sense at `plan.md:5` ("no Workers runtime — that stays Phase 3"). The same string, two meanings, one file.

## Detailed Findings

### 1. The live gap — enqueue path (`src/pages/api/submissions.ts`)

Sequence: parse body → validate → service-role insert `pending` row → enqueue → 201.

- **Insert** (`submissions.ts:45-49`): `admin.from("submissions").insert({ ...validation.value, enrichment_status: "pending" }).select("id").single()` via `createAdminClient(env)` (`:41`).
- **The swallow** (`submissions.ts:64-68`, falls through to `:70`):
  ```ts
  try {
    await enqueueEnrichment(env, data.id);
  } catch {
    logSubmissionEvent("submission_enqueue_failed", "queue_send_error");
  }
  // → return json({ ok: true }, 201);   (:70)
  ```
  The `catch` only logs and does not return, so the 201 fires regardless. **This is the silent-loss point.**
- **The KNOWN GAP marker** (`submissions.ts:58-63`, verbatim) names `submission-enqueue-recovery-sweep` and states the stranded row "currently stays `pending` forever".
- **The failure log is deliberately id-less** (`logSubmissionEvent`, `submissions.ts:19-22`): emits only `{ event, reason, timestamp }` — no id, no body, no client identifier (anonymity NFR, `:15-18`). Consequence the sweep must honor: **a stranded row is found by a status-scan on `enrichment_status`, NOT by grepping the log** (`:18`).
- **Insert-fail path** (`submissions.ts:51-56`): returns 500, no enqueue, no body echo → nothing durable → correctly outside the sweep's scope.
- **Enqueue helper** (`src/lib/enrichment/enqueue.ts:7-9`): `enqueueEnrichment(env: { QUEUE: Queue<EnrichmentMessage> }, submissionId: string): Promise<void>` → `env.QUEUE.send({ submissionId })`. Message carries **only the id** (`types.ts:6-8`); the DB row is the source of truth. The sweep reuses this verbatim.
- **Bindings source**: routes import `env` from `@/lib/runtime-env` (`runtime-env.ts:12-14`, re-exports from `cloudflare:workers`) because Astro v6 + `@astrojs/cloudflare` v13 removed `Astro.locals.runtime.env`. The **scheduled handler instead receives `env` as a handler argument** (like `queue`), not via this module.

### 2. Where the sweep wires in — worker entry + wrangler (`src/worker.ts`, `wrangler.jsonc`)

- **Custom entry** (`worker.ts:21-36`): default export `satisfies ExportedHandler<Env, EnrichmentMessage>` with **only** `fetch` (`:22`, delegates to `@astrojs/cloudflare/handler`) and `queue` (`:24-35`). **No `scheduled` handler exists** (grep for `scheduled|ScheduledController` across `src/` = no matches). A `scheduled(controller, env, ctx)` member slots into the same object after `:35`; the `satisfies ExportedHandler` type already permits it.
- **Queue handler pattern to mirror** (`worker.ts:24-35`): builds deps from `env` — `createSupabaseStore(createAdminClient(env))` + `env.OPENAI_API_KEY`. The sweep handler builds `createAdminClient(env)` the same way and calls `enqueueEnrichment(env, id)`.
- **wrangler.jsonc** (read fully, 41 lines): `main: "src/worker.ts"` (`:4`), `compatibility_date "2026-05-08"` (`:5`), `nodejs_compat` (`:6`). Queues: producer `dib-enrichment`→`QUEUE` (`:25`); main consumer `max_retries:5`, DLQ `dib-enrichment-dlq` (`:27-32`); DLQ consumer `max_retries:3`, no DLQ-of-its-own (`:33-37`). **No `triggers`/`triggers.crons` key** — to be added as a new top-level key.
- **Cron shape already prescribed** by `context/foundation/infrastructure.md:124-130`: `"triggers": { "crons": ["0 7 * * 1"] }`, with a documented **UTC caveat** — Cron Triggers run on UTC, Europe/Warsaw is UTC+1/+2, so compute any time window *inside* the handler, don't trust the literal trigger time. (Note: that example cron is the weekly-digest example; the sweep's cadence is an open question — see below.)
- **Env typing** (`src/worker-env.d.ts:15-28`): global `Env` already exposes `QUEUE`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` — **no new binding needed**. ⚠️ `worker-env.d.ts:6-11`: the `QUEUE` type is **hand-authored**; do **NOT** run `wrangler types` (it would emit an untyped `Queue` and collide).
- **Build pipeline**: `astro build` (`@astrojs/cloudflare` adapter) emits `dist/server/` + a generated `dist/server/wrangler.json`. The generated config copies the queues block verbatim; **verify after adding `triggers.crons` that it propagates into `dist/server/wrangler.json`**, else cron won't register. Known dev-loop trap (`lessons.md:54-58`): `wrangler dev` serves the *built* bundle and does **not** hot-reload `worker.ts` — run `npm run build` before `wrangler dev`. Local cron verification: `npx wrangler dev --test-scheduled` (`infrastructure.md:63,93,132`).

### 3. Re-enqueue safety — consumer idempotency (`src/lib/enrichment/consumer.ts`)

- **CAS claim** (`consumer.ts:239-252`): a single conditional UPDATE `→ processing`, filter `.or("enrichment_status.eq.pending,and(enrichment_status.eq.processing,enrichment_attempted_at.lt.${staleBefore})")` (`:244-246`). Matches `pending` OR stale-`processing` only. Stale threshold `STALE_PROCESSING_THRESHOLD_MS = 12 min` (`:31`), a **crash backstop only** (`:27-30`). Zero rows matched → `null` → log `enrichment_skipped` + `message.ack()` (`:93-99`) — **no AI call, no write**.
- **Per-claim token** = `enrichment_attempted_at = claimedAt` (`:80, :242`). Every terminal write is guarded on it: `markDone` (`:266-268`), `resetToPending` (`:277-278`), `markFailed` (`:290-292`) plus a `.neq("enrichment_status","done")` floor (`:289`). A stale delivery holding an old token no-ops on every write — cannot clobber a row another claim owns.
- **Retry resets before re-enqueue** (`consumer.ts:107-116`): transient failure → `resetToPending` (`:112`, `processing→pending`, guarded) → `message.retry()` (`:114`). Implements `lessons.md:47-52`. App-level retries are **uncapped by design** — exhaustion is owned by the platform `max_retries`→DLQ (`:10-13`); `enrichment_attempts` is forensic only.
- **Transient vs permanent** (`errors.ts:26-38`): `429`/`>=500` and any non-typed throw → transient; `4xx` (400/401/403/404/422) → permanent. DLQ branch `processDeadLetterMessage` (`:152-189`) is the sole authority for retry-exhaustion failures; idempotent no-op for missing/`done`/`failed` rows (`:167-171`).

**Per-case safety verdict** (sweep re-sends `{ submissionId }`; CAS is the only gate):

| Sweep re-enqueues a row that is… | Outcome | Safe? |
|---|---|---|
| (a) genuinely stranded `pending` | claim matches → enriches once → `markDone`. **Intended recovery.** | ✅ |
| (b) `processing` fresh | claim matches 0 → ack+skip (`:93-99`) | ✅ no double call |
| (c) `done` | claim matches 0 → ack+skip | ✅ no clobber |
| (d) `failed` | consumer no-ops; **sweep must filter to `pending` so it never targets this** | ✅ |
| (e) mid-transient-retry `pending` | sweep send + platform redelivery race the same CAS; first claim wins, loser ack+skips | ✅ CAS serializes |
| extra: stale `processing` (>12 min, reset-failed under outage) | claim matches stale branch → reclaims → enriches once | ✅ true outage recovery |
| extra: fresh `processing` wedged (<12 min) | claim matches 0 → ack+skip; recovered only on a *later* touch after 12-min stale window | ✅ but **delayed**, not by the sweep |

### 4. Data model & the sweep's selection query

- **`submissions` table** (`supabase/migrations/20260528000000_create_submissions.sql:32-78`). `enrichment_status text NOT NULL DEFAULT 'pending'` (`:47`), CHECK `IN ('pending','processing','done','failed')` (`:74-75`). DB type is loose `string` (`src/lib/database.types.ts:41`) — the CHECK is the only enforcement.
- **Age column = `created_at`, NOT `enrichment_attempted_at`.** A never-enqueued row has `enrichment_attempted_at = NULL` (no DEFAULT, `:50`; only set by the consumer's claim at `consumer.ts:242`). `created_at timestamptz NOT NULL DEFAULT now()` (`:34`) is the only reliable age for a stranded row.
- **Index** (`...20260528000000...:89-90`): composite `submissions_enrichment_status_created_at_idx (enrichment_status, created_at DESC)` serves `WHERE enrichment_status='pending' AND created_at < now()-Nmin` — leading column is equality-fixed, exactly the condition `lessons.md:26-31` requires. There is **no** partial `pending` index (the two partials are `'done'`-only, `:93-100`).
- **Use `.eq('enrichment_status','pending')`, not `.in([...])`** — `lessons.md:33-38` (single-element `IN` misses partial-index predicate proof); matches the codebase's consistent `.eq`/`.neq` usage (`consumer.ts:267,277,289`).
- **RLS**: service-role (`createAdminClient`, `src/lib/enrichment/supabase-admin.ts:6-8,14-24`) bypasses RLS + column grants by design (migration header `...20260528000000...:143-146` even anticipates "future retention cron uses the same path"). No new grant needed.
- **No migration required.** Index, enum, role path, and age column all already exist.

**Bottom-line query the sweep should run** (research recommendation, not a plan):
```ts
admin.from("submissions")
  .select("id")
  .eq("enrichment_status", "pending")
  .lt("created_at", new Date(Date.now() - N * 60_000).toISOString());
// then: for each row → await enqueueEnrichment(env, row.id);
```

### 5. Failure-signal decoupling / total-outage (the deferred consideration from `change.md:30-31`)

- **`emitFailureSignal`** (`log.ts:45-48`) emits a durable `enrichment_failed` log line (FR-018 half-signal). In the DLQ branch it fires **unconditionally after `markFailed`** (`consumer.ts:187`) — **not** gated on the guarded write applying. `lessons.md:61-66` flags this as a known-open gap: harmless while forensic-only, but a false alert once S-03 (email) consumes it.
  - **Sweep amplifies it**: if the sweep re-enqueues a row a concurrently-exhausting DLQ delivery is finishing, a spurious `enrichment_failed` can be emitted even though the re-enqueue succeeds.
- **Total-outage silent drop** (`lessons.md:68-73`): under a full Supabase outage for the whole retry window, the main queue exhausts → DLQ → DLQ writes also throw → DLQ message exhausts its own `max_retries:3` (no DLQ-of-its-own) and is **dropped**; the row is abandoned in an intermediate state with no signal. **This sweep is the documented recovery path** for that scenario (for `pending` rows; freshly-wedged `processing` rows are recovered by the consumer's own 12-min stale-reclaim, not the sweep).

## Code References

- `src/pages/api/submissions.ts:45-49` — service-role insert of the `pending` row
- `src/pages/api/submissions.ts:58-63` — **KNOWN GAP** comment naming this change-id
- `src/pages/api/submissions.ts:64-68` — enqueue try/catch that swallows failure and still 201s
- `src/pages/api/submissions.ts:19-22` — id-less anonymity-safe failure log
- `src/lib/enrichment/enqueue.ts:7-9` — `enqueueEnrichment(env, id)` → `QUEUE.send({ submissionId })`
- `src/lib/enrichment/types.ts:6-8` — `EnrichmentMessage = { submissionId: string }`
- `src/worker.ts:21-36` — default export; `fetch` + `queue` only, **no `scheduled`**
- `src/worker.ts:24-35` — queue-handler pattern to mirror (`createAdminClient(env)` etc.)
- `src/worker-env.d.ts:15-28` — global `Env`; QUEUE/SUPABASE_*/OPENAI already present; ⚠️ hand-typed QUEUE
- `wrangler.jsonc:24-39` — queue bindings; **no `triggers.crons`**
- `src/lib/enrichment/consumer.ts:239-252` — CAS claim (the idempotency chokepoint)
- `src/lib/enrichment/consumer.ts:93-99` — claim-returns-null → ack-and-skip
- `src/lib/enrichment/consumer.ts:266-268, 277-278, 289-292` — token-guarded terminal writes
- `src/lib/enrichment/consumer.ts:107-116` — reset-before-retry transient path
- `src/lib/enrichment/consumer.ts:152-189` — DLQ branch; `:187` unconditional failure signal
- `src/lib/enrichment/errors.ts:26-38` — transient/permanent classification
- `src/lib/enrichment/supabase-admin.ts:14-24` — service-role admin client (RLS bypass)
- `supabase/migrations/20260528000000_create_submissions.sql:32-78` — schema; `:74-75` status CHECK; `:89-90` composite index; `:106-141` RLS + grants
- `context/foundation/infrastructure.md:124-132` — prescribed `triggers.crons` shape + UTC caveat + `--test-scheduled`

## Architecture Insights

- **The DB row is the single source of truth; the queue message is a pointer.** Both producer paths (the route and the future sweep) send only `{ submissionId }`; the consumer re-reads fresh state and the CAS claim arbitrates. This is what makes a second producer trivially safe to add.
- **At-least-once is already the design assumption** (`types.ts:2-3`), so the sweep introduces no new failure mode — it's another redelivery source.
- **`pending`-only scope is deliberate.** Crash recovery for `processing` rows is already owned by the consumer's 12-min stale-reclaim; a sweep targeting `processing` would just generate ack-and-skip noise. Keep the sweep's predicate `enrichment_status='pending' AND created_at < now()-Nmin`.
- **Service-role + cron is a sanctioned pattern** the schema header already anticipated (`...20260528000000...:143-146`).
- **Config-propagation is the silent failure mode here**, not code: a `triggers.crons` block that doesn't survive `astro build` into `dist/server/wrangler.json` means cron never registers and the sweep silently never runs — verify the built output.

## Historical Context (from prior changes)

- `context/archive/2026-06-08-testing-submission-durability-taxonomy/plan.md` — the parent. Phase 3 (internal) "Submission Insert/Enqueue Durability"; `:32-38` "What We're NOT Doing" defers this sweep and the total-outage decoupling; sub-task #3 (`:173-177`) opened this change folder. Tests lock the truthful contract (`:157-171`).
- `context/archive/2026-06-02-ai-enrichment-queue/plan.md` — original F-03 queue design (CAS idempotency, retry/DLQ, the `dib-enrichment` + `dib-enrichment-dlq` topology this sweep feeds into).
- `context/foundation/lessons.md` priors that directly bind this change:
  - `:47-52` reset-claimed-row-before-re-enqueue (already implemented in the consumer — assert it stays true).
  - `:61-66` gate the durable failure signal on the guarded write (open gap the sweep amplifies).
  - `:68-73` terminal-queue + total-outage silent drop — **the sweep is its recovery path**.
  - `:19-24` don't harden a consumer that doesn't exist yet — why Phase 2 deferred this until now (the consumer now exists).
  - `:26-38` composite/partial index rules — why `created_at` + `.eq('pending')` is correct.

## Related Research

- `context/archive/2026-06-08-testing-submission-durability-taxonomy/research.md` — § Open Questions #1 (the original deferral note for this sweep).
- `context/archive/2026-06-02-ai-enrichment-queue/research.md` — queue consumer internals (if deeper idempotency context is needed during planning).

## Open Questions (for `/10x-plan`)

1. **Cron cadence + age threshold N.** What `triggers.crons` schedule (e.g. every 5–15 min) and what `N` minutes for "older than" — N must exceed the normal in-flight window so the sweep never races a just-enqueued row. The `infrastructure.md` example `"0 7 * * 1"` is the weekly digest, not a guide for this. Decide N and cadence together.
2. **Batch bound + ordering.** Should the sweep cap rows per run (e.g. `LIMIT 100`, oldest-first via the composite index) to bound a single invocation under a backlog, and rely on the next tick for the rest? Avoid an unbounded re-enqueue storm.
3. **Failure-signal decoupling: in-scope here or deferred again?** `change.md:30-31` says "consider while here". Options: (a) fix the unconditional `emitFailureSignal` gating (`lessons.md:61-66`) as part of this change, or (b) leave it and only document the residual. Recommendation: at minimum add a sweep-side observability log line (id-less, anonymity-safe) of how many rows were re-enqueued, so the sweep itself is auditable.
4. **Where does the query+loop live?** A new `src/lib/enrichment/recovery-sweep.ts` (testable pure function taking a store + enqueue fn) called from `worker.ts scheduled`, mirroring how `queue` delegates to `consumer.ts`? Keeps the handler thin and unit-testable without a Workers runtime.
5. **Test layer.** Phase 2's tests are pure-unit/fake-client. The sweep's selection logic can be unit-tested the same way; cron registration + `--test-scheduled` is a manual smoke (mirrors `lessons.md:54-58`). Confirm no new test infra is pulled in.
