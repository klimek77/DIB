// S-04 / FR-016 instant-notify builder + orchestrator. Mails the admin allow-list
// one email per NEW submission, reusing the S-03 channel (`sendEmail` +
// `resolveAlertRecipients`). Distinct from S-03's FR-018 *failure* alert.
//
// Anonymity holds by construction: `NewSubmissionNotice` carries ONLY safe
// submission attributes (no `content`, no `signature`), and the builder reads
// only those named fields — there is no code path to a deanonymizing value,
// exactly like `fr018-alert.ts`. The stored taxonomy values are already
// display-ready Polish labels ("Gliwice" / "Pomysł" / "IT"), rendered verbatim.

import type { Branch, Department, Topic } from "@/lib/submissions/taxonomies";

import { sendEmail } from "./email";
import { resolveAlertRecipients } from "./recipients";

/** The only fields the instant-notify email may carry. No content, signature, or IP/identifier. */
export interface NewSubmissionNotice {
  submissionId: string;
  branch: Branch;
  topic: Topic;
  department?: Department;
  createdAt: string;
}

/**
 * Build the instant-notify email for one new submission. Pure. Subject carries
 * the topic for glanceability; the body lists czas / oddział / [dział] / tematyka
 * and a link to the auth-gated detail view. The `dział` line is omitted when no
 * department was provided.
 */
export function buildNewSubmissionNotification(
  notice: NewSubmissionNotice,
  baseUrl: string,
): { subject: string; text: string } {
  const subject = `Nowe zgłoszenie — ${notice.topic}`;

  const lines = ["Wpłynęło nowe zgłoszenie.", "", `Czas: ${notice.createdAt}`, `Oddział: ${notice.branch}`];
  if (notice.department !== undefined) lines.push(`Dział: ${notice.department}`);
  lines.push(`Tematyka: ${notice.topic}`);
  lines.push("", `Szczegóły: ${baseUrl}/dashboard/submissions/${notice.submissionId}`);

  return { subject, text: lines.join("\n") };
}

/**
 * Resolve recipients, build, and send the instant-notify email — best-effort.
 * Returns a `Promise<void>` the route hands to `cfContext.waitUntil`, so it must
 * NEVER throw: the WHOLE body (resolve + build + send) is wrapped so any failure
 * logs an id-less marker and the promise still resolves (a throw escaping the
 * swallow would surface as an unhandled rejection, not the intended log). No-ops
 * silently with no recipients (fail-closed allow-list) or an env-gated channel.
 */
export async function notifyNewSubmission(env: Env, notice: NewSubmissionNotice, baseUrl: string): Promise<void> {
  try {
    const to = resolveAlertRecipients(env);
    if (to.length === 0) return;
    const { subject, text } = buildNewSubmissionNotification(notice, baseUrl);
    await sendEmail({ to, subject, text, env });
  } catch {
    // Id-less, anonymity-safe marker (no submissionId) so a chronically failing channel is greppable.
    // eslint-disable-next-line no-console -- Workers Observability captures console as the log transport
    console.log(JSON.stringify({ event: "new_submission_notify_failed", timestamp: new Date().toISOString() }));
  }
}
