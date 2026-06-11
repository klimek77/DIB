import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "../database.types";

import {
  type ConsumerContext,
  createSupabaseStore,
  processDeadLetterMessage,
  processEnrichmentMessage,
  type SubmissionStore,
} from "./consumer";
import type { EnrichmentResult } from "./enrich";
import { EnrichmentError } from "./errors";
import type { EnrichmentMessage } from "./types";

// A minimal queue Message — the consumer only touches `body`, `ack`, and `retry`. We keep the
// spies separately so assertions stay typed as mocks (the cast erases the Mock type on the message).
function makeMessage(submissionId: string) {
  const ack = vi.fn();
  const retry = vi.fn();
  const message = { body: { submissionId }, ack, retry } as unknown as Message<EnrichmentMessage>;
  return { message, ack, retry };
}

function makeStore(overrides: Partial<SubmissionStore> = {}): SubmissionStore {
  return {
    claim: vi.fn(() => Promise.resolve<{ id: string; content: string; attempts: number } | null>(null)),
    markDone: vi.fn(() => Promise.resolve()),
    resetToPending: vi.fn(() => Promise.resolve()),
    markFailed: vi.fn(() => Promise.resolve()),
    readStatus: vi.fn(() =>
      Promise.resolve<{ status: string; attempts: number; attemptedAt: string | null } | null>(null),
    ),
    selectStrandedPending: vi.fn(() => Promise.resolve<{ id: string }[]>([])),
    ...overrides,
  };
}

// Collect single-string console.log lines (the JSON log/signal transport) without leaking to stdout.
function captureLogs() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
    if (typeof value === "string") lines.push(value);
  });
  return {
    lines,
    restore: () => {
      spy.mockRestore();
    },
  };
}

const RESULT: EnrichmentResult = {
  tone: "Pozytywny",
  classification: "pomysł",
  title: "Więcej miejsc parkingowych",
  summary: "Pracownik proponuje powiększenie firmowego parkingu.",
};

function ctxWith(store: SubmissionStore, enrichFn?: ConsumerContext["enrichFn"]): ConsumerContext {
  return { store, apiKey: "test-key", enrichFn };
}

