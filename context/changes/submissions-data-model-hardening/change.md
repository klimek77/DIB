---
change_id: submissions-data-model-hardening
title: Submissions data model hardening
status: impl_reviewed
created: 2026-05-29
updated: 2026-05-29
archived_at: null
---

## Notes

Originally opened to carry all 15 `/simplify` findings (6-phase plan).

**Trimmed 2026-05-29** to a 3-finding core (#1 content `btrim`, #2 signature length cap, #3 `ENRICHMENT_STATUSES`) after a finding-by-finding re-verification (8-agent cross-check) against the actual code and against `submissions-data-model/reviews/impl-review.md`:
- Dropped as INVALID: #9 (index "prefix" theory is false — composite can't serve bare `ORDER BY created_at DESC`), #10 (seed is already one multi-row INSERT), #15 (`Omit<Database,'__InternalSupabase'>` is a valid no-op; typecheck/build pass).
- Dropped as premature/cosmetic: #6 auth refit (bug doesn't manifest in any current flow), #7 signout parity, #12 type guards (zero importers), #4 gen-types.mjs, #13 header trim, #11 doc deletion, #5 seed determinism.
- #8 / #14 captured instead as entries in `context/foundation/lessons.md`.
- TRUNCATE removed from the migration (smoke-row cleanup is now a manual Studio one-off).

The prior `reviews/plan-review.md` (verdict SOUND) reviewed the pre-trim **superset**; every surviving item was PASS there, so `status: plan_reviewed` still holds. Original 6-phase plan preserved in git `47afe76`.

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->
