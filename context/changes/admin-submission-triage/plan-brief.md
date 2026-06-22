# Admin Submission Triage (status + delete) — Plan Brief

> Full plan: `context/changes/admin-submission-triage/plan.md`

## What & Why

Domknięcie CRUD admina na dashboardzie: zmiana **statusu triage'u** zgłoszenia
(`nowe → w trakcie → rozpatrzone/odrzucone`) i **usunięcie** zgłoszenia (moderacja
spamu/off-topic). Obie operacje przez **sesję admina → RLS**, więc wzmacniają guardrail
„zero wycieku poza adminów" (test-plan #1) i nie naruszają anonimowości nadawcy.

## Starting Point

`submissions` ma tylko `enrichment_status` (lifecycle AI), brak statusu triage'u i brak
polityk RLS UPDATE/DELETE. Detal (`[id].astro`) jest read-only; dashboard-lista jest
zero-JS (S-02). Middleware chroni tylko `/dashboard` — endpoint pod `/api/*` musi sam się
bramkować.

## Desired End State

Każde zgłoszenie ma `review_status` (domyślnie `new`). Admin na detalu widzi badge statusu,
zmienia status (select → PATCH) i usuwa zgłoszenie (przycisk → `window.confirm` → DELETE →
redirect). `PATCH/DELETE /api/submissions/[id]` działa tylko dla admina (app-guard +
same-origin), egzekwowane dodatkowo przez RLS; nie-admin dostaje 403/0-wierszy.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Architektura mutacji | SSR session-client + RLS (nie service-role) | Defense in depth — DB broni nawet przy bugu w app | Notes |
| Status enum | 4 stany, kody EN + etykiety PL | Spójne z `enrichment_status`; stabilne kody niezależne od wyświetlania | Plan |
| Delete | Hard delete (DELETE wiersza) | Najprostsze, maks. anonimowość, mieści się w „1 migracja" | Plan |
| Endpoint | Jedna trasa `[id].ts`: PATCH + DELETE | RESTful, jeden guard, lustro zasobu | Plan |
| `review_status` a liczniki | Tylko metadana-badge | Ciasny zakres, zero ryzyka dla agregatów/digestu (#8) | Plan |
| UI | React island tylko na detalu | Minimalny client-JS, lista zostaje zero-JS (S-02) | Plan |
| Confirm delete | Natywne `window.confirm()` | Zero nowego UI, pasuje do „małej zmiany" | Plan |
| CSRF | Same-origin (Origin header) check | Tania obrona destrukcyjnych operacji bez infrastruktury tokenów | Plan |
| Audyt | Minimalnie — tylko `review_status` | Anonimowość dotyczy nadawcy, nie admina | Plan |

## Scope

**In scope:** kolumna `review_status` + CHECK + granty + RLS UPDATE/DELETE; `REVIEW_STATUSES`
w TS + drift-guard; endpoint PATCH/DELETE + walidator + testy; UI island na detalu; SQL probe'y.

**Out of scope:** soft delete; filtrowanie listy/agregatów/digestu wg statusu; inline akcje na
liście; `reviewed_at`/`reviewed_by`; token CSRF; modal; zmiana ścieżki insertu; `*.workers.test.ts`.

## Architecture / Approach

Schema-first, warstwami: migracja (kolumna+granty+RLS) → TS-const+drift → endpoint
(guard: same-origin + isAllowedAdmin + walidacja; SSR client; `maybeSingle()`→404) → UI
island (`client:load`) → DB-layer probe'y. Endpoint używa SSR cookie-client, RLS jako
backstop; `GRANT UPDATE (review_status)` column-scoped chroni pozostałe kolumny (42501).

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Migracja DB | `review_status` + granty + polityki RLS; regen typów | `REVOKE FROM PUBLIC` no-op — granty muszą być jawne dla `authenticated` |
| 2. Taksonomia TS | `REVIEW_STATUSES` + etykiety PL + drift-guard | Drift CHECK↔const (diacritic/set-equality) |
| 3. Endpoint API | PATCH/DELETE + walidator + testy | Endpoint nie objęty middleware → musi self-guardować |
| 4. UI island | Akcje na detalu (status + delete) | Wprowadzenie client-JS na dotąd statyczną stronę |
| 5. SQL probes + smoke | Dowód RLS UPDATE/DELETE + column-grant backstop | Manualny gate (lokalny/staging Supabase) |

**Prerequisites:** lokalny Supabase (`npm run db:reset`), `.dev.vars`, zaseedowana
allow-lista (`npm run db:seed-admins`).
**Estimated effort:** ~2-3 sesje, 5 faz, ~11 plików.

## Open Risks & Assumptions

- Prod NIE auto-aplikuje migracji — `supabase db push` + weryfikacja `schema_migrations` to
  jawny krok deployu (lessons.md).
- `window.confirm()` wymaga obsługi `page.on('dialog')` jeśli kiedyś dojdzie E2E (E2E poza
  scope wg test-plan).
- Same-origin check zakłada, że przeglądarki wysyłają `Origin` na PATCH/DELETE (tak jest).

## Success Criteria (Summary)

- Admin zmienia status i usuwa zgłoszenie z detalu; nie-admin/obcy origin → 403.
- `npm test` + `npm run typecheck` zielone; SQL probe'y UPDATE/DELETE + backstop 42501 OK.
- Lista dashboardu nadal działa bez client-JS (S-02 nienaruszone).