describe("processEnrichmentMessage", () => {
  it("acks without an AI call when no row is claimed (already done / fresh in-flight) — gate 3.4", async () => {
    const log = captureLogs();
    const enrichFn = vi.fn<NonNullable<ConsumerContext["enrichFn"]>>();
    const store = makeStore({ claim: vi.fn(() => Promise.resolve(null)) });
    const { message, ack, retry } = makeMessage("id-done");

    await processEnrichmentMessage(message, ctxWith(store, enrichFn));

    expect(enrichFn).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(store.markDone).not.toHaveBeenCalled();
    log.restore();
  });

  it("enriches and marks the row done on success", async () => {
    const log = captureLogs();
    const enrichFn = vi.fn(() => Promise.resolve(RESULT));
    const store = makeStore({ claim: vi.fn(() => Promise.resolve({ id: "id-1", content: "treść", attempts: 0 })) });
    const { message, ack, retry } = makeMessage("id-1");

    await processEnrichmentMessage(message, ctxWith(store, enrichFn));

    expect(enrichFn).toHaveBeenCalledOnce();
    // attempt = pre-claim attempts (0) + 1
    expect(store.markDone).toHaveBeenCalledWith("id-1", RESULT, 1, expect.any(String));
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    log.restore();
  });

  it("on a transient error: resets to pending, retries, and does NOT write failed — gate 3.5", async () => {
    const log = captureLogs();
    const enrichFn = vi.fn(() => Promise.reject(new EnrichmentError("transient", "rate limited", 429)));
    const store = makeStore({ claim: vi.fn(() => Promise.resolve({ id: "id-1", content: "treść", attempts: 0 })) });
    const { message, ack, retry } = makeMessage("id-1");

    await processEnrichmentMessage(message, ctxWith(store, enrichFn));

    expect(store.resetToPending).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    expect(store.markFailed).not.toHaveBeenCalled();
    log.restore();
  });

  it("on a permanent error: marks failed, emits the FR-018 signal, and acks — gate 3.5", async () => {
    const log = captureLogs();
    // The error message echoes a slice of submission content — it must NOT leak into logs or the DB.
    const leakyMessage = 'OpenAI returned 400: {"input":"PARKING PROPOSAL FROM JAN KOWALSKI"}';
    const enrichFn = vi.fn(() => Promise.reject(new EnrichmentError("permanent", leakyMessage, 400)));
    const store = makeStore({ claim: vi.fn(() => Promise.resolve({ id: "id-1", content: "treść", attempts: 2 })) });
    const { message, ack, retry } = makeMessage("id-1");

    await processEnrichmentMessage(message, ctxWith(store, enrichFn));

    expect(store.markFailed).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();

    // FR-018 signal emitted with the permanent errorType.
    expect(
      log.lines.some((l) => l.includes('"event":"enrichment_failed"') && l.includes('"errorType":"permanent"')),
    ).toBe(true);
    // PII guard (impl-review-phase-2 F1): the raw OpenAI body must not reach logs OR enrichment_last_error.
    expect(log.lines.some((l) => l.includes("PARKING PROPOSAL"))).toBe(false);
    // Clobber guard: this branch holds a fresh claim, so it must pass its claim token (claimedAt) to
    // markFailed — a stale invocation that lost the claim then no-ops instead of clobbering.
    expect(store.markFailed).toHaveBeenCalledWith(
      "id-1",
      expect.not.stringContaining("PARKING PROPOSAL"),
      3,
      expect.any(String),
    );
    log.restore();
  });

  it("permanent error: captureError gets the redacted descriptor + PII-safe tags (impl-review F3)", async () => {
    const log = captureLogs();
    const leakyMessage = 'OpenAI returned 400: {"input":"PARKING PROPOSAL FROM JAN KOWALSKI"}';
    const enrichFn = vi.fn(() => Promise.reject(new EnrichmentError("permanent", leakyMessage, 400)));
    const store = makeStore({ claim: vi.fn(() => Promise.resolve({ id: "id-1", content: "treść", attempts: 0 })) });
    const captureError = vi.fn<NonNullable<ConsumerContext["captureError"]>>();
    const { message } = makeMessage("id-1");

    await processEnrichmentMessage(message, { ...ctxWith(store, enrichFn), captureError });

    // Body-free descriptor + the same PII-safe tags the log signal carries — never the raw error.
    expect(captureError).toHaveBeenCalledExactlyOnceWith("Enrichment permanent error (HTTP 400)", {
      errorType: "permanent",
      submissionId: "id-1",
      errorKind: "permanent",
      errorStatus: 400,
    });
    log.restore();
  });

  it("captureError is NOT called when markFailed fails (gated on the guarded write applying)", async () => {
    const log = captureLogs();
    const enrichFn = vi.fn(() => Promise.reject(new EnrichmentError("permanent", "bad request", 400)));
    const store = makeStore({
      claim: vi.fn(() => Promise.resolve({ id: "id-1", content: "treść", attempts: 0 })),
      markFailed: vi.fn(() => Promise.reject(new Error("db down"))),
    });
    const captureError = vi.fn<NonNullable<ConsumerContext["captureError"]>>();
    const { message, retry } = makeMessage("id-1");

    await processEnrichmentMessage(message, { ...ctxWith(store, enrichFn), captureError });

    // Same gate as the FR-018 signal: no capture for a failure that was never durably recorded.
    expect(captureError).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
    log.restore();
  });

  it("transient error: captureError is not called (self-healing path is not alert-grade)", async () => {
    const log = captureLogs();
    const enrichFn = vi.fn(() => Promise.reject(new EnrichmentError("transient", "rate limited", 429)));
    const store = makeStore({ claim: vi.fn(() => Promise.resolve({ id: "id-1", content: "treść", attempts: 0 })) });
    const captureError = vi.fn<NonNullable<ConsumerContext["captureError"]>>();
    const { message } = makeMessage("id-1");

    await processEnrichmentMessage(message, { ...ctxWith(store, enrichFn), captureError });

    expect(captureError).not.toHaveBeenCalled();
    log.restore();
  });

  it("retries (not acks) when the success write-back fails, after resetting to pending", async () => {
    const log = captureLogs();
    const enrichFn = vi.fn(() => Promise.resolve(RESULT));
    const store = makeStore({
      claim: vi.fn(() => Promise.resolve({ id: "id-1", content: "treść", attempts: 0 })),
      markDone: vi.fn(() => Promise.reject(new Error("db down"))),
    });
    const { message, ack, retry } = makeMessage("id-1");

    await processEnrichmentMessage(message, ctxWith(store, enrichFn));

    expect(store.resetToPending).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    log.restore();
  });
});

