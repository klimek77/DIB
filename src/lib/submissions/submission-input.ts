// Security core of S-01's producer side: turn an UNTRUSTED request body into exactly
// the columns a submissions row may receive, rejecting everything else. The endpoint
// inserts via the service-role admin client (to read back `id` under the no-SELECT anon
// grant), which BYPASSES the F-01 column grant that normally withholds id/enrichment_*/ai_*
// from clients — so this whitelist is the only thing stopping a client from setting them.
//
// Pure (no I/O). Reads ONLY the five user-writable fields; any `id`, `enrichment_*`, `ai_*`,
// or unknown key in the body is ignored by construction (never read). Taxonomy membership is
// checked against the SSOT in taxonomies.ts character-for-character — a diacritic drift would
// pass here only to fail the DB CHECK on INSERT.

import { BRANCHES, DEPARTMENTS, TOPICS, type Branch, type Department, type Topic } from "./taxonomies";

export const CONTENT_MIN = 1;
export const CONTENT_MAX = 800;
export const SIGNATURE_MIN = 1;
export const SIGNATURE_MAX = 200;

/** The clean, insertable shape. The caller adds `enrichment_status: 'pending'`. */
export interface ValidatedSubmission {
  branch: Branch;
  topic: Topic;
  content: string;
  department?: Department;
  signature?: string;
}

export type SubmissionValidationResult = { ok: true; value: ValidatedSubmission } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Optional fields treat undefined / null / "" as "not provided" — the form sends "" for an
// unselected dropdown. A present-but-non-empty value still has to pass its own validation.
function isProvided(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function validateSubmissionInput(body: unknown): SubmissionValidationResult {
  if (!isRecord(body)) {
    return { ok: false, error: "Nieprawidłowe dane formularza." };
  }

  // branch (oddział) — required, exact taxonomy member.
  const { branch } = body;
  if (typeof branch !== "string" || !(BRANCHES as readonly string[]).includes(branch)) {
    return { ok: false, error: "Wybierz prawidłowy oddział." };
  }

  // topic (tematyka) — required, exact taxonomy member.
  const { topic } = body;
  if (typeof topic !== "string" || !(TOPICS as readonly string[]).includes(topic)) {
    return { ok: false, error: "Wybierz prawidłową tematykę." };
  }

  // content (treść) — required; trimmed length mirrors the DB CHECK char_length(btrim(content)) 1..800.
  if (typeof body.content !== "string") {
    return { ok: false, error: "Treść jest wymagana." };
  }
  const content = body.content.trim();
  if (content.length < CONTENT_MIN || content.length > CONTENT_MAX) {
    return { ok: false, error: `Treść musi mieć od ${CONTENT_MIN} do ${CONTENT_MAX} znaków.` };
  }

  const value: ValidatedSubmission = {
    branch: branch as Branch,
    topic: topic as Topic,
    content,
  };

  // department (dział) — optional; if provided, must be an exact taxonomy member.
  if (isProvided(body.department)) {
    if (typeof body.department !== "string" || !(DEPARTMENTS as readonly string[]).includes(body.department)) {
      return { ok: false, error: "Wybierz prawidłowy dział." };
    }
    value.department = body.department as Department;
  }

  // signature (podpis) — optional; if provided, trimmed length 1..200 (mirrors the DB CHECK).
  if (isProvided(body.signature)) {
    if (typeof body.signature !== "string") {
      return { ok: false, error: "Nieprawidłowy podpis." };
    }
    const signature = body.signature.trim();
    // A signature that is whitespace-only collapses to "not provided".
    if (signature.length > 0) {
      if (signature.length < SIGNATURE_MIN || signature.length > SIGNATURE_MAX) {
        return { ok: false, error: `Podpis może mieć maksymalnie ${SIGNATURE_MAX} znaków.` };
      }
      value.signature = signature;
    }
  }

  return { ok: true, value };
}
