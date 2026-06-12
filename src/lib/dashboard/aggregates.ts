// The only module that talks to Supabase for the dashboard: one RPC round-trip
// for every aggregate (FR-008/010/011/012) + one PostgREST query for the list
// (FR-013). Errors propagate as exceptions — the page renders a retry state,
// never silently-empty data.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { BRANCHES, TONES, TOPICS, type Branch, type Tone, type Topic } from "@/lib/submissions/taxonomies";

import type { ResolvedRange } from "./range";

export interface WeekBucket {
  /** Monday of the ISO week, Warsaw wall-clock, as `YYYY-MM-DD`. */
  weekStartIso: string;
  /** ISO week number as emitted by Postgres `to_char(…, 'IW')`, e.g. "24". */
  isoWeek: string;
  count: number;
}

export interface DashboardAggregates {
  totalRange: number;
  totalAll: number;
  byTopic: Record<Topic, number>;
  byBranch: Record<Branch, number>;
  byTone: Record<Tone, number>;
  /** Always exactly 8 buckets — zero-filled in SQL, validated (not computed) here. */
  byWeek: WeekBucket[];
  /** Rounded percentage of negative tone in range, or null when the range is empty. */
  negPct: number | null;
}

type SubmissionRow = Database["public"]["Tables"]["submissions"]["Row"];

export type SubmissionListItem = Pick<
  SubmissionRow,
  "id" | "created_at" | "branch" | "topic" | "ai_title" | "ai_summary" | "ai_tone"
>;

interface RawAggregates {
  total_range?: number;
  total_all?: number;
  by_topic?: Record<string, number>;
  by_branch?: Record<string, number>;
  by_tone?: Record<string, number>;
  by_week?: unknown;
}

// jsonb_object_agg returns only the keys present in the data — the UI contract
// is the FULL taxonomy shape, so missing keys become explicit zeros here.
// Unknown keys (taxonomy drift) are dropped; the drift-guard test pins
// taxonomies.ts ≡ migration CHECKs separately.
function zeroFill<K extends string>(
  keys: readonly K[],
  partial: Record<string, number> | undefined,
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = partial?.[key] ?? 0;
  return out;
}

// by_week is a pass-through: zero-fill and ALL week math live in SQL
// (generate_series over Warsaw week starts). This mapper only pins the
// contract — exactly 8 well-shaped buckets — and renames keys for the UI.
// Recomputing buckets here would risk silent key drift between the two sides.
function mapWeeks(raw: unknown): WeekBucket[] {
  if (!Array.isArray(raw) || raw.length !== 8) {
    throw new Error(
      `dashboard_aggregates: by_week must contain exactly 8 buckets, got ${Array.isArray(raw) ? raw.length : typeof raw}`,
    );
  }
  return raw.map((bucket: unknown) => {
    const b = bucket as Partial<{ week_start: string; iso_week: string; count: number }> | null;
    if (!b || typeof b.week_start !== "string" || typeof b.iso_week !== "string" || typeof b.count !== "number") {
      throw new Error("dashboard_aggregates: by_week bucket shape mismatch");
    }
    return { weekStartIso: b.week_start, isoWeek: b.iso_week, count: b.count };
  });
}

export async function fetchDashboardAggregates(
  supabase: SupabaseClient<Database>,
  range: ResolvedRange,
): Promise<DashboardAggregates> {
  const { data, error } = await supabase.rpc("dashboard_aggregates", {
    p_from: range.fromIso,
    p_to: range.toIso,
    // undefined drops the key from the request body; PostgREST applies DEFAULT NULL.
    p_branch: range.branch ?? undefined,
  });
  if (error) {
    throw new Error(`dashboard_aggregates RPC failed: ${error.message}`);
  }

  const raw = (data ?? {}) as RawAggregates;
  const totalRange = raw.total_range ?? 0;
  const byTone = zeroFill(TONES, raw.by_tone);

  return {
    totalRange,
    totalAll: raw.total_all ?? 0,
    byTopic: zeroFill(TOPICS, raw.by_topic),
    byBranch: zeroFill(BRANCHES, raw.by_branch),
    byTone,
    byWeek: mapWeeks(raw.by_week),
    negPct: totalRange === 0 ? null : Math.round((100 * byTone.Negatywny) / totalRange),
  };
}

export async function fetchSubmissionsList(
  supabase: SupabaseClient<Database>,
  range: ResolvedRange,
  limit = 100,
): Promise<SubmissionListItem[]> {
  // .eq (never .in) on enrichment_status — the partial/composite indexes only
  // match an equality predicate (lessons.md).
  let query = supabase
    .from("submissions")
    .select("id, created_at, branch, topic, ai_title, ai_summary, ai_tone")
    .eq("enrichment_status", "done")
    .gte("created_at", range.fromIso)
    .lt("created_at", range.toIso);
  if (range.branch !== null) {
    query = query.eq("branch", range.branch);
  }
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) {
    throw new Error(`dashboard submissions list query failed: ${error.message}`);
  }
  return data;
}
