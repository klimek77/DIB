// Reusable fire-and-forget enqueue helper. S-01 (the employee form POST) calls
// this after inserting a `pending` row to kick off async enrichment. Pure send —
// no DB access, no AI; the consumer re-reads the row from the id.

import type { EnrichmentMessage } from "./types";

export async function enqueueEnrichment(env: { QUEUE: Queue<EnrichmentMessage> }, submissionId: string): Promise<void> {
  await env.QUEUE.send({ submissionId });
}
