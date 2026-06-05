# S-01 `first-end-to-end-submission` — Plan Brief

> Full plan: `context/changes/first-end-to-end-submission/plan.md`
> Research: `context/changes/first-end-to-end-submission/research.md`

## What & Why

Close the north-star loop: an anonymous employee submits an idea/problem, AI enriches it asynchronously, and an allow-listed admin reads that one enriched submission in a detail view. This is the slice that proves the whole product thesis end-to-end — every other slice (S-02..S-05) depends on it.

## Starting Point

~80% of the machinery is already built and verified: F-01 schema, F-02 magic-link auth (Set-Cookie verified on a real Workers preview), F-03 queue + enrichment consumer. What's missing is the user-facing surface, one migration, and the route→runtime wiring that lets the submission endpoint enqueue a job.

## Desired End State

A public welcome → 3-step form → "dziękujemy" (`<1s`) flow writes a `pending` row and fire-and-forgets a queue job; the consumer enriches it; an allow-listed admin opens `/dashboard/submissions/[id]` and sees the full content + AI tone/classification/summary (labelled "AI-generated, może być stronnicze") + signature/date/dział, gracefully handling all enrichment states.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Insert→id→enqueue under RLS | Service-role insert + strict server-side payload whitelist | Anon role has no SELECT so it can't read back `id`; service-role is the simplest path, whitelist compensates for bypassing the column grant | Research (A) |
| `topic` taxonomy | Shipped `TOPICS` (4 values); flag PRD FR-003/FR-011 as stale | Already DB-enforced and consumed by F-03; the PRD's 5 values actually map to AI `CLASSIFICATIONS` | Research (B) |
| Admin detail route location | `/dashboard/submissions/[id]` | Already inside `PROTECTED_ROUTES` — no middleware change, auto allow-list-gated | Plan (C) |
| RLS defense-in-depth | Add allow-list SELECT policy now (`is_allowed_admin()` SECURITY DEFINER fn + `admin_allowlist` table) | First real read surface; closes the "deferred permissive gate = live exposure" risk and lets the detail view read via the RLS-gated SSR client | Plan (D) |
| Detail view content | Read-only card: content + AI (with disclaimer) + meta, all 4 enrichment states | Covers roadmap outcome + FR-008 graceful degradation + FR-014 + the AI disclaimer NFR | Plan |
| Form structure | 3-step wizard (oddział → tematyka → treść), dział + podpis in the content step | Faithful to the design mockups (form-01..04); optional fields fit the final step | Plan |
| Frontend build | Plan specifies contracts; visual build delegated to `frontend-design` using `design/` | Separates logic/contract from pixel work; reuses the polished design system, adapted Next/TW3.4 → Astro/TW4 | Plan |
| Verification depth | Unit on the risk logic (payload whitelist, validation) + manual e2e on a Workers preview | Covers the highest risks (anonymity, `<1s`, insert) without e2e infra that belongs to later lessons | Plan |

## Scope

**In scope:** `department DROP NOT NULL` + allow-list admin RLS migration; `App.Locals.runtime` typing; `POST /api/submissions` (service-role insert + whitelist + enqueue, `<1s`, anonymity-safe); welcome reframe; 3-step form + char counter; success page; read-only admin detail view.

**Out of scope:** admin dashboard/aggregates (S-02); notifications/AI-failure alert (S-03); network gate FR-015 (F-04, blocked on IT); `topic` 5-value migration; auth rebuild; e2e/Playwright/hooks/CI; rate-limiting.

## Architecture / Approach

Producer side: form island → `POST /api/submissions` → validate+whitelist → service-role insert (returns `id`) → `enqueueEnrichment(env, id)` (never awaits AI). Consumer (F-03, unchanged) re-reads the row by id and writes `ai_*`. Admin side: SSR-authenticated read of one row, now gated by an allow-list RLS policy for DB-level defense-in-depth. Three UI surfaces specify their contract in the plan and delegate the visual build to the `frontend-design` plugin.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Data layer | Migration (department optional + allow-list RLS) + types regen | Empty allow-list table locks out all admins; SECURITY DEFINER fn must pin search_path |
| 2. Backend | Runtime typing + payload whitelist (+unit test) + `POST /api/submissions` | Service-role bypasses column grant — whitelist must be airtight; keep route `<1s` (no AI await) |
| 3. Public flow scaffolding | Welcome reframe + `/submit` shell + success page | Visual fidelity in delegated build (Next/TW3.4 → Astro/TW4) |
| 4. Form wizard island | 3-step wizard + live char counter, POST → success | Per-step validation; diacritic-exact taxonomy values |
| 5. Admin detail view | Read-only `/dashboard/submissions/[id]`, all enrichment states | No mockup exists; RLS read must be re-verified at the route |

**Prerequisites:** F-01/F-02/F-03 done (✓). Migration must apply + `admin_allowlist` seeded before admin read works. `wrangler dev` (not `astro dev`) for the queue path.
**Estimated effort:** ~5 phases; backend (1–2) is the load-bearing work, UI (3–5) is delegated build + review. Roughly 2–3 focused sessions.

## Open Risks & Assumptions

- **Allow-list env↔DB sync.** `ALLOWED_ADMIN_EMAILS` stays the app SSOT; the `admin_allowlist` table mirrors it and must be seeded at deploy — drift locks out admins or weakens the policy.
- **Queue path is manually verified only.** Local Queues aren't shared across Miniflare instances, so the insert→enqueue→consume path is checked under `wrangler dev`, not in CI this slice.
- **PRD drift accepted, not fixed.** FR-003/FR-011 (5-value "tematyka") remain stale vs the shipped 4-value `TOPICS` — flagged, not migrated.
- **Pilot still gated on F-04.** S-01 runs on public `workers.dev`; the corporate network gate (FR-015) is a separate blocked slice and does not block S-01 development.

## Success Criteria (Summary)

- An anonymous employee submits in `<1s` and a row reaches `done` via the queue, with no client identifier stored.
- An allow-listed admin reads the enriched submission (with disclaimer) in the detail view; a non-allow-listed session cannot read it.
- The payload whitelist rejects any `ai_*`/`id`/`enrichment_*` injection (unit-guarded).
