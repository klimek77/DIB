---
date: 2026-06-05T15:12:06+02:00
researcher: klimek77
git_commit: 5e974c20e8096ddc99006a906811a4ce327746c5
branch: main
repository: DIB
topic: "S-01 first-end-to-end-submission — codebase readiness & risk verification"
tags: [research, codebase, s-01, submissions, enrichment-queue, magic-link-auth, rls]
status: complete
last_updated: 2026-06-05
last_updated_by: klimek77
---

# Research: S-01 `first-end-to-end-submission` — codebase readiness & risk verification

**Date**: 2026-06-05T15:12:06+02:00
**Researcher**: klimek77
**Git Commit**: `5e974c20e8096ddc99006a906811a4ce327746c5`
**Branch**: main
**Repository**: DIB (digital idea box)

## Research Question

For the north-star slice **S-01 `first-end-to-end-submission`** (anonymous employee submission → async AI enrichment → admin detail view), verify the named S-01 risks against the **current** code and map every integration seam so `/10x-plan` can plan the largest, riskiest slice without re-discovery. Hard-verify three risks: (1) the `@supabase/ssr` magic-link **Set-Cookie** quirk on Workers, (2) the **`<1s` fire-and-forget enqueue** path, (3) the **data layer** (department migration + RLS + enriched-only visibility). Frontend is a lighter **gap inventory** (a dedicated design plugin owns build).

## Summary

**S-01 is ~20% built and the three foundations it sits on (F-01/F-02/F-03) are genuinely done and verified.** The plumbing is in place; S-01 is mostly *new user-facing surface* + *one migration* + *one piece of route→runtime wiring*.

Risk verdicts up front:

| Hard-verified risk | Verdict | One-line evidence |
| --- | --- | --- |
| Magic-link **Set-Cookie on Workers** | ✅ **MITIGATED** (verified live) | F-02 confirmed the cookie round-trip on Cloudflare preview `33defad5` (`impl-review.md:21`, `plan.md:382`). No re-verify needed unless S-01 changes the cookie/callback path. |
| **`<1s` fire-and-forget enqueue** | ✅ **READY** (one wiring gap) | Producer helper `enqueueEnrichment(env, id)` already exists; `QUEUE.send({submissionId})` is a cheap queue write, never awaits AI. **Gap:** `App.Locals.runtime` is not yet typed/exposed to API routes. |
| **Data: dept migration + RLS + visibility** | ⚠️ **MIGRATION NEEDED + 1 open risk** | `department` is still `NOT NULL` (drop needed, roadmap confirmed). Admin-read RLS is still `USING (true)` — tightening landed in **app layer**, not RLS (no DB defense-in-depth). |

**The three plan-shaping findings the agents surfaced that are NOT in the roadmap:**

1. **Anon insert cannot read back the new row's `id`** — so it cannot enqueue. The anon role has an INSERT column-grant (5 cols) but **no SELECT** and `id` is not in the grant. The submission endpoint must insert with the **service-role admin client** (already exists at `src/lib/enrichment/supabase-admin.ts`) to obtain `id`, then enqueue. This is the single biggest architectural decision in S-01.
2. **Employee `topic` (4 values) ≠ AI `classification` (5 values)** — the shipped schema deliberately split these (`taxonomies.ts:50-53`), but the **PRD/roadmap text is stale**: FR-003 and FR-011 still describe the employee "tematyka" as the 5 values that actually live in `CLASSIFICATIONS`. S-01's form dropdown must use the shipped 4-value `TOPICS`.
3. **The admin detail route must live under a protected path** — middleware only guards `/dashboard` (`middleware.ts:5`). Agent-proposed `/admin/submissions/[id]` would be **unguarded** unless `/admin` is added to `PROTECTED_ROUTES`.

## Risks-to-verify — detailed scorecard

### Risk 1 — Magic-link Set-Cookie on Workers + `@supabase/ssr` → ✅ MITIGATED