describe("processDeadLetterMessage", () => {
  it("marks a retry-exhausted row failed and emits the FR-018 signal (sole exhaustion authority)", async () => {
    const log = captureLogs();
    const store = makeStore({
      readStatus: vi.fn(() =>
        Promise.resolve({ status: "processing", attempts: 5, attemptedAt: "2026-06-05T10:00:00.000Z" }),
      ),
    });
    const { message, ack, retry } = makeMessage("id-1");

    await processDeadLetterMessage(message, ctxWith(store));

    expect(store.markFailed).toHaveBeenCalledOnce();
    // Optimistic-concurrency guard: the DLQ holds no claim, so it passes the token it OBSERVED. If a
    // fresh claim re-stamped the row between readStatus and markFailed, the write no-ops (no clobber).
    expect(store.markFailed).toHaveBeenCalledWith("id-1", expect.any(String), 5, "2026-06-05T10:00:00.000Z");
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(
      log.lines.some((l) => l.includes('"event":"enrichment_failed"') && l.includes('"errorType":"retry_exhausted"')),
    ).toBe(true);
    log.restore();
  });

  it("retry-exhausted: captureError gets the static descriptor, gated on markFailed applying (impl-review F3)", async () => {
    const log = captureLogs();
    const store = makeStore({
      readStatus: vi.fn(() =>
        Promise.resolve({ status: "processing", attempts: 5, attemptedAt: "2026-06-05T10:00:00.000Z" }),
      ),
    });
    const captureError = vi.fn<NonNullable<ConsumerContext["captureError"]>>();
    const { message } = makeMessage("id-1");

    await processDeadLetterMessage(message, { ...ctxWith(store), captureError });

    expect(captureError).toHaveBeenCalledExactlyOnceWith("Enrichment retries exhausted (max_retries) — routed to DLQ", {
      errorType: "retry_exhausted",
      submissionId: "id-1",
    });
    log.restore();
  });

  it("captureError is NOT called when the DLQ markFailed fails or the row is already terminal", async () => {
    const log = captureLogs();
    const captureError = vi.fn<NonNullable<ConsumerContext["captureError"]>>();

    // markFailed rejects → retry path, no capture (same gate as the durable signal).
    const failingStore = makeStore({
      readStatus: vi.fn(() =>
        Promise.resolve({ status: "processing", attempts: 5, attemptedAt: "2026-06-05T10:00:00.000Z" }),
      ),
      markFailed: vi.fn(() => Promise.reject(new Error("db down"))),
    });
    const failing = makeMessage("id-1");
    await processDeadLetterMessage(failing.message, { ...ctxWith(failingStore), captureError });
    expect(captureError).not.toHaveBeenCalled();
    expect(failing.retry).toHaveBeenCalledOnce();

    // Row already done → idempotent no-op, no capture.
    const doneStore = makeStore({
      readStatus: vi.fn(() =>
        Promise.resolve({ status: "done", attempts: 3, attemptedAt: "2026-06-05T10:00:00.000Z" }),
      ),
    });
    const done = makeMessage("id-1");
    await processDeadLetterMessage(done.message, { ...ctxWith(doneStore), captureError });
    expect(captureError).not.toHaveBeenCalled();
    log.restore();
  });

  it("is an idempotent no-op when the row already succeeded (never clobbers a done row)", async () => {
    const log = captureLogs();
    const store = makeStore({
      readStatus: vi.fn(() =>
        Promise.resolve({ status: "done", attempts: 3, attemptedAt: "2026-06-05T10:00:00.000Z" }),
      ),
    });
    const { message, ack, retry } = makeMessage("id-1");

    await processDeadLetterMessage(message, ctxWith(store));

    expect(store.markFailed).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    log.restore();
  });

  it("is an idempotent no-op when the row is already failed", async () => {
    const log = captureLogs();
    const store = makeStore({
      readStatus: vi.fn(() =>
        Promise.resolve({ status: "failed", attempts: 5, attemptedAt: "2026-06-05T10:00:00.000Z" }),
      ),
    });
    const { message, ack } = makeMessage("id-1");

    await processDeadLetterMessage(message, ctxWith(store));

    expect(store.markFailed).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    log.restore();
  });
});

