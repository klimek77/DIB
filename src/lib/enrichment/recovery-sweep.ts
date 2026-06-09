// Recovery sweep for submission rows stranded in `enrichment_status = 'pending'` — rows whose
// initial enqueue (src/pages/api/submissions.ts) silently failed and which therefore never reach the
// consumer. Held as a runtime-agnostic pure function so it is unit-testable without a Workers runtime
// or a live Supabase; src/worker.ts's `scheduled` handler injects the real selector + enqueue closure
// (mirroring how the `queue` handler delegates to consumer.ts).
//
// Anonymity NFR: this function touches no id or body in any log — it returns counts only and the
// caller emits the single id-less summary line. Per-row enqueue failures are isolated so one
// un-enqueueable row never aborts the batch (it increments `failed` and the sweep continues).

export interface RecoverySweepDeps {
  /** Ids of `pending` rows older than `olderThanIso` (by `created_at`), oldest first, bounded by `limit`. */
  selectStrandedPending: (olderThanIso: string, limit: number) => Promise<{ id: string }[]>;
  /** Re-send one stranded row through the normal enrichment queue. */
  enqueue: (submissionId: string) => Promise<void>;
  /** Injected clock so the cutoff is deterministic in tests. */
  now: () => number;
}

export interface RecoverySweepOptions {
  /** A row counts as stranded once its `created_at` is older than this many milliseconds. */
  olderThanMs: number;
  /** Max rows re-enqueued per run; the rest wait for the next tick (bounds work under a backlog). */
  limit: number;
}

export interface RecoverySweepResult {
  scanned: number;
  reenqueued: number;
  failed: number;
}

export async function runRecoverySweep(
  deps: RecoverySweepDeps,
  opts: RecoverySweepOptions,
): Promise<RecoverySweepResult> {
  // Age from `created_at`, not `enrichment_attempted_at`: a never-enqueued row has the latter NULL.
  const olderThanIso = new Date(deps.now() - opts.olderThanMs).toISOString();
  const rows = await deps.selectStrandedPending(olderThanIso, opts.limit);

  let reenqueued = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deps.enqueue(row.id);
      reenqueued += 1;
    } catch {
      // Isolate per-row failures: one un-enqueueable row must not abort the rest of the batch. No
      // id/body logged (anonymity); the count surfaces in the caller's summary so the run stays auditable.
      failed += 1;
    }
  }

  return { scanned: rows.length, reenqueued, failed };
}
