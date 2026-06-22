import { describe, expect, it } from "vitest";

import { validateReviewStatusInput } from "./review-status-input";
import { REVIEW_STATUSES } from "./taxonomies";

describe("validateReviewStatusInput — whitelist + enum", () => {
  it("accepts every REVIEW_STATUSES member and returns exactly that value", () => {
    for (const status of REVIEW_STATUSES) {
      const result = validateReviewStatusInput({ review_status: status });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual({ review_status: status });
    }
  });

  it("rejects a status outside the taxonomy", () => {
    const result = validateReviewStatusInput({ review_status: "archived" });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing or non-string review_status", () => {
    expect(validateReviewStatusInput({}).ok).toBe(false);
    expect(validateReviewStatusInput({ review_status: 42 }).ok).toBe(false);
    expect(validateReviewStatusInput({ review_status: null }).ok).toBe(false);
    expect(validateReviewStatusInput({ review_status: "" }).ok).toBe(false);
  });

  it("rejects a non-record body (null, string, array)", () => {
    expect(validateReviewStatusInput(null).ok).toBe(false);
    expect(validateReviewStatusInput("new").ok).toBe(false);
    expect(validateReviewStatusInput(["new"]).ok).toBe(false);
  });

  it("ignores injected keys by construction — the validated value is exactly { review_status }", () => {
    // Hostile keys alongside a valid status: id / ai_* / content / enrichment_* must never
    // survive into the value the endpoint puts in the UPDATE SET (the Object.keys seal).
    const result = validateReviewStatusInput({
      review_status: "reviewed",
      content: "hacked",
      ai_title: "pwned",
      id: "client-supplied-id",
      enrichment_status: "done",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual(["review_status"]);
      expect(result.value).toEqual({ review_status: "reviewed" });
    }
  });
});
