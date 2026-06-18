// S-05 / FR-017 weekly-digest builder + orchestrator. Every Monday a cron mails
// the admin allow-list a plain-text numeric summary of the previous Warsaw
// calendar week, reusing the S-02 aggregate RPC, the S-03 channel (`sendEmail` +
// `resolveAlertRecipients`) and the DST-safe week window. Distinct from the
// S-04 per-submission instant-notify and the S-03 failure alert.
//
// Anonymity holds by construction: the body is built EXCLUSIVELY from aggregate
// COUNTS (totalRange + by-topic + by-branch). There is no code path here to a
// submission's content, signature, ai_summary, or any per-row field — only
// taxonomy labels (already display-ready Polish) and integers reach the mail.

import { fetchDashboardAggregates, type DashboardAggregates } from "@/lib/dashboard/aggregates";
import { previousWarsawWeekRange, type ResolvedRange } from "@/lib/dashboard/range";
import { createAdminClient } from "@/lib/enrichment/supabase-admin";
import { BRANCHES, TOPICS } from "@/lib/submissions/taxonomies";

import { sendEmail } from "./email";
import { resolveAlertRecipients } from "./recipients";

function countSection(title: string, keys: readonly string[], counts: Record<string, number>): string[] {
  return [title, ...keys.map((key) => `- ${key}: ${counts[key] ?? 0}`)];
}

/**
 * Build the weekly-digest email from aggregate counts. Pure. Subject carries the
 * week span; body lists the total, a per-topic breakdown and a per-branch
 * breakdown (full taxonomy, zeros included for a complete picture), plus a link
 * to the dashboard ONLY when a base URL is configured (cron has no request to
 * derive an origin from). No raw submission fields ever appear.
 */
export function buildWeeklyDigest(
  aggregates: DashboardAggregates,
  range: ResolvedRange,
  baseUrl: string | undefined,
): { subject: string; text: string } {
  const subject = `Tygodniowe podsumowanie zgłoszeń — ${range.label}`;

  const lines = [
    `Podsumowanie zgłoszeń za miniony tydzień (${range.label}).`,
    "",
    `Łączna liczba zgłoszeń: ${aggregates.totalRange}`,
    "",
    ...countSection("Wg tematyki:", TOPICS, aggregates.byTopic),
    "",
    ...countSection("Wg oddziału:", BRANCHES, aggregates.byBranch),
  ];
  if (baseUrl) lines.push("", `Dashboard: ${baseUrl}/dashboard`);

  return { subject, text: lines.join("\n") };
}

/** Anonymity-safe, greppable log marker. Carries no recipient addresses or content. */
function logDigestEvent(event: string, fields: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console -- Workers Observability captures console as the log transport
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}

/**
 * Resolve recipients, compute the previous Warsaw week, fetch its aggregates and
 * mail the digest. Best-effort: the whole body is wrapped so a cron firing never
 * throws (an unhandled rejection could trigger a redelivery → duplicate send,
 * and there is no dedup store by design). Skips — without sending — when the
 * allow-list is empty (fail-closed) or the week had zero submissions. Reads
 * secrets and the base URL off the raw Worker `env` (not `astro:env`, which is
 * request-scoped). The RPC is RLS-gated, so it MUST go through the service-role
 * `createAdminClient` — a user-JWT client has no principal in cron and returns 0.
 */
export async function sendWeeklyDigest(
  env: Env,
  now: Date,
  deps?: { fetchImpl?: typeof fetch },
): Promise<{ sent: boolean }> {
  try {
    const to = resolveAlertRecipients(env);
    if (to.length === 0) {
      logDigestEvent("weekly_digest_skipped", { reason: "no_recipients" });
      return { sent: false };
    }

    const range = previousWarsawWeekRange(now);
    const aggregates = await fetchDashboardAggregates(createAdminClient(env), range);
    if (aggregates.totalRange === 0) {
      logDigestEvent("weekly_digest_skipped", { reason: "empty_week" });
      return { sent: false };
    }

    const { subject, text } = buildWeeklyDigest(aggregates, range, env.APP_BASE_URL);
    const result = await sendEmail({ to, subject, text, env, fetchImpl: deps?.fetchImpl });
    logDigestEvent(result.sent ? "weekly_digest_sent" : "weekly_digest_skipped", {
      recipients: to.length,
      sent: result.sent,
      reason: result.sent ? undefined : "channel_unconfigured",
    });
    return result;
  } catch {
    logDigestEvent("weekly_digest_failed");
    return { sent: false };
  }
}
