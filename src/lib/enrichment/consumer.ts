// Per-message consumer logic for the async enrichment path (F-03), Phase 3.
//
// Lifecycle for one `{ submissionId }` message:
//   1. CAS claim    pending (or stale-processing) → processing   [idempotency core]
//   2. enrich       call the provider seam on the row's content
//   3. write-back   processing → done with the AI fields, or
//   4. transient    reset processing → pending, then message.retry()  [platform redelivers]
//   5. permanent    processing → failed + FR-018 signal, then ack()
//
// Retry EXHAUSTION is owned exclusively by the platform: `max_retries` → dead-letter queue.
// The main handler carries NO app-level attempts cap (two caps would race). `enrichment_attempts`
// is incremented for forensics, never as a control gate. The DLQ branch (processDeadLetterMessage)
// is the SOLE authority that fails a transient-exhausted row.
//
// DB access goes through the small SubmissionStore seam below so the orchestration is unit-testable
// without a live Postgres; createSupabaseStore() is the one real implementation.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../database.types";

import { enrich, type EnrichmentResult } from "./enrich";
import { EnrichmentError, isTransient, type ErrorKind } from "./errors";
import { emitFailureSignal, logEnrichment } from "./log";
import type { EnrichmentMessage } from "./types";

// Stale-processing reclaim window — a CRASH BACKSTOP ONLY. The normal transient path resets the
// row to `pending` before retrying (branch 4), so retries never wait this out. Set generously long
// (well past the worst-case enrich() duration) so a fresh `processing` row genuinely means another
// active invocation, never a legitimate retry in flight.
const STALE_PROCESSING_THRESHOLD_MS = 12 * 60 * 1000;

// Exponential backoff hint for message.retry(); the platform's max_retries is the real cap.
const RETRY_BASE_DELAY_SECONDS = 10;
const RETRY_MAX_DELAY_SECONDS = 300;

export interface ClaimedRow {
  id: string;
  content: string;
  /** Pre-claim attempt count. The attempt number for THIS delivery is `attempts + 1`. */
  attempts: number;
}

// The DB seam the consumer drives. One real impl (createSupabaseStore); tests inject a mock.
// Property-style signatures (not method shorthand) so referencing `store.markFailed` etc. in tests
// is not flagged as an unbound method.
export interface SubmissionStore {
  /** Atomic CAS: claim `pending` (or stale-`processing`) → `processing`. Returns the row, or null. */
  claim: (id: string, claimedAt: string, staleBefore: string) => Promise<ClaimedRow | null>;
  /** Write the enrichment outputs and flip → `done` (guarded on this claim). */
  markDone: (id: string, result: EnrichmentResult, attempts: number, claimedAt: string) => Promise<void>;
  /** Reset `processing` → `pending` (guarded on this claim) so a redelivery re-claims cleanly. */
  resetToPending: (id: string, attempts: number, claimedAt: string) => Promise<void>;
  /**
   * Terminal failure: flip → `failed` + record a (PII-safe) last-error, never clobbering a `done` row.
   * Pass `claimedAt` to additionally guard on the per-claim token: the permanent-error branch passes
   * its own claim, the DLQ branch passes the token it observed via `readStatus` (optimistic concurrency)
   * — either way a row re-claimed by another invocation is left untouched. Omit only when no token exists.
   * Returns the number of rows the guarded UPDATE affected: `> 0` when this write landed the `failed`
   * row, `0` when the row was re-claimed / already terminal so the guard matched nothing. Callers gate
   * the durable failure signal + alert on this count (lessons: emit the signal only when the write applied).
   */
  markFailed: (id: string, lastError: string, attempts: number, claimedAt?: string | null) => Promise<number>;
  /** Read current lifecycle state (DLQ idempotency + signal attempt count + per-claim token). */
  readStatus: (id: string) => Promise<{ status: string; attempts: number; attemptedAt: string | null } | null>;
  /**
   * Ids of `pending` rows older than `olderThanIso` (by `created_at`), oldest first, capped at `limit`.
   * Powers the recovery sweep's re-enqueue of rows whose initial enqueue silently failed.
   */
  selectStrandedPending: (olderThanIso: string, limit: number) => Promise<{ id: string }[]>;
}

