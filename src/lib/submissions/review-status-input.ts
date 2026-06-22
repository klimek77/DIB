// Whitelist validator for the admin triage PATCH body. Like submission-input.ts on the
// producer side, the validated value IS the whitelist: it reads ONLY `review_status` and
// checks membership in the REVIEW_STATUSES SSOT (mirrors submissions_review_status_check).
// Any other key in the body — content / ai_* / enrichment_* / id — is ignored by
// construction (never read). The endpoint sends value.review_status as the SOLE column in
// the UPDATE SET; the column-scoped GRANT UPDATE(review_status) is the DB backstop should
// this ever let another column through (test-plan #3).
//
// Pure (no I/O).

import { REVIEW_STATUSES, type ReviewStatus } from "./taxonomies";

export type ReviewStatusValidationResult =
  | { ok: true; value: { review_status: ReviewStatus } }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateReviewStatusInput(body: unknown): ReviewStatusValidationResult {
  if (!isRecord(body)) {
    return { ok: false, error: "Nieprawidłowe dane." };
  }

  // review_status — required, exact taxonomy member. Read in isolation: nothing else in
  // `body` is touched, so the returned value can only ever be { review_status }.
  const { review_status } = body;
  if (typeof review_status !== "string" || !(REVIEW_STATUSES as readonly string[]).includes(review_status)) {
    return { ok: false, error: "Nieprawidłowy status." };
  }

  return { ok: true, value: { review_status: review_status as ReviewStatus } };
}
