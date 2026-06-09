// Custom Worker entry — replaces the default `@astrojs/cloudflare/entrypoints/server`
// (which exports only `{ fetch }`) so we can add a `queue` handler alongside the
// Astro HTTP path. The HTTP path is preserved verbatim by delegating to the
// adapter's `handle`; no Astro routing behavior is lost.
//
// The `queue` handler routes by queue name: the main queue runs the full
// claim → enrich → write-back → retry state machine; the dead-letter queue runs the
// terminal-failure backstop (the sole authority for retry-exhaustion failures).

import { handle } from "@astrojs/cloudflare/handler";

import { createSupabaseStore, processDeadLetterMessage, processEnrichmentMessage } from "./lib/enrichment/consumer";
import { enqueueEnrichment } from "./lib/enrichment/enqueue";
import { runRecoverySweep } from "./lib/enrichment/recovery-sweep";
import { createAdminClient } from "./lib/enrichment/supabase-admin";
import type { EnrichmentMessage } from "./lib/enrichment/types";

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

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),

  async queue(batch: MessageBatch<EnrichmentMessage>, env: Env, _ctx: ExecutionContext) {
    const consumerCtx = { store: createSupabaseStore(createAdminClient(env)), apiKey: env.OPENAI_API_KEY };
    const isDeadLetter = batch.queue === DEAD_LETTER_QUEUE;

    for (const message of batch.messages) {
      if (isDeadLetter) {
        await processDeadLetterMessage(message, consumerCtx);
      } else {
        await processEnrichmentMessage(message, consumerCtx);
      }
    }
  },

  // Cron tick (wrangler.jsonc triggers.crons, every 15 min). Re-enqueues submission rows stranded in
  // `enrichment_status = 'pending'` — rows whose initial enqueue silently failed — so "no silent loss"
  // is actually true, not merely recoverable in principle. Mirrors the `queue` handler's env→deps build.
  // Re-enqueue is safe by the consumer's CAS claim (only `pending`/stale-`processing` claims; everything
  // else acks-and-skips), so the sweep is just another at-least-once redelivery source.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const store = createSupabaseStore(createAdminClient(env));
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
    console.log(JSON.stringify({ event: "enrichment_recovery_sweep", ...result, timestamp: new Date().toISOString() }));
  },
} satisfies ExportedHandler<Env, EnrichmentMessage>;
