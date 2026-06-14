import { describe, expect, it } from "vitest";

import { buildEnrichmentFailureAlert, type FailureAlertItem } from "./fr018-alert";

const baseItem: FailureAlertItem = {
  submissionId: "11111111-1111-1111-1111-111111111111",
  errorType: "permanent",
  attempts: 1,
  errorKind: "auth",
  errorStatus: 401,
  timestamp: "2026-06-14T10:00:00.000Z",
};

describe("buildEnrichmentFailureAlert — subject reflects count", () => {
  it("uses the singular noun for a single item", () => {
    const { subject } = buildEnrichmentFailureAlert([baseItem]);
    expect(subject).toContain("1 zgłoszenie");
    expect(subject).not.toContain("zgłoszeń");
  });

  it("reflects the count for N items", () => {
    const items: FailureAlertItem[] = Array.from({ length: 5 }, (_, i) => ({
      ...baseItem,
      submissionId: `0000000${i}-0000-0000-0000-000000000000`,
    }));
    const { subject } = buildEnrichmentFailureAlert(items);
    expect(subject).toContain("5 zgłoszeń");
  });
});

describe("buildEnrichmentFailureAlert — body lists each item's safe fields", () => {
  it("lists every item with its operational fields", () => {
    const items: FailureAlertItem[] = [
      baseItem,
      {
        submissionId: "22222222-2222-2222-2222-222222222222",
        errorType: "retry_exhausted",
        attempts: 5,
        timestamp: "2026-06-14T11:00:00.000Z",
      },
    ];
    const { text } = buildEnrichmentFailureAlert(items);

    // Both submission ids present, one line each.
    expect(text).toContain("11111111-1111-1111-1111-111111111111");
    expect(text).toContain("22222222-2222-2222-2222-222222222222");
    // Safe operational fields rendered.
    expect(text).toContain("próby: 1");
    expect(text).toContain("próby: 5");
    expect(text).toContain("status: 401");
    // Optional fields omitted cleanly when absent (no "status:" for the second item line).
    const secondLine = text.split("\n").find((l) => l.includes("22222222"));
    expect(secondLine).toBeDefined();
    expect(secondLine).not.toContain("status:");
    expect(secondLine).not.toContain("rodzaj:");
  });
});

describe("buildEnrichmentFailureAlert — anonymity shape-seal", () => {
  it("never renders content / signature / raw error, even if present on the item object", () => {
    const SECRET_CONTENT = "TOP_SECRET_SUBMISSION_BODY";
    const SECRET_SIGNATURE = "Jan Kowalski";
    const RAW_ERROR = "OpenAI 401: invalid api key for org-xyz";

    // Pollute the item with forbidden fields the typed contract does not declare.
    // The builder reads only the named safe fields, so none of these may surface.
    const polluted = {
      ...baseItem,
      content: SECRET_CONTENT,
      signature: SECRET_SIGNATURE,
      message: RAW_ERROR,
    } as unknown as FailureAlertItem;

    const { subject, text } = buildEnrichmentFailureAlert([polluted]);
    for (const leak of [SECRET_CONTENT, SECRET_SIGNATURE, RAW_ERROR]) {
      expect(subject).not.toContain(leak);
      expect(text).not.toContain(leak);
    }
  });
});
