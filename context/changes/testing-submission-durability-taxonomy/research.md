---
date: 2026-06-08T14:21:06+0200
researcher: klimek77
git_commit: 0e821d5ea03b240a435b5eebf54bfc465cc2ccd6
branch: main
repository: DIB
topic: "Phase 2 grounding — submission durability (Risk #4) & AI-enrichment idempotency (Risk #7)"
tags: [research, codebase, submissions, enrichment-queue, taxonomy, idempotency, durability]
status: complete
last_updated: 2026-06-08
last_updated_by: klimek77
---

# Research: Phase 2 grounding — submission durability (Risk #4) & AI-enrichment idempotency (Risk #7)

**Date**: 2026-06-08T14:21:06+0200
**Researcher**: klimek77
**Git Commit**: 0e821d5ea03b240a435b5eebf54bfc465cc2ccd6
**Branch**: main
**Repository**: DIB

## Research Question

Ground the two Phase-2 test risks from `test-plan.md §2` in live code:

- **Risk #4** — verify the insert/enqueue sequence and the `taxonomies.ts ↔ migration-CHECK` mapping; prove "UI success ⇒ durable row or clean error" and that enqueue-fail can't silently drop data. Challenge **"200 == saved + queued"** and **"taxonomies always match DB"**.
- **Risk #7** — verify the `pending → processing` CAS, the stale-reclaim threshold, and the transient/permanent boundary in `src/lib/enrichment/`; prove a duplicate delivery neither re-calls AI nor overwrites the result. Challenge **"retry always safe"**.

## Summary

Three verdicts, two of them overturning a comforting assumption:

| Claim under test | Verdict | One-line reason |
|---|---|---|
| Risk #4a — "UI success ⇒ durable row **or** clean error; enqueue-fail can't silently drop data" | **PARTIAL — disproven for the enqueue-fail half** | insert-fail → clean 500 ✓; but insert-OK + enqueue-fail returns **201** and the "pending-rows re-enqueue sweep" the code comment relies on **does not exist** → row stranded in `pending` forever. |
| Risk #4 — "HTTP 200 == saved AND queued" | **FALSE** | 201 guarantees the row was saved; it does **not** guarantee the job was queued (enqueue `catch` only logs, then falls through to the same 201). |
| Risk #4b — "taxonomies always match DB" | **TRUE at HEAD, but UNGUARDED** | All 5 DB-enforced taxonomy columns match `taxonomies.ts` character-for-character today; **no test** locks `taxonomies.ts ≡ CHECK` — parity is held by hand-written comments only. |
| Risk #7 — "2nd delivery neither re-calls AI nor overwrites result; stale `processing` reclaimed" | **PROVEN (logic), but stale-reclaim itself UNTESTED** | CAS branches on rows-affected → duplicate ack-skips; result-write is independently token-guarded; 12-min stale backstop exists; the transient retry resets `processing→pending` first (the known wedge is avoided). |
| Risk #7 — "retry is always safe" | **FALSE** | Permanent (4xx / off-SSOT) errors go straight to `failed` + ack, **not** retry. The transient/permanent boundary is real in `errors.ts`; conflating them would burn redeliveries on un-retryable errors. |

The cheapest layer that gives signal (per `test-plan.md §2` Risk Response): **unit** drift-guard for #4b; **unit / integration** for the #4a enqueue-fail path and the #7 stale-reclaim + CAS rows-affected branch (the two highest-value uncovered seams).

## Detailed Findings

### Risk #4a — Insert / enqueue durability (DISPROVEN for enqueue-fail)

**Sequence** (`src/pages/api/submissions.ts`), fully sequential and awaited:
1. Parse body — `request.json()` (`submissions.ts:28`); parse error → 400 (`:30`).
2. Validate — `validateSubmissionInput(body)` (`:35`); invalid → 400 (`:37`).
3. Service-role client — `createAdminClient(env)` (`:40`).
4. **Insert** — `.insert({ ...validation.value, enrichment_status: "pending" }).select("id").single()` (`:44-48`); error inspected (`:50-55`).
5. **Enqueue** — `try { await enqueueEnrichment(env, data.id) } catch { logSubmissionEvent(...) }` (`:62-66`); `enqueueEnrichment` = `await env.QUEUE.send({ submissionId })` (`enqueue.ts:8`).
6. **Respond** — `json({ ok: true }, 201)` (`:68`) — reached on **both** enqueue success and enqueue failure.

**Failure-mode matrix:**