// These exercise the REAL SubmissionStore (createSupabaseStore) against a chainable supabase-js mock,
// so the per-claim WHERE-guards are asserted directly — the mocked-store tests above only cover WHEN a
// transition is requested, never the guard that decides whether it actually writes.
describe("createSupabaseStore — per-claim write guards", () => {
  interface FilterCall {
    op: "eq" | "neq";
    col: string;
    val: unknown;
  }
  interface BuilderRecord {
    table: string;
    updates: unknown[];
    selects: unknown[];
    filters: FilterCall[];
    ors: unknown[];
  }

  // A minimal thenable query builder: records the filter chain and resolves to a fixed result. markFailed
  // awaits the builder directly (so it needs `then`); readStatus ends in `.maybeSingle()`.
  function makeDb(result: { data?: unknown; error: unknown }) {
    const builders: BuilderRecord[] = [];
    const db = {
      from(table: string) {
        const rec: BuilderRecord = { table, updates: [], selects: [], filters: [], ors: [] };
        const builder = {
          update(values: unknown) {
            rec.updates.push(values);
            return builder;
          },
          select(cols: unknown) {
            rec.selects.push(cols);
            return builder;
          },
          eq(col: string, val: unknown) {
            rec.filters.push({ op: "eq", col, val });
            return builder;
          },
          neq(col: string, val: unknown) {
            rec.filters.push({ op: "neq", col, val });
            return builder;
          },
          or(arg: unknown) {
            rec.ors.push(arg);
            return builder;
          },
          maybeSingle() {
            return Promise.resolve(result);
          },
          then<T>(onFulfilled: (r: typeof result) => T) {
            return Promise.resolve(result).then(onFulfilled);
          },
        };
        builders.push(rec);
        return builder;
      },
    };
    return { db: db as unknown as SupabaseClient<Database>, builders };
  }

  it("markFailed guards on the per-claim token when claimedAt is supplied", async () => {
    const { db, builders } = makeDb({ error: null });
    await createSupabaseStore(db).markFailed("id-1", "boom", 3, "2026-06-05T10:00:00.000Z");

    const { filters } = builders[0];
    expect(filters).toContainEqual({ op: "neq", col: "enrichment_status", val: "done" });
    expect(filters).toContainEqual({ op: "eq", col: "enrichment_attempted_at", val: "2026-06-05T10:00:00.000Z" });
  });

  it("markFailed without a token guards only on not-done (never-claimed DLQ fallback)", async () => {
    const { db, builders } = makeDb({ error: null });
    await createSupabaseStore(db).markFailed("id-1", "exhausted", 5);

    const { filters } = builders[0];
    expect(filters).toContainEqual({ op: "neq", col: "enrichment_status", val: "done" });
    expect(filters.some((f) => f.col === "enrichment_attempted_at")).toBe(false);
  });

  it("readStatus returns the observed claim token for the DLQ optimistic guard", async () => {
    const { db } = makeDb({
      data: {
        enrichment_status: "processing",
        enrichment_attempts: 2,
        enrichment_attempted_at: "2026-06-05T10:00:00.000Z",
      },
      error: null,
    });

    const status = await createSupabaseStore(db).readStatus("id-1");

    expect(status).toEqual({ status: "processing", attempts: 2, attemptedAt: "2026-06-05T10:00:00.000Z" });
  });

  it("claim issues the CAS update with the stale-processing OR-predicate and returns the row", async () => {
    const { db, builders } = makeDb({
      data: [{ id: "id-1", content: "treść", enrichment_attempts: 0 }],
      error: null,
    });

    const row = await createSupabaseStore(db).claim("id-1", "2026-06-08T12:00:00.000Z", "2026-06-08T11:48:00.000Z");

    const { updates, filters, ors } = builders[0];
    expect(updates).toContainEqual({
      enrichment_status: "processing",
      enrichment_attempted_at: "2026-06-08T12:00:00.000Z",
    });
    expect(filters).toContainEqual({ op: "eq", col: "id", val: "id-1" });
    // The CAS matches a fresh `pending` row OR a `processing` row stale past the reclaim window.
    expect(ors).toContain(
      "enrichment_status.eq.pending,and(enrichment_status.eq.processing,enrichment_attempted_at.lt.2026-06-08T11:48:00.000Z)",
    );
    expect(row).toEqual({ id: "id-1", content: "treść", attempts: 0 });
  });

  it("claim returns null when the conditional update matches zero rows (rows-affected branch)", async () => {
    const { db } = makeDb({ data: [], error: null });

    const row = await createSupabaseStore(db).claim("id-1", "2026-06-08T12:00:00.000Z", "2026-06-08T11:48:00.000Z");

    expect(row).toBeNull();
  });

  it("markDone guards on processing + the per-claim token", async () => {
    const { db, builders } = makeDb({ error: null });
    await createSupabaseStore(db).markDone("id-1", RESULT, 1, "2026-06-05T10:00:00.000Z");

    const { updates, filters } = builders[0];
    expect(updates[0]).toMatchObject({ enrichment_status: "done", enrichment_last_error: null });
    expect(filters).toContainEqual({ op: "eq", col: "enrichment_status", val: "processing" });
    expect(filters).toContainEqual({ op: "eq", col: "enrichment_attempted_at", val: "2026-06-05T10:00:00.000Z" });
  });

  it("resetToPending guards on processing + the per-claim token", async () => {
    const { db, builders } = makeDb({ error: null });
    await createSupabaseStore(db).resetToPending("id-1", 2, "2026-06-05T10:00:00.000Z");

    const { updates, filters } = builders[0];
    expect(updates[0]).toMatchObject({ enrichment_status: "pending" });
    expect(filters).toContainEqual({ op: "eq", col: "enrichment_status", val: "processing" });
    expect(filters).toContainEqual({ op: "eq", col: "enrichment_attempted_at", val: "2026-06-05T10:00:00.000Z" });
  });
});

