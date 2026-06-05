# S-01 `first-end-to-end-submission` Implementation Plan

## Overview

Close the north-star loop: an anonymous employee on the corporate network opens a link, reads a welcome screen, fills a short form (oddział required, dział optional, tematyka, treść ≤800, optional podpis), and sees "dziękujemy" in `<1s`. Behind the response the row lands `pending` and a fire-and-forget job is enqueued; the already-shipped F-03 consumer enriches it (ton + klasyfikacja + summary). An allow-listed admin logs in via the existing magic-link flow and reads that one submission in a read-only detail view, with the AI fields labelled "AI-generated, może być stronnicze".

This is the roadmap's largest and highest-leverage slice, but ~80% of the machinery already exists (F-01 schema, F-02 auth, F-03 queue+consumer, all verified). S-01 adds: **one migration**, the **route→runtime wiring + submission endpoint**, and the **UI surfaces** (visual build delegated to the `frontend-design` plugin using `design/`).

## Current State Analysis

From `context/changes/first-end-to-end-submission/research.md` (codebase grounding, commit `5e974c2`):

- **F-01 schema (live)** — `public.submissions` (15 cols). `branch NOT NULL` (oddział required ✓); `department text NOT NULL` (dział — **needs `DROP NOT NULL`**); `topic` CHECK ∈ 4-value `('Pomysł','Problem','Usprawnienie','Inne')`; content length CHECK `BETWEEN 1 AND 800`; signature CHECK `BETWEEN 1 AND 200`; `enrichment_status` default `'pending'`. Anon role: `INSERT (department, branch, topic, content, signature)` column-grant, **no SELECT**, `REVOKE ALL` wipes the table-wide auto-grant.
- **F-02 auth (live, verified)** — server-only `@supabase/ssr` client (`src/lib/supabase.ts`), magic-link request/callback/signout, allow-list (`ALLOWED_ADMIN_EMAILS` → `src/lib/auth/allowlist.ts`, fail-closed, enforced at signin/callback/middleware). Set-Cookie round-trip verified live on Workers preview `33defad5`. Middleware guards only `/dashboard` (`PROTECTED_ROUTES = ["/dashboard"]`).
- **F-03 enrichment (live)** — producer helper `enqueueEnrichment(env, submissionId)` (`src/lib/enrichment/enqueue.ts`); message shape `{ submissionId }` only; consumer re-reads fresh row state, CAS-claims `pending→processing`, writes `ai_*`+`done`, retries via queue `max_retries`+DLQ; only `content` is ever sent to OpenAI (anonymity guardrail). `Env` (with `QUEUE`) typed in `src/worker-env.d.ts`.
- **The wiring gap** — no API route reads `locals.runtime.env`; `App.Locals` in `src/env.d.ts` types only `user`. S-01 must add `runtime: Runtime<Env>`.
- **The insert problem** — anon cannot read back `id` (no SELECT, `id` not in grant), so it cannot enqueue. Decision A (confirmed): insert via the existing **service-role admin client** (`src/lib/enrichment/supabase-admin.ts`) to obtain `id`, then enqueue — with a strict server-side payload whitelist.
- **Taxonomy** — shipped `TOPICS` (4) is DB-enforced and consumed by F-03; the PRD's 5-value "tematyka" (FR-003/FR-011) actually maps to AI `CLASSIFICATIONS`. Decision B (confirmed): use shipped `TOPICS`, flag the PRD as stale.
- **Stack/tests** — Astro + React islands + Tailwind 4 + Cloudflare adapter + Supabase. `npm run test` (vitest), `npm run typecheck` (astro check), `npm run lint` (eslint), `npm run db:gen-types`, `npm run db:reset`. Test pattern: colocated `*.test.ts` (see `src/lib/enrichment/*.test.ts`). No e2e/Playwright yet (later lessons).
- **Design reference** — `design/design.md` + 8 PNGs. Built for Next.js + Tailwind 3.4; a visual reference to adapt to Astro + TW4. Form mockups (`form-01..04`) = 3-step wizard, dark/DM Sans/emerald. Dashboard mockups = **S-02** (out of scope). **No mockup exists for the admin detail view** — it inherits the light/Lato/sewera-blue dashboard aesthetic (design §4.2/§5).

