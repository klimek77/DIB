import type { APIContext, APIRoute } from "astro";

import { isAllowedAdmin } from "@/lib/auth/allowlist";
import { validateReviewStatusInput } from "@/lib/submissions/review-status-input";
import { createClient } from "@/lib/supabase";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Shared guard for both mutating verbs (plan Critical Implementation Details — order matters):
//   (1) same-origin — a state change must carry an Origin equal to the request's own origin.
//       Missing or mismatched → 403. This is the lightweight CSRF defense for the mutations
//       (no double-submit token by design). fetch() sends Origin on every non-GET/HEAD request,
//       so a legitimate same-origin PATCH/DELETE always carries it.
//   (2) app-level admin gate via the SAME allow-list the middleware uses. Middleware does NOT
//       cover /api/*, so the endpoint must self-guard.
// RLS is the LAST line (a non-admin/anon session sees 0 rows → 404), but the app-guard is the
// FIRST so a forged request never reaches the DB. Returns a Response to short-circuit, else null.
function guard(context: APIContext): Response | null {
  const origin = context.request.headers.get("Origin");
  if (!origin || origin !== new URL(context.request.url).origin) {
    return json({ ok: false, error: "Niedozwolone żądanie." }, 403);
  }
  if (!isAllowedAdmin(context.locals.user?.email)) {
    return json({ ok: false, error: "Brak uprawnień." }, 403);
  }
  return null;
}

// PATCH /api/submissions/:id — admin sets the triage status. SET carries ONLY review_status;
// any other column would raise 42501 under the column-scoped grant (test-plan #3 backstop).
export const PATCH: APIRoute = async (context) => {
  const denied = guard(context);
  if (denied) return denied;

  const { id } = context.params;
  if (!id) {
    return json({ ok: false, error: "Nie znaleziono zgłoszenia." }, 404);
  }

  let body: unknown;
  try {
    body = await context.request.json();
  } catch {
    return json({ ok: false, error: "Nieprawidłowe dane." }, 400);
  }

  // The validated value IS the whitelist — we send value.review_status, never the raw body.
  const validation = validateReviewStatusInput(body);
  if (!validation.ok) {
    return json({ ok: false, error: validation.error }, 400);
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return json({ ok: false, error: "Błąd serwera." }, 500);
  }

  const { data, error } = await supabase
    .from("submissions")
    .update({ review_status: validation.value.review_status })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) {
    return json({ ok: false, error: "Błąd serwera." }, 500);
  }
  // 0 rows ⇒ id absent OR RLS denied (non-admin session). Both collapse to 404 so the response
  // never reveals which — mirrors the existing detail-read.
  if (!data) {
    return json({ ok: false, error: "Nie znaleziono zgłoszenia." }, 404);
  }

  return json({ ok: true }, 200);
};

// DELETE /api/submissions/:id — admin hard-deletes a submission (spam/off-topic moderation).
export const DELETE: APIRoute = async (context) => {
  const denied = guard(context);
  if (denied) return denied;

  const { id } = context.params;
  if (!id) {
    return json({ ok: false, error: "Nie znaleziono zgłoszenia." }, 404);
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return json({ ok: false, error: "Błąd serwera." }, 500);
  }

  const { data, error } = await supabase.from("submissions").delete().eq("id", id).select("id").maybeSingle();

  if (error) {
    return json({ ok: false, error: "Błąd serwera." }, 500);
  }
  if (!data) {
    return json({ ok: false, error: "Nie znaleziono zgłoszenia." }, 404);
  }

  return json({ ok: true }, 200);
};
