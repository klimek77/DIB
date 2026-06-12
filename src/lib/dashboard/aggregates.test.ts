import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/database.types";
import { BRANCHES, TONES, TOPICS } from "@/lib/submissions/taxonomies";

import { fetchDashboardAggregates, fetchSubmissionsList } from "./aggregates";
import type { ResolvedRange } from "./range";

const RANGE: ResolvedRange = {
  preset: "30d",
  fromIso: "2026-05-13T10:00:00.000Z",
  toIso: "2026-06-12T10:00:00.000Z",
  branch: null,
  label: "Ostatnie 30 dni",
};

const RANGE_WITH_BRANCH: ResolvedRange = { ...RANGE, branch: BRANCHES[4] };

// SQL emits exactly 8 zero-filled buckets; tests fabricate the same shape.
function weekBuckets(counts: number[]): { week_start: string; iso_week: string; count: number }[] {
  return counts.map((count, i) => ({
    week_start: `2026-04-${String(20 + i).padStart(2, "0")}`,
    iso_week: String(17 + i),
    count,
  }));
}

function rpcPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total_range: 0,
    total_all: 0,
    by_topic: {},
    by_branch: {},
    by_tone: {},
    by_week: weekBuckets([0, 0, 0, 0, 0, 0, 0, 0]),
    ...overrides,
  };
}

// Mock at the edge only (the Supabase client), per the _submissions.test.ts pattern.
function makeRpcClient(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient<Database>, rpc };
}

// Chainable recorder for the list query. `in` is deliberately ABSENT: if the
// implementation ever regressed from .eq to .in (breaking the partial-index
// match), the chain would throw TypeError instead of passing silently.
function makeListClient(result: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return method === "limit" ? Promise.resolve(result) : builder;
    };
  const builder = {
    select: record("select"),
    eq: record("eq"),
    gte: record("gte"),
    lt: record("lt"),
    order: record("order"),
    limit: record("limit"),
  };
  const from = vi.fn().mockReturnValue(builder);
  return { client: { from } as unknown as SupabaseClient<Database>, from, calls };
}

describe("fetchDashboardAggregates — RPC call shape", () => {
  it("passes the range bounds and omits p_branch when no branch filter", async () => {
    const { client, rpc } = makeRpcClient({ data: rpcPayload(), error: null });

    await fetchDashboardAggregates(client, RANGE);

    expect(rpc).toHaveBeenCalledExactlyOnceWith("dashboard_aggregates", {
      p_from: RANGE.fromIso,
      p_to: RANGE.toIso,
      p_branch: undefined,
    });
  });

  it("passes p_branch when the range carries a branch filter", async () => {
    const { client, rpc } = makeRpcClient({ data: rpcPayload(), error: null });

    await fetchDashboardAggregates(client, RANGE_WITH_BRANCH);

    expect(rpc).toHaveBeenCalledExactlyOnceWith("dashboard_aggregates", {
      p_from: RANGE.fromIso,
      p_to: RANGE.toIso,
      p_branch: BRANCHES[4],
    });
  });

  it("propagates an RPC error as an exception (no silent empty data)", async () => {
    const { client } = makeRpcClient({ data: null, error: { message: "boom" } });

    await expect(fetchDashboardAggregates(client, RANGE)).rejects.toThrow(/dashboard_aggregates RPC failed/);
  });
});

describe("fetchDashboardAggregates — zero-fill mapping", () => {
  it("fills the FULL taxonomy shape with zeros from an empty jsonb", async () => {
    const { client } = makeRpcClient({ data: rpcPayload(), error: null });

    const result = await fetchDashboardAggregates(client, RANGE);

    expect(result.byTopic).toEqual(Object.fromEntries(TOPICS.map((t) => [t, 0])));
    expect(result.byBranch).toEqual(Object.fromEntries(BRANCHES.map((b) => [b, 0])));
    expect(result.byTone).toEqual(Object.fromEntries(TONES.map((t) => [t, 0])));
    expect(result.totalRange).toBe(0);
    expect(result.totalAll).toBe(0);
  });

  it("merges present counts over the zero-filled shape", async () => {
    const { client } = makeRpcClient({
      data: rpcPayload({
        total_range: 5,
        total_all: 12,
        by_topic: { Pomysł: 3, Problem: 2 },
        by_branch: { Gliwice: 4, Centrala: 1 },
        by_tone: { Pozytywny: 3, Negatywny: 2 },
      }),
      error: null,
    });

    const result = await fetchDashboardAggregates(client, RANGE);

    expect(result.byTopic).toEqual({ Pomysł: 3, Problem: 2, Usprawnienie: 0, Inne: 0 });
    expect(result.byBranch.Gliwice).toBe(4);
    expect(result.byBranch.Centrala).toBe(1);
    expect(result.byBranch.Katowice).toBe(0);
    expect(result.byTone).toEqual({ Pozytywny: 3, Negatywny: 2, Neutralny: 0 });
    expect(result.totalRange).toBe(5);
    expect(result.totalAll).toBe(12);
  });
});

