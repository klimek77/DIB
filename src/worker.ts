// Custom Worker entry — replaces the default `@astrojs/cloudflare/entrypoints/server`
// (which exports only `{ fetch }`) so we can add a `queue` handler alongside the
// Astro HTTP path. The HTTP path is preserved verbatim by delegating to the
// adapter's `handle`; no Astro routing behavior is lost.
//
// Phase 1 ships a no-op `queue` handler (log + ack). Phase 3 replaces it with the
// claim → enrich → write-back → retry/DLQ state machine.

import { handle } from "@astrojs/cloudflare/handler";

import type { EnrichmentMessage } from "./lib/enrichment/types";

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),

  queue(batch: MessageBatch<EnrichmentMessage>, _env: Env, _ctx: ExecutionContext) {
    for (const message of batch.messages) {
      // eslint-disable-next-line no-console -- Workers Observability captures console as the log transport
      console.log(
        JSON.stringify({
          event: "enrichment_message_received",
          queue: batch.queue,
          submissionId: message.body.submissionId,
        }),
      );
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, EnrichmentMessage>;
