import { describe, expect, it } from "vitest";

import { BRANCHES } from "@/lib/submissions/taxonomies";

import { previousWarsawWeekRange, resolveRange, warsawDayStartUtc } from "./range";

// Fixed "now" keeps rolling-preset assertions exact (summer: Warsaw = UTC+2).
const NOW = new Date("2026-06-12T10:00:00.000Z");

function params(q: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams(q);
}

describe("warsawDayStartUtc — Warsaw midnight as a UTC instant", () => {
  it("winter date (CET, +01:00)", () => {
    expect(warsawDayStartUtc("2026-01-15").toISOString()).toBe("2026-01-14T23:00:00.000Z");
  });

  it("summer date (CEST, +02:00)", () => {
    expect(warsawDayStartUtc("2026-06-15").toISOString()).toBe("2026-06-14T22:00:00.000Z");
  });

  it("spring-forward day 2026-03-29 — midnight is still CET (+01:00)", () => {
    expect(warsawDayStartUtc("2026-03-29").toISOString()).toBe("2026-03-28T23:00:00.000Z");
  });

  it("day after spring-forward — midnight is CEST (+02:00)", () => {
    expect(warsawDayStartUtc("2026-03-30").toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("fall-back day 2026-10-25 — midnight is still CEST (+02:00)", () => {
    expect(warsawDayStartUtc("2026-10-25").toISOString()).toBe("2026-10-24T22:00:00.000Z");
  });

  it("day after fall-back — midnight is CET (+01:00)", () => {
    expect(warsawDayStartUtc("2026-10-26").toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
});

describe("previousWarsawWeekRange — prior full Warsaw week as [Mon, Mon) UTC", () => {
  const HOUR = 60 * 60 * 1000;
  const spanHours = (r: { fromIso: string; toIso: string }) =>
    (new Date(r.toIso).getTime() - new Date(r.fromIso).getTime()) / HOUR;

  it("winter Monday trigger → prior week, both bounds CET (+01:00), 168h", () => {
    const r = previousWarsawWeekRange(new Date("2026-01-19T07:00:00.000Z"));
    expect(r.fromIso).toBe("2026-01-11T23:00:00.000Z");
    expect(r.toIso).toBe("2026-01-18T23:00:00.000Z");
    expect(r.branch).toBeNull();
    expect(r.preset).toBe("custom");
    expect(r.label).toBe("12–18 stycznia 2026");
    expect(spanHours(r)).toBe(168);
  });

  it("summer Monday trigger → prior week, both bounds CEST (+02:00), 168h", () => {
    const r = previousWarsawWeekRange(new Date("2026-06-15T07:00:00.000Z"));
    expect(r.fromIso).toBe("2026-06-07T22:00:00.000Z");
    expect(r.toIso).toBe("2026-06-14T22:00:00.000Z");
    expect(r.label).toBe("8–14 czerwca 2026");
    expect(spanHours(r)).toBe(168);
  });

  it("mid-week trigger resolves the SAME prior week (window is Warsaw-day, not trigger-time)", () => {
    const wed = previousWarsawWeekRange(new Date("2026-06-17T10:00:00.000Z"));
    expect(wed.fromIso).toBe("2026-06-07T22:00:00.000Z");
    expect(wed.toIso).toBe("2026-06-14T22:00:00.000Z");
  });

  it("week containing the spring-forward (2026-03-29) → 167h span, bounds straddle CET→CEST", () => {
    const r = previousWarsawWeekRange(new Date("2026-03-30T07:00:00.000Z"));
    // from = 23.03 midnight CET (+01:00); to = 30.03 midnight CEST (+02:00).
    expect(r.fromIso).toBe("2026-03-22T23:00:00.000Z");
    expect(r.toIso).toBe("2026-03-29T22:00:00.000Z");
    expect(r.label).toBe("23–29 marca 2026");
    expect(spanHours(r)).toBe(167);
  });

  it("week containing the fall-back (2026-10-25) → 169h span, bounds straddle CEST→CET", () => {
    const r = previousWarsawWeekRange(new Date("2026-10-26T07:00:00.000Z"));
    // from = 19.10 midnight CEST (+02:00); to = 26.10 midnight CET (+01:00).
    expect(r.fromIso).toBe("2026-10-18T22:00:00.000Z");
    expect(r.toIso).toBe("2026-10-25T23:00:00.000Z");
    expect(r.label).toBe("19–25 października 2026");
    expect(spanHours(r)).toBe(169);
  });

  it("derives the week from the WARSAW day, not the raw UTC instant (late-Sunday-UTC = early-Monday-Warsaw)", () => {
    // 2026-06-14T23:30Z is Sunday in UTC but Monday 01:30 in Warsaw → must resolve the
    // SAME prior week as the 06-15T07:00Z trigger. A regression to a raw-UTC weekday
    // would land a full week off here while staying green on every other case.
    const nearMidnight = previousWarsawWeekRange(new Date("2026-06-14T23:30:00.000Z"));
    expect(nearMidnight.fromIso).toBe("2026-06-07T22:00:00.000Z");
    expect(nearMidnight.toIso).toBe("2026-06-14T22:00:00.000Z");
  });

  it("label collapses a week spanning two months (same year)", () => {
    // Trigger Mon 2026-04-06 → reporting week Mon 30.03 – Sun 05.04.
    expect(previousWarsawWeekRange(new Date("2026-04-06T07:00:00.000Z")).label).toBe("30 marca – 5 kwietnia 2026");
  });

  it("label spells out both years for a week spanning the year boundary", () => {
    // Trigger Mon 2027-01-04 → reporting week Mon 28.12.2026 – Sun 03.01.2027.
    expect(previousWarsawWeekRange(new Date("2027-01-04T07:00:00.000Z")).label).toBe(
      "28 grudnia 2026 – 3 stycznia 2027",
    );
  });
});

describe("resolveRange — rolling presets", () => {
  it.each([
    ["24h", "2026-06-11T10:00:00.000Z"],
    ["7d", "2026-06-05T10:00:00.000Z"],
    ["30d", "2026-05-13T10:00:00.000Z"],
    ["1y", "2025-06-12T10:00:00.000Z"],
  ] as const)("range=%s rolls back from now", (preset, expectedFrom) => {
    const resolved = resolveRange(NOW, params({ range: preset }));
    expect(resolved.preset).toBe(preset);
    expect(resolved.fromIso).toBe(expectedFrom);
    expect(resolved.toIso).toBe(NOW.toISOString());
  });

  it("defaults to 30d when range is missing", () => {
    const resolved = resolveRange(NOW, params());
    expect(resolved.preset).toBe("30d");
    expect(resolved.fromIso).toBe("2026-05-13T10:00:00.000Z");
    expect(resolved.toIso).toBe(NOW.toISOString());
    expect(resolved.label).toContain("Ostatnie 30 dni");
  });

  it("defaults to 30d on a garbage range param", () => {
    const resolved = resolveRange(NOW, params({ range: "yolo" }));
    expect(resolved.preset).toBe("30d");
  });
});

describe("resolveRange — custom range", () => {
  it("covers full Warsaw days: [dayStart(from), dayStart(to + 1 day))", () => {
    const resolved = resolveRange(NOW, params({ range: "custom", from: "2026-06-01", to: "2026-06-10" }));
    expect(resolved.preset).toBe("custom");
    expect(resolved.fromIso).toBe("2026-05-31T22:00:00.000Z");
    expect(resolved.toIso).toBe("2026-06-10T22:00:00.000Z");
    expect(resolved.label).toContain("Zakres własny");
  });

  it("single-day custom (from === to) spans exactly that Warsaw day", () => {
    const resolved = resolveRange(NOW, params({ range: "custom", from: "2026-06-10", to: "2026-06-10" }));
    expect(resolved.fromIso).toBe("2026-06-09T22:00:00.000Z");
    expect(resolved.toIso).toBe("2026-06-10T22:00:00.000Z");
  });

  it("custom spanning the spring DST transition keeps both bounds correct", () => {
    const resolved = resolveRange(NOW, params({ range: "custom", from: "2026-03-28", to: "2026-03-29" }));
    // 28.03 midnight is CET (+01:00); the exclusive bound (30.03 midnight) is CEST (+02:00).
    expect(resolved.fromIso).toBe("2026-03-27T23:00:00.000Z");
    expect(resolved.toIso).toBe("2026-03-29T22:00:00.000Z");
  });

  it("month-end rollover in the exclusive bound (to = last day of month)", () => {
    const resolved = resolveRange(NOW, params({ range: "custom", from: "2026-06-30", to: "2026-06-30" }));
    expect(resolved.toIso).toBe("2026-06-30T22:00:00.000Z"); // start of 1 July, Warsaw
  });

  it.each([
    ["missing to", { range: "custom", from: "2026-06-01" }],
    ["missing from", { range: "custom", to: "2026-06-10" }],
    ["from > to", { range: "custom", from: "2026-06-10", to: "2026-06-01" }],
    ["non-ISO format", { range: "custom", from: "01-06-2026", to: "10-06-2026" }],
    ["calendar-invalid date", { range: "custom", from: "2026-02-30", to: "2026-03-01" }],
  ])("falls back silently to the 30d default on %s", (_name, q) => {
    const resolved = resolveRange(NOW, params(q));
    expect(resolved.preset).toBe("30d");
    expect(resolved.fromIso).toBe("2026-05-13T10:00:00.000Z");
    expect(resolved.toIso).toBe(NOW.toISOString());
  });
});

describe("resolveRange — branch param", () => {
  it("accepts a known branch", () => {
    const resolved = resolveRange(NOW, params({ branch: BRANCHES[0] }));
    expect(resolved.branch).toBe(BRANCHES[0]);
  });

  it("nullifies an unknown branch", () => {
    const resolved = resolveRange(NOW, params({ branch: "Nieznany Oddział" }));
    expect(resolved.branch).toBeNull();
  });

  it("defaults to null when absent", () => {
    expect(resolveRange(NOW, params()).branch).toBeNull();
  });

  it("keeps the branch on the custom→default fallback path", () => {
    const resolved = resolveRange(NOW, params({ range: "custom", from: "garbage", branch: BRANCHES[1] }));
    expect(resolved.preset).toBe("30d");
    expect(resolved.branch).toBe(BRANCHES[1]);
  });
});
