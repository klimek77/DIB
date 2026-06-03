import { describe, expect, it, vi } from "vitest";

import { CLASSIFICATIONS, TONES } from "../submissions/taxonomies";

import { enrich, type EnrichmentResult } from "./enrich";
import { isTransient } from "./errors";
import { ENRICHMENT_JSON_SCHEMA } from "./openai";

// Capture the rejection of a promise so we can assert on the thrown error's
// classification without relying on a specific matcher being registered.
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

function okResponse(result: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE: EnrichmentResult = {
  tone: "Pozytywny",
  classification: "pomysł",
  title: "Więcej miejsc parkingowych",
  summary: "Pracownik proponuje powiększenie firmowego parkingu, aby skrócić poranne poszukiwania miejsca.",
};

// Gate 2.3 — diacritic-drift guard. The Structured-Outputs enum MUST mirror the
// taxonomy SSOT character-for-character; a drift would let a structurally-valid AI
// response fail the DB CHECK on ai_tone.
describe("enrichment JSON schema (drift guard, gate 2.3)", () => {
  it("tone enum equals the TONES const", () => {
    expect(ENRICHMENT_JSON_SCHEMA.properties.tone.enum).toEqual([...TONES]);
  });

  it("classification enum equals the CLASSIFICATIONS const", () => {
    expect(ENRICHMENT_JSON_SCHEMA.properties.classification.enum).toEqual([...CLASSIFICATIONS]);
  });
});

// Gate 2.4 — enrich() returns a schema-valid EnrichmentResult against a mocked
// OpenAI response (tone ∈ TONES, classification ∈ CLASSIFICATIONS).
describe("enrich() (gate 2.4)", () => {
  it("returns a schema-valid result from a mocked OpenAI response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(okResponse({ ...SAMPLE })));

    const result = await enrich("Proponuję powiększyć parking przy biurze.", { apiKey: "test-key", fetchImpl });

    expect(TONES).toContain(result.tone);
    expect(CLASSIFICATIONS).toContain(result.classification);
    expect(result.title.length).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends only the submission content to OpenAI — never a signature (anonymity guard)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(okResponse({ ...SAMPLE })));

    await enrich("Treść zgłoszenia bez podpisu.", { apiKey: "test-key", fetchImpl });

    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(init?.body as string) as {
      messages: { role: string; content: string }[];
    };
    expect(JSON.stringify(body)).not.toContain("signature");
    const userMessage = body.messages.find((m) => m.role === "user");
    expect(userMessage?.content).toBe("Treść zgłoszenia bez podpisu.");
  });

  it("classifies an HTTP 429 as transient", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("rate limited", { status: 429 })));

    const err = await captureRejection(enrich("x", { apiKey: "test-key", fetchImpl }));

    expect(isTransient(err)).toBe(true);
  });

  it("classifies an HTTP 400 as permanent", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("bad request", { status: 400 })));

    const err = await captureRejection(enrich("x", { apiKey: "test-key", fetchImpl }));

    expect(isTransient(err)).toBe(false);
  });

  it("rejects an off-SSOT tone as a permanent error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(okResponse({ ...SAMPLE, tone: "Positive" })));

    const err = await captureRejection(enrich("x", { apiKey: "test-key", fetchImpl }));

    expect(isTransient(err)).toBe(false);
  });
});
