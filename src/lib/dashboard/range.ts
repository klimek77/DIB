// FR-010: time-range resolution for the dashboard. Pure logic, no date library —
// rolling presets are plain millisecond arithmetic, custom ranges snap to
// Europe/Warsaw day boundaries via Intl (DST-safe). Invalid/missing URL params
// silently fall back to the 30-day default; the page never throws on user input.

import { BRANCHES, type Branch } from "@/lib/submissions/taxonomies";

export type RangePreset = "24h" | "7d" | "30d" | "1y" | "custom";

export interface ResolvedRange {
  preset: RangePreset;
  /** Inclusive lower bound (UTC instant) — query as created_at >= fromIso. */
  fromIso: string;
  /** Exclusive upper bound (UTC instant) — query as created_at < toIso. */
  toIso: string;
  branch: Branch | null;
  /** Human-readable pl-PL description for the TopBar chip. */
  label: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PRESET_MS = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "1y": 365 * DAY_MS,
} as const;

const PRESET_NAMES: Record<RangePreset, string> = {
  "24h": "Ostatnie 24 godziny",
  "7d": "Ostatnie 7 dni",
  "30d": "Ostatnie 30 dni",
  "1y": "Ostatni rok",
  custom: "Zakres własny",
};

const DEFAULT_PRESET = "30d" as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const WARSAW_OFFSET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Warsaw",
  timeZoneName: "longOffset",
});

const DAY_MONTH_FMT = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "short",
  timeZone: "Europe/Warsaw",
});

const DAY_MONTH_YEAR_FMT = new Intl.DateTimeFormat("pl-PL", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Warsaw",
});

const YEAR_FMT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  timeZone: "Europe/Warsaw",
});

/**
 * UTC instant of midnight Europe/Warsaw for a `YYYY-MM-DD` calendar date.
 * The Warsaw offset for that date is read from Intl (`timeZoneName: "longOffset"`
 * → "GMT+01:00"/"GMT+02:00"), parsed and subtracted from the date's UTC midnight.
 * Warsaw DST transitions happen at 02:00/03:00 local — never inside the window
 * between Warsaw local midnight and UTC midnight — so the single offset read at
 * UTC midnight is always the offset in force at that local midnight.
 */
export function warsawDayStartUtc(dateStr: string): Date {
  const utcMidnight = new Date(`${dateStr}T00:00:00Z`);
  const tzName = WARSAW_OFFSET_FMT.formatToParts(utcMidnight).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(tzName);
  const offsetMinutes = match?.[1] ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  return new Date(utcMidnight.getTime() - offsetMinutes * 60_000);
}

function isValidDateStr(value: string | null): value is string {
  if (!value || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Round-trip guard: rejects calendar-invalid dates (2026-02-30) on any engine.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nextDayStr(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A calendar date pinned to noon UTC — renders as the same date in Warsaw. */
function calendarDateForDisplay(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00Z`);
}

function formatDateSpan(from: Date, to: Date): string {
  const sameYear = YEAR_FMT.format(from) === YEAR_FMT.format(to);
  const fromStr = sameYear ? DAY_MONTH_FMT.format(from) : DAY_MONTH_YEAR_FMT.format(from);
  return `${fromStr} – ${DAY_MONTH_YEAR_FMT.format(to)}`;
}

function parseBranch(value: string | null): Branch | null {
  return value !== null && (BRANCHES as readonly string[]).includes(value) ? (value as Branch) : null;
}

function rollingRange(preset: Exclude<RangePreset, "custom">, now: Date, branch: Branch | null): ResolvedRange {
  const from = new Date(now.getTime() - PRESET_MS[preset]);
  return {
    preset,
    fromIso: from.toISOString(),
    toIso: now.toISOString(),
    branch,
    label: `${PRESET_NAMES[preset]} · ${formatDateSpan(from, now)}`,
  };
}

/**
 * Resolves the dashboard's URL params (`range`, `from`, `to`, `branch`) into
 * concrete query bounds. Custom ranges require BOTH valid `YYYY-MM-DD` dates
 * with `from <= to` and cover full Warsaw days: `[dayStart(from), dayStart(to + 1))`.
 * Anything invalid falls back to the rolling 30-day default. Unknown branch → null.
 */
export function resolveRange(now: Date, params: URLSearchParams): ResolvedRange {
  const branch = parseBranch(params.get("branch"));
  const requested = params.get("range");

  if (requested === "custom") {
    const from = params.get("from");
    const to = params.get("to");
    if (isValidDateStr(from) && isValidDateStr(to) && from <= to) {
      return {
        preset: "custom",
        fromIso: warsawDayStartUtc(from).toISOString(),
        toIso: warsawDayStartUtc(nextDayStr(to)).toISOString(),
        branch,
        label: `${PRESET_NAMES.custom} · ${formatDateSpan(calendarDateForDisplay(from), calendarDateForDisplay(to))}`,
      };
    }
    return rollingRange(DEFAULT_PRESET, now, branch);
  }

  if (requested === "24h" || requested === "7d" || requested === "30d" || requested === "1y") {
    return rollingRange(requested, now, branch);
  }
  return rollingRange(DEFAULT_PRESET, now, branch);
}