- The full flow is **complete**: request (`signInWithOtp`) → both-shape callback (`exchangeCodeForSession` for `?code=`, `verifyOtp` for `token_hash`) → server cookie write via the `@supabase/ssr` `getAll`/`setAll` adapter → redirect to `/dashboard`.
- The cookie write goes through `Astro.cookies.set(name, value, options)` in the adapter `setAll` (`src/lib/supabase.ts:21`). **Cookie attributes are not pinned in project code** — it trusts `@supabase/ssr` defaults. The infra risk register prescribed pinning `SameSite`/`Secure`/`Path` (`infrastructure.md:85`); that was not literally implemented, but the defaults proved adequate.
- **Verified end-to-end on real Workers**: F-02 closed manual check 2.9 ("Workers cookie round-trip") on Cloudflare preview deploy `33defad5` / commit `75ceb45` (`context/archive/2026-06-01-auth-refit-magic-link/plan.md:382`, `reviews/impl-review.md:21`). This is the strongest signal short of re-running it.
- **S-01 action**: reuse, don't rebuild. Re-verify only if S-01 introduces a browser client, changes the callback, or pins cookie attributes. If S-01 ships a fresh preview, a 30-second login round-trip is cheap insurance (this is the class of bug that passes locally and fails in prod).

### Risk 2 — `<1s` fire-and-forget enqueue → ✅ READY (one wiring gap)

- **Producer binding**: `QUEUE` → queue `dib-enrichment` (`wrangler.jsonc:25`). Typed globally as `Queue<EnrichmentMessage>` in `src/worker-env.d.ts:18`.
- **Producer helper already written for S-01**: `src/lib/enrichment/enqueue.ts` → `enqueueEnrichment(env, submissionId)`, whose header literally says *"S-01 (the employee form POST) calls this after inserting a `pending` row."*
- **Message shape**: `{ submissionId: string }` only — never the full row (`src/lib/enrichment/types.ts:6-8`). The consumer re-reads fresh row state from the id.
- **Why it stays under 1s**: `QUEUE.send()` is a queue write only — it does **not** run the consumer, call OpenAI (the 30s call at `openai.ts:14`), or touch `ai_*` columns. The response is bounded by the row INSERT + the send, both sub-second. **Do not `await enrich()` in the route.** Optional hardening: `ctx.waitUntil(env.QUEUE.send(...))` so the response returns even before the send resolves.
- **THE WIRING GAP (S-01's first task)**: no API route reads `locals.runtime.env` yet. `src/env.d.ts` types only `App.Locals.user` — there is **no `runtime: Runtime<Env>`** on `App.Locals`. S-01 must add it (the `Env` type already exists in `src/worker-env.d.ts`). Standard adapter access pattern: `const env = context.locals.runtime.env; await env.QUEUE.send({ submissionId })`.
- **Local-dev gotcha (lessons.md:54-59)**: local Queues are NOT shared across Miniflare instances. Test the full path by enqueuing from **inside** the Worker under `wrangler dev` (a temporary `GET /__dev/enqueue?id=…` reverted before commit), and **`npm run build` before `wrangler dev`** (the custom `worker.ts` does not hot-reload). `astro dev` does not run queue consumers at all.

### Risk 3 — Data: department migration + RLS + enriched-only visibility → ⚠️ MIGRATION NEEDED + open RLS risk

- **Migration is genuinely still needed**: `department text NOT NULL` (`migrations/20260528000000_create_submissions.sql:37`). No migration drops it (grep for `DROP NOT NULL` = zero hits). `branch` is already `NOT NULL` (satisfies "oddział required"). S-01 must run `ALTER TABLE public.submissions ALTER COLUMN department DROP NOT NULL;` and then **regenerate `database.types.ts`** (`npm run db:gen-types`) so the Insert type's `department: string` becomes `department?: string | null` — currently it lies (`database.types.ts:42`).
- **RLS — admin-read tightening did NOT land in the DB layer (open risk)**: only two policies exist, both from F-01. `submissions_authenticated_select USING (true)` (`...create_submissions.sql:123-127`) still lets **any** authenticated user SELECT all rows. The allow-list gate landed in **application code** — `src/lib/auth/allowlist.ts:25-27` + `src/middleware.ts:22-26`. So the admin-read protection is **route-guard-only**; there is no defense-in-depth at RLS. Acceptable *only while* the invariant "only allow-listed admins ever hold a Supabase session" holds. This is exactly the lessons.md pattern *"a deferred permissive gate is live exposure"* — S-01 ships the first real read surface (detail view), so the plan must make this trade-off explicit (accept route-guard-only, or add an allow-list RLS policy).
- **Anon insert path (verified)**: `submissions_anon_insert WITH CHECK (true)` (`:112-116`) AND-ed with a narrow column GRANT `INSERT (department, branch, topic, content, signature)` (`:135`); `REVOKE ALL ... FROM anon, authenticated` (`:133`) wipes Supabase's table-wide auto-grant. So anon may insert only those 5 columns — it cannot set `id`, `enrichment_status`, or any `ai_*` field.
- **Enriched-only visibility (FR-008)**: `enrichment_status` is `text NOT NULL DEFAULT 'pending'`, CHECK in `('pending','processing','done','failed')` (`:47`, `:74-75`). Two partial indexes serve the dashboard's done-only reads: `submissions_topic_done_idx (topic) WHERE enrichment_status = 'done'` (`:93-95`) and `submissions_branch_done_idx (branch) WHERE enrichment_status = 'done'` (`:98-100`). **lessons.md:33-38**: a partial index is only used when the query WHERE *syntactically* matches its predicate — use `.eq('enrichment_status','done')`, **never** `.in(['done'])`. (Mostly an S-02 concern, but S-01's detail view should also read the row by `id` and may want the done-state semantics.)

