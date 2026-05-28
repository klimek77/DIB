---
change_id: submissions-data-model
title: Submissions table + types + RLS — foundation for write/read path
status: implementing
created: 2026-05-28
updated: 2026-05-28
archived_at: null
---

## Phase 2 adaptations (2026-05-28)

- Docker was offline at the start of Phase 2; restored mid-implementation, `supabase start` + `db reset` then ran cleanly.
- Lint criterion 2.2 (`npm run lint` exits 0): project-wide baseline broken on this Windows host due to `core.autocrlf=true` (1120 CRLF errors already present at HEAD a12fe73, untouched files). Phase 2 contribution is clean: `npx eslint src/lib/submissions/taxonomies.ts src/lib/database.types.ts src/lib/supabase.ts` returns 0 errors after `lint:fix` on the new + edited TS files. Project-wide normalization (`.gitattributes` + `git add --renormalize`) is a separate change, not bundled into Phase 2.
- `src/lib/database.types.ts` added to a new `.prettierignore` and to `eslint.config.js` ignores so the generated file is excluded from project lint rules (standard practice for generated code; the file ships under the `// @generated` marker).
- `db:gen-types` script kept verbatim from plan (`supabase gen types ... > file`); the supabase CLI does not emit the `// @generated` header, so the marker is hand-added once after generation. Future re-runs strip it — a known small UX gap, surfaced in the file's header comment for the next reader. A hardened script (Node-based prepend) is a candidate cleanup for a follow-up.


## Notes

first from @context/foundation/roadmap.md

CSV-driven taxonomy decisions (locked into the migration):
- topic values diverge from PRD (`Pomysł / Problem / Usprawnienie / Inne` vs PRD's 5-value set)
- tone closes PRD Open Q7 with `Pozytywny / Negatywny / Neutralny`
- location is two required fields (`department` + `branch`), resolving PRD FR-003 ambiguity
- `ai_title` added as a 4th enrichment column (PRD names three)

Follow-up after F-01 lands: small change to update PRD FR-003 / FR-011 wording to match.

Phase 1 verification path adapted (Docker unavailable):
- `supabase db reset` (local) → `supabase link --project-ref ovwgoqhqbbgfodivwmwk` + `supabase db push` (cloud). Migration applied to cloud at 2026-05-28; confirmed via `supabase migration list --linked` showing 20260528000000 in both Local + Remote.
- `supabase db dump` (Docker-required) → functional verification via PostgREST + publishable key (6 tests: anon INSERT success with return=minimal; column-grant denial on enrichment_status; CHECK violations on topic/department/branch/content-length; anon SELECT explicit 42501 denial).
- `seed.sql` NOT applied to cloud (push doesn't load seeds). Two smoke-test rows landed via the verification fetch calls — clean up via Supabase dashboard or wait for a future local-Docker pass.
- Item 1.3 (seed count = 6) deferred until local-Docker pass; for S-02 dashboard dev, either populate cloud manually via Studio SQL editor OR install Docker and run `npm run db:reset`.

Plan reviewed 2026-05-28 — REVISE verdict, 2 warnings + 2 observations.
F1 (typecheck → astro check), F2 (downstream-consumer contract for taxonomy types), F3 (migration header REVOKE rationale) — all auto-applied to plan.md.
F4 forward-looking note for F-02: `SET ROLE anon` in Studio does NOT populate `request.jwt.claims`, so once F-02 tightens admin SELECT with `auth.uid()`-based allow-list, the manual verification recipe needs `SET LOCAL request.jwt.claims = ...` inside a transaction. Capture in F-02's change.md or in `context/foundation/lessons.md` once `/10x-lesson` bootstraps it.
Full report: `context/changes/submissions-data-model/reviews/plan-review.md`
