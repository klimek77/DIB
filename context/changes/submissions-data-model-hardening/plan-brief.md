# Submissions data-model hardening — Plan Brief

> Full plan: `context/changes/submissions-data-model-hardening/plan.md`

## What & Why

Forward-only hardening of the submissions data model and surrounding TypeScript / build / auth surfaces. Driven by 15 findings from a `/simplify` code review of the prior `submissions-data-model` change. Goal: close real correctness gaps (whitespace-only content, signature DoS vector, missing enrichment_status taxonomy, fragile db:gen-types, cookie staleness in middleware) without disturbing the parts of the original plan that landed deliberately.

## Starting Point

Original `submissions-data-model` is `status: implemented` at commit `7ea069e` (epilogue). Schema is applied to local stack + cloud project `ovwgoqhqbbgfodivwmwk` (with 2 smoke-test rows on cloud per p1 verification). Taxonomy module exists with 4 of 5 CHECK lists mirrored. `db:gen-types` works but is fragile (shell redirect strips `@generated` header on every regen; truncates the committed file on CLI failure). Auth wrappers per route handler — each one constructs its own supabase client, so middleware-driven token refresh isn't visible to downstream handlers in the same request.

## Desired End State

A new forward-only migration tightens the content CHECK to use `btrim`, adds a signature length cap, drops a verified-redundant index, and wipes cloud's smoke-test rows. Seed becomes deterministic (literal UUIDs + staggered timestamps). The taxonomy module ships `ENRICHMENT_STATUSES` + 5 type-guard helpers for narrow-type validation on Row reads (working around supabase/cli#1433). `db:gen-types` is a Node script with atomic write + always-prepended `@generated` header. Supabase CLI is bumped to 2.101.0; types regenerated. Auth handlers consume `context.locals.supabase` set once by middleware — token refresh stays visible to all in-request consumers; signout's null-handling matches signin's. The prior change's identity file is trimmed and reusable patterns flow into `context/foundation/lessons.md`.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Scope | All 15 /simplify findings | User Notes explicitly says "pełne findings"; matches the binding intent of opening this change | Plan |
| Schema fix path | New forward-only migration | Original migration already applied to cloud; editing it creates drift | Plan |
| Cookie wrapper fix | Shared client via `context.locals.supabase` | Single client per request resolves the token-refresh visibility gap at the right altitude (Astro middleware-first pattern); alternative in-memory cache would only partially fix | Plan |
| Row narrowing | TS-only type guards | Closes the gen-types narrowing gap without schema/migration risk; pg ENUM migration deferred | Plan |
| Smoke-row cleanup | TRUNCATE in the new migration | Lands the change.md TODO from the prior change in the same window as the constraint hardening; safe because cloud has only known test rows | Plan |
| Index changes | Drop #9 (redundant); document #14 (partial-index syntactic match) via lessons | #9 is verified-redundant write cost; #14 mitigation is lighter as a rule for S-02 than a schema rewrite | Plan |
| CLI bump | In this change, paired with regen | Closes #15 (`__InternalSupabase` drift) and locks in the new tooling immediately after the script refactor | Plan |
| db:gen-types form | Separate `scripts/gen-types.mjs` | Readable + debuggable; inline node oneliner in package.json is quote-hell | Plan |
| Phase order | Schema → Seed → Taxonomy → Tooling → Auth → Docs | Isolate the riskiest surface (auth wrapper) to last so all earlier work is stable when it lands | Plan |
| Doc cleanup | Trim prior change.md + file lessons | Identity files stay stable; reusable patterns move to `context/foundation/lessons.md` | Plan |

## Scope