## Detailed Findings

### Area 1 — Submissions data model (F-01, live)

- **Table**: 15 columns. Required non-null user/system cols: `id` (uuid, default `gen_random_uuid()`), `created_at` (timestamptz, default `now()`), `department`, `branch`, `topic`, `content`, `enrichment_status` (default `'pending'`), `enrichment_attempts` (default 0). Nullable: `signature`, `enrichment_last_error`, `enrichment_attempted_at`, `ai_title`, `ai_tone`, `ai_classification`, `ai_summary` (`...create_submissions.sql:32-78`).
- **CHECKs**: `department` ∈ 11-value list; `branch` ∈ 9-value list; `topic` ∈ `('Pomysł','Problem','Usprawnienie','Inne')`; `enrichment_status` ∈ 4-value list; `ai_tone IS NULL OR ∈ ('Pozytywny','Negatywny','Neutralny')`. Content length CHECK hardened to `char_length(btrim(content)) BETWEEN 1 AND 800` and a `signature` CHECK `… BETWEEN 1 AND 200` added in `migrations/20260529000000_submissions_constraints_hardening.sql:25-37`.
- **`ai_classification` has NO CHECK** — it is app-enforced only (`CLASSIFICATIONS` in `taxonomies.ts:54`).
- **Indexes (4)**: `created_at_desc` (full), composite `(enrichment_status, created_at DESC)` (full), plus the two partials above. The standalone `created_at` index is intentionally retained alongside the composite (a composite does not serve a bare `ORDER BY created_at DESC` — lessons.md:26-31).
- **taxonomies SSOT** (`src/lib/submissions/taxonomies.ts`): `DEPARTMENTS` (11), `BRANCHES` (9), `TOPICS` (4), `TONES` (3), `ENRICHMENT_STATUSES` (4) all mirror the CHECKs character-for-character (diacritic drift silently breaks INSERTs — header `:1-16`); `CLASSIFICATIONS` (5) is app-only. **"Change-in-same-commit" rule** binds this file to any future migration.
- **Generated types** (`src/lib/database.types.ts`): `Insert` requires `branch`, `content`, `department`, `topic`; CHECK columns typed as plain `string` (gen-types limitation — narrow via the `taxonomies.ts` `as const` aliases, not the Row types).

