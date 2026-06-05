import type { APIRoute } from "astro";

import { enqueueEnrichment } from "@/lib/enrichment/enqueue";
import { createAdminClient } from "@/lib/enrichment/supabase-admin";
import { env } from "@/lib/runtime-env";
import { validateSubmissionInput } from "@/lib/submissions/submission-input";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Structured, identifier-free diagnostics. Anonymity NFR: this endpoint must never read or log
// IP / headers / cookies / any client identifier — these lines carry only a static event + reason
// tag (no submission id, no body), greppable in `wrangler tail` for the recovery sweep.
function logSubmissionEvent(event: string, reason: string): void {
  // eslint-disable-next-line no-console -- Workers Observability captures console as the log transport
  console.error(JSON.stringify({ event, reason, timestamp: new Date().toISOString() }));
}

// Public, anonymous submission endpoint — the producer side of the north-star loop. Inserts a
// `pending` row and fire-and-forget enqueues enrichment; returns in <1s by never awaiting AI.
export const POST: APIRoute = async (context) => {
  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return json({ ok: false, error: "Nieprawidłowe dane formularza." }, 400);
  }

  // The validated value IS the whitelist. Service-role insert (below) bypasses the F-01 column
  // grant, so we trust ONLY validation.value here — never the raw body's id/enrichment_*/ai_*.
  const validation = validateSubmissionInput(body);
  if (!validation.ok) {
    return json({ ok: false, error: validation.error }, 400);
  }

  const admin = createAdminClient(env);

  // Insert via the service-role client to read back `id`: anon has no SELECT and `id` is not in its
  // column grant, so the public role cannot obtain the id needed to enqueue.
  const { data, error } = await admin
    .from("submissions")
    .insert({ ...validation.value, enrichment_status: "pending" })
    .select("id")
    .single();

  if (error) {
    // Hard failure: nothing was saved → 500. No client identifier in the log (anonymity).
    // (`.single()` returns a discriminated union — a null `error` guarantees a non-null `data`.)
    logSubmissionEvent("submission_insert_failed", "db_insert_error");
    return json({ ok: false, error: "Nie udało się zapisać zgłoszenia. Spróbuj ponownie." }, 500);
  }

  // Fire-and-forget enrichment. The row is already durable as `pending`, so an enqueue failure must
  // NOT surface as a 500 (that would invite a duplicate resubmit). An insert-succeeded-but-never-
  // enqueued row is recovered by the pending-rows re-enqueue sweep (plan Critical Implementation
  // Details). Never await enrich()/OpenAI here — QUEUE.send is a sub-second queue write and the <1s
  // NFR depends on not awaiting AI.
  try {
    await enqueueEnrichment(env, data.id);
  } catch {
    logSubmissionEvent("submission_enqueue_failed", "queue_send_error");
  }

  return json({ ok: true }, 201);
};