export interface ConsumerContext {
  store: SubmissionStore;
  apiKey: string;
  /** Injectable enrich seam for tests; defaults to the real OpenAI-backed enrich(). */
  enrichFn?: (content: string, opts: { apiKey: string }) => Promise<EnrichmentResult>;
  /** Override the stale-processing reclaim window (crash backstop only). */
  staleThresholdMs?: number;
  /**
   * Injected error-capture seam (worker.ts wires the Sentry-backed impl; tests omit it → no-op).
   * Keeps this module SDK-free and node-pool-testable, mirroring the `store`/`enrichFn` injection.
   * Receives a body-free `descriptor` + PII-safe tags — NEVER a raw error/EnrichmentError (whose
   * `.message` can carry the OpenAI body = submission content). Called only at the two TERMINAL
   * failure points the consumer swallows; transient retry paths self-heal and are not captured.
   */
  captureError?: (
    descriptor: string,
    tags: {
      errorType: "permanent" | "retry_exhausted";
      submissionId: string;
      errorKind?: ErrorKind;
      errorStatus?: number;
    },
  ) => void;
}

export async function processEnrichmentMessage(
  message: Message<EnrichmentMessage>,
  ctx: ConsumerContext,
): Promise<void> {
  const { submissionId } = message.body;
  const enrichFn = ctx.enrichFn ?? enrich;
  const claimedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - (ctx.staleThresholdMs ?? STALE_PROCESSING_THRESHOLD_MS)).toISOString();

  let claimed: ClaimedRow | null;
  try {
    claimed = await ctx.store.claim(submissionId, claimedAt, staleBefore);
  } catch {
    // The claim write itself failed (DB error) — transient. Let the platform redeliver.
    logEnrichment({ event: "enrichment_retrying", submissionId, reason: "claim_failed" });
    message.retry({ delaySeconds: backoffSeconds(1) });
    return;
  }

  if (!claimed) {
    // No row claimed: it is already `done`, or another invocation holds a FRESH claim. Either way,
    // ack and skip — never a second AI call. (A genuinely stuck row is recovered by stale-reclaim.)
    logEnrichment({ event: "enrichment_skipped", submissionId });
    message.ack();
    return;
  }

  const attempt = claimed.attempts + 1;
  logEnrichment({ event: "enrichment_claimed", submissionId, attempts: attempt });

  let result: EnrichmentResult;
  try {
    result = await enrichFn(claimed.content, { apiKey: ctx.apiKey });
  } catch (err) {
    if (isTransient(err)) {
      // Reset processing → pending (guarded on THIS claim) BEFORE re-enqueueing, so the redelivery
      // re-claims cleanly through the `pending` branch instead of waiting out the stale threshold
      // (lessons: "reset a claimed row to its re-claimable state before re-enqueueing a retry").
      await resetForRetry(ctx.store, submissionId, attempt, claimedAt);
      logEnrichment({ event: "enrichment_retrying", submissionId, attempts: attempt, ...errorTelemetry(err) });
      message.retry({ delaySeconds: backoffSeconds(attempt) });
      return;
    }
    // Permanent (4xx/auth/schema). NOT an attempts cap — exhaustion is the DLQ's job. Guarded on THIS
    // claim (claimedAt): if a stale-reclaim handed the row to a fresh invocation, this write no-ops
    // instead of clobbering that claim (and dropping a result the fresh claim may still produce).
    let rowsFailed: number;
    try {
      rowsFailed = await ctx.store.markFailed(submissionId, redactError(err), attempt, claimedAt);
    } catch {
      // DB unavailable while recording the failure — reset and retry the terminal write later.
      await resetForRetry(ctx.store, submissionId, attempt, claimedAt);
      logEnrichment({ event: "enrichment_retrying", submissionId, attempts: attempt, reason: "fail_writeback_failed" });
      message.retry({ delaySeconds: backoffSeconds(attempt) });
      return;
    }
    // Gate the durable signal + capture on the guarded write actually landing a row (lessons: gate a
    // failure signal on the guarded write applying). `rowsFailed === 0` means the row was re-claimed
    // between claim and markFailed — another invocation owns it, so this is not a failure to report;
    // still ack (the row is handled, not lost). Body-free descriptor, never `err`.
    if (rowsFailed > 0) {
      emitFailureSignal({ submissionId, errorType: "permanent", attempts: attempt, ...errorTelemetry(err) });
      ctx.captureError?.(redactError(err), { errorType: "permanent", submissionId, ...errorTelemetry(err) });
    }
    message.ack();
    return;
  }

  try {
    await ctx.store.markDone(submissionId, result, attempt, claimedAt);
  } catch {
    // Write-back failed (transient DB error). Reset → pending and retry so the row never wedges in
    // `processing`; the redelivery re-enriches (bounded by max_retries).
    await resetForRetry(ctx.store, submissionId, attempt, claimedAt);
    logEnrichment({ event: "enrichment_retrying", submissionId, attempts: attempt, reason: "writeback_failed" });
    message.retry({ delaySeconds: backoffSeconds(attempt) });
    return;
  }

  logEnrichment({ event: "enrichment_done", submissionId, attempts: attempt });
  message.ack();
}