## Desired End State

- A migration has dropped `department NOT NULL` and replaced the permissive `submissions_authenticated_select USING (true)` with an allow-list-gated SELECT policy; `database.types.ts` reflects both.
- `POST /api/submissions` accepts a whitelisted body, inserts a `pending` row via the service-role client, enqueues `{ submissionId }`, and returns success in `<1s` — never awaiting AI, never persisting/logging any client identifier.
- A public welcome → 3-step form → success flow exists and is visually built from `design/`.
- An allow-listed admin can open `/dashboard/submissions/[id]` and read the full submission + AI enrichment (with disclaimer) + meta, across all four enrichment states; the read goes through the RLS-gated SSR client.

**Verification:** the full round-trip (submit → `pending` → consumer → `done` → admin detail) works on a `wrangler dev` / Workers preview run; unit tests guard the payload whitelist and validation; a non-allow-listed authenticated email cannot read submission rows.

### Key Discoveries

- `enqueueEnrichment(env, submissionId)` already exists and is cheap — the route's only job is insert→id→enqueue (`research.md` Area 2; `src/lib/enrichment/enqueue.ts`).
- Service-role insert is the simplest path to `id` under the no-SELECT anon grant, but it **bypasses the column-grant**, so the endpoint must whitelist the payload itself (`research.md` decision A).
- Choosing the RLS allow-list policy (decision D) means the detail view can read via the **authenticated SSR client** (RLS now permits allow-listed admins) instead of service-role — cleaner and it exercises the new policy.
- Taxonomy is a diacritic-exact contract across migration CHECK ↔ `taxonomies.ts` ↔ OpenAI schema — the form must use `TOPICS`/`BRANCHES`/`DEPARTMENTS` verbatim (`research.md` Area 1; `lessons.md`).
- Local Queues are not shared across Miniflare instances — the queue path is verified by enqueuing from inside the Worker under `wrangler dev`, after `npm run build` (`lessons.md:54-59`).

## What We're NOT Doing

- **No admin dashboard / aggregates** (counter, pie, oddział breakdown, submission list) — that is **S-02**.
- **No notification / AI-failure alert** — that is **S-03** (the consumer already emits the failure signal).
- **No network gate (FR-015)** — F-04 is blocked on corporate CIDR from IT; S-01 dev/verify runs on public `workers.dev`. Pilot cannot open until F-04 lands, but it does not block S-01.
- **No changes to the F-03 consumer, OpenAI schema, or `ai_*`/`enrichment_*` columns** — S-01 only writes the insert defaults; the consumer owns enrichment.
- **No migration of `topic` to the PRD's 5 values** — shipped `TOPICS` is authoritative (decision B); PRD FR-003/FR-011 noted as stale.
- **No rebuild of auth** — reuse F-02; re-verify Set-Cookie only if the cookie/callback path changes (it does not here).
- **No e2e/Playwright/MCP, no hooks/CI YAML** — out of this lesson's scope; verification is unit + manual preview round-trip.
- **No rate-limiting / spam protection / captcha** on the public endpoint — not an S-01 risk; parked.

## Implementation Approach

Two backend phases land first (data, then endpoint+wiring) because the form and detail view depend on their contracts. Three UI phases follow: each **specifies its contract in this plan** (fields, props, POST shape, data shown, enrichment-state handling) and then **delegates the visual build to `frontend-design:frontend-design`**, which consumes `design/design.md` + the relevant PNG mockups and adapts the Tailwind 3.4 / Next recipes to our Astro + Tailwind 4 stack, reusing existing primitives (`FormField.tsx`, `SubmitButton.tsx`, `ServerError.tsx`, `ui/button.tsx`) and copying the `SignInForm.tsx` island pattern.

Per the project rule, **every phase touches ≤5 files**; the ~13-file slice splits into 5 phases.

## Critical Implementation Details

