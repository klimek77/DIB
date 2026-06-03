// OpenAI implementation of the enrichment seam. Calls gpt-4o-mini via the Chat
// Completions API with Structured Outputs (`response_format` json_schema,
// `strict: true`). Raw `fetch` rather than the openai SDK: keeps the Worker bundle
// lean, avoids Node-only globals (tsconfig `types` is exhaustive — workers-types
// only), and makes the call trivially mockable via the injectable `fetchImpl`.

import { CLASSIFICATIONS, TONES } from "../submissions/taxonomies";

import type { EnrichmentResult, EnrichOptions } from "./enrich";
import { classifyHttpStatus, EnrichmentError } from "./errors";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 30_000;

// JSON schema for Structured Outputs. The `tone`/`classification` enums are spread
// from the taxonomy SSOT (never re-typed) so a diacritic drift cannot slip a
// structurally-valid AI response past the DB CHECK on `ai_tone`. The drift-guard
// unit test (2.3) reads these arrays back and asserts they equal the consts.
export const ENRICHMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tone", "classification", "title", "summary"],
  properties: {
    tone: { type: "string", enum: [...TONES] },
    classification: { type: "string", enum: [...CLASSIFICATIONS] },
    title: { type: "string" },
    summary: { type: "string" },
  },
} as const;

const SYSTEM_PROMPT =
  "Jesteś asystentem analizującym zgłoszenia pracowników do firmowej skrzynki pomysłów. " +
  "Na podstawie treści zgłoszenia ustal: ton wypowiedzi, klasyfikację zgłoszenia, krótki tytuł " +
  "(kilka słów) oraz zwięzłe podsumowanie (1–2 zdania). Odpowiadaj wyłącznie po polsku i wyłącznie " +
  "zgodnie z podanym schematem JSON.";

interface OpenAiChatResponse {
  choices?: { message?: { content?: string | null } }[];
}

export async function enrichWithOpenAI(content: string, opts: EnrichOptions): Promise<EnrichmentResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      // Only the submission content reaches OpenAI — never the signature.
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "enrichment", strict: true, schema: ENRICHMENT_JSON_SCHEMA },
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    // Network drop / DNS / abort-timeout — no HTTP status, so retry-worthy.
    throw new EnrichmentError("transient", `OpenAI request failed: ${describeCause(cause)}`);
  }

  if (!response.ok) {
    const detail = await safeReadBody(response);
    throw new EnrichmentError(
      classifyHttpStatus(response.status),
      `OpenAI returned ${response.status}: ${detail}`,
      response.status,
    );
  }

  const payload: OpenAiChatResponse = await response.json();
  const raw = payload.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || raw.trim() === "") {
    // Empty / refused completion — the structured-output contract was not met.
    throw new EnrichmentError("permanent", "OpenAI response carried no structured content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnrichmentError("permanent", "OpenAI structured output was not valid JSON");
  }

  return validateResult(parsed);
}

// Validate the parsed payload against the SSOT lists. A structurally-valid response
// whose enum value drifted from the DB CHECK is a permanent failure: retrying the
// same prompt will not change it, and writing it back would fail the row UPDATE.
function validateResult(value: unknown): EnrichmentResult {
  if (typeof value !== "object" || value === null) {
    throw new EnrichmentError("permanent", "Structured output was not an object");
  }
  const { tone, classification, title, summary } = value as Record<string, unknown>;

  if (!isTone(tone)) {
    throw new EnrichmentError("permanent", `Invalid tone from OpenAI: ${String(tone)}`);
  }
  if (!isClassification(classification)) {
    throw new EnrichmentError("permanent", `Invalid classification from OpenAI: ${String(classification)}`);
  }
  if (typeof title !== "string" || title.trim() === "") {
    throw new EnrichmentError("permanent", "Structured output had an empty title");
  }
  if (typeof summary !== "string" || summary.trim() === "") {
    throw new EnrichmentError("permanent", "Structured output had an empty summary");
  }

  return { tone, classification, title, summary };
}

function isTone(value: unknown): value is EnrichmentResult["tone"] {
  return typeof value === "string" && (TONES as readonly string[]).includes(value);
}

function isClassification(value: unknown): value is EnrichmentResult["classification"] {
  return typeof value === "string" && (CLASSIFICATIONS as readonly string[]).includes(value);
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}
