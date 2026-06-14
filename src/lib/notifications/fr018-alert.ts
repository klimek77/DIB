// FR-018 alert payload builder. Turns the N terminal-failure items collected in
// one consumer invocation into a single anonymity-safe email. This is the only
// place the alert wording lives, and it constructs the body from the typed safe
// fields EXCLUSIVELY — there is no code path here to content, signature, or raw
// error text, so the anonymity guardrail holds by construction.

/** The only fields an alert may carry. No content, signature, raw error, or IP/geo. */
export interface FailureAlertItem {
  submissionId: string;
  errorType: "permanent" | "retry_exhausted";
  attempts: number;
  errorKind?: "transient" | "permanent";
  errorStatus?: number;
  timestamp: string;
}

const ERROR_TYPE_LABEL: Record<FailureAlertItem["errorType"], string> = {
  permanent: "błąd trwały",
  retry_exhausted: "wyczerpane ponowienia",
};

/** Polish noun form for "zgłoszenie" given a count (1 / 2–4 / 5+ with the teen exception). */
function submissionNoun(count: number): string {
  if (count === 1) return "zgłoszenie";
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "zgłoszenia";
  return "zgłoszeń";
}

function formatItem(item: FailureAlertItem): string {
  const parts = [`ID: ${item.submissionId}`, `typ: ${ERROR_TYPE_LABEL[item.errorType]}`, `próby: ${item.attempts}`];
  if (item.errorKind !== undefined) parts.push(`rodzaj: ${item.errorKind}`);
  if (item.errorStatus !== undefined) parts.push(`status: ${item.errorStatus}`);
  parts.push(`czas: ${item.timestamp}`);
  return `- ${parts.join(" | ")}`;
}

/**
 * Build the coalesced FR-018 alert from one invocation's terminal failures.
 * Subject reflects the count; body lists each item's safe fields only.
 */
export function buildEnrichmentFailureAlert(items: FailureAlertItem[]): { subject: string; text: string } {
  const count = items.length;
  const subject = `Wzbogacenie AI nie powiodło się — ${count} ${submissionNoun(count)}`;

  const intro =
    count === 1
      ? "Wzbogacenie AI zgłoszenia zakończyło się trwałym niepowodzeniem:"
      : `Wzbogacenie AI zakończyło się trwałym niepowodzeniem dla ${count} ${submissionNoun(count)}:`;

  const text = [intro, "", ...items.map(formatItem)].join("\n");

  return { subject, text };
}
