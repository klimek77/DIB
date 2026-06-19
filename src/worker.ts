// Custom Worker entry — replaces the default `@astrojs/cloudflare/entrypoints/server`
// (which exports only `{ fetch }`) so we can add a `queue` handler alongside the
// Astro HTTP path. The HTTP path is preserved verbatim by delegating to the
// adapter's `handle`; no Astro routing behavior is lost.
//
// The `queue` handler routes by queue name: the main queue runs the full
// claim → enrich → write-back → retry state machine; the dead-letter queue runs the
// terminal-failure backstop (the sole authority for retry-exhaustion failures).

import { handle } from "@astrojs/cloudflare/handler";
import * as Sentry from "@sentry/cloudflare";

import { createSupabaseStore, processDeadLetterMessage, processEnrichmentMessage } from "./lib/enrichment/consumer";
import { enqueueEnrichment } from "./lib/enrichment/enqueue";
import { runRecoverySweep } from "./lib/enrichment/recovery-sweep";
import { createAdminClient } from "./lib/enrichment/supabase-admin";
import type { EnrichmentMessage } from "./lib/enrichment/types";
import { sendEmail } from "./lib/notifications/email";
import { buildEnrichmentFailureAlert, type FailureAlertItem } from "./lib/notifications/fr018-alert";
import { resolveAlertRecipients } from "./lib/notifications/recipients";
import { sendWeeklyDigest } from "./lib/notifications/weekly-digest";
import { buildServerSentryOptions, captureServerError } from "./lib/observability/sentry-server-options";
import { routeScheduledCron } from "./lib/scheduled/route-cron";

// Dead-letter queue name (wrangler.jsonc queues.consumers[1].queue). Messages that exhaust the main
// queue's max_retries are delivered here; the DLQ branch is the SOLE authority for retry-exhaustion
// failures — the main handler deliberately carries no app-level attempts cap.
const DEAD_LETTER_QUEUE = "dib-enrichment-dlq";

// Recovery-sweep tuning (scheduled handler). Age is measured from `created_at` (a never-enqueued row
// has `enrichment_attempted_at` NULL): the threshold must exceed the normal in-flight window so the
// sweep never re-enqueues a row a just-submitted request is still enqueuing — 10 min clears that and
// stays under the consumer's 12-min stale-reclaim. The batch cap bounds work per tick, so a backlog
// drains across successive cron fires instead of one unbounded re-enqueue burst.
const RECOVERY_AGE_THRESHOLD_MS = 10 * 60_000;
const RECOVERY_BATCH_LIMIT = 100;

