import { beforeEach, describe, expect, it, vi } from "vitest";

import { type DashboardAggregates, fetchDashboardAggregates } from "@/lib/dashboard/aggregates";
import type { ResolvedRange } from "@/lib/dashboard/range";
import { createAdminClient } from "@/lib/enrichment/supabase-admin";
import { BRANCHES, type Branch, TONES, TOPICS, type Topic } from "@/lib/submissions/taxonomies";

import { resolveAlertRecipients } from "./recipients";
import { buildWeeklyDigest, sendWeeklyDigest } from "./weekly-digest";

// Edges only: the RPC client, its recipient resolver, and the admin client.
// The channel (`sendEmail`) and the window math (`previousWarsawWeekRange`) stay
// REAL — the happy-path asserts the actual composed Resend payload via fetchImpl.
vi.mock("@/lib/dashboard/aggregates");
vi.mock("@/lib/enrichment/supabase-admin");
vi.mock("./recipients");

function fill<K extends string>(keys: readonly K[], over: Partial<Record<K, number>>): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = over[key] ?? 0;
  return out;
}

function makeAggregates(
  over: {
    totalRange?: number;
    byTopic?: Partial<Record<Topic, number>>;
    byBranch?: Partial<Record<Branch, number>>;
  } = {},
): DashboardAggregates {
  return {
    totalRange: over.totalRange ?? 0,
    totalAll: over.totalRange ?? 0,
    byTopic: fill(TOPICS, over.byTopic ?? {}),
    byBranch: fill(BRANCHES, over.byBranch ?? {}),
    byTone: fill(TONES, {}),
    byWeek: [],
    negPct: null,
  };
}

const RANGE: ResolvedRange = {
  preset: "custom",
  fromIso: "2026-06-07T22:00:00.000Z",
  toIso: "2026-06-14T22:00:00.000Z",
  branch: null,
  label: "8–14 czerwca 2026",
};

describe("buildWeeklyDigest — pure composition", () => {
  it("composes subject + total + per-topic + per-branch, with the dashboard link when baseUrl is set", () => {
    const agg = makeAggregates({
      totalRange: 5,
      byTopic: { Pomysł: 3, Problem: 2 },
      byBranch: { Gliwice: 4, Katowice: 1 },
    });
    const { subject, text } = buildWeeklyDigest(agg, RANGE, "https://dib.example.com");

    expect(subject).toBe("Tygodniowe podsumowanie zgłoszeń — 8–14 czerwca 2026");
    expect(text).toContain("(8–14 czerwca 2026)");
    expect(text).toContain("Łączna liczba zgłoszeń: 5");
    expect(text).toContain("Wg tematyki:");
    expect(text).toContain("- Pomysł: 3");
    expect(text).toContain("- Problem: 2");
    expect(text).toContain("- Usprawnienie: 0");
    expect(text).toContain("Wg oddziału:");
    expect(text).toContain("- Gliwice: 4");
    expect(text).toContain("- Katowice: 1");
    expect(text).toContain("Dashboard: https://dib.example.com/dashboard");
  });

  it("omits the dashboard line when baseUrl is undefined", () => {
    const { text } = buildWeeklyDigest(makeAggregates({ totalRange: 1 }), RANGE, undefined);
    expect(text).not.toContain("Dashboard:");
  });

  it("seals the full output line set — nothing beyond aggregate counts can leak", () => {
    const agg = makeAggregates({ totalRange: 2, byTopic: { Pomysł: 2 }, byBranch: { Gliwice: 2 } });
    const { text } = buildWeeklyDigest(agg, RANGE, "https://dib.example.com");
    // Structural anonymity proof: every emitted line is enumerated here, so no raw
    // content/signature/ai_summary (or any unexpected field) can slip into the mail.
    const expected = [
      `Podsumowanie zgłoszeń za miniony tydzień (${RANGE.label}).`,
      "",
      "Łączna liczba zgłoszeń: 2",
      "",
      "Wg tematyki:",
      ...TOPICS.map((t) => `- ${t}: ${t === "Pomysł" ? 2 : 0}`),
      "",
      "Wg oddziału:",
      ...BRANCHES.map((b) => `- ${b}: ${b === "Gliwice" ? 2 : 0}`),
      "",
      "Dashboard: https://dib.example.com/dashboard",
    ];
    expect(text.split("\n")).toEqual(expected);
    // Fast readable guard, redundant with the seal above but documents the intent.
    expect(text).not.toMatch(/podpis|signature|ai_summary|treść/i);
  });
});