// End-to-handler idempotency: drive processEnrichmentMessage against a single in-memory row whose
// claim/markDone/resetToPending encode the SAME CAS rule as createSupabaseStore (status='pending' OR
// stale-'processing'; terminal writes guarded on the per-claim token). This proves the COMPOSITION —
// duplicate delivery, fresh-in-flight skip, stale reclaim — that the per-method tests above cannot.
// Manual parity gate (plan 2.4): this fake's rule must mirror consumer.ts:240-295.
interface FakeRow {
  status: string;
  attemptedAt: string | null;
  attempts: number;
  content: string;
  result: EnrichmentResult | null;
}

function makeInMemoryStore(initial: Partial<FakeRow> & { content: string }) {
  const row: FakeRow = { status: "pending", attemptedAt: null, attempts: 0, result: null, ...initial };
  const store: SubmissionStore = {
    claim: (id, claimedAt, staleBefore) => {
      const reclaimable =
        row.status === "pending" ||
        (row.status === "processing" && row.attemptedAt !== null && row.attemptedAt < staleBefore);
      if (!reclaimable) return Promise.resolve(null);
      row.status = "processing";
      row.attemptedAt = claimedAt;
      return Promise.resolve({ id, content: row.content, attempts: row.attempts });
    },
    markDone: (_id, result, attempts, claimedAt) => {
      if (row.status === "processing" && row.attemptedAt === claimedAt) {
        row.status = "done";
        row.result = result;
        row.attempts = attempts;
      }
      return Promise.resolve();
    },
    resetToPending: (_id, attempts, claimedAt) => {
      if (row.status === "processing" && row.attemptedAt === claimedAt) {
        row.status = "pending";
        row.attempts = attempts;
      }
      return Promise.resolve();
    },
    markFailed: (_id, _lastError, attempts, claimedAt) => {
      if (row.status !== "done" && (claimedAt == null || row.attemptedAt === claimedAt)) {
        row.status = "failed";
        row.attempts = attempts;
      }
      return Promise.resolve();
    },
    readStatus: (_id) => Promise.resolve({ status: row.status, attempts: row.attempts, attemptedAt: row.attemptedAt }),
    selectStrandedPending: (_olderThanIso, _limit) => Promise.resolve(row.status === "pending" ? [{ id: "id-1" }] : []),
  };
  return { store, row };
}

