// Pure cron → job router for the Worker `scheduled` handler. The Worker runs more
// than one schedule (wrangler.jsonc triggers.crons), and Cloudflare passes the
// firing expression verbatim as `controller.cron`. Keeping the mapping a pure
// string → union function lets it be unit-tested in the node suite, away from the
// Workers runtime that the actual handler needs.
//
// The cron strings MUST stay in lockstep with wrangler.jsonc triggers.crons —
// JSONC config can't import these constants, so the duplication is unavoidable;
// a drift between the two surfaces as an "unknown" job at runtime (no-op + marker)
// rather than the wrong job running.

export type ScheduledJob = "sweep" | "digest" | "unknown";

/** Recovery sweep — re-enqueues rows stranded in enrichment_status='pending' (every 15 min). */
export const SWEEP_CRON = "*/15 * * * *";

/** Weekly digest — Monday 07:00 UTC (08:00 Warsaw winter / 09:00 summer; S-05 / FR-017). */
export const DIGEST_CRON = "0 7 * * 1";

/** Map a firing cron expression to the job it should run. Unknown expressions → "unknown". */
export function routeScheduledCron(cron: string): ScheduledJob {
  switch (cron) {
    case SWEEP_CRON:
      return "sweep";
    case DIGEST_CRON:
      return "digest";
    default:
      return "unknown";
  }
}
