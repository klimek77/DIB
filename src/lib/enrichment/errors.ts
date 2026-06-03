// Transient-vs-permanent error taxonomy for the enrichment path. The consumer
// (Phase 3) keys its retry decision on this: a `transient` error calls
// `message.retry()` (platform redelivers with backoff), a `permanent` error goes
// straight to a `failed` row. Retry exhaustion itself is owned by the platform's
// `max_retries` + DLQ — this classifier only decides retry-vs-fail per attempt,
// never "how many times".

export type ErrorKind = "transient" | "permanent";

export class EnrichmentError extends Error {
  readonly kind: ErrorKind;
  /** HTTP status that produced the error, when the cause was an HTTP response. */
  readonly status?: number;

  constructor(kind: ErrorKind, message: string, status?: number) {
    super(message);
    this.name = "EnrichmentError";
    this.kind = kind;
    this.status = status;
  }
}

// 429 (rate limit) and any 5xx (server-side) are worth retrying; everything else
// in the 4xx family (400 bad request, 401/403 auth, 404, 422 schema) is a caller
// fault that will not fix itself on redelivery, so it is permanent.
export function classifyHttpStatus(status: number): ErrorKind {
  if (status === 429 || status >= 500) return "transient";
  return "permanent";
}

// The consumer's retry gate. A typed EnrichmentError carries its own verdict; any
// other throw (network drop, DNS failure, fetch TypeError, AbortSignal timeout)
// has no HTTP status and is treated as transient — it may succeed on redelivery,
// and the bounded `max_retries` + DLQ backstop caps the cost of a real dead end.
export function isTransient(err: unknown): boolean {
  if (err instanceof EnrichmentError) return err.kind === "transient";
  return true;
}
