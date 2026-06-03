// Provider-agnostic enrichment seam. The consumer (Phase 3) calls `enrich()` and
// never touches a provider directly.
//
// Seam discipline (lessons: "don't harden a consumer that doesn't exist yet"):
// this is exactly ONE exported function + ONE impl file (`openai.ts`). Anthropic
// is out of scope. Swapping it in later means writing a second impl and changing
// this one call site — NOT a provider registry, factory, or strategy map.

import type { Classification, Tone } from "../submissions/taxonomies";

import { enrichWithOpenAI } from "./openai";

export interface EnrichmentResult {
  tone: Tone;
  classification: Classification;
  title: string;
  summary: string;
}

export interface EnrichOptions {
  /** OpenAI API key (env.OPENAI_API_KEY in the consumer). */
  apiKey: string;
  /** Override the model; defaults to gpt-4o-mini. */
  model?: string;
  /** Request timeout in ms before the call aborts as a transient error. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the runtime global. */
  fetchImpl?: typeof fetch;
}

// The input is the submission `content` ONLY — never the `signature`. Anonymity is
// a PRD guardrail: the AI request payload must never carry author-identifying data.
export function enrich(content: string, opts: EnrichOptions): Promise<EnrichmentResult> {
  return enrichWithOpenAI(content, opts);
}