- **RLS allow-list without leaking the list.** A policy `USING` expression that references another table forces grants/RLS concerns on that table. Use a `SECURITY DEFINER`, `STABLE` function with a pinned `search_path` that checks the JWT email against the allow-list table, and make the policy `USING (public.is_allowed_admin())`. The function bypasses grants/RLS on the allow-list table for the check only. Beware: an **empty allow-list table locks out every admin** — seeding is mechanized by the idempotent `npm run db:seed-admins` script (Phase 1 change #3), which mirrors `ALLOWED_ADMIN_EMAILS` (the app-side SSOT) into the table. Run it right after the migration applies and on any deploy that changes the env var.

  ```sql
  create function public.is_allowed_admin() returns boolean
    language sql stable security definer set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.admin_allowlist
      where email = lower(auth.jwt() ->> 'email')
    );
  $$;
  ```

- **`<1s` is a code-discipline rule, not infra.** The route awaits the insert (needs `id`) and the `QUEUE.send` — both sub-second — and **never** awaits `enrich()`/OpenAI. Optional hardening: `ctx.waitUntil(env.QUEUE.send(...))` so the HTTP response can return before the send resolves.
- **Insert→enqueue ordering & orphan recovery.** The insert must precede the enqueue (the queue only carries `id`). Treat the two steps as separately-failing: an **insert** failure is a hard 500 (nothing saved); once the insert succeeds the submission is durable, so an **enqueue** failure must not surface as a 500 — return success and rely on recovery. F-03's retry/DLQ only covers messages that *reached* the queue, so an insert-succeeded-but-never-enqueued row is stuck `pending` with no job and is invisible to the consumer. Recovery path: a `pending`-rows sweep re-enqueues by `id` via `enqueueEnrichment(env, id)`. S-01 only needs to **document** this path (the sweep itself is an ops / S-02 concern) — per `lessons.md:68-73` ("document the stuck-intermediate-state → re-enqueue recovery path").
- **Anonymity guardrails.** The endpoint must not read/store/log IP, headers, cookies, or any client identifier. The payload whitelist must reject `id`, `enrichment_*`, and `ai_*`. `signature` is stored but is **never** put on the queue or sent to AI (the consumer already only sends `content`).
- **Local queue testing.** Run `npm run build` before `wrangler dev` (the custom `src/worker.ts` does not hot-reload); enqueue from **inside** the Worker (a temporary `GET /__dev/enqueue?id=…`, reverted before commit) — `astro dev` does not run queue consumers, and local Queues are not shared across Miniflare instances (`lessons.md:54-59`).
- **Taxonomy diacritic-exactness.** Form options come from `src/lib/submissions/taxonomies.ts` (`TOPICS`, `BRANCHES`, `DEPARTMENTS`) verbatim; a single diacritic drift silently breaks the INSERT against the CHECK.

---

## Phase 1: Data layer — department optional + allow-list admin RLS

### Overview

One migration makes `department` nullable, adds the admin allow-list table + `is_allowed_admin()` function, and replaces the permissive admin SELECT policy with an allow-list-gated one. Regenerate the typed schema.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/20260605000000_s01_department_optional_and_admin_allowlist_rls.sql`

**Intent**: Make `department` optional (dział is an optional field per roadmap Q6), and give the first real admin read surface DB-level defense-in-depth (decision D) instead of relying solely on the route guard.

**Contract**:
- `ALTER TABLE public.submissions ALTER COLUMN department DROP NOT NULL;`
- `CREATE TABLE public.admin_allowlist (email text PRIMARY KEY)` with values stored lower-cased; enable RLS on it with **no permissive policy** (only the definer function reads it).
- `CREATE FUNCTION public.is_allowed_admin()` — `SECURITY DEFINER`, `STABLE`, pinned `search_path` (snippet in Critical Implementation Details).
- `DROP POLICY submissions_authenticated_select` (the `USING (true)` one) and `CREATE POLICY` a replacement `FOR SELECT TO authenticated USING (public.is_allowed_admin())`.
- The anon INSERT policy + column grant from F-01 are untouched.

#### 2. Regenerated types

**File**: `src/lib/database.types.ts`

**Intent**: Reflect the now-nullable `department` and the new `admin_allowlist` table so the endpoint's types stop lying (Insert currently types `department: string`).

**Contract**: Output of `npm run db:gen-types` after the migration applies. `submissions` Insert `department` becomes `string | null` / optional; `admin_allowlist` row/insert types appear. No hand-edits.

#### 3. Admin allow-list seed script

**File**: `scripts/seed-admins.mjs` (+ a `db:seed-admins` entry in `package.json`)

**Intent**: Mechanize the env↔table sync so "migration applied" reliably leads to "admins seeded" — closing the empty-table-locks-out-all-admins footgun. `ALLOWED_ADMIN_EMAILS` stays the single source of truth.

**Contract**: A small idempotent script that parses `ALLOWED_ADMIN_EMAILS` (comma-separated, lower-cased) and upserts each address into `public.admin_allowlist` via the service-role client with `ON CONFLICT (email) DO NOTHING`. Safe to re-run; reads the same env var the app does. This is the canonical seeding step (replaces the prose "deploy step"). Does not delete rows — removal stays a manual decision.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npm run db:reset`
- Types regenerate with no diff beyond the migration: `npm run db:gen-types` (then confirm `department` optional in Insert)
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- A seeded allow-listed email (authenticated session) can `SELECT` a submission row; a non-seeded authenticated email gets **0 rows** (RLS verified).
- Anon insert of the 5 granted columns still succeeds (column grant unaffected).
- Running `npm run db:seed-admins` populates `admin_allowlist` to mirror `ALLOWED_ADMIN_EMAILS` (idempotent — safe to re-run); the table is non-empty and no admin is locked out.

**Implementation Note**: After automated verification passes, pause for manual confirmation (especially the RLS allow/deny check and that no admin is locked out) before proceeding.

---

## Phase 2: Backend — runtime wiring + submission endpoint

### Overview

Type `App.Locals.runtime`, extract a unit-testable payload validator/whitelist, and implement `POST /api/submissions` (service-role insert → `id` → fire-and-forget enqueue, `<1s`, anonymity-safe).

### Changes Required:

#### 1. Runtime typing

**File**: `src/env.d.ts`

**Intent**: Expose the Cloudflare runtime to API routes so the endpoint can reach `locals.runtime.env.QUEUE` (decision E).

**Contract**: Add `runtime: import("@astrojs/cloudflare").Runtime<Env>` to the `App.Locals` interface (`Env` already declared in `src/worker-env.d.ts`). No behavioural change elsewhere.

#### 2. Payload validator + whitelist

**File**: `src/lib/submissions/submission-input.ts`

**Intent**: One pure function that turns an untrusted request body into exactly the columns the row may receive, rejecting everything else — the security core of the slice.

**Contract**: Given a parsed body, return either a validation error or a clean object `{ department?, branch, topic, content, signature? }` (+ caller adds `enrichment_status: 'pending'`). Enforces: `branch ∈ BRANCHES`, `topic ∈ TOPICS`, `department` (if present) `∈ DEPARTMENTS`, `content` length 1–800 (trimmed), `signature` (if present) length 1–200. Strips/ignores any `id`, `enrichment_*`, `ai_*`, or unknown keys. Pure (no I/O), imports from `taxonomies.ts`.

#### 3. Unit test

**File**: `src/lib/submissions/submission-input.test.ts`

**Intent**: Lock the whitelist and validation against regression (vitest, colocated pattern).

**Contract**: Covers — rejects injected `ai_title`/`id`/`enrichment_status`/unknown keys; requires `branch`/`topic`/`content`; rejects out-of-taxonomy values and bad diacritics; enforces content ≤800 and signature ≤200; accepts a minimal valid body without `department`/`signature`.

#### 4. Submission endpoint

**File**: `src/pages/api/submissions.ts`

**Intent**: The public POST that closes the producer side of the loop.

**Contract**: `POST` handler — parse body → `submission-input` validate/whitelist → insert via the service-role client (`src/lib/enrichment/supabase-admin.ts`) selecting `id` back → `enqueueEnrichment(env, id)` (from `locals.runtime.env`) without awaiting AI → return a small success JSON (`{ ok: true }`) with `<1s` latency. On validation error return 400 with a neutral message. If the **insert** fails, return 500 (nothing was saved). If the insert succeeds but the **enqueue** fails, still return success — the row is durably saved as `pending` and will be reconciled by the un-enqueued-`pending` recovery path (see Critical Implementation Details); a 500 here would be misleading and could invite a duplicate resubmit. Never echo identifiers on any path. Reads no IP/headers; logs no client identifier. Follows the `src/pages/api/auth/signin.ts` route pattern.

#### 5. Endpoint route test

**File**: `src/pages/api/submissions.test.ts`

**Intent**: Cover the route's compose-logic — the part the validator unit test doesn't reach — so the anonymity and whitelist guarantees are regression-locked, not just eyeballed manually.

**Contract**: vitest with the service-role admin client and `QUEUE` mocked. Asserts: a body carrying `ai_*`/`id`/`enrichment_status` inserts defaults only (client values stripped); the caller sets `enrichment_status: 'pending'`; a valid POST returns the success shape and calls `enqueueEnrichment` exactly once with the inserted `id`, and never awaits AI; invalid bodies return 400 and insert nothing; an **insert** failure returns 500 while an **enqueue** failure still returns success (the F1 failure contract); and **no IP / header / cookie / identifier appears in any logged argument** (spy on the logger/`console`). Does not exercise the real queue — cross-process Miniflare testing stays manual.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm run test` (the `submission-input` + `submissions` route suites)
- Type checking passes (route compiles, `locals.runtime` typed): `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- After `npm run build` then `wrangler dev`: a valid `POST /api/submissions` returns success in `<1s` and inserts a `pending` row; a job reaches the queue and the consumer transitions the row to `done`.
- A POST carrying `ai_title` / `id` / `enrichment_status` results in a row with **defaults only** (client values stripped).
- No IP / header / cookie / identifier is persisted or logged for a submission (anonymity).
- An invalid body (missing `branch`, bad `topic`, content >800) returns 400 and inserts nothing.

**Implementation Note**: Pause for manual confirmation of the full `wrangler dev` round-trip and the anonymity/whitelist checks before proceeding.

---

## Phase 3: Frontend — welcome + public flow scaffolding

### Overview

The public page scaffolding: reframe the welcome screen (FR-002) with a CTA into the form, add the `/submit` page that hosts the form island, and the `/submit-success` thank-you page (FR-004). Visual build delegated to `frontend-design`.

### Changes Required:

#### 1. Welcome reframe

**File**: `src/pages/index.astro` + `src/components/Welcome.astro`

**Intent**: Replace generic starter copy with a DIB welcome that explains anonymity and routes the employee into the form (FR-002).

**Contract**: Welcome content + a "dalej" CTA linking to `/submit`. Dark/DM Sans/emerald aesthetic with the eyebrow "Anonimowo · Bezpiecznie · Poufnie" + trust-footer (design §4.1).

#### 2. Submit page shell

**File**: `src/pages/submit.astro`

**Intent**: Host the React form island and lay out the dark-theme container.

**Contract**: Page renders the `SubmissionForm` island (Phase 4) inside the `max-w-[640px]` centered dark container (design §2). No business logic in the page.

#### 3. Success page

**File**: `src/pages/submit-success.astro`

**Intent**: The "dziękujemy" confirmation shown after a successful submit (FR-004).

**Contract**: Success screen — the large "✓" in glow + thank-you copy + a glass button back to start (design §4.1 SuccessScreen recipe).

### Implementation approach (delegated build)

Invoke `frontend-design:frontend-design` with `design/design.md` §4.1 + `design/form-04-success.PNG` and the contracts above; it adapts the Tailwind 3.4 recipes to Tailwind 4 and the project's `global.css` tokens.

### Success Criteria:

#### Automated Verification:

- Build passes: `npm run build`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- `/` shows the DIB welcome with a working "dalej" CTA → `/submit`.
- `/submit` renders the form shell; `/submit-success` renders the thank-you screen.
- Visuals match design §4.1 (dark / DM Sans / emerald, fadeUp entry, trust-footer) — delegated build reviewed.

**Implementation Note**: Pause for manual visual confirmation before proceeding.

---

## Phase 4: Frontend — submission form wizard island

### Overview

The 3-step wizard island (oddział → tematyka → treść, with dział + podpis in the content step) plus a live character counter; submits to the Phase 2 endpoint and redirects to success.

### Changes Required:

#### 1. Form island

**File**: `src/components/submissions/SubmissionForm.tsx`

**Intent**: The interactive client island that collects the submission and posts it.

**Contract**: 3 steps — (1) oddział (`BRANCHES`, **required**), (2) tematyka (`TOPICS`), (3) treść (≤800, with counter) + dział (`DEPARTMENTS`, optional) + podpis (optional). Per-step validation gates "Dalej"; final submit `POST`s the whitelisted shape `{ branch, topic, content, department?, signature? }` as JSON to `/api/submissions`, then navigates to `/submit-success`. Surfaces endpoint errors via the `ServerError` pattern. Option values come verbatim from `taxonomies.ts`. Reuses `FormField`/`SubmitButton` patterns; `StepProgress` 3-segment bar + `animate-fadeUp` per step (design §4.1).

#### 2. Character counter

**File**: `src/components/submissions/CharCounter.tsx`

**Intent**: Live ≤800 feedback for the content field.

**Contract**: Shows `n/800`, signals when the limit is exceeded, and the form blocks submit past 800 (mirrors the DB CHECK).

### Implementation approach (delegated build)

Invoke `frontend-design:frontend-design` with `design/design.md` §4.1, `design/form-01-branch.PNG` / `form-02-category.PNG` / `form-03-content.PNG`, and the contract above (fields, step order, POST shape). Logic (validation, fetch, navigation) is specified here; the plugin owns the visual recipes.

### Success Criteria:

#### Automated Verification:

- Build passes: `npm run build`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- The wizard walks oddział(required) → tematyka → treść+dział(opt)+podpis(opt); "Dalej" is gated by per-step validity.
- Char counter is live and blocks content >800.
- A completed submit posts to `/api/submissions` and redirects to `/submit-success` in `<1s`; the row appears `pending` then `done`.
- Submitted values land with exact diacritics (no CHECK violation).
- Visuals match design §4.1 (steps, progress bar, fadeUp) — delegated build reviewed.

**Implementation Note**: Pause for manual confirmation of the full form→submit→success path before proceeding.

---

## Phase 5: Frontend — admin detail view

### Overview

A read-only `/dashboard/submissions/[id]` page (under the already-protected `/dashboard`) that shows one submission with its AI enrichment, disclaimer, and meta, across all four enrichment states. Reads via the RLS-gated SSR client.

### Changes Required:

#### 1. Detail route

**File**: `src/pages/dashboard/submissions/[id].astro` (+ optional presentational `src/components/submissions/SubmissionDetail.tsx`)

**Intent**: The admin read surface that closes the loop — the first place the new RLS policy is exercised through a real session.

**Contract**: Server-side, read the submission by `id` via the **authenticated SSR client** (`src/lib/supabase.ts`) so RLS (`is_allowed_admin()`) gates the read; 404 when not found / not permitted. Render: full `content`; AI block `ai_tone` / `ai_classification` / `ai_title` / `ai_summary` under an "AI-generated, może być stronnicze" label; `signature` if present; `created_at` (data); `department` (dział). Enrichment states — `pending`/`processing` → "AI w toku" placeholder; `failed` → graceful (content + a quiet "wzbogacenie nie powiodło się", no AI block) per FR-008; `done` → full AI block. Light/Lato/sewera-blue dashboard aesthetic (design §4.2/§5). No edit/mutation controls.

### Implementation approach (delegated build)

No mockup exists for this surface; invoke `frontend-design:frontend-design` with `design/design.md` §4.2 + §5 (consistency rules) and `design/dashboard-login.PNG` as the aesthetic anchor, plus the field/state contract above. The plugin produces the read-only card in the dashboard style.

### Success Criteria:

#### Automated Verification:

- Build passes: `npm run build`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`

#### Manual Verification:

- `/dashboard/submissions/[id]` redirects to login when logged out; an allow-listed admin sees content + AI (tone/classification/summary) with the disclaimer + signature(if present) + data + dział.
- `pending`/`processing` shows "AI w toku"; `failed` shows content gracefully without the AI block (FR-008); `done` shows the full AI block.
- A non-allow-listed authenticated session cannot read the row — verified at the **DB layer** (a `SELECT` as a non-allow-listed JWT returns 0 rows). Middleware redirects such a session before the route runs, so this exercises the RLS defense-in-depth *behind* the route guard, not the page itself.
- Visuals match design §4.2/§5 (light / Lato / sewera-blue) — delegated build reviewed.

**Implementation Note**: Pause for final manual confirmation of the complete end-to-end loop (anonymous submit → enrichment → admin detail) before marking the slice complete.

---

## Testing Strategy

### Unit Tests (vitest, `npm run test`):

- `submission-input` — payload whitelist (rejects `ai_*`/`id`/`enrichment_*`/unknown keys), required-field enforcement, taxonomy membership (exact diacritics), content ≤800 / signature ≤200.
- `submissions` route (admin client + `QUEUE` mocked) — client `ai_*`/`id`/`enrichment_status` stripped, `pending` default set, success shape + single `enqueueEnrichment(id)` call (AI never awaited), 400 on invalid bodies, 500 on insert failure but success on enqueue failure (F1), and no identifier in any logged argument.

### Integration-ish:

- The insert→id→enqueue path is exercised manually under `wrangler dev` (local Queues aren't shared across Miniflare instances, so an automated cross-process queue test is out of scope this slice).

### Manual Testing Steps:

1. `npm run build` then `wrangler dev`; submit a valid form → confirm `<1s` response, `pending` row, queue job, consumer → `done`.
2. Submit a body with injected `ai_*`/`id`/`enrichment_status` → confirm stripped.
3. Submit invalid bodies (missing `branch`, bad `topic`, content >800) → confirm 400, nothing inserted.
4. Log in as an allow-listed admin → open the detail view for the row → confirm content + AI + disclaimer + meta; check `pending`/`failed`/`done` rendering.
5. Confirm a non-allow-listed authenticated email cannot read submission rows.
6. (If the cookie/callback path were touched — it is not — re-verify the magic-link Set-Cookie round-trip on a fresh preview.)

## Performance Considerations

- The `<1s` NFR is preserved purely by not awaiting AI in the route; insert + `QUEUE.send` are both sub-second. `ctx.waitUntil` on the send is optional hardening.
- Detail view reads a single row by primary key — no index concern. Done-only/list reads (partial-index predicate matching, `lessons.md:33-38`) are an **S-02** concern.

## Migration Notes

- Run order: apply migration → `npm run db:gen-types` → `npm run db:seed-admins` → commit (taxonomies unchanged this slice).
- Seed `admin_allowlist` via `npm run db:seed-admins` (idempotent, mirrors `ALLOWED_ADMIN_EMAILS`) immediately after the migration applies — an empty table locks out all admins. Re-run after any local `db:reset` and on any `ALLOWED_ADMIN_EMAILS` change (the env var stays SSOT).
- Rollback: the migration is additive except the policy swap; reverting restores `USING (true)` and re-adds `NOT NULL` (only safe if no NULL `department` rows exist yet).

## References

- Research: `context/changes/first-end-to-end-submission/research.md`
- Roadmap S-01: `context/foundation/roadmap.md:127-141`
- Design system: `design/design.md` (+ `design/form-0*.PNG`, `design/dashboard-login.PNG`)
- Canonical patterns: `src/pages/api/auth/signin.ts` (POST route), `src/components/auth/SignInForm.tsx` (form island), `src/pages/dashboard.astro` (protected page stub)
- Producer helper: `src/lib/enrichment/enqueue.ts`; service-role client: `src/lib/enrichment/supabase-admin.ts`
- Lessons: `context/foundation/lessons.md` (partial-index predicate; deferred permissive gate; local queue testing)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.
>
> **Phase 2 adaptation (decision E correction):** `locals.runtime.env` was removed in Astro v6 / @astrojs/cloudflare v13 (the getter throws at runtime). The route reads bindings via `import { env } from "cloudflare:workers"`, wrapped in `src/lib/runtime-env.ts` (vitest-mockable); the planned `src/env.d.ts` `runtime: Runtime<Env>` typing was reverted. Same capability, correct for this adapter version.

### Phase 1: Data layer — department optional + allow-list admin RLS

#### Automated

- [x] 1.1 Migration applies cleanly: `npm run db:reset` — 9e2fe45
- [x] 1.2 Types regenerate with `department` optional in Insert: `npm run db:gen-types` — 9e2fe45
- [x] 1.3 Type checking passes: `npm run typecheck` — 9e2fe45
- [x] 1.4 Linting passes: `npm run lint` — 9e2fe45

#### Manual

- [x] 1.5 Allow-listed email can SELECT a row; non-seeded authenticated email gets 0 rows (RLS verified) — 9e2fe45
- [x] 1.6 Anon insert of the 5 granted columns still succeeds — 9e2fe45
- [x] 1.7 `npm run db:seed-admins` populates `admin_allowlist` to mirror `ALLOWED_ADMIN_EMAILS` (idempotent); table non-empty, no admin locked out — 9e2fe45

### Phase 2: Backend — runtime wiring + submission endpoint

#### Automated

- [x] 2.1 Unit tests pass: `npm run test` (`submission-input` + `submissions` route suites) — 8618a1a
- [x] 2.2 Type checking passes (route compiles, `locals.runtime` typed): `npm run typecheck` — 8618a1a
- [x] 2.3 Linting passes: `npm run lint` — 8618a1a

#### Manual

- [x] 2.4 `wrangler dev` (after `npm run build`): valid POST returns `<1s`, inserts `pending`, consumer reaches `done` — 8618a1a
- [x] 2.5 POST with `ai_*`/`id`/`enrichment_status` → row has defaults only (stripped) — 8618a1a
- [x] 2.6 No IP/header/cookie/identifier persisted or logged (anonymity) — 8618a1a
- [x] 2.7 Invalid body (missing branch / bad topic / content >800) → 400, nothing inserted — 8618a1a

### Phase 3: Frontend — welcome + public flow scaffolding

#### Automated

- [x] 3.1 Build passes: `npm run build`
- [x] 3.2 Type checking passes: `npm run typecheck`
- [x] 3.3 Linting passes: `npm run lint`

#### Manual

- [x] 3.4 `/` shows DIB welcome with working "dalej" CTA → `/submit`
- [x] 3.5 `/submit` renders form shell; `/submit-success` renders thank-you
- [x] 3.6 Visuals match design §4.1 (dark / DM Sans / emerald) — delegated build reviewed

### Phase 4: Frontend — submission form wizard island

#### Automated

- [ ] 4.1 Build passes: `npm run build`
- [ ] 4.2 Type checking passes: `npm run typecheck`
- [ ] 4.3 Linting passes: `npm run lint`

#### Manual

- [ ] 4.4 Wizard walks oddział(req) → tematyka → treść+dział(opt)+podpis(opt); "Dalej" gated by per-step validity
- [ ] 4.5 Char counter live; blocks content >800
- [ ] 4.6 Submit posts to `/api/submissions`, redirects to success `<1s`; row `pending` → `done`
- [ ] 4.7 Submitted values land with exact diacritics (no CHECK violation)
- [ ] 4.8 Visuals match design §4.1 (steps, progress bar, fadeUp) — delegated build reviewed

### Phase 5: Frontend — admin detail view

#### Automated

- [ ] 5.1 Build passes: `npm run build`
- [ ] 5.2 Type checking passes: `npm run typecheck`
- [ ] 5.3 Linting passes: `npm run lint`

#### Manual

- [ ] 5.4 Logged-out → redirect to login; allow-listed admin sees content + AI + disclaimer + signature/data/dział
- [ ] 5.5 `pending`/`processing` → "AI w toku"; `failed` → graceful (content, no AI block, FR-008); `done` → full AI block
- [ ] 5.6 Non-allow-listed authenticated session cannot read the row — RLS verified at the DB layer (SELECT as a non-allow-listed JWT → 0 rows; middleware redirects before the route)
- [ ] 5.7 Visuals match design §4.2/§5 (light / Lato / sewera-blue) — delegated build reviewed
- [ ] 5.8 Full end-to-end loop confirmed (anonymous submit → enrichment → admin detail)
