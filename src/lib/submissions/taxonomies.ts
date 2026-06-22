// Single source of truth for the seven taxonomy lists shared by the
// employee form (S-01), the admin dashboard (S-02), and the AI enrichment
// consumer (F-03). Values mirror character-for-character the CHECK
// constraints in supabase/migrations/ — submissions_department_check,
// submissions_branch_check, submissions_topic_check, submissions_ai_tone_check,
// submissions_enrichment_status_check (20260528000000_create_submissions.sql)
// and submissions_review_status_check (20260619000000_admin_submission_triage.sql).
// A diacritic drift between this file and the migration silently breaks INSERTs
// in production. Future migrations that add or remove a value MUST update this
// file in the same commit.
//
// Why import the type aliases below instead of
// Database['public']['Tables']['submissions']['Row']['topic'] etc.:
// `supabase gen types typescript` falls back to plain `string` for
// `text + CHECK` columns (supabase/cli#1433). The Row types are correct
// for query results; the `as const` aliases below are correct for narrowing.

export const DEPARTMENTS = [
  "Sprzedaż",
  "Handlowy",
  "Magazyn",
  "HR",
  "Księgowość",
  "Sekretariat",
  "IT",
  "Operacyjny",
  "Media",
  "Segment Konstrukcji",
  "Segment Dachy",
] as const;

export const BRANCHES = [
  "Gliwice",
  "Tarnowskie Góry",
  "Oświęcim",
  "Sosnowiec",
  "Katowice",
  "Dąbrowa Górnicza",
  "Chrzanów",
  "Centrala",
  "Supermarket Dobromir",
] as const;

export const TOPICS = ["Pomysł", "Problem", "Usprawnienie", "Inne"] as const;

export const TONES = ["Pozytywny", "Negatywny", "Neutralny"] as const;

export const ENRICHMENT_STATUSES = ["pending", "processing", "done", "failed"] as const;

// Admin triage status (admin-submission-triage) — distinct from ENRICHMENT_STATUSES
// (AI lifecycle) above; do NOT conflate. EN codes mirror submissions_review_status_check
// (20260619000000). The PL labels below are what the dashboard renders (UI is Polish).
export const REVIEW_STATUSES = ["new", "in_progress", "reviewed", "rejected"] as const;

export const REVIEW_STATUS_LABELS: Record<(typeof REVIEW_STATUSES)[number], string> = {
  new: "Nowe",
  in_progress: "W trakcie",
  reviewed: "Rozpatrzone",
  rejected: "Odrzucone",
};

// AI-derived classification of a submission (F-03 enrichment output → ai_classification).
// Distinct from the user-picked `topic` above — do NOT conflate the two. NOT DB-enforced
// (ai_classification has no CHECK), so this const is the app-level source of truth: the
// OpenAI Structured-Outputs enum and FR-011's dashboard pie chart (S-02) both read from it.
export const CLASSIFICATIONS = ["pomysł", "zgłoszenie", "propozycja", "błąd", "skarga"] as const;

export type Department = (typeof DEPARTMENTS)[number];
export type Branch = (typeof BRANCHES)[number];
export type Topic = (typeof TOPICS)[number];
export type Tone = (typeof TONES)[number];
export type EnrichmentStatus = (typeof ENRICHMENT_STATUSES)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type Classification = (typeof CLASSIFICATIONS)[number];