| Scenario | Code does | UI sees | Silent data loss? | Ref |
|---|---|---|---|---|
| insert-fail (CHECK / constraint / conn) | log `submission_insert_failed`, return **500**, enqueue never reached | server error, stays on form, no "thank you" | **No** — nothing saved, clean error | `submissions.ts:50-55` |
| enqueue-fail (`QUEUE.send` throws) | row already `pending`; `catch` logs `submission_enqueue_failed`, **falls through to 201**; no row mutation, no retry, no compensating mark | "Dziękujemy!" (redirect on 2xx) | **Yes (effectively)** — row survives but stuck `pending` forever; never enriched, never on `done`-gated dashboard | `submissions.ts:62-66,68` |
| both-ok | insert returns id; enqueue resolves; 201 | "Dziękujemy!" | No | `submissions.ts:44-68` |

**The load-bearing gap — the recovery sweep is vaporware.** The comment at `submissions.ts:57-60` justifies swallowing the enqueue failure: *"An insert-succeeded-but-never-enqueued row is recovered by the pending-rows re-enqueue sweep."* A full `src/` + `wrangler.jsonc` + `worker.ts` search found **no `scheduled` handler** (`worker.ts` exports only `fetch` + `queue`), **no `triggers`/`crons` block** in `wrangler.jsonc`, and **no sweep code** anywhere — `sweep|re-enqueue|cron|scheduled` matches only archived plan docs. The consumer's stale-reclaim recovers rows that *were* enqueued; it has no path to discover a `pending` row that was **never enqueued**. So today an enqueue-fail row is terminally stranded. Historical context confirms this was **always deferred** (S-01 documented the sweep but did not build it — see Historical Context).

**Challenge result — "200 == saved + queued": FALSE.** 201 means "row saved **AND** (job queued **OR** enqueue silently failed)". There is no transaction across insert+enqueue (Cloudflare Queues cannot enlist in a Postgres tx); the `pending` status was *intended* as a recoverable marker, but recoverability depends on a sweep that does not exist.

### Risk #4b — Taxonomy drift (`taxonomies.ts ↔ CHECK`): match at HEAD, NO GUARD

**Mapping** — `src/lib/submissions/taxonomies.ts` vs the final-effective DB CHECKs (all defined in `20260528000000_create_submissions.sql`; the two later migrations do **not** touch any taxonomy value set):

| Column | TS (`taxonomies.ts`) | DB CHECK (migration) | Match? | Notes |
|---|---|---|---|---|
| `department` | `DEPARTMENTS` ×11 (`:18-30`) | `submissions_department_check` ×11 (`20260528…:58-63`) | **Y** | Column made **nullable** by `20260605…:30-31` (`DROP NOT NULL`); CHECK passes on NULL by default. TS side optional (`submission-input.ts:24,73-78`). Aligned. |
| `branch` | `BRANCHES` ×9 (`:32-42`) | `submissions_branch_check` ×9 (`20260528…:64-69`) | **Y** | Required both sides; diacritics match exactly (`Tarnowskie Góry`, `Oświęcim`, `Dąbrowa Górnicza`). **Highest-risk** (user-supplied, required). |
| `topic` | `TOPICS` ×4 (`:44`) | `submissions_topic_check` ×4 (`20260528…:70-71`) | **Y** | Required; `Pomysł` carries trailing `ł` both sides. **Highest-risk** (user-supplied). |
| `enrichment_status` | `ENRICHMENT_STATUSES` ×4 (`:48`) | `submissions_enrichment_status_check` (`20260528…:74-75`) | **Y** | `pending/processing/done/failed`; app-set, not user-supplied. |
| `ai_tone` | `TONES` ×3 (`:46`) | `submissions_ai_tone_check` `IS NULL OR IN(...)` (`20260528…:76-77`) | **Y** | Server-written; also feeds OpenAI schema enum (`openai.ts:27`). |
| `ai_classification` | `CLASSIFICATIONS` ×5 (`:54`) | **no DB CHECK** | **N/A** | App-level SSOT only (`taxonomies.ts:51-53`); no DB constraint to drift against. |