describe("sendWeeklyDigest — orchestration", () => {
  // Summer Monday trigger → real previousWarsawWeekRange resolves the 8–14 czerwca window.
  const NOW = new Date("2026-06-15T07:00:00.000Z");
  const ENV = {
    RESEND_API_KEY: "re_test",
    ALERT_FROM: "alerts@dib.example.com",
    APP_BASE_URL: "https://dib.example.com",
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "svc-role-key",
    ALLOWED_ADMIN_EMAILS: "admin@x.com",
  } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createAdminClient).mockReturnValue({} as unknown as ReturnType<typeof createAdminClient>);
  });

  it("skips without touching the channel or RPC when the allow-list is empty", async () => {
    vi.mocked(resolveAlertRecipients).mockReturnValue([]);
    const fetchImpl = vi.fn();

    const result = await sendWeeklyDigest(ENV, NOW, { fetchImpl });

    expect(result).toEqual({ sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fetchDashboardAggregates).not.toHaveBeenCalled();
  });

  it("skips without sending when the week had zero submissions", async () => {
    vi.mocked(resolveAlertRecipients).mockReturnValue(["admin@x.com"]);
    vi.mocked(fetchDashboardAggregates).mockResolvedValue(makeAggregates({ totalRange: 0 }));
    const fetchImpl = vi.fn();

    const result = await sendWeeklyDigest(ENV, NOW, { fetchImpl });

    expect(result).toEqual({ sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("queries the RPC with the resolved previous-week range, through the SERVICE-ROLE client", async () => {
    vi.mocked(resolveAlertRecipients).mockReturnValue(["admin@x.com"]);
    vi.mocked(fetchDashboardAggregates).mockResolvedValue(makeAggregates({ totalRange: 0 }));
    // Sentinel so we can prove the RPC ran on createAdminClient(env)'s output — the
    // RLS-gated SECURITY INVOKER RPC returns 0 rows under a user-JWT client in cron.
    const adminClient = { __role: "service" } as unknown as ReturnType<typeof createAdminClient>;
    vi.mocked(createAdminClient).mockReturnValue(adminClient);

    await sendWeeklyDigest(ENV, NOW, { fetchImpl: vi.fn() });

    expect(createAdminClient).toHaveBeenCalledWith(ENV);
    const [client, range] = vi.mocked(fetchDashboardAggregates).mock.calls[0];
    expect(client).toBe(adminClient);
    expect(range.fromIso).toBe("2026-06-07T22:00:00.000Z");
    expect(range.toIso).toBe("2026-06-14T22:00:00.000Z");
  });

  it("sends through the real channel with the composed payload when there is data", async () => {
    vi.mocked(resolveAlertRecipients).mockReturnValue(["admin@x.com", "b@x.com"]);
    vi.mocked(fetchDashboardAggregates).mockResolvedValue(makeAggregates({ totalRange: 3, byTopic: { Pomysł: 3 } }));
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const result = await sendWeeklyDigest(ENV, NOW, { fetchImpl });

    expect(result).toEqual({ sent: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body as string) as { to: string[]; subject: string; text: string };
    expect(body.to).toEqual(["admin@x.com", "b@x.com"]);
    expect(body.subject).toBe("Tygodniowe podsumowanie zgłoszeń — 8–14 czerwca 2026");
    expect(body.text).toContain("Łączna liczba zgłoszeń: 3");
    expect(body.text).toContain("- Pomysł: 3");
    expect(body.text).toContain("Dashboard: https://dib.example.com/dashboard");
  });

  it("swallows a downstream failure and reports not-sent (cron must never throw)", async () => {
    vi.mocked(resolveAlertRecipients).mockReturnValue(["admin@x.com"]);
    vi.mocked(fetchDashboardAggregates).mockRejectedValue(new Error("rpc unreachable"));

    const result = await sendWeeklyDigest(ENV, NOW, { fetchImpl: vi.fn() });

    expect(result).toEqual({ sent: false });
  });

  it("never writes a recipient address into the log transport (anonymity risk #2, log half)", async () => {
    vi.mocked(resolveAlertRecipients).mockReturnValue(["admin@x.com", "secret-admin@x.com"]);
    vi.mocked(fetchDashboardAggregates).mockResolvedValue(makeAggregates({ totalRange: 4 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await sendWeeklyDigest(ENV, NOW, { fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 200 })) });

    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("weekly_digest_sent");
    expect(logged).toContain('"recipients":2'); // count, never the addresses
    expect(logged).not.toMatch(/admin@x\.com/);
    logSpy.mockRestore();
  });
});
