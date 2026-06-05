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
import { createAdminClient } from "./lib/enrichment/supabase-admin";
import type { EnrichmentMessage } from "./lib/enrichment/types";

// Dead-letter queue name (wrangler.jsonc queues.consumers[1].queue). Messages that exhaust the main
// queue's max_retries are delivered here; the DLQ branch is the SOLE authority for retry-exhaustion
// failures — the main handler deliberately carries no app-level attempts cap.
const DEAD_LETTER_QUEUE = "dib-enrichment-dlq";

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
} satisfies ExportedHandler<Env, EnrichmentMessage>;
