// Structured, greppable logging for the enrichment consumer. Each call emits a single
// JSON line via `console`, which Workers Observability captures as the log transport
// (visible in `wrangler tail`). Keeps one consistent key shape across the path.
//
// PII guard (impl-review-phase-2 F1): NEVER pass `err.message`, the submission `content`,
// the `signature`, or the `env` object into these helpers. `EnrichmentError.message` can
// carry up to 500 chars of the OpenAI error body, which on a 4xx commonly echoes a slice
// of the user-authored submission content. Log only `errorKind` + `errorStatus` (+ ids).

import type { ErrorKind } from "./errors";

export type EnrichmentLogEvent =
  | "enrichment_claimed"
  | "enrichment_done"
  | "enrichment_retrying"
  | "enrichment_skipped";

export interface EnrichmentLogFields {
  event: EnrichmentLogEvent;
  submissionId: string;
  attempts?: number;
  errorKind?: ErrorKind;
  errorStatus?: number;
  /** Short, non-PII reason tag for diagnostics (e.g. "claim_failed", "writeback_failed"). */
  reason?: string;
}

export function logEnrichment(fields: EnrichmentLogFields): void {
  // eslint-disable-next-line no-console -- Workers Observability captures console as the log transport
  console.log(JSON.stringify({ ...fields, timestamp: new Date().toISOString() }));
}

// FR-018 failure signal — the durable, greppable event a future failure-alert change (S-03)
// will consume. The `enrichment_status='failed'` + `enrichment_last_error` row state is the
// second half of the signal; this is the first half. No email, no webhook here.
export interface FailureSignalFields {
  submissionId: string;
  /** "permanent" = 4xx/auth/schema in the main handler; "retry_exhausted" = max_retries → DLQ. */
  errorType: "permanent" | "retry_exhausted";
  attempts: number;
  errorKind?: ErrorKind;
  errorStatus?: number;
}

export function emitFailureSignal(fields: FailureSignalFields): void {
  // eslint-disable-next-line no-console -- Workers Observability captures console as the log transport
  console.log(JSON.stringify({ event: "enrichment_failed", ...fields, timestamp: new Date().toISOString() }));
}