// Dead-letter backstop — the SOLE authority for retry-exhaustion failures. A message that exhausts
// the main queue's max_retries lands here; this is where its row becomes `failed`. Idempotent with
// the permanent branch above: a row already `failed` (or that succeeded after all) is a no-op.
export async function processDeadLetterMessage(
  message: Message<EnrichmentMessage>,
  ctx: ConsumerContext,
): Promise<void> {
  const { submissionId } = message.body;

  let current: { status: string; attempts: number; attemptedAt: string | null } | null;
  try {
    current = await ctx.store.readStatus(submissionId);
  } catch {
    // Can't read the row (DB error). Retry the DLQ delivery, bounded by the DLQ's own max_retries.
    message.retry();
    return;
  }

  if (!current || current.status === "done" || current.status === "failed") {
    // Row vanished, succeeded after all, or already terminal — idempotent no-op; never clobber.
    message.ack();
    return;
  }

  let rowsFailed: number;
  try {
    // Guard on the token observed above: if a fresh claim re-stamped the row between readStatus and
    // here (e.g. a re-enqueue raced this exhausted delivery), this write no-ops rather than failing a
    // row that another invocation is actively — and possibly successfully — processing.
    rowsFailed = await ctx.store.markFailed(
      submissionId,
      "Enrichment retries exhausted (max_retries) — routed to DLQ",
      current.attempts,
      current.attemptedAt,
    );
  } catch {
    message.retry();
    return;
  }
  // Same rows-affected gate as the permanent branch: a fresh claim that re-stamped the row between
  // readStatus and markFailed yields zero rows here — emit no false exhaustion signal/capture, still ack.
  if (rowsFailed > 0) {
    emitFailureSignal({ submissionId, errorType: "retry_exhausted", attempts: current.attempts });
    // Static descriptor (no PII); gated on the same successful markFailed as the durable signal above.
    ctx.captureError?.("Enrichment retries exhausted (max_retries) — routed to DLQ", {
      errorType: "retry_exhausted",
      submissionId,
    });
  }
  message.ack();
}

async function resetForRetry(
  store: SubmissionStore,
  submissionId: string,
  attempt: number,
  claimedAt: string,
): Promise<void> {
  try {
    await store.resetToPending(submissionId, attempt, claimedAt);
  } catch {
    // Even the reset write failed; the stale-processing reclaim backstop recovers the row once the
    // threshold passes. Nothing more to do here — message.retry() is still issued by the caller.
    logEnrichment({ event: "enrichment_retrying", submissionId, attempts: attempt, reason: "reset_failed" });
  }
}

function backoffSeconds(attempt: number): number {
  const delay = RETRY_BASE_DELAY_SECONDS * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, RETRY_MAX_DELAY_SECONDS);
}

function errorTelemetry(err: unknown): { errorKind?: ErrorKind; errorStatus?: number } {
  if (err instanceof EnrichmentError) {
    return { errorKind: err.kind, errorStatus: err.status };
  }
  return {};
}

