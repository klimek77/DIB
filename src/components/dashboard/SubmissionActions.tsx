import React, { useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { REVIEW_STATUSES, REVIEW_STATUS_LABELS, type ReviewStatus } from "@/lib/submissions/taxonomies";

// Admin triage actions island (admin-submission-triage Phase 4) — the ONLY client-JS on the
// detail view; the dashboard list stays zero-JS by design (S-02). Mounts under the submission
// card on [id].astro and talks to PATCH/DELETE /api/submissions/:id through the admin SESSION
// cookie (same-origin fetch), so RLS gates both mutations at the DB layer (defense in depth,
// test-plan #1). Both verbs require a same-origin Origin header — fetch() sends it automatically
// on non-GET requests, so credentials:"same-origin" + the default Origin satisfy the endpoint guard.
//
// Light / sewera-blue dashboard world (design §4.2), matching the detail page's white cards.

interface SubmissionActionsProps {
  id: string;
  reviewStatus: ReviewStatus;
}

const selectClass =
  "w-full max-w-xs cursor-pointer rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 outline-none transition-colors focus:border-[#0176D0] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto";

export default function SubmissionActions({ id, reviewStatus }: SubmissionActionsProps) {
  const [status, setStatus] = useState<ReviewStatus>(reviewStatus);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeStatus(next: ReviewStatus) {
    if (next === status || saving || deleting) return;

    // Optimistic: reflect the choice in the select immediately; revert on failure.
    const previous = status;
    setStatus(next);
    setSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/submissions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ review_status: next }),
      });

      if (response.ok) {
        // Reload so the server-rendered status badge re-reads the persisted value (manual gate 4.5).
        window.location.reload();
        return;
      }

      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      setStatus(previous);
      setError(data?.error ?? "Nie udało się zapisać statusu. Spróbuj ponownie.");
    } catch {
      setStatus(previous);
      setError("Wystąpił problem z połączeniem. Spróbuj ponownie.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (saving || deleting) return;
    if (!window.confirm("Czy na pewno chcesz usunąć to zgłoszenie? Tej operacji nie można cofnąć.")) return;

    setDeleting(true);
    setError(null);

    try {
      const response = await fetch(`/api/submissions/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
      });

      if (response.ok) {
        window.location.href = "/dashboard";
        return;
      }

      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? "Nie udało się usunąć zgłoszenia. Spróbuj ponownie.");
    } catch {
      setError("Wystąpił problem z połączeniem. Spróbuj ponownie.");
    } finally {
      setDeleting(false);
    }
  }

  function handleSelectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    void changeStatus(e.target.value as ReviewStatus);
  }

  return (
    <div className="space-y-5">
      <div>
        <label
          htmlFor="review-status"
          className="mb-1.5 block text-xs font-semibold tracking-wider text-gray-500 uppercase"
        >
          Zmień status
        </label>
        <select
          id="review-status"
          value={status}
          onChange={handleSelectChange}
          disabled={saving || deleting}
          className={selectClass}
        >
          {REVIEW_STATUSES.map((s) => (
            <option key={s} value={s}>
              {REVIEW_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="border-t border-gray-300 pt-5">
        <h3 className="mb-1.5 text-xs font-semibold tracking-wider text-gray-500 uppercase">Strefa moderacji</h3>
        <p className="mb-3 text-sm text-gray-500">Usuwa zgłoszenie na stałe — np. spam lub treść off-topic.</p>
        <Button type="button" variant="destructive" onClick={handleDelete} disabled={saving || deleting}>
          <Trash2 className="size-4" aria-hidden="true" />
          {deleting ? "Usuwanie…" : "Usuń zgłoszenie"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