describe("processEnrichmentMessage — idempotency & stale reclaim (end-to-handler)", () => {
  it("duplicate delivery: a second delivery of a completed job neither re-calls AI nor overwrites the result", async () => {
    const log = captureLogs();
    const enrichFn = vi.fn(() => Promise.resolve(RESULT));
    const { store, row } = makeInMemoryStore({ content: "treść" });
    const ctx: ConsumerContext = { store, apiKey: "test-key", enrichFn };

    const first = makeMessage("id-1");
    await processEnrichmentMessage(first.message, ctx);
    const second = makeMessage("id-1");
    await processEnrichmentMessage(second.message, ctx);

    expect(enrichFn).toHaveBeenCalledOnce(); // NOT twice — the second delivery CAS-misses
    expect(row.status).toBe("done");
    expect(row.result).toEqual(RESULT); // not clobbered by the duplicate
    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(second.retry).not.toHaveBeenCalled();
    log.restore();
  });

  it("fresh in-flight duplicate: a delivery for a freshly-claimed row skips without re-calling AI", async () => {
    const log = captureLogs();
    const enrichFn = vi.fn(() => Promise.resolve(RESULT));
    // Another invocation holds a FRESH claim (attempted_at = now, within the stale window).
    const { store, row } = makeInMemoryStore({
      content: "treść",
      status: "processing",
      attemptedAt: new Date().toISOString(),
    });
    const ctx: ConsumerContext = { store, apiKey: "test-key", enrichFn };
    const { message, ack, retry } = makeMessage("id-1");

    await processEnrichmentMessage(message, ctx);

    expect(enrichFn).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(row.status).toBe("processing"); // untouched
    log.restore();
  });

  it("stale reclaim: a row stuck in processing past the stale threshold is re-claimed and enriched", async () => {
    const log = captureLogs();
    const enrichFn = vi.fn(() => Promise.resolve(RESULT));
    // A crashed prior invocation left the row `processing` with a long-stale token.
    const { store, row } = makeInMemoryStore({
      content: "treść",
      status: "processing",
      attemptedAt: "2000-01-01T00:00:00.000Z",
      attempts: 1,
    });
    const ctx: ConsumerContext = { store, apiKey: "test-key", enrichFn };
    const { message, ack, retry } = makeMessage("id-1");

    await processEnrichmentMessage(message, ctx);

    expect(enrichFn).toHaveBeenCalledOnce(); // reclaimed → enriched
    expect(row.status).toBe("done");
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    log.restore();
  });

  it("transient + resetToPending failure: still retries and leaves recovery to the stale backstop (no failed write)", async () => {
    const log = captureLogs();
    const enrichFn = vi.fn(() => Promise.reject(new EnrichmentError("transient", "rate limited", 429)));
    const store = makeStore({
      claim: vi.fn(() => Promise.resolve({ id: "id-1", content: "treść", attempts: 0 })),
      resetToPending: vi.fn(() => Promise.reject(new Error("db down"))),
    });
    const { message, ack, retry } = makeMessage("id-1");

    await processEnrichmentMessage(message, ctxWith(store, enrichFn));

    expect(store.resetToPending).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce(); // recovery deferred to the 12-min stale backstop
    expect(ack).not.toHaveBeenCalled();
    expect(store.markFailed).not.toHaveBeenCalled(); // a transient error must NOT fail the row
    expect(log.lines.some((l) => l.includes('"reason":"reset_failed"'))).toBe(true);
    log.restore();
  });
});