// PII guard (impl-review-phase-2 F1): EnrichmentError.message can carry up to 500 chars of the
// OpenAI error body, which on a 4xx commonly echoes a slice of the submission content. Since
// `enrichment_last_error` feeds the S-03 failure-alert email, store a body-free descriptor only.
function redactError(err: unknown): string {
  if (err instanceof EnrichmentError) {
    return err.status !== undefined
      ? `Enrichment ${err.kind} error (HTTP ${err.status})`
      : `Enrichment ${err.kind} error`;
  }
  return "Enrichment failed (unexpected error)";
}

// The one real SubmissionStore. Uses the service-role client (createAdminClient) which bypasses RLS
// and the column grants withheld from anon/authenticated. The claim is a single conditional UPDATE
// (atomic CAS); supabase-js cannot express `attempts = attempts + 1` in the same statement, so the
// incremented attempt count is persisted on each terminal/transition write instead — attempts is
// forensic-only, so this is safe. Each transition write is guarded on `enrichment_attempted_at`
// (the unique per-claim token) so a row reclaimed by another invocation is never clobbered; `markFailed`
// guards on the token when given one (its `≠ done` floor covers the rare never-claimed DLQ row).
export function createSupabaseStore(db: SupabaseClient<Database>): SubmissionStore {
  return {
    async claim(id, claimedAt, staleBefore) {
      const { data, error } = await db
        .from("submissions")
        .update({ enrichment_status: "processing", enrichment_attempted_at: claimedAt })
        .eq("id", id)
        .or(
          `enrichment_status.eq.pending,and(enrichment_status.eq.processing,enrichment_attempted_at.lt.${staleBefore})`,
        )
        .select("id, content, enrichment_attempts");
      if (error) throw error;
      if (data.length === 0) return null;
      const row = data[0];
      return { id: row.id, content: row.content, attempts: row.enrichment_attempts };
    },

    async markDone(id, result, attempts, claimedAt) {
      const { error } = await db
        .from("submissions")
        .update({
          enrichment_status: "done",
          ai_tone: result.tone,
          ai_classification: result.classification,
          ai_title: result.title,
          ai_summary: result.summary,
          enrichment_attempts: attempts,
          enrichment_last_error: null,
        })
        .eq("id", id)
        .eq("enrichment_status", "processing")
        .eq("enrichment_attempted_at", claimedAt);
      if (error) throw error;
    },

    async resetToPending(id, attempts, claimedAt) {
      const { error } = await db
        .from("submissions")
        .update({ enrichment_status: "pending", enrichment_attempts: attempts })
        .eq("id", id)
        .eq("enrichment_status", "processing")
        .eq("enrichment_attempted_at", claimedAt);
      if (error) throw error;
    },

    async markFailed(id, lastError, attempts, claimedAt) {
      // Floor: never clobber a `done` row. When a claim token is supplied, also require it to still
      // match — so a write from an invocation that has since lost the claim affects zero rows.
      let query = db
        .from("submissions")
        .update({ enrichment_status: "failed", enrichment_last_error: lastError, enrichment_attempts: attempts })
        .eq("id", id)
        .neq("enrichment_status", "done");
      if (claimedAt != null) {
        query = query.eq("enrichment_attempted_at", claimedAt);
      }
      // `.select("id")` surfaces the rows the guarded UPDATE actually matched, so the caller can gate
      // the durable signal/alert on the write landing (0 rows = re-claimed / already terminal).
      const { data, error } = await query.select("id");
      if (error) throw error;
      return data.length;
    },

    async readStatus(id) {
      const { data, error } = await db
        .from("submissions")
        .select("enrichment_status, enrichment_attempts, enrichment_attempted_at")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data
        ? {
            status: data.enrichment_status,
            attempts: data.enrichment_attempts,
            attemptedAt: data.enrichment_attempted_at,
          }
        : null;
    },

    async selectStrandedPending(olderThanIso, limit) {
      // `.eq` (not `.in`) so the WHERE matches the leading equality of the composite
      // submissions_enrichment_status_created_at_idx; oldest-first + limit bound each sweep tick.
      const { data, error } = await db
        .from("submissions")
        .select("id")
        .eq("enrichment_status", "pending")
        .lt("created_at", olderThanIso)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return data;
    },
  };
}