**Findings:**
- **No drift at current HEAD**, for any column, in either direction (no TS-not-DB or DB-not-TS, no casing/diacritic mismatch).
- **Parity is discipline-only.** It is held by comments (`taxonomies.ts:1-10` "future migrations MUST update this file in the same commit"; `submission-input.ts:9-10` "a diacritic drift would pass here only to fail the DB CHECK on INSERT") — **not assertions**. A migration adding a value without editing `taxonomies.ts` would compile, lint, typecheck, and pass all 7 existing test files.
- **No Postgres ENUM/domain.** The CHECK is the single physical SSOT; generated `database.types.ts` falls back to plain `string` (`:34,44,51,...`) — zero enum-level type safety (supabase/cli#1433, documented `taxonomies.ts:12-16`). This is *why* the hand-maintained mirror exists.
- **App validation derives FROM `taxonomies.ts`** (`submission-input.ts:12` imports + `.includes()` at `:47,53,74`; `openai.ts:7` for AI path) — so the app layer can't drift from the TS const. The **only un-asserted seam is `taxonomies.ts ↔ SQL CHECK`**.
- **Existing "drift guard" is the wrong seam.** `enrich.test.ts:37-45` (gate 2.3) asserts the OpenAI-schema enum equals the TS const — it never reads a `.sql` file. `test-plan.md §6.5` marks the real TS↔CHECK guard **"TBD — Phase 2"**.

**Challenge result — "taxonomies always match DB": TRUE today, but nothing prevents future drift.** A drift would surface as a DB CHECK rejection at INSERT (Risk #4a's insert-fail path) for `branch`/`topic` from untrusted form input — which is exactly why #4a and #4b are the same phase.

### Risk #7 — AI-enrichment queue idempotency (PROVEN; stale-reclaim UNTESTED)

**State machine** — columns in `20260528…create_submissions.sql`: `enrichment_status` (`:47`, CHECK `:74-75`), `enrichment_attempts` (`:48`, **forensic only**, never a control gate), `enrichment_last_error` (`:49`), `enrichment_attempted_at` (`:50`, **the per-claim CAS token**, starts NULL). Unchanged by later migrations.

Transitions in `consumer.ts`: `pending→processing` CAS `claim()` (`:239-252`); `processing→done` `markDone()` guarded (`:254-270`); `processing→pending` `resetToPending()` guarded (`:272-280`); `processing→failed` `markFailed()` guarded (`:282-295`).

**1. CAS claim** (`consumer.ts:240-251`): `UPDATE ... SET status='processing', attempted_at=claimedAt WHERE id=$ AND (status.eq.pending OR and(status.eq.processing, attempted_at.lt.staleBefore))`, then `if (data.length === 0) return null`. It branches on **rows-affected**; caller (`:93-99`) logs `enrichment_skipped` + `message.ack()` + returns — **no AI call, no write**.

**2. Duplicate delivery** — delivery #2 (row already `processing`, token not yet stale): CAS WHERE matches neither arm → 0 rows → `claim` returns null → ack-skip. **AI is never re-called; nothing written.** The result-write is **independently** token-guarded: `markDone` requires `attempted_at = claimedAt` (`:266-268`), so a write from an invocation whose token no longer matches affects 0 rows — no clobber even if a claim had slipped through. Two *simultaneous* `pending` deliveries are serialized by Postgres on the row UPDATE; the second's WHERE no longer matches → 0 rows. **No window found where #2 re-calls AI or clobbers.**

**3. Stale-reclaim** — `STALE_PROCESSING_THRESHOLD_MS = 12 * 60 * 1000` (**12 min**, `consumer.ts:31`, overridable via `ctx.staleThresholdMs`); `staleBefore = now - threshold` (`:81`). Second OR-arm re-claims a `processing` row older than 12 min and re-stamps `attempted_at`, stale-ing the orphaned invocation's token so its later guarded writes no-op. Documented as a **crash backstop only** (`:27-30`) — set well past worst-case `enrich()` duration (`DEFAULT_TIMEOUT_MS = 30s`, `openai.ts:14`).

**4. Transient vs permanent** (`errors.ts`): `classifyHttpStatus` → **429 / ≥500 → transient**, everything else (400/401/403/404/422) → **permanent** (`:26-29`); untyped throws (network/abort) → transient (`:35-38`). OpenAI producers: network/abort → transient (`openai.ts:69`), `!response.ok` → `classifyHttpStatus` (`:74-78`), empty/invalid-JSON/off-SSOT-enum → **permanent** (`:85,92,103-118`).

| Class | Action | Resets row re-claimable BEFORE redelivery? | Ref |
|---|---|---|---|
| Transient | `resetToPending` then `message.retry()` | **YES** (`processing→pending`, token-guarded) | `consumer.ts:108-115,191-204,272-280` |
| Permanent | `markFailed(...,claimedAt)` + `emitFailureSignal` + `ack()` | N/A — terminal, guarded on token + `≠ done` | `consumer.ts:117-131,282-295` |
| `markFailed`/`markDone` write fails (DB down) | `resetToPending` + `retry()` | YES | `consumer.ts:122-127,136-142` |
| `claim` write fails (DB down) | `retry()` (nothing claimed) | N/A | `consumer.ts:86-90` |

**The `lessons.md` wedge is AVOIDED.** On transient, the code calls `resetToPending` (`processing→pending`) **before** `message.retry()` (`consumer.ts:112-114`, with an explicit comment citing the lesson at `:109-111`). The redelivery re-claims through the cheap `pending` arm immediately — **not** by waiting out the 12-min stale window. This is exactly the [[reset-claimed-row-before-reenqueue]] rule from `lessons.md:47-52`, implemented correctly.

**Challenge result — "retry always safe": FALSE.** Permanent (4xx / off-SSOT-enum) errors go straight to `failed` + ack — they are **not** retried. The boundary is real in `errors.ts:26-29`; conflating transient and permanent would burn redeliveries on un-retryable errors and delay (or mask) the terminal `failed` state.

**Stuck-forever paths** (all bounded, none infinite under a healthy DB):
1. `resetToPending` itself fails (`consumer.ts:197-203`): row stays `processing` with a *fresh* token; recovered by the **12-min stale backstop**.
2. Crash between claim and write: row left `processing`, non-stale token; recovered by the **stale backstop** at 12 min (the window the backstop exists for).
3. DLQ depends on the same failing store (`consumer.ts:159-186`): bounded by the **DLQ's own `max_retries`**; only a *persistent* DB outage across both queues can drop the `failed` stamp — an infra failure mode, documented as the [[terminal-queue-total-outage]] residual risk (`lessons.md:68-73`), not a logic wedge.

Retry **exhaustion** is owned solely by the platform `max_retries → DLQ` (`consumer.ts:10-13,149-151`); the handler carries no app-level attempts cap, deliberately avoiding two racing caps.

### Reconciliation note (an agent finding that did NOT survive verification)

One sub-agent flagged a `department` `NOT NULL` (DB) vs *optional* (validator) mismatch as a live insert-fail trigger — based on reading only `20260528…create_submissions.sql:37`. **Verified false at HEAD**: `20260605000000_..._department_optional...sql:30-31` runs `ALTER COLUMN department DROP NOT NULL` (comment: *"F-01 created it NOT NULL. Drop the constraint."*). At current HEAD `department` is **nullable and aligned** with the optional validator. Recorded here so the plan does not chase a phantom — the only realistic validated-payload → CHECK-rejection path is **taxonomy drift** (Risk #4b), which connects the two halves of Risk #4. (Cf. `lessons.md` "Verify every finding against the code before turning it into a plan".)

## Code References

- `src/pages/api/submissions.ts:44-68` — insert → enqueue → 201; enqueue-fail swallowed in `catch` (`:62-66`)
- `src/pages/api/submissions.ts:57-60` — comment promising a non-existent "pending-rows re-enqueue sweep"
- `src/lib/enrichment/enqueue.ts:8` — `env.QUEUE.send({ submissionId })`
- `src/worker.ts:21-36` — exports only `fetch` + `queue`; **no `scheduled` handler**
- `wrangler.jsonc` — `queues` block only; **no `triggers`/`crons`**
- `src/lib/submissions/taxonomies.ts:18-54` — the 6 taxonomy consts (5 DB-enforced + `CLASSIFICATIONS` app-only)
- `src/lib/submissions/submission-input.ts:12,47-78` — app validation derived from `taxonomies.ts`
- `supabase/migrations/20260528000000_create_submissions.sql:58-77` — all 5 taxonomy CHECK constraints (physical SSOT)
- `supabase/migrations/20260605000000_..._department_optional...sql:30-31` — `department DROP NOT NULL`
- `src/lib/enrichment/consumer.ts:240-251` — CAS claim (rows-affected branch at `:249`)
- `src/lib/enrichment/consumer.ts:31` — `STALE_PROCESSING_THRESHOLD_MS` = 12 min
- `src/lib/enrichment/consumer.ts:108-115` — transient: `resetToPending` BEFORE `message.retry()`
- `src/lib/enrichment/consumer.ts:254-295` — token-guarded `markDone` / `resetToPending` / `markFailed`
- `src/lib/enrichment/errors.ts:26-38` — transient/permanent classification
- `src/lib/enrichment/enrich.test.ts:37-45` — existing OpenAI-schema↔TS-const guard (NOT the SQL seam)
- `src/lib/enrichment/consumer.test.ts:65-141,222-305` — existing idempotency/transient/permanent/DLQ + real-store `markFailed`/`readStatus` guards

## Architecture Insights

- **Two independent idempotency mechanisms in the consumer**: (1) the `pending→processing` CAS gate (prevents *starting* duplicate work) and (2) the `attempted_at = claimedAt` optimistic-concurrency token on every terminal write (prevents a stale invocation *clobbering* the result). They are orthogonal; tests must cover both, not assume one implies the other.
- **`enrichment_attempts` is forensic, not control** — the queue platform's `max_retries → DLQ` is the *sole* retry-exhaustion authority. A test or change that gates behavior on `enrichment_attempts` would introduce a second, racing cap.
- **Durability boundary is the insert/enqueue seam, not the consumer.** The consumer is robust; the gap is upstream — a row that never reaches the queue (enqueue-fail) is outside the consumer's recoverable set, and the compensating sweep is unbuilt.
- **The CHECK is the only enum SSOT in the DB** (no Postgres ENUM/domain), and generated types are plain `string` — so taxonomy safety lives entirely in `taxonomies.ts` + the (missing) TS↔SQL guard.

## Historical Context (from prior changes)

- `context/archive/2026-06-02-ai-enrichment-queue/plan.md:252-261,59,61,63,249` — designed the CAS predicate, the 10–15 min stale threshold (impl chose 12), the transient/permanent rule, the DLQ-as-sole-exhaustion-authority, and **adopted** "reset `processing→pending` before re-enqueue on transient retry" (plan-review F1 → `lessons.md:47-52`).
- `context/archive/2026-06-4-first-end-to-end-submission/plan.md:71-72,172` — insert→enqueue design: insert-fail = 500, enqueue-fail = **return success**; the orphan-recovery sweep was **documented and deferred** (never implemented) — directly confirms the #4a vaporware-sweep finding.
- `context/archive/2026-05-29-submissions-data-model-hardening/plan.md:106-107,67-68` — added `ENRICHMENT_STATUSES` mirror, `btrim(content)` and `signature` CHECKs; specified a schema-enum-equals-const drift guard but deferred the test to "Phase 2" (this change).
- `context/archive/2026-05-28-submissions-data-model/plan.md` — original CHECK constraints + anon column grants; service-role insert bypasses grants but not CHECK/constraints.
- `context/archive/2026-06-08-testing-access-control-anonymity/` (Phase 1) — established the reusable test patterns below.

## Related Research

- `context/archive/2026-06-08-testing-access-control-anonymity/research.md` — Phase 1 of this same test rollout (access-control & anonymity, Risks #1/#2/#3).

**Phase 1 test patterns to reuse in Phase 2:**
- **Config-frozen-at-import unit test**: `vi.resetModules()` + `vi.doMock("astro:env/server", ...)` + dynamic `import()` (`src/lib/auth/allowlist.test.ts`) — applies to any module that snapshots env/state at import.
- **Edge-only mocking for route/consumer tests**: mock Supabase client, `QUEUE`, OpenAI; never mock internal modules (`submissions.test.ts`, `consumer.test.ts`).
- **Injected-keys exhaustive seal**: `expect(Object.keys(value).sort()).toEqual([...])` to prove server fields are ignored by construction (`submission-input.test.ts`).
- **Error-path no-echo assert**: static Polish error body, no request-field leak.

## Open Questions

1. **Decision for #4a (plan input):** build the `pending`-rows re-enqueue sweep (a `scheduled` handler + `triggers.crons` in `wrangler.jsonc`) so the durability claim becomes true — **or** delete the misleading `submissions.ts:57-60` comment and explicitly document/accept the silent-strand risk. A test cannot make the claim true; it can only lock in whichever decision is made.
2. **#4b parser robustness:** the drift-guard must parse the *final-effective* CHECK set across migrations in date order (only `20260528…` defines taxonomy values today, but the parser should survive a future DROP/re-ADD, mirroring how `content_length` was replaced in `20260529…`). Diacritic-sensitive set-equality, both directions, excluding `ai_classification` (and asserting no `ai_classification` CHECK exists, so a future one is caught).
3. **#7 highest-value uncovered seams:** (a) the real-store CAS `data.length === 0 ⇒ null` branch (mocked-store tests stub `claim`); (b) the stale-reclaim `.or()` stale arm — that a >12-min `processing` row IS re-claimable and a fresh one is NOT (entirely unproven today); (c) `resetToPending`/`markDone` token guards at the real store (only `markFailed`/`readStatus` are asserted); (d) an end-to-end two-delivery interleave proving #1 claims and #2 CAS-misses.
4. **Layer choice:** can (3a)–(3c) be driven at the `createSupabaseStore` builder level with a mocked PostgREST client (unit, cheap), or do they need an emulated/real Postgres (integration) to exercise the atomic UPDATE-WHERE semantics honestly? The `test-plan.md §2` Risk #7 row leans unit ("extend existing in `src/lib/enrichment/`"); confirm during planning.
