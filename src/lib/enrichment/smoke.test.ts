import { describe, expect, it } from "vitest";

import type { EnrichmentMessage } from "./types";

// Phase 1 smoke test — proves the vitest harness is wired and runs green before
// the real enrichment/idempotency tests land in Phases 2–3.
describe("enrichment harness smoke", () => {
  it("constructs an EnrichmentMessage carrying only the submission id", () => {
    const message: EnrichmentMessage = { submissionId: "00000000-0000-0000-0000-000000000000" };
    expect(message.submissionId).toBe("00000000-0000-0000-0000-000000000000");
    expect(Object.keys(message)).toEqual(["submissionId"]);
  });
});
