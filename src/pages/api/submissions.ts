import type { APIRoute } from "astro";

import { enqueueEnrichment } from "@/lib/enrichment/enqueue";
import { createAdminClient } from "@/lib/enrichment/supabase-admin";
import { notifyNewSubmission, type NewSubmissionNotice } from "@/lib/notifications/new-submission-alert";
import { captureServerError } from "@/lib/observability/sentry-server-options";
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
// tag (no submission id, no body). Forensic only: because the line is id-less, a stranded `pending`
// row is found by a status-scan, NOT by grepping this log (the re-enqueue sweep is a deferred change).
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
    .select("id, created_at")
    .single();

  if (error) {
    // Hard failure: nothing was saved → 500. No client identifier in the log (anonymity).
    // (`.single()` returns a discriminated union — a null `error` guarantees a non-null `data`.)
    logSubmissionEvent("submission_insert_failed", "db_insert_error");
    // Surface the broken write surface in Sentry. Static descriptor + reason tag ONLY — NO
    // submissionId, no body, no headers — preserving this endpoint's id-less anonymity posture.
    // The enqueue failure below stays log-only (recoverable by the sweep), not a captured event.
    captureServerError("Submission insert failed", {
      errorType: "submission_insert_failed",
      reason: "db_insert_error",
    });
    return json({ ok: false, error: "Nie udało się zapisać zgłoszenia. Spróbuj ponownie." }, 500);
  }

  // S-04 / FR-016: instant-notify the admin allow-list about the new submission. Deferred via
  // cfContext.waitUntil so the Resend round-trip adds zero latency to the <1s 201 yet still runs
  // after the response (a bare un-awaited promise could be cancelled when the request ends). PICK
  // only the safe fields from validation.value — never spread it: it carries content/signature,
  // which must never leave the gated surface. No `?.` on cfContext — the adapter populates it
  // unconditionally for every rendered route (dev+prod) and strictTypeChecked flags the dead chain.
  // Independent of the enqueue block below (an enqueue failure must not skip the notify).
  const notice: NewSubmissionNotice = {
    submissionId: data.id,
    branch: validation.value.branch,
    topic: validation.value.topic,
    department: validation.value.department,
    createdAt: data.created_at,
  };
  const baseUrl = new URL(context.request.url).origin;
  context.locals.cfContext.waitUntil(notifyNewSubmission(env, notice, baseUrl));

  // Fire-and-forget enrichment. The row is already durable as `pending`, so an enqueue failure must
  // NOT surface as a 500 (that would invite a duplicate resubmit). KNOWN GAP: an insert-succeeded-
  // but-never-enqueued row currently stays `pending` forever — the pending-rows re-enqueue sweep that
  // would recover it is NOT yet built (deferred change: submission-enqueue-recovery-sweep). Never
  // await enrich()/OpenAI here — QUEUE.send is a sub-second queue write and the <1s NFR depends on
  // not awaiting AI.
  try {
    await enqueueEnrichment(env, data.id);
  } catch {
    logSubmissionEvent("submission_enqueue_failed", "queue_send_error");
  }

  return json({ ok: true }, 201);
};