### Area 2 — Async AI enrichment plumbing (F-03, live)

- **wrangler queues** (`wrangler.jsonc:24-39`): producer `{queue: "dib-enrichment", binding: "QUEUE"}`; consumer `dib-enrichment` (`max_batch_size:1`, `max_retries:5`, DLQ `dib-enrichment-dlq`); DLQ consumer `dib-enrichment-dlq` (`max_retries:3`, **no DLQ-of-its-own → terminal**). `max_retries`+DLQ is the sole retry-exhaustion authority (no app-level attempts cap).
- **Worker entry** `src/worker.ts`: default export `satisfies ExportedHandler<Env, EnrichmentMessage>` with `fetch` (delegates to `@astrojs/cloudflare/handler`) + `queue` (routes by `batch.queue`: main → `processEnrichmentMessage`, DLQ → `processDeadLetterMessage`). Consumer ctx built with a service-role Supabase store + `env.OPENAI_API_KEY` (`worker.ts:25`).
- **Consumer state machine** (`src/lib/enrichment/consumer.ts`): CAS claim `pending→processing` guarded on a per-claim `enrichment_attempted_at` token (`:239-252`); `markDone` writes `ai_tone/ai_classification/ai_title/ai_summary` + `done`, guarded on the token (`:254-269`); `resetToPending` reverts before retry (lessons.md:47); `markFailed` PII-redacts `enrichment_last_error` (feeds S-03 alert). Transient → `message.retry()` with backoff `10*2^(n-1)` capped 300s; permanent → `markFailed` + `emitFailureSignal`.
- **AI** (`src/lib/enrichment/openai.ts`): `gpt-4o-mini`, raw `fetch` Chat Completions, Structured Outputs `strict:true`. `ENRICHMENT_JSON_SCHEMA` requires `tone` (enum `TONES`), `classification` (enum `CLASSIFICATIONS`), `title`, `summary` (`:20-30`). **Only `content` is sent to OpenAI — never `signature`** (anonymity guardrail; `enrich.ts:31-32`).
- **S-01's role**: insert the row (`enrichment_status` defaults to `'pending'`), then `enqueueEnrichment(env, id)`. S-01 **does not** touch any `ai_*`/`enrichment_*` column — the consumer owns them.

### Area 3 — Admin auth (F-02, live)

- **Single server client** `src/lib/supabase.ts:7-26` (`createServerClient` + `getAll`/`setAll` adapter). **No browser client** — auth is fully server-side (correct for PKCE magic-link).
- **Routes**: `POST /api/auth/signin` (`signInWithOtp`, `emailRedirectTo = ${origin}/auth/callback`, request-time allow-list, neutral redirect to `/auth/check-email` — no enumeration); `GET /auth/callback` (handles `?code=` via `exchangeCodeForSession` and `token_hash`+`type` via `verifyOtp`, narrows `type` to a literal union); `POST /api/auth/signout`. **Old password `signin`/`signup` removed** (verified: `signup.ts` deleted, `signInWithPassword`/`signUp` absent from `src/`).
- **Middleware** `src/middleware.ts`: `PROTECTED_ROUTES = ["/dashboard"]` (`:5`); `supabase.auth.getUser()` populates `context.locals.user`; allow-list enforced at `:22-25`.
- **Allow-list**: env var `ALLOWED_ADMIN_EMAILS` (comma-separated, declared `astro.config.mjs:21`), parsed once in `src/lib/auth/allowlist.ts:12-27` (**fail-closed**), enforced at three points (signin / callback / middleware) through one helper.
- **Pages**: `src/pages/auth/signin.astro` (renders `SignInForm`), `auth/check-email.astro`, `src/pages/dashboard.astro` (**stub** — reads `locals.user`, signout form, no submission logic). Post-login redirect → `/dashboard`.

