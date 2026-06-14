// Reusable email transport for all notification features (S-03 FR-018 alert,
// and the future S-04 instant-notify / S-05 weekly-digest). Resend over raw
// `fetch` rather than the SDK: keeps the Worker bundle lean and the call
// trivially mockable via the injectable `fetchImpl` (mirrors openai.ts).
//
// Env-gated: with RESEND_API_KEY or ALERT_FROM absent it no-ops (no network
// call), the same optional-secret posture as SENTRY_DSN — so dev/test/local
// never send, and FR-018 activates by setting the secrets + verifying a domain.

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export interface SendEmailOptions {
  to: string[];
  subject: string;
  text: string;
  env: Env;
  fetchImpl?: typeof fetch;
}

/**
 * Send a plain-text email via Resend. Returns `{ sent: false }` without a
 * network call when the channel is not configured (missing key/from) or there
 * are no recipients. Throws on a non-2xx Resend response — the caller decides
 * how to handle it (the FR-018 flush swallows+logs so a provider blip never
 * breaks enrichment).
 */
export async function sendEmail(opts: SendEmailOptions): Promise<{ sent: boolean }> {
  const { to, subject, text, env } = opts;
  const apiKey = env.RESEND_API_KEY;
  const from = env.ALERT_FROM;

  // Env-gated no-op: unconfigured channel sends nothing (dev/test/local).
  if (!apiKey || !from) return { sent: false };
  // No recipients (fail-closed allow-list) → nothing to send.
  if (to.length === 0) return { sent: false };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(RESEND_EMAILS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from, to, subject, text }),
  });

  if (!response.ok) {
    throw new Error(`Resend returned ${response.status}`);
  }

  return { sent: true };
}