const handler = {
  fetch: (request, env, ctx) => handle(request, env, ctx),

  async queue(batch: MessageBatch<EnrichmentMessage>, env: Env, _ctx: ExecutionContext) {
    // captureError: the Sentry-backed capture seam. The consumer swallows its terminal failures
    // (so withSentry's auto-capture never sees them) and stays SDK-free; this injection is how those
    // redacted, body-free descriptors reach Sentry. No-ops without an active client (local / no DSN).
    // alertAdmin: a pure batch-local collector — each gated terminal failure pushes one anonymity-safe
    // item; we coalesce the whole invocation's failures into ONE FR-018 email after the loop (below).
    const failureBuffer: FailureAlertItem[] = [];
    const consumerCtx = {
      store: createSupabaseStore(createAdminClient(env)),
      apiKey: env.OPENAI_API_KEY,
      captureError: captureServerError,
      alertAdmin: (item: FailureAlertItem) => failureBuffer.push(item),
    };
    const isDeadLetter = batch.queue === DEAD_LETTER_QUEUE;

    for (const message of batch.messages) {
      if (isDeadLetter) {
        await processDeadLetterMessage(message, consumerCtx);
      } else {
        await processEnrichmentMessage(message, consumerCtx);
      }
    }

    // FR-018 flush: ONE coalesced email for all of this invocation's terminal failures. Skipped
    // silently when there were no failures, no recipients (fail-closed allow-list), or the channel is
    // env-gated off (sendEmail no-ops without RESEND_API_KEY/ALERT_FROM). A send failure is logged
    // id-less and swallowed so a provider blip never fails the batch or re-drives enrichment.
    //
    // KNOWN GAP — total Supabase outage (documented in plan.md Migration Notes; lessons: decouple the
    // alert from the write). If the store is unreachable for the whole retry window, the DLQ message
    // exhausts its own max_retries and is dropped before markFailed ever lands — so no `failed` row, no
    // signal, and no alert here (the buffer stays empty). Recovery is NOT a second transport: the 15-min
    // cron sweep re-enqueues stranded `pending` rows, and a `processing`-stranded row needs a manual
    // re-enqueue.
    if (failureBuffer.length > 0) {
      const to = resolveAlertRecipients(env);
      const { subject, text } = buildEnrichmentFailureAlert(failureBuffer);
      try {
        await sendEmail({ to, subject, text, env });
      } catch {
        // Id-less, anonymity-safe marker (count only) so a chronically failing channel is greppable.
        // eslint-disable-next-line no-console -- Workers Observability captures console as the log transport
        console.log(
          JSON.stringify({
            event: "enrichment_alert_send_failed",
            count: failureBuffer.length,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  },

  // Cron dispatch (wrangler.jsonc triggers.crons). The Worker runs two schedules; we branch on the
  // firing expression via the pure routeScheduledCron mapper (unit-tested node-side), never on the
  // trigger instant. Both job branches are awaited (no waitUntil); an unrecognized cron no-ops with a
  // greppable marker rather than defaulting to the wrong job.
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const job = routeScheduledCron(controller.cron);

    if (job === "digest") {
      // S-05 weekly digest (Mon 07:00 UTC). The orchestrator is best-effort (never throws) and
      // computes the previous Warsaw calendar week itself, so the exact firing instant — and DST —
      // don't matter here.
      await sendWeeklyDigest(env, new Date());
      return;
    }

    if (job === "unknown") {
      // Config drift: a cron we don't recognize fired. Log an id-less marker and no-op rather than
      // run the sweep (or any job) by default.
      // eslint-disable-next-line no-console -- Workers Observability captures console as the log transport
      console.log(JSON.stringify({ event: "scheduled_unknown_cron", timestamp: new Date().toISOString() }));
      return;
    }

    // job === "sweep" (every 15 min). Re-enqueues submission rows stranded in
    // `enrichment_status = 'pending'` — rows whose initial enqueue silently failed — so "no silent loss"
    // is actually true, not merely recoverable in principle. Mirrors the `queue` handler's env→deps build.
    // Re-enqueue is safe by the consumer's CAS claim (only `pending`/stale-`processing` claims; everything
    // else acks-and-skips), so the sweep is just another at-least-once redelivery source.
    const store = createSupabaseStore(createAdminClient(env));
    try {
      const result = await runRecoverySweep(
        {
          selectStrandedPending: (olderThanIso, limit) => store.selectStrandedPending(olderThanIso, limit),
          enqueue: (id) => enqueueEnrichment(env, id),
          now: () => Date.now(),
        },
        { olderThanMs: RECOVERY_AGE_THRESHOLD_MS, limit: RECOVERY_BATCH_LIMIT },
      );
      // One id-less summary line — counts only, no id/body (anonymity NFR). Routed through console as the
      // Workers Observability log transport, same convention as log.ts (hence the matching no-console disable).
      // eslint-disable-next-line no-console -- Workers Observability captures console as the log transport
      console.log(
        JSON.stringify({ event: "enrichment_recovery_sweep", ...result, timestamp: new Date().toISOString() }),
      );
    } catch (err) {
      // A throw here is almost always the store SELECT failing (Supabase unreachable) — per-row enqueue
      // failures are already isolated inside runRecoverySweep. Emit one id-less marker so a chronically
      // failing sweep is greppable in app logs, not just a raw CF invocation error. No err body is logged
      // (anonymity / log.ts PII guard). Re-throw so CF still records the invocation as failed; the cron
      // re-runs on its next tick regardless and the rows stay `pending` (recoverable).
      // eslint-disable-next-line no-console -- Workers Observability captures console as the log transport
      console.log(JSON.stringify({ event: "enrichment_recovery_sweep_failed", timestamp: new Date().toISOString() }));
      throw err;
    }
  },
} satisfies ExportedHandler<Env, EnrichmentMessage>;

// Wrap the whole ExportedHandler once so unhandled exceptions in fetch + queue + scheduled are all
// captured by a single init. Server config comes from `env` (Workers ignore sentry.server.config.ts).
// A falsy SENTRY_DSN → the SDK no-ops, so this is inert locally and reversible by clearing the secret.
export default Sentry.withSentry<Env, EnrichmentMessage>((env) => buildServerSentryOptions(env), handler);
