# Submission Durability & Taxonomy Integrity (Test Rollout Phase 2) Implementation Plan

## Overview

Write the Phase-2 tests from `context/foundation/test-plan.md §3` that protect **Risk #4** (submission durability + taxonomy integrity) and **Risk #7** (AI-enrichment queue idempotency). All tests are pure-unit / fake-client (no live DB, no Workers runtime — that stays Phase 3). No production behavior changes; the only production edit is correcting two misleading comments. The missing durability **recovery sweep is explicitly deferred** to its own production change.

## Current State Analysis

Grounded in `context/changes/testing-submission-durability-taxonomy/research.md` (this change) — codebase baseline, not re-derived:

- **#4a insert/enqueue** (`src/pages/api/submissions.ts`): sequence is `validate → insert(pending) → enqueue → 201`, all awaited. `insert-fail → 500` (clean, no enqueue) ✓. `insert-OK + enqueue-fail` → `catch` logs a **static** event (`submissions.ts:65`) and **falls through to 201**. The row survives as `enrichment_status='pending'` but is **never recovered**: there is no `scheduled` handler in `worker.ts`, no `triggers.crons` in `wrangler.jsonc`, no sweep code anywhere. Comments at `submissions.ts:17` and `:57-60` claim a sweep that does not exist.
- **#4b taxonomy** (`src/lib/submissions/taxonomies.ts` ↔ `supabase/migrations/`): all 5 DB-enforced columns (`department`, `branch`, `topic`, `enrichment_status`, `ai_tone`) match the migration CHECK sets character-for-character at HEAD. `ai_classification` is app-only (no DB CHECK). App validation already derives from `taxonomies.ts`, so the **only un-asserted seam is `taxonomies.ts ↔ migration SQL`**. The existing `enrich.test.ts:37-45` guard covers the *OpenAI-schema ↔ TS* seam, not the SQL one. No Postgres ENUM/domain — the CHECK is the physical SSOT; generated DB types are plain `string`.
- **#7 enrichment** (`src/lib/enrichment/consumer.ts`): CAS claim (`:240-251`) branches on rows-affected; token-guarded terminal writes (`markDone`/`resetToPending`/`markFailed`, `:254-295`); 12-min stale backstop (`STALE_PROCESSING_THRESHOLD_MS`, `:31`); transient → `resetToPending` **before** `message.retry()` (`:108-115`, the `lessons.md` wedge is avoided). Logic is correct. **Untested**: the stale-reclaim `.or()` arm, the real-store CAS rows-affected branch, the `markDone`/`resetToPending` token guards (only `markFailed`/`readStatus` are asserted at the real store, `consumer.test.ts:222-305`), and the two-delivery interleave.

### Key Discoveries:

