import { describe, expect, it } from "vitest";

import { CONTENT_MAX, SIGNATURE_MAX, validateSubmissionInput, type ValidatedSubmission } from "./submission-input";
import { BRANCHES, DEPARTMENTS, TOPICS } from "./taxonomies";

// A minimal valid body — branch + topic + content, no optional fields.
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    branch: BRANCHES[0],
    topic: TOPICS[0],
    content: "Proponuję powiększyć firmowy parking.",
    ...overrides,
  };
}

function expectOk(result: ReturnType<typeof validateSubmissionInput>): ValidatedSubmission {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
}

describe("validateSubmissionInput — whitelist (strips non-user fields)", () => {
  it("ignores injected id / enrichment_* / ai_* / unknown keys", () => {
    const value = expectOk(
      validateSubmissionInput(
        validBody({
          id: "11111111-1111-1111-1111-111111111111",
          enrichment_status: "done",
          enrichment_attempts: 99,
          ai_title: "pwned",
          ai_tone: "Pozytywny",
          ai_classification: "skarga",
          ai_summary: "leaked",
          created_at: "2000-01-01T00:00:00Z",
          totally_unknown_key: "x",
        }),
      ),
    );

    // Only the five user-writable fields may survive; nothing else leaks through.
    expect(Object.keys(value).sort()).toEqual(["branch", "content", "topic"]);
    expect(value).not.toHaveProperty("id");
    expect(value).not.toHaveProperty("enrichment_status");
    expect(value).not.toHaveProperty("ai_title");
  });
});

describe("validateSubmissionInput — required fields", () => {
  it("rejects a non-object body", () => {
    expect(validateSubmissionInput(null).ok).toBe(false);
    expect(validateSubmissionInput("nope").ok).toBe(false);
    expect(validateSubmissionInput([]).ok).toBe(false);
  });

  it("requires branch", () => {
    const { branch: _omit, ...rest } = validBody();
    void _omit;
    expect(validateSubmissionInput(rest).ok).toBe(false);
  });

  it("requires topic", () => {
    const { topic: _omit, ...rest } = validBody();
    void _omit;
    expect(validateSubmissionInput(rest).ok).toBe(false);
  });

  it("requires content", () => {
    const { content: _omit, ...rest } = validBody();
    void _omit;
    expect(validateSubmissionInput(rest).ok).toBe(false);
  });

  it("rejects whitespace-only content (trimmed length 0)", () => {
    expect(validateSubmissionInput(validBody({ content: "   \n\t " })).ok).toBe(false);
  });
});

describe("validateSubmissionInput — taxonomy membership (exact diacritics)", () => {
  it("rejects an out-of-taxonomy branch", () => {
    expect(validateSubmissionInput(validBody({ branch: "Nieistniejący" })).ok).toBe(false);
  });

  it("rejects an out-of-taxonomy topic", () => {
    expect(validateSubmissionInput(validBody({ topic: "Skarga" })).ok).toBe(false);
  });

  it("rejects a diacritic-stripped branch (e.g. 'Oswiecim' for 'Oświęcim')", () => {
    expect(validateSubmissionInput(validBody({ branch: "Oswiecim" })).ok).toBe(false);
  });

  it("rejects a diacritic-stripped topic ('Pomysl' for 'Pomysł')", () => {
    expect(validateSubmissionInput(validBody({ topic: "Pomysl" })).ok).toBe(false);
  });

  it("rejects an out-of-taxonomy department when one is provided", () => {
    expect(validateSubmissionInput(validBody({ department: "Marketing" })).ok).toBe(false);
  });
});

describe("validateSubmissionInput — length bounds", () => {
  it("accepts content at exactly the 800 limit", () => {
    const value = expectOk(validateSubmissionInput(validBody({ content: "a".repeat(CONTENT_MAX) })));
    expect(value.content.length).toBe(CONTENT_MAX);
  });

  it("rejects content over 800 (after trim)", () => {
    expect(validateSubmissionInput(validBody({ content: "a".repeat(CONTENT_MAX + 1) })).ok).toBe(false);
  });

  it("trims surrounding whitespace from content before storing", () => {
    const value = expectOk(validateSubmissionInput(validBody({ content: "  pomysł  " })));
    expect(value.content).toBe("pomysł");
  });

  it("rejects a signature over 200 chars", () => {
    expect(validateSubmissionInput(validBody({ signature: "a".repeat(SIGNATURE_MAX + 1) })).ok).toBe(false);
  });

  it("accepts a signature at exactly the 200 limit", () => {
    const value = expectOk(validateSubmissionInput(validBody({ signature: "a".repeat(SIGNATURE_MAX) })));
    expect(value.signature).toBe("a".repeat(SIGNATURE_MAX));
  });
});

describe("validateSubmissionInput — optional fields", () => {
  it("accepts a minimal valid body without department or signature", () => {
    const value = expectOk(validateSubmissionInput(validBody()));
    expect(value).not.toHaveProperty("department");
    expect(value).not.toHaveProperty("signature");
  });

  it("treats empty-string department/signature as not provided", () => {
    const value = expectOk(validateSubmissionInput(validBody({ department: "", signature: "" })));
    expect(value).not.toHaveProperty("department");
    expect(value).not.toHaveProperty("signature");
  });

  it("keeps a valid department and trimmed signature when provided", () => {
    const value = expectOk(validateSubmissionInput(validBody({ department: DEPARTMENTS[0], signature: "  Jan K.  " })));
    expect(value.department).toBe(DEPARTMENTS[0]);
    expect(value.signature).toBe("Jan K.");
  });
});