**In scope:**
- New SQL migration (`20260529000000_submissions_constraints_hardening.sql`) with content trim CHECK, signature length CHECK, DROP redundant index, TRUNCATE smoke rows.
- `supabase/seed.sql` rewrite to deterministic UUIDs + staggered timestamps + multi-row INSERT.
- `src/lib/submissions/taxonomies.ts` extension: `ENRICHMENT_STATUSES` const + 5 type-guard helpers + trimmed header.
- `scripts/gen-types.mjs` new file; `package.json` script wired; supabase CLI bumped to 2.101.0; types regenerated.
- `src/env.d.ts` extension; `src/middleware.ts` sets `locals.supabase`; 3 auth route handlers (signin/signout/signup) refactored to read locals; signout returns explicit error on null parity with signin.
- `context/changes/submissions-data-model/change.md` trimmed; `context/foundation/lessons.md` bootstrapped (Phase 1) + extended (Phase 6) to 4 entries total.

**Out of scope:**
- No test runner (vitest/playwright) introduction.
- No pg ENUM migration for taxonomy columns.
- No partial-index schema rewrite (gotcha documented via lessons).
- No removal of redundant GRANT USAGE line from the original migration (history kept).
- No `.gitattributes` for project-wide CRLF baseline (separate change).

## Architecture / Approach

Six phases, ordered by risk. Each phase is independently verifiable + commit-rituated (per `/10x-implement`). Schema first (forward-only, deterministic), seed second (local-only impact), taxonomy + types third (additive, no consumer impact), build tooling fourth (atomic; script can be rolled back trivially), auth wrapper fifth (most invasive — gated last so all earlier work is committed before the auth surface mutates), doc cleanup sixth (closeout + lessons capture). The auth refit replaces 4 per-request supabase client constructions with 1, via the Astro-canonical `context.locals` pattern.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema hardening | New migration; lessons.md bootstrap | Cloud TRUNCATE: verify state before push |
| 2. Seed determinism | Stable UUIDs + staggered timestamps | None — local-only impact |
| 3. TS taxonomy + guards | ENRICHMENT_STATUSES + 5 type guards + trimmed header | None — additive |
| 4. Tooling + CLI bump + regen | scripts/gen-types.mjs + supabase 2.101 | CLI release-notes may produce unrelated type-file diff |
| 5. Auth wrapper refit | Shared client via locals + signout parity | Auth path break — needs browser smoke testing |
| 6. Doc cleanup + lessons | Trimmed change.md + 4 lessons | None — text-only |

**Prerequisites:** local Supabase stack running (`supabase start`); cloud project linked (`ovwgoqhqbbgfodivwmwk`); user has `supabase db push` access to land Phase 1 on cloud; browser available for Phase 5 manual smoke.

**Estimated effort:** ~2-3 sessions across 6 phases. Phases 1-3 in one session, 4-5 in a second, 6 in either. Phase 5 requires concentrated focus (auth path); don't bundle it with others.

## Open Risks & Assumptions

- **Cloud state assumption**: Plan assumes cloud `public.submissions` has only the 2 smoke-test rows from p1 verification. If anyone manually inserted data between p1 epilogue (commit `7ea069e`) and Phase 1's cloud push, TRUNCATE will wipe it. Mitigation: pre-push verify count via Studio SQL.
- **CLI bump diff noise**: Bumping supabase CLI 2.98 → 2.101 may produce unrelated changes in the regenerated `database.types.ts`. Mitigation: human review of the Phase 4 diff before commit.
- **Auth refit breakage**: Phase 5 changes 5 files atomically — env.d.ts, middleware, 3 routes. Browser smoke is mandatory; `astro check` won't catch cookie round-trip regressions.
- **Lessons.md timing**: Phase 1 bootstraps lessons.md; Phase 6 extends it. If anything else (e.g. `/10x-lesson` invocations between phases) writes to it, ordering must remain stable. Mitigation: Phase 1 sets the canonical entries first; Phase 6 only appends.

## Success Criteria (Summary)

- Whitespace-only content INSERT fails with CHECK violation; oversized signature INSERT fails with CHECK violation; redundant index gone.
- `npm run db:reset` produces deterministic state byte-for-byte across consecutive runs.
- `npm run db:gen-types` runs atomically (CLI failure leaves committed file untouched); `@generated` header always present.
- `context.locals.supabase` is the single client per request; signin / signout / signup all read from locals; browser sign-in/sign-up/sign-out cycle works end-to-end.
- `context/foundation/lessons.md` carries 4 entries for future planning/review.
