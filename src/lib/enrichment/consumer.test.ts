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
  }

  // A minimal thenable query builder: records the filter chain and resolves to a fixed result. markFailed
  // awaits the builder directly (so it needs `then`); readStatus ends in `.maybeSingle()`.
  function makeDb(result: { data?: unknown; error: unknown }) {
    const builders: BuilderRecord[] = [];
    const db = {
      from(table: string) {
        const rec: BuilderRecord = { table, updates: [], selects: [], filters: [] };
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
});
