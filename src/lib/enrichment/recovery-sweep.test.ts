import { describe, expect, it, vi } from "vitest";

import { type RecoverySweepDeps, runRecoverySweep } from "./recovery-sweep";

// Fake deps in the fake-store style of consumer.test.ts: property-style vi.fn() members so
// referencing them in expect(...) is not flagged as an unbound method.
function makeDeps(overrides: Partial<RecoverySweepDeps> = {}): RecoverySweepDeps {
  return {
    selectStrandedPending: vi.fn(() => Promise.resolve<{ id: string }[]>([])),
    enqueue: vi.fn(() => Promise.resolve()),
    now: () => 0,
    ...overrides,
  };
}

describe("runRecoverySweep", () => {
  it("re-enqueues every row the selector returns", async () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const deps = makeDeps({ selectStrandedPending: vi.fn(() => Promise.resolve(rows)) });

    const result = await runRecoverySweep(deps, { olderThanMs: 600_000, limit: 100 });

    expect(deps.enqueue).toHaveBeenCalledTimes(3);
    expect(deps.enqueue).toHaveBeenNthCalledWith(1, "a");
    expect(deps.enqueue).toHaveBeenNthCalledWith(2, "b");
    expect(deps.enqueue).toHaveBeenNthCalledWith(3, "c");
    expect(result).toEqual({ scanned: 3, reenqueued: 3, failed: 0 });
  });

  it("is a no-op when the selector returns no rows", async () => {
    const deps = makeDeps({ selectStrandedPending: vi.fn(() => Promise.resolve<{ id: string }[]>([])) });

    const result = await runRecoverySweep(deps, { olderThanMs: 600_000, limit: 100 });

    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 0, reenqueued: 0, failed: 0 });
  });

  it("isolates a per-row enqueue failure: counts it, still enqueues the rest, and does not throw", async () => {
    const rows = [{ id: "a" }, { id: "boom" }, { id: "c" }];
    const enqueue = vi.fn((id: string) =>
      id === "boom" ? Promise.reject(new Error("queue send failed")) : Promise.resolve(),
    );
    const deps = makeDeps({ selectStrandedPending: vi.fn(() => Promise.resolve(rows)), enqueue });

    const result = await runRecoverySweep(deps, { olderThanMs: 600_000, limit: 100 });

    expect(deps.enqueue).toHaveBeenCalledTimes(3); // the failure did not abort the batch
    expect(result).toEqual({ scanned: 3, reenqueued: 2, failed: 1 });
  });

  it("computes the cutoff as now - olderThanMs and passes its ISO form to the selector", async () => {
    const fixedNow = Date.parse("2026-06-09T12:00:00.000Z");
    const selectStrandedPending = vi.fn(() => Promise.resolve<{ id: string }[]>([]));
    const deps = makeDeps({ now: () => fixedNow, selectStrandedPending });

    await runRecoverySweep(deps, { olderThanMs: 10 * 60_000, limit: 100 });

    const expectedIso = new Date(fixedNow - 10 * 60_000).toISOString();
    expect(expectedIso).toBe("2026-06-09T11:50:00.000Z");
    expect(selectStrandedPending).toHaveBeenCalledWith(expectedIso, 100);
  });

  it("forwards the limit verbatim to the selector", async () => {
    const selectStrandedPending = vi.fn(() => Promise.resolve<{ id: string }[]>([]));
    const deps = makeDeps({ selectStrandedPending });

    await runRecoverySweep(deps, { olderThanMs: 600_000, limit: 42 });

    expect(selectStrandedPending).toHaveBeenCalledWith(expect.any(String), 42);
  });
});