describe("fetchDashboardAggregates — negPct", () => {
  it("computes the rounded negative percentage", async () => {
    const { client } = makeRpcClient({
      data: rpcPayload({ total_range: 3, by_tone: { Negatywny: 1 } }),
      error: null,
    });

    await expect(fetchDashboardAggregates(client, RANGE)).resolves.toMatchObject({ negPct: 33 });
  });

  it("rounds half up (1/6 → 17)", async () => {
    const { client } = makeRpcClient({
      data: rpcPayload({ total_range: 6, by_tone: { Negatywny: 1 } }),
      error: null,
    });

    await expect(fetchDashboardAggregates(client, RANGE)).resolves.toMatchObject({ negPct: 17 });
  });

  it("is null when the range is empty (UI shows a dash, never NaN)", async () => {
    const { client } = makeRpcClient({ data: rpcPayload({ total_range: 0 }), error: null });

    await expect(fetchDashboardAggregates(client, RANGE)).resolves.toMatchObject({ negPct: null });
  });
});

describe("fetchDashboardAggregates — by_week pass-through (SQL owns week math)", () => {
  it("passes 8 buckets through, renaming keys only", async () => {
    const counts = [0, 1, 2, 3, 4, 5, 6, 7];
    const { client } = makeRpcClient({ data: rpcPayload({ by_week: weekBuckets(counts) }), error: null });

    const result = await fetchDashboardAggregates(client, RANGE);

    expect(result.byWeek).toHaveLength(8);
    expect(result.byWeek.map((w) => w.count)).toEqual(counts);
    expect(result.byWeek[0]).toEqual({ weekStartIso: "2026-04-20", isoWeek: "17", count: 0 });
  });

  it.each([
    ["7 buckets", weekBuckets([0, 0, 0, 0, 0, 0, 0])],
    ["9 buckets", weekBuckets([0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["not an array", { oops: true }],
  ])("throws on a contract violation: %s", async (_name, byWeek) => {
    const { client } = makeRpcClient({ data: rpcPayload({ by_week: byWeek }), error: null });

    await expect(fetchDashboardAggregates(client, RANGE)).rejects.toThrow(/by_week must contain exactly 8 buckets/);
  });

  it("throws on a malformed bucket (missing iso_week)", async () => {
    const buckets = weekBuckets([0, 0, 0, 0, 0, 0, 0, 0]).map(({ week_start, count }) => ({ week_start, count }));
    const { client } = makeRpcClient({ data: rpcPayload({ by_week: buckets }), error: null });

    await expect(fetchDashboardAggregates(client, RANGE)).rejects.toThrow(/by_week bucket shape mismatch/);
  });
});

describe("fetchSubmissionsList — query builder", () => {
  it("pins .eq on enrichment_status (partial-index contract) and all range filters", async () => {
    const { client, from, calls } = makeListClient({ data: [], error: null });

    await fetchSubmissionsList(client, RANGE);

    expect(from).toHaveBeenCalledExactlyOnceWith("submissions");
    expect(calls).toContainEqual({ method: "eq", args: ["enrichment_status", "done"] });
    expect(calls).toContainEqual({ method: "gte", args: ["created_at", RANGE.fromIso] });
    expect(calls).toContainEqual({ method: "lt", args: ["created_at", RANGE.toIso] });
    expect(calls).toContainEqual({ method: "order", args: ["created_at", { ascending: false }] });
    expect(calls).toContainEqual({ method: "limit", args: [100] });
    // No branch filter when range.branch is null.
    expect(calls.filter((c) => c.method === "eq")).toHaveLength(1);
  });

  it("selects exactly the list columns", async () => {
    const { client, calls } = makeListClient({ data: [], error: null });

    await fetchSubmissionsList(client, RANGE);

    const select = calls.find((c) => c.method === "select");
    expect(select?.args[0]).toBe("id, created_at, branch, topic, ai_title, ai_summary, ai_tone");
  });

  it("adds the branch .eq when the range carries a branch", async () => {
    const { client, calls } = makeListClient({ data: [], error: null });

    await fetchSubmissionsList(client, RANGE_WITH_BRANCH);

    expect(calls).toContainEqual({ method: "eq", args: ["branch", BRANCHES[4]] });
  });

  it("honors a custom limit", async () => {
    const { client, calls } = makeListClient({ data: [], error: null });

    await fetchSubmissionsList(client, RANGE, 25);

    expect(calls).toContainEqual({ method: "limit", args: [25] });
  });

  it("returns the fetched rows", async () => {
    const row = {
      id: "row-1",
      created_at: "2026-06-10T08:00:00.000Z",
      branch: "Gliwice",
      topic: "Pomysł",
      ai_title: "Tytuł",
      ai_summary: "Podsumowanie",
      ai_tone: "Pozytywny",
    };
    const { client } = makeListClient({ data: [row], error: null });

    await expect(fetchSubmissionsList(client, RANGE)).resolves.toEqual([row]);
  });

  it("propagates a query error as an exception", async () => {
    const { client } = makeListClient({ data: null, error: { message: "boom" } });

    await expect(fetchSubmissionsList(client, RANGE)).rejects.toThrow(/dashboard submissions list query failed/);
  });
});