- The enqueue-fail log is intentionally **id-less** (`submissions.ts:15-21`, anonymity framing) — so it is forensic-only; per-row recovery can only ever be a status-scan, never a log-driven lookup. This makes the "greppable for the recovery sweep" comment (`:17`) doubly misleading.
- The drift guard makes **"app-validated ⇒ passes DB CHECK" true by construction** — if `taxonomies.ts ≡ CHECK` is asserted, no live-DB CHECK-rejection test is needed to cover the #4 taxonomy-drift path.
- The real-store builder test pattern already exists (`consumer.test.ts:222-305`: a fake Supabase/PostgREST builder asserting `markFailed`/`readStatus` query shape) — Phase 2 extends it to `claim`/`markDone`/`resetToPending`.
- Vitest runs in **node env** (`test-plan.md §4`), so `node:fs`/`node:path` are available to the drift-guard test to read migration files.
- `lessons.md` priors that bound this work: "Reset a claimed row before re-enqueueing" (implemented — assert it), "Don't harden a consumer that doesn't exist yet" (⇒ defer the sweep), "Gate a durable failure signal on the guarded write" + "terminal queue + total-dependency outage" (⇒ document as deferred, don't build here).

## Desired End State

`npm test` covers, at unit fidelity with no new infra:
1. A drift guard that **fails loudly** if `taxonomies.ts` and the migration CHECK sets ever diverge (either direction, diacritic-sensitive), for all 5 enforced columns, and asserts `ai_classification` has no DB CHECK.
2. Enrichment idempotency proven end-to-handler: a duplicate delivery does not re-call AI or clobber the result; a stale `processing` row is reclaimable and a fresh one is not; terminal writes are token-guarded; a failed reset is recovered by the stale backstop.
3. Submission durability locked to the **truthful** contract: enqueue-fail returns 201 and leaves a recoverable `pending` row + a logged event; insert-fail returns 500 with no enqueue and no body leak. Production comments corrected to state the sweep is deferred. The recovery-sweep production change is opened as a follow-up.

Verify: `npm test` green, `npm run typecheck` (`astro check`) clean, `npm run lint` clean; a manual mutation check confirms each guard actually fails when the invariant is broken.

## What We're NOT Doing

- **NOT building the pending-rows re-enqueue sweep** (`scheduled` handler + `triggers.crons`). It is a production feature deserving its own `/10x-new → /10x-research → /10x-plan` cycle; this phase opens it as a follow-up and words the #4a success criterion to admit the gap. (Honors `lessons.md` "don't harden a consumer that doesn't exist yet".)
- **NOT changing any production behavior** — no API status changes, no new log fields, no row-marking. The id-less log and 201-on-enqueue-fail contract are asserted as-is (the only production edit is comment text).
- **NOT introducing a real/emulated Postgres or `@cloudflare/vitest-pool-workers`** — DB/runtime integration stays Phase 3 (`test-plan.md §4`). Pure-unit/fake-client fidelity throughout.
- **NOT testing AI content correctness / hallucination** — out of scope per `test-plan.md §7`.
- **NOT building the total-outage failure-signal decoupling** (`lessons.md:68-73`) — documented residual risk, deferred with the sweep.
- **NOT re-testing the OpenAI-schema ↔ TS seam** — already covered by `enrich.test.ts:37-45`.

## Implementation Approach

Three independent phases, sequenced cheapest-signal-first; each touches 1-2 files and commits on its own. Phase 1 is a self-contained new unit test. Phase 2 and Phase 3 extend existing test files following their established mocking patterns (edge-only mocks: Supabase client, QUEUE, OpenAI — never internal modules). Production code is touched only in Phase 3, and only comments.

## Critical Implementation Details

- **Drift-guard parsing must track the final-effective CHECK across migrations in date order.** Only `20260528000000_create_submissions.sql` defines taxonomy CHECKs today, but the parser must survive a future `DROP CONSTRAINT` + re-`ADD` (mirroring how `content_length` was replaced in `20260529…`). Read all `supabase/migrations/*.sql` sorted by filename; last definition of each named constraint wins.
- **Diacritic sensitivity is the whole point.** Compare raw strings — never NFC/NFD-normalize or diacritic-fold. The failure mode is exactly `Oświęcim` vs `Oswiecim`, `Pomysł` vs `Pomysl`.
- **The #7 interleave fake store must encode the same CAS predicate as `consumer.ts`** (`claim` matches `pending` OR `processing`-older-than-stale; sets the token; terminal writes guard on the token). If the fake's rule drifts from production, the test proves nothing — Phase 2's manual check exists to catch that.

## Phase 1: Taxonomy Drift Guard (Risk #4b, unit)

### Overview

A new unit test that locks `taxonomies.ts ≡ migration CHECK` so future drift fails CI instead of surfacing as a runtime DB rejection on a user's submission.

### Changes Required:

#### 1. Taxonomy drift-guard test

**File**: `src/lib/submissions/taxonomies.drift.test.ts` (new; next to the unit it guards per `test-plan.md §6.1`)

**Intent**: Read the migration SQL, extract the final-effective allowed-value set for each DB-enforced taxonomy CHECK, and assert order-independent, diacritic-sensitive set-equality against the corresponding `taxonomies.ts` const — failing loudly with the offending column + value in either direction. Also assert `ai_classification` has no CHECK, so a future migration adding one without updating the test is itself caught.

**Contract**:
- Inputs: `DEPARTMENTS`, `BRANCHES`, `TOPICS`, `ENRICHMENT_STATUSES`, `TONES` from `@/lib/submissions/taxonomies` (and `CLASSIFICATIONS` for the negative assertion); the three files in `supabase/migrations/` read via `node:fs`/`node:path`.
- Constraint→const map asserted: `submissions_department_check ≡ DEPARTMENTS`, `submissions_branch_check ≡ BRANCHES`, `submissions_topic_check ≡ TOPICS`, `submissions_enrichment_status_check ≡ ENRICHMENT_STATUSES`, `submissions_ai_tone_check ≡ TONES`. Plus: no constraint matching `ai_classification` exists in any migration.
- Parser (non-obvious — snippet warranted): match each named CHECK and pull its quoted literals, last-definition-wins across date-ordered files. Tolerate the `col IS NULL OR col IN (...)` shape (`ai_tone`).
  ```
  // per migration file, in filename order:
  /CONSTRAINT\s+(\w+)\s+CHECK\s*\(([\s\S]*?)\)\s*(?:,|\n\s*\))/g   // name + body
  /'([^']*)'/g                                                     // literals within the IN(...) body
  // accumulate into Map<constraintName, string[]>; later files overwrite earlier entries
  ```

### Success Criteria:

#### Automated Verification:

- New test runs and passes at HEAD: `npm test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- Mutation check: temporarily delete one value from a `taxonomies.ts` const (e.g. drop `'Chrzanów'` from `BRANCHES`) → the guard FAILS naming the column + missing value; revert. Repeat removing a value from the migration side.
- Confirm the parser ignores the non-taxonomy CHECKs (`content` length, `signature`) without error.

**Implementation Note**: After automated verification passes, pause for the manual mutation check before proceeding.

---

## Phase 2: Enrichment Queue Idempotency (Risk #7, fake-client unit)

### Overview

Extend `consumer.test.ts` to close the four gaps research found: the duplicate-delivery interleave, the stale-reclaim arm, the real-store token guards, and the reset-fail→stale-recovery path.

### Changes Required:

#### 1. Two-delivery interleave (idempotency core)

**File**: `src/lib/enrichment/consumer.test.ts` (extend) — plus a small in-memory fake store helper (same file or a sibling `*.fixtures.ts`)

**Intent**: Drive the real consumer handler twice for the same submission id against one shared in-memory store that encodes the production CAS semantics, proving delivery #2's claim returns 0 rows → ack-skip with `enrichFn` never called a second time and the stored result unchanged.

**Contract**: a fake store implementing `claim`/`markDone`/`resetToPending`/`markFailed`/`readStatus` with the same rule as `consumer.ts:240-295` (claim matches `pending` OR stale-`processing`, stamps the token; terminal writes guard on the token). Assert: `enrichFn` called exactly once across both deliveries; final row `done`; both deliveries `ack` (none `retry`).

#### 2. Stale-reclaim arm

**File**: `src/lib/enrichment/consumer.test.ts` (extend); `createSupabaseStore` builder assertion extends the `consumer.test.ts:222-305` fake-builder pattern

**Intent**: Prove the threshold flows into the query and the handler reclaims correctly. Builder-level: assert `claim()` builds the `.or(...)` predicate containing `enrichment_attempted_at.lt.<staleBefore>` with `staleBefore` derived from `STALE_PROCESSING_THRESHOLD_MS` (12 min). Handler-level (in-memory fake): a `processing` row older than the threshold IS re-claimed (enrich proceeds); a fresh `processing` row is NOT (claim→null→ack-skip).

**Contract**: assert the `.or()` argument string shape and the computed `staleBefore` boundary; assert reclaim vs skip via the fake store with controllable `enrichment_attempted_at`. Threshold injected via `ctx.staleThresholdMs` where helpful (`consumer.ts:71,81`).

#### 3. Real-store token guards on `markDone` / `resetToPending`

**File**: `src/lib/enrichment/consumer.test.ts` (extend the `:222-305` real-store-guard block)

**Intent**: Mirror the existing `markFailed`/`readStatus` builder guards for the two untested terminal writes, so a regression dropping a token guard (which would let a stale invocation clobber) is caught.

**Contract**: assert `markDone` builds with `.eq('enrichment_status','processing')` + `.eq('enrichment_attempted_at', claimedAt)` (`consumer.ts:266-268`); assert `resetToPending` builds with its token guard (`:277-278`).

#### 4. Reset-fail → stale-backstop recovery

**File**: `src/lib/enrichment/consumer.test.ts` (extend)

**Intent**: Prove the documented bounded-recovery path (`consumer.ts:197-203`): when `resetToPending` itself fails on a transient error, the handler still `message.retry()`s and the row remains reclaimable by the stale backstop (not wedged forever).

**Contract**: stub `resetToPending` to throw; assert `message.retry()` is called and no terminal `failed` write occurs; document (assert via comment/test name) that recovery is via the 12-min stale arm.

### Success Criteria:

#### Automated Verification:

- Extended suite passes: `npm test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- Review that the in-memory fake store's CAS rule matches `consumer.ts:240-295` exactly (no divergence that would make the interleave test vacuous).

**Implementation Note**: After automated verification passes, pause for the manual fake-store parity review before proceeding.

---

## Phase 3: Submission Insert/Enqueue Durability (Risk #4a, integration)

### Overview

Lock the submission endpoint's durability contract truthfully, correct the two misleading comments, and open the deferred recovery-sweep change.

### Changes Required:

#### 1. Enqueue-fail and insert-fail durability assertions

**File**: `src/pages/api/submissions.test.ts` (extend; real `enqueueEnrichment` over a mocked `QUEUE.send`, mocked admin client — existing pattern)

**Intent**: Strengthen the existing enqueue-fail test (`:307-318`, which only checks the 201) to also assert the row was inserted as `enrichment_status='pending'` (recoverable by status-scan) and the static failure event was logged; confirm insert-fail returns 500 with no enqueue and no request-body echo.

**Contract**: enqueue-fail case → `QUEUE.send` throws; assert response 201, the admin insert received `enrichment_status:'pending'`, and `console.error` carried the static `submission_enqueue_failed`/`queue_send_error` event with **no id/body**. Insert-fail case (`:271-280`) → assert 500, `QUEUE.send` not called, body is the static Polish string only.

#### 2. Correct the misleading comments

**File**: `src/pages/api/submissions.ts` (comment-only edit; no behavior change)

**Intent**: Make the code tell the truth: the recovery sweep does not exist yet (it is a deferred change), and the id-less enqueue-fail log is forensic-only — stranded rows are found by `enrichment_status='pending'` status-scan, not by this log line.

**Contract**: rewrite the comment at `submissions.ts:57-60` (drop "is recovered by the pending-rows re-enqueue sweep"; state it as a deferred follow-up) and trim `:17` (drop "greppable in `wrangler tail` for the recovery sweep"). No code lines change; tests from change #1 stay green.

#### 3. Open the deferred recovery-sweep change

**File**: new change folder via `/10x-new` (e.g. `submission-enqueue-recovery-sweep`)

**Intent**: Record the production work this phase deliberately defers so it is not lost: a `scheduled` handler + `triggers.crons` that re-enqueues `pending` rows older than N minutes, with the total-outage failure-signal decoupling (`lessons.md:68-73`) considered there.

**Contract**: a `change.md` stub capturing the gap, linking back to this plan and `research.md §Open Questions #1`. No implementation here.

### Success Criteria:

#### Automated Verification:

- Extended route suite passes: `npm test`
- Comment edit does not change behavior (suite still green): `npm test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- Confirm the corrected comments accurately describe the deferred-sweep state (no remaining claim that a sweep exists).
- Confirm the follow-up change folder exists with a clear stub.

**Implementation Note**: After automated verification passes, pause for the manual comment + follow-up review.

---

## Testing Strategy

### Unit Tests:

- Taxonomy drift guard: set-equality TS↔CHECK for 5 columns, both directions, diacritic-sensitive; `ai_classification` has no CHECK.
- Enrichment idempotency: duplicate-delivery interleave (enrich once, no clobber); stale-arm predicate + reclaim-vs-skip; `markDone`/`resetToPending` token guards; reset-fail→retry recovery.

### Integration Tests:

- Submission endpoint (route + mocked QUEUE/admin): enqueue-fail → 201 + `pending` row + logged event; insert-fail → 500 + no enqueue + no body echo.

### Manual Testing Steps:

1. Mutation-check each drift-guard assertion (remove a value each side → guard fails, naming the value).
2. Review fake-store CAS parity against `consumer.ts:240-295`.
3. Review corrected comments + the deferred-sweep follow-up stub.

## Migration Notes

No schema or data migration. The drift-guard test only **reads** migration files; it never applies them.

## References

- Research: `context/changes/testing-submission-durability-taxonomy/research.md`
- Test strategy: `context/foundation/test-plan.md` §2 (Risk #4/#7), §6.1/§6.4/§6.5 (cookbook slots this phase fills)
- Phase 1 patterns: `context/archive/2026-06-08-testing-access-control-anonymity/plan.md`
- Enrichment design: `context/archive/2026-06-02-ai-enrichment-queue/plan.md`
- Existing patterns to extend: `src/lib/enrichment/consumer.test.ts:222-305`, `src/pages/api/submissions.test.ts:307-318`, `src/lib/enrichment/enrich.test.ts:37-45`
- Lessons: `context/foundation/lessons.md` (reset-before-reenqueue; don't harden a non-existent consumer; gate the failure signal)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Taxonomy Drift Guard

#### Automated

- [x] 1.1 New drift-guard test runs and passes at HEAD (`npm test`) — a5cd2f7
- [x] 1.2 Type checking passes (`npm run typecheck`) — a5cd2f7
- [x] 1.3 Linting passes (`npm run lint`) — a5cd2f7

#### Manual

- [x] 1.4 Mutation check: removing a value either side fails the guard with the offending column + value — a5cd2f7
- [x] 1.5 Parser ignores non-taxonomy CHECKs (content/signature) without error — a5cd2f7

### Phase 2: Enrichment Queue Idempotency

#### Automated

- [x] 2.1 Extended consumer suite passes (`npm test`) — 7c9cb69
- [x] 2.2 Type checking passes (`npm run typecheck`) — 7c9cb69
- [x] 2.3 Linting passes (`npm run lint`) — 7c9cb69

#### Manual

- [x] 2.4 In-memory fake-store CAS rule matches `consumer.ts:240-295` (no divergence) — 7c9cb69

### Phase 3: Submission Insert/Enqueue Durability

#### Automated

- [x] 3.1 Extended route suite passes — enqueue-fail (201 + `pending` + log) and insert-fail (500, no enqueue, no echo) (`npm test`) — a93ed55
- [x] 3.2 Comment-only edit keeps the suite green (`npm test`) — a93ed55
- [x] 3.3 Type checking passes (`npm run typecheck`) — a93ed55
- [x] 3.4 Linting passes (`npm run lint`) — a93ed55

#### Manual

- [x] 3.5 Corrected comments accurately describe the deferred-sweep state — a93ed55
- [x] 3.6 Deferred recovery-sweep follow-up change folder exists with a clear stub — a93ed55
