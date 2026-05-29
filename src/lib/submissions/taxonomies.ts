// Single source of truth for the four taxonomy lists shared by the
// employee form (S-01), the admin dashboard (S-02), and the AI enrichment
// consumer (F-03). Values mirror character-for-character the CHECK
// constraints in supabase/migrations/20260528000000_create_submissions.sql
// (submissions_department_check, submissions_branch_check,
// submissions_topic_check, submissions_ai_tone_check). A diacritic drift
// between this file and the migration silently breaks INSERTs in production.
// Future migrations that add or remove a value MUST update this file in
// the same commit.
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

export type Department = (typeof DEPARTMENTS)[number];
export type Branch = (typeof BRANCHES)[number];
export type Topic = (typeof TOPICS)[number];
export type Tone = (typeof TONES)[number];
export type EnrichmentStatus = (typeof ENRICHMENT_STATUSES)[number];