### Area 4 — Frontend / API surface gap (lighter — design plugin owns build)

EXISTS vs MISSING for the six S-01 surfaces:

| Surface | Status | Path |
| --- | --- | --- |
| Welcome / intro screen | partial (scaffold) | `src/pages/index.astro` + `src/components/Welcome.astro` — generic starter copy; needs DIB reframing + "dalej" CTA into the form |
| Employee submission form | **MISSING** | needs `src/pages/submit.astro` + `src/components/submissions/SubmissionForm.tsx` (React island) |
| Live char counter (≤800) | **MISSING** | needs `src/components/submissions/CharCounter.tsx` (or inline in the form) |
| "Thank you" confirmation | **MISSING** | needs `src/pages/submit-success.astro` |
| Submission POST endpoint | **MISSING** | needs `src/pages/api/submissions.ts` |
| Admin detail view | **MISSING** | needs a `[id]` page under a **protected** path (see decision C) |

- **Reusable building blocks (EXISTS)**: `src/components/auth/FormField.tsx`, `SubmitButton.tsx` (`useFormStatus`), `ServerError.tsx`, `src/components/ui/button.tsx` (CVA). Canonical patterns to copy: Astro-page-+-island `src/pages/auth/signin.astro`; POST route `src/pages/api/auth/signin.ts`; React form `src/components/auth/SignInForm.tsx`.
- **Design system**: Tailwind 4 via `src/styles/global.css` (oklch tokens, `bg-cosmic` gradient, dark mode). No component library — hand-authored. PascalCase for components.
- Endpoint naming convention to honor: `/api/submissions` (POST).

## Plan-shaping decisions S-01 must make

- **(A) Insert→id→enqueue under RLS — RECOMMEND service-role insert.** Anon cannot read back `id` (no SELECT; `id` not in the column grant), so it cannot enqueue. The submission endpoint should insert with the existing **service-role admin client** (`src/lib/enrichment/supabase-admin.ts`), which bypasses RLS and returns `id`, then call `enqueueEnrichment(env, id)`. **Caveat:** service-role bypasses the column grant's protection, so the endpoint MUST server-side whitelist the insert payload to exactly `{department?, branch, topic, content, signature?}` + `enrichment_status:'pending'` — never trust a client-supplied `ai_*`/`enrichment_*`/`id`. Also honor the anonymity NFR: do not log/store IP, headers, or any client identifier. (Alternative: keep anon insert + add `id` to the column grant and pre-generate the UUID server-side — more moving parts, still needs a way to confirm; service-role is simpler.)
- **(B) Topic taxonomy — use the shipped 4-value `TOPICS`, flag PRD drift.** The form's "tematyka" dropdown = `TOPICS = ('Pomysł','Problem','Usprawnienie','Inne')`. The PRD's 5-value "tematyka" (FR-003) and FR-011's pie chart actually map to `CLASSIFICATIONS` (AI output). The codebase resolved this deliberately (`taxonomies.ts:50-53`); the PRD text was never updated. Decide: accept shipped taxonomy as authoritative (recommended — it's already DB-enforced and consumed by F-03) and note the PRD as stale, or migrate the `topic` CHECK. Do **not** silently conflate them.
- **(C) Admin detail route must be protected.** Put the detail page under `/dashboard/...` (already in `PROTECTED_ROUTES`) OR add `/admin` to `middleware.ts:5`. An `/admin/submissions/[id]` page without that edit is publicly reachable.
- **(D) RLS defense-in-depth.** Admin SELECT is still `USING (true)`. S-01 ships the first read surface — either accept route-guard-only protection (document the invariant "only allow-listed admins authenticate") or add an allow-list RLS policy now. lessons.md flags deferred permissive gates as live exposure.
- **(E) Wire `App.Locals.runtime`.** Add `runtime: Runtime<Env>` to `App.Locals` in `src/env.d.ts` (Env already in `src/worker-env.d.ts`) so the POST route can reach `locals.runtime.env.QUEUE`. Verify `platformProxy` for local `astro dev`, but rely on `wrangler dev` for the queue path.

