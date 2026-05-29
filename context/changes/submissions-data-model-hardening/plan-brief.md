# Submissions data-model hardening — Plan Brief

> Full plan: `context/changes/submissions-data-model-hardening/plan.md`

## What & Why

Minimal forward-only hardening of the submissions schema. Closes two real defects on the anonymous insert path (whitespace-only content; unbounded anon-writable signature) and completes one contract gap (the missing `ENRICHMENT_STATUSES` taxonomy list). **Trimmed from an earlier 6-phase / 15-finding version** after a finding-by-finding re-verification against the code: 3 findings were factually wrong (#9 index "prefix" theory, #10 already-done INSERT consolidation, #15 no-op `Omit<>` CLI bump) and ~7 were premature or cosmetic (auth refit, type guards, gen-types script, doc deletion, seed determinism). Original plan preserved in git (`47afe76`).

## Starting Point

Original `submissions-data-model` is `status: implemented`, applied to local + cloud (`ovwgoqhqbbgfodivwmwk`). `content` CHECK uses raw `char_length` (accepts `'   '`); `signature` is `text NULL` with no cap and is anon-INSERTable. `taxonomies.ts` mirrors 4 of 5 CHECK lists (missing `enrichment_status`). `typecheck`/`build` pass; `database.types.ts` is in sync with the live schema.

## Desired End State

A new forward-only migration replaces the content CHECK with a `btrim` form and adds a signature length cap (1–200 trimmed, NULL still allowed); no index changes, no data statements. `taxonomies.ts` gains `ENRICHMENT_STATUSES` + `EnrichmentStatus`. `db:reset` / `typecheck` / `lint` / `build` exit 0.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Scope | 3 findings (#1 content trim, #2 signature cap, #3 enrichment const) | Only these close a real defect or complete an existing contract; the other 12 were invalid, premature, or cosmetic on re-verification | Re-verification cross-check |
| Schema fix path | New forward-only migration | Original migration already applied to cloud; editing it creates drift | Plan |
| Smoke-row cleanup | Manual one-off in Studio, NOT in the migration | Keeps the migration pure schema and replay-safe; the new CHECKs don't require a clean slate | Re-verification |
| Index #9 | Keep `submissions_created_at_desc_idx` | The "redundant prefix" claim is false — composite leads with enrichment_status, so it can't serve a bare ORDER BY created_at DESC | Re-verification |
| Auth refit #6 | Defer | Stale-token bug doesn't manifest in any current flow; highest blast radius for zero realized benefit | Re-verification |
| CLI bump #15 | Drop | `Omit<Database,'__InternalSupabase'>` is a valid no-op; typecheck/build pass; bump is pure downside | Re-verification |
| Signature empty-string | `''` now rejected (NULL or 1–200 trimmed) | Anonymity = "no signature" is NULL, not empty string; consistent with content btrim | Plan |

## Scope

**In scope:**
- New migration `20260529000000_submissions_constraints_hardening.sql` — content `btrim` CHECK + signature length CHECK. No index/data changes.
- `src/lib/submissions/taxonomies.ts` — add `ENRICHMENT_STATUSES` const + `EnrichmentStatus` type.

**Out of scope (dropped/deferred — see plan `## What We're NOT Doing` for per-finding reasons):**
- #9 index drop (invalid), #10 INSERT consolidation (already done), #15 CLI bump (no-op).
- #6 auth refit, #7 signout parity, #12 type guards, #4 gen-types.mjs, #13 header trim, #11 doc deletion, #5 seed determinism.
- #8 / #14 already captured in `context/foundation/lessons.md`.
- No test runner, no pg ENUM, no `.gitattributes`.

## Architecture / Approach

Two small independently-verifiable phases: Phase 1 = pure-schema forward-only migration (two CHECKs, no data statements, no index changes); Phase 2 = 2-line additive taxonomy export. Verified via `db:reset` + psql/Studio smoke (Phase 1) and `astro check` / `build` (Phase 2).

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema constraint hardening | New migration: content `btrim` CHECK + signature length CHECK | Cloud `db push`: confirm existing rows satisfy new constraints first (they should) |
| 2. Taxonomy ENRICHMENT_STATUSES | `ENRICHMENT_STATUSES` const + `EnrichmentStatus` type | None — additive |

**Prerequisites:** local Supabase stack running (`supabase start`); cloud project linked; `supabase db push` access for Phase 1 cloud apply.

**Estimated effort:** ~1 short session for both phases.

## Open Risks & Assumptions

- **Cloud constraint validity:** the 2 smoke rows on cloud have short non-empty content + NULL signature, so `db push` should succeed without TRUNCATE; the plan mandates a pre-push validity count as the gate.
- **Empty-string signature now rejected:** S-01's form must send `NULL` (not `''`) for the no-signature case. Captured as a downstream contract note.

## Success Criteria (Summary)

- Whitespace-only content INSERT fails with CHECK violation; oversize/whitespace signature INSERT fails with CHECK violation; `submissions_created_at_desc_idx` still present.
- `npm run db:reset` / `typecheck` / `lint` (touched) / `build` exit 0.
- `taxonomies.ts` exports `ENRICHMENT_STATUSES` + `EnrichmentStatus`.