## Code References

(Permalinks pinned to `5e974c2`.)

- [`supabase/migrations/20260528000000_create_submissions.sql:32-100`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/supabase/migrations/20260528000000_create_submissions.sql#L32-L100) — table, CHECKs, indexes
- [`…20260528000000_create_submissions.sql:112-135`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/supabase/migrations/20260528000000_create_submissions.sql#L112-L135) — RLS policies + REVOKE + anon column GRANT (the `USING (true)` admin SELECT + the `id`-less insert grant)
- [`supabase/migrations/20260529000000_submissions_constraints_hardening.sql:25-37`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/supabase/migrations/20260529000000_submissions_constraints_hardening.sql#L25-L37) — content/signature length CHECKs
- [`src/lib/submissions/taxonomies.ts:44-54`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/lib/submissions/taxonomies.ts#L44-L54) — `TOPICS` vs `CLASSIFICATIONS` (decision B)
- [`src/lib/database.types.ts:34-50`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/lib/database.types.ts#L34-L50) — Insert type (`department` required → regenerate after migration)
- [`src/lib/enrichment/enqueue.ts`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/lib/enrichment/enqueue.ts) — `enqueueEnrichment(env, submissionId)` (the exact call S-01 makes)
- [`src/lib/enrichment/types.ts:6-8`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/lib/enrichment/types.ts#L6-L8) — `EnrichmentMessage = { submissionId }`
- [`wrangler.jsonc:24-39`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/wrangler.jsonc#L24-L39) — queue producer/consumer/DLQ bindings
- [`src/worker-env.d.ts:16-27`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/worker-env.d.ts#L16-L27) — `Env` (has `QUEUE`, secrets); not yet on `App.Locals`
- [`src/env.d.ts`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/env.d.ts) — `App.Locals` (only `user` — add `runtime`, decision E)
- [`src/lib/enrichment/consumer.ts:239-295`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/lib/enrichment/consumer.ts#L239-L295) — CAS claim / markDone / resetToPending / markFailed
- [`src/lib/enrichment/openai.ts:20-36`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/lib/enrichment/openai.ts#L20-L36) — Structured-Output schema + prompt
- [`src/lib/enrichment/supabase-admin.ts`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/lib/enrichment/supabase-admin.ts) — service-role client (use for the insert, decision A)
- [`src/lib/supabase.ts:7-26`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/lib/supabase.ts#L7-L26) — SSR client + cookie adapter (Set-Cookie path)
- [`src/middleware.ts:5-26`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/middleware.ts#L5-L26) — route guard + `PROTECTED_ROUTES` (decision C)
- [`src/lib/auth/allowlist.ts:12-27`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/lib/auth/allowlist.ts#L12-L27) — `isAllowedAdmin` (where admin-read tightening actually lives)
- [`src/pages/api/auth/signin.ts`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/pages/api/auth/signin.ts) — canonical POST-route pattern to copy
- [`src/components/auth/SignInForm.tsx`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/components/auth/SignInForm.tsx), [`FormField.tsx`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/components/auth/FormField.tsx) — canonical React form pattern
- [`src/pages/dashboard.astro`](https://github.com/klimek77/DIB/blob/5e974c20e8096ddc99006a906811a4ce327746c5/src/pages/dashboard.astro) — stub admin page

## Architecture Insights

- **id is the contract; the row is the truth.** F-03 was built so the producer only emits `{submissionId}` and the consumer re-reads fresh state. This is why the insert must surface `id` (decision A) and why S-01 never sends content/signature on the queue (anonymity + freshness).
- **Security was deliberately layered app-side, not in RLS.** Both the admin-read gate (allow-list) and the column-protection-on-insert (column grant) are real, but the *read* gate is route-only. The system's safety rests on the invariant "only allow-listed admins authenticate." S-01 is the first slice to lean on it for a real read.
- **Taxonomy is a load-bearing, diacritic-sensitive contract** split across migration CHECK ↔ `taxonomies.ts` ↔ OpenAI schema. The `topic`/`classification` split (decision B) is intentional; treat `taxonomies.ts` as SSOT and keep migrations in the same commit.
- **The `<1s` NFR is a code-discipline rule, not an infra problem** — the async split already exists. The only way S-01 violates it is by awaiting AI in the route. Don't.

## Historical Context (from prior changes)

- `context/archive/2026-05-28-submissions-data-model/` (F-01) — table, RLS, indexes, types; deliberately deferred the admin-SELECT tightening to F-02's layer.
- `context/archive/2026-05-29-submissions-data-model-hardening/` — content/signature length CHECKs; the "don't harden a not-yet-written consumer" and composite-index lessons originate here.
- `context/archive/2026-06-01-auth-refit-magic-link/` (F-02) — magic-link refit; **Set-Cookie round-trip verified on preview `33defad5`** (`plan.md:382`, `reviews/impl-review.md:21`); old password endpoints removed.
- `context/archive/2026-06-02-ai-enrichment-queue/` (F-03) — queue + consumer; lessons.md:47-73 (reset-before-retry, guard the failure signal, terminal-queue outage) all originate here.
- `context/deployment/deploy-plan.md` — note its "verification status" (2026-05-27) predates the magic-link refit and describes the OLD signup flow; do not treat it as auth ground truth.

## Lessons that apply to S-01 (from `context/foundation/lessons.md`)

- **Partial-index predicate match** (`:33-38`) — done-only reads use `.eq('enrichment_status','done')`, not `.in([...])`.
- **Deferred permissive gate = live exposure** (`:12-17`) — S-01 ships the read surface that makes the `USING (true)` policy load-bearing (decision D).
- **Composite index ordering** (`:26-31`) — relevant to S-02; the standalone `created_at` index is not redundant.
- **Local queue testing** (`:54-59`) — enqueue from inside the Worker; rebuild before `wrangler dev`.

## Open Questions

1. **Insert path (decision A)** — confirm service-role insert + payload whitelist is acceptable, vs. extending the anon grant. *Recommend service-role; plan must decide.*
2. **Topic taxonomy (decision B)** — accept shipped 4-value `TOPICS` as authoritative (recommended) and mark PRD FR-003/FR-011 as stale, or migrate `topic` to the PRD's 5 values? Owner: user/PRD.
3. **RLS defense-in-depth (decision D)** — add an allow-list SELECT policy in S-01, or accept route-guard-only and document the invariant? Owner: plan.
4. **FR-015 network gate** — F-04 is `blocked` (corporate CIDR pending from IT). S-01 dev/verify runs fine on public `workers.dev`, but the *pilot* cannot open until F-04 lands. Not an S-01 blocker; a pilot-gate dependency.
5. **Content limit 800** — PRD Open Question #1 still open (default 800, already in the CHECK). Non-blocking.

## Next step

S-01 is ready for **`/10x-plan first-end-to-end-submission`**. Carry these into the plan as the cost × signal brief:
- One migration (`department DROP NOT NULL`) + types regen.
- Decision A (service-role insert + whitelist) is the highest-leverage design call.
- New surface: `submit.astro`, `SubmissionForm.tsx` (+ char counter), `submit-success.astro`, `api/submissions.ts`, protected `[id]` detail page — reuse `FormField`/`SubmitButton`/`SignInForm` patterns; design/build via the dedicated frontend plugin.
- Wire `App.Locals.runtime` (decision E); keep the route fire-and-forget (`<1s`).
- Auth is done — reuse, don't rebuild; re-verify Set-Cookie only if the cookie path changes.
