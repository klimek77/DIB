# Admin Submission Triage (status + delete) Implementation Plan

## Overview

Domknięcie CRUD admina na dashboardzie: admin może (1) zmienić **status triage'u**
zgłoszenia (`nowe → w trakcie → rozpatrzone/odrzucone`) i (2) **usunąć** zgłoszenie
(moderacja spamu/off-topic). Obie akcje idą przez **sesję admina** (SSR cookie-client),
więc RLS egzekwuje je na warstwie DB — to defense in depth dla guardraila „zero wycieku
poza adminów" (test-plan #1) i nie narusza anonimowości nadawcy (status/delete to
metadane/operacje admina, nie tożsamość nadawcy).

## Current State Analysis

- `public.submissions` ma `enrichment_status` (pending/processing/done/failed) — to
  lifecycle AI, **nie** triage admina. Brak kolumny statusu triage'u, brak `deleted_at`,
  brak `updated_at` (`supabase/migrations/20260528000000_create_submissions.sql:32-78`).
- RLS dziś: `submissions_anon_insert` (INSERT anon, column-grant na 5 kolumn) +
  `submissions_authenticated_select` (SELECT authenticated `USING is_allowed_admin()`).
  **Brak polityk UPDATE i DELETE**
  (`20260528...:103-147`, `20260605...:75-85`).
- Granty: `REVOKE ALL ON public.submissions FROM anon, authenticated`, potem
  `GRANT INSERT(5 kolumn) TO anon` i `GRANT SELECT TO authenticated`. `service_role`
  bypassuje RLS (`20260528...:130-147`).
- `is_allowed_admin()` — SQL STABLE SECURITY DEFINER, pinned `search_path`, czyta
  `admin_allowlist` po `lower(auth.jwt()->>'email')`; `GRANT EXECUTE ... TO authenticated`
  (`20260605...:57-73`).
- Dwa klienty Supabase: SSR cookie-client `createClient(headers, cookies)`
  (`src/lib/supabase.ts:7-26`, RLS-gated, używany przez dashboard/detail) vs service-role
  `createAdminClient(env)` (`src/lib/enrichment/supabase-admin.ts:14-24`, bypass RLS,
  używany przez insert endpoint).
- Middleware chroni **tylko** `/dashboard` (`PROTECTED_ROUTES = ["/dashboard"]`,
  `src/middleware.ts:6,24-28`), ale `context.locals.user` ustawia dla **wszystkich** tras
  (`:8-19`). Endpoint pod `/api/*` **musi sam** sprawdzić `isAllowedAdmin`.
- Detal `src/pages/dashboard/submissions/[id].astro` — read-only, SSR client,
  `select("*").eq("id",id).maybeSingle()` → 404 dla braku/RLS-deny (`:16-26`); karta
  zgłoszenia (oddział/dział/tematyka/data + treść + podpis) to naturalne miejsce na akcje.
- Dashboard list (`dashboard.astro`) — **zero client-JS by design (S-02)**; lista pokazuje
  tylko `enrichment_status='done'` (`src/lib/dashboard/aggregates.ts:110-131`).
- Taksonomie TS lustrują CHECK-i z testem driftu (`src/lib/submissions/taxonomies.ts:18-62`,
  `taxonomies.drift.test.ts:91-119`, set-equality bidirectional, diacritic-sensitive).
- Walidacja insertu: „ignored by construction" — zwalidowany obiekt JEST whitelistą
  (`src/lib/submissions/submission-input.ts:40-96`), test pieczętuje klucze przez
  `Object.keys(...).sort()` (`_submissions.test.ts`).
- Brak ochrony CSRF na endpointach mutujących; brak reużywalnego guard-helpera.

## Desired End State

- Każde zgłoszenie ma `review_status` (domyślnie `new`, backfill istniejących na `new`).
- Admin na detalu widzi badge bieżącego statusu, może zmienić status (select → PATCH) i
  usunąć zgłoszenie (przycisk destrukcyjny → `window.confirm` → DELETE → redirect na
  `/dashboard`).
- `PATCH/DELETE /api/submissions/[id]` działają **tylko** dla zalogowanego admina
  (app-guard + same-origin), egzekwowane **dodatkowo** przez RLS; nie-admin/anon dostaje
  403 (app) i 0 wierszy (RLS backstop). Próba update kolumny innej niż `review_status`
  przez rolę `authenticated` → `ERROR 42501` (column-grant backstop).
- `review_status` jest **wyłącznie metadaną wyświetlaną** — NIE zmienia filtrowania listy
  ani agregatów/weekly-digestu (zakres ciasny, zero ryzyka dla #8).
- Weryfikacja: `npm test` zielone (endpoint + walidator + drift), `npm run typecheck`
  zielone, SQL probe'y UPDATE/DELETE dają oczekiwane wyniki, manualny smoke UI przechodzi.

### Key Discoveries:

- Endpoint MUSI self-guardować: middleware nie obejmuje `/api/*` (`src/middleware.ts:6`).
- `REVOKE ... FROM PUBLIC` to no-op przy domyślnych grantach Supabase — granty nadajemy
  jawnie roli `authenticated`, NIE polegamy na PUBLIC (lessons.md:75-80).
- Column-scoped `GRANT UPDATE (review_status)` to backstop test-plan #3 — nawet bug w
  endpointcie nie zapisze `content`/`ai_*` przez rolę authenticated.
- Prod Supabase NIE auto-aplikuje migracji — `supabase db push` + weryfikacja
  `schema_migrations` to jawny krok deployu (lessons.md:131-136, CLAUDE.md Deploy).
- `database.types.ts` jest generowany (`npm run db:gen-types`) — nigdy ręcznie.

## What We're NOT Doing

- **Soft delete** — delete jest twardy (DELETE wiersza); brak `deleted_at`.
- **Filtrowanie listy/agregatów/digestu wg `review_status`** — status to metadana-badge;
  agregaty (`dashboard_aggregates` RPC) i weekly-digest pozostają bez zmian.
- **Inline akcje na liście** — przyciski tylko na detalu (lista zostaje zero-JS, S-02).
- **Metadane audytu** (`reviewed_at`/`reviewed_by`) — tylko kolumna `review_status`.
- **Pełny token CSRF (double-submit)** — wystarczy same-origin check na mutacjach.
- **Modal potwierdzenia / komponent dialogu** — natywne `window.confirm()`.
- **Zmiana ścieżki insertu** (`POST /api/submissions`) — nie dotykamy producenta.
- **`*.workers.test.ts`** — endpoint nie ma kontraktu Set-Cookie; logika testowana w
  node-suite z mockiem SSR-clienta, RLS pokryte SQL-probe'ami (manual gate).

## Implementation Approach

Schema-first, warstwami: (1) migracja zakłada kolumnę + granty + polityki, (2) TS-const i
drift-guard lustrują nowy CHECK, (3) endpoint mutujący z guardem i walidatorem, (4) UI
island na detalu, (5) DB-layer probe'y + smoke. Każda faza buduje na poprzedniej; endpoint
importuje `REVIEW_STATUSES` z fazy 2, UI woła endpoint z fazy 3.

## Critical Implementation Details

- **Kolejność guarda w endpointcie**: najpierw same-origin (Origin == origin requestu,
  odrzuć brak/mismatch dla mutacji), potem `context.locals.user` + `isAllowedAdmin(email)`
  (403), potem walidacja body (400 dla PATCH), potem operacja na SSR-clientcie. RLS jest
  ostatnią linią (0 wierszy → 404), ale app-guard jest pierwszą.
- **`maybeSingle()` po update/delete**: PostgREST zwraca 0 wierszy gdy RLS odmawia LUB id
  nie istnieje — oba kolapsują do 404 (jak istniejący detail-read). To celowe (nie
  ujawnia różnicy istnieje/nie-masz-dostępu).
- **Column-grant a PATCH**: `.update({ review_status })` MUSI wysyłać wyłącznie
  `review_status` — każda inna kolumna w SET → 42501 z roli authenticated. To zarazem
  backstop i wymóg poprawności endpointu.

## Phase 1: Migracja DB — kolumna `review_status` + granty + RLS

### Overview

Zakłada kolumnę triage'u, nadaje roli `authenticated` minimalne uprawnienia UPDATE
(column-scoped) i DELETE, oraz polityki RLS bramkowane `is_allowed_admin()`. Regeneruje typy.

### Changes Required:

#### 1. Nowa migracja

**File**: `supabase/migrations/20260619000000_admin_submission_triage.sql`

**Intent**: Dodać kolumnę `review_status` z domyślną wartością i CHECK-iem 4 wartości
(backfill istniejących wierszy na `new`), nadać `authenticated` `UPDATE (review_status)` i
`DELETE`, oraz utworzyć polityki RLS UPDATE/DELETE gated `is_allowed_admin()`. anon i
PUBLIC nie dostają nic.

**Contract**: Migracja idempotentnie rozszerza `public.submissions`. Granty jawne roli
`authenticated` (nie PUBLIC — lessons.md:75-80). Kluczowe stwierdzenia:

```sql
ALTER TABLE public.submissions
  ADD COLUMN review_status text NOT NULL DEFAULT 'new'
  CONSTRAINT submissions_review_status_check
    CHECK (review_status IN ('new', 'in_progress', 'reviewed', 'rejected'));

-- Column-scoped UPDATE backstop (test-plan #3): authenticated może zmienić TYLKO status.
GRANT UPDATE (review_status) ON public.submissions TO authenticated;
GRANT DELETE              ON public.submissions TO authenticated;

CREATE POLICY submissions_admin_update ON public.submissions
  FOR UPDATE TO authenticated
  USING (public.is_allowed_admin()) WITH CHECK (public.is_allowed_admin());

CREATE POLICY submissions_admin_delete ON public.submissions
  FOR DELETE TO authenticated
  USING (public.is_allowed_admin());
```

#### 2. Regeneracja typów

**File**: `src/lib/database.types.ts`

**Intent**: Po `npm run db:reset` (rebuild z migracji+seed) zregenerować typy, by
`review_status` pojawił się w `Row`/`Insert`/`Update` `submissions`.

**Contract**: `npm run db:gen-types` (nigdy ręcznie). `submissions.Row.review_status: string`,
`Insert.review_status?: string`, `Update.review_status?: string`.

### Success Criteria:

#### Automated Verification:

- Reset DB stosuje migracje czysto: `npm run db:reset`
- Typy zregenerowane i zawierają `review_status`: `npm run db:gen-types` (diff pokazuje pole)
- Typecheck przechodzi: `npm run typecheck`

#### Manual Verification:

- W Studio: `\d public.submissions` pokazuje `review_status` (NOT NULL, default `new`, CHECK)
- Istniejące wiersze mają `review_status = 'new'` (backfill)
- Polityki `submissions_admin_update`/`submissions_admin_delete` istnieją (pg_policies)

**Implementation Note**: Po automatach pauza na manualne potwierdzenie przed Fazą 2.

---

## Phase 2: Taksonomia TS + drift-guard

### Overview

Lustruje nowy CHECK po stronie TS (SSOT dla UI/walidacji) i dopina go do testu driftu.

### Changes Required:

#### 1. Stałe taksonomii + etykiety PL

**File**: `src/lib/submissions/taxonomies.ts`

**Intent**: Dodać `REVIEW_STATUSES` (kody EN, `as const`) lustrzane do CHECK-a z Fazy 1 oraz
mapę `REVIEW_STATUS_LABELS` kod→etykieta PL (UI po polsku), spójnie z wzorcem
`ENRICHMENT_STATUSES`.

**Contract**: `export const REVIEW_STATUSES = ['new','in_progress','reviewed','rejected'] as const;`
plus `REVIEW_STATUS_LABELS: Record<(typeof REVIEW_STATUSES)[number], string>`
(`new→Nowe`, `in_progress→W trakcie`, `reviewed→Rozpatrzone`, `rejected→Odrzucone`).
Opcjonalny typ `ReviewStatus = (typeof REVIEW_STATUSES)[number]`.

#### 2. Rozszerzenie drift-guarda

**File**: `src/lib/submissions/taxonomies.drift.test.ts`

**Intent**: Dodać asercję set-equality `REVIEW_STATUSES` ↔ `submissions_review_status_check`,
analogicznie do pozostałych pięciu taksonomii.

**Contract**: Test parsuje CHECK po nazwie `submissions_review_status_check` z migracji i
porównuje dwukierunkowo z `REVIEW_STATUSES`.

### Success Criteria:

#### Automated Verification:

- Drift-guard przechodzi (status ≡ CHECK): `npx vitest run src/lib/submissions/taxonomies.drift.test.ts`
- Typecheck przechodzi: `npm run typecheck`
- Lint przechodzi: `npm run lint`

#### Manual Verification:

- Etykiety PL poprawne i kompletne dla wszystkich 4 kodów

**Implementation Note**: Po automatach pauza na manualne potwierdzenie przed Fazą 3.

---

## Phase 3: Endpoint API `PATCH/DELETE /api/submissions/[id]`

### Overview

Jeden dynamiczny endpoint mutujący przez SSR session-client (RLS aktywne), z guardem
(app-level + same-origin) i walidatorem statusu (whitelist).

### Changes Required:

#### 1. Walidator statusu

**File**: `src/lib/submissions/review-status-input.ts`

**Intent**: Whitelistowy walidator body PATCH — czyta wyłącznie `review_status`, sprawdza
przynależność do `REVIEW_STATUSES`; wszystko inne ignorowane by construction (wzorzec
`submission-input.ts`).

**Contract**: `validateReviewStatusInput(body: unknown): { ok: true; value: { review_status: ReviewStatus } } | { ok: false; error: string }`.

#### 2. Endpoint

**File**: `src/pages/api/submissions/[id].ts`

**Intent**: `export const PATCH` i `export const DELETE` (`APIRoute`). Wspólny guard: (a)
same-origin (`Origin` == `new URL(request.url).origin`, brak/mismatch → 403), (b)
`isAllowedAdmin(context.locals.user?.email)` (null/nie-admin → 403). PATCH: walidacja body
(400), `createClient(headers, cookies)` → `.update({ review_status }).eq('id', id).select('id').maybeSingle()`
(null → 404). DELETE: `.delete().eq('id', id).select('id').maybeSingle()` (null → 404).
Sukces → `{ ok: true }` (200). Błędy statyczne, bez PII.

**Contract**: Ścieżka `/api/submissions/:id`. Odpowiedzi: 200 `{ok:true}`; 400 (zły status);
403 (zła origin / nie-admin); 404 (brak/RLS-deny); 500 (błąd DB). Klient: **SSR cookie-client**
(`src/lib/supabase.ts`), NIE service-role. SET zawiera wyłącznie `review_status`.

#### 3. Testy (kolokowane, prefiks `_`)

**File**: `src/pages/api/submissions/_id-endpoint.test.ts` oraz
`src/lib/submissions/review-status-input.test.ts`

**Intent**: Integracyjny test endpointu (mock krawędzi: `@/lib/supabase` `createClient`,
`@/lib/auth/allowlist` `isAllowedAdmin`; driver: `Request` + `context.locals.user`) pokrywa
macierz: brak usera→403, nie-admin→403, zła origin→403, admin+zły status→400, admin+OK→200 z
asercją że `.update` dostał WYŁĄCZNIE `{review_status}`, PATCH z dodatkowymi polami→pola
zignorowane, DELETE admin→200 woła `.delete().eq(id)`, brak wiersza→404. Unit walidatora:
whitelist + enum + ignored-by-construction (`Object.keys` seal).

**Contract**: Prefiks `_` wyłącza pliki z routingu Astro (CLAUDE.md/test-plan §6.2); globy
vitest łapią je nadal. Mock tylko na krawędzi (nie modułów wewnętrznych).

### Success Criteria:

#### Automated Verification:

- Test endpointu przechodzi: `npx vitest run src/pages/api/submissions/_id-endpoint.test.ts`
- Test walidatora przechodzi: `npx vitest run src/lib/submissions/review-status-input.test.ts`
- Pełny node-suite zielony: `npm test`
- Typecheck + lint: `npm run typecheck && npm run lint`

#### Manual Verification:

- (po Fazie 4) curl/fetch z sesją admina: PATCH zmienia status, DELETE usuwa
- Żądanie bez sesji / z obcego origin → 403

**Implementation Note**: Po automatach pauza na manualne potwierdzenie przed Fazą 4.

---

## Phase 4: UI island akcji na detalu

### Overview

React island na `[id].astro` (jedyny client-JS; lista zostaje statyczna): badge statusu,
select zmiany statusu (PATCH), przycisk destrukcyjny usuwania (`window.confirm` → DELETE →
redirect na `/dashboard`).

### Changes Required:

#### 1. Komponent akcji

**File**: `src/components/dashboard/SubmissionActions.tsx`

**Intent**: Island (`client:load`) z propsami `id` i `reviewStatus`. Select z opcjami
`REVIEW_STATUS_LABELS`; zmiana → `fetch(PATCH)`; sukces → odśwież widoczny status (np.
`location.reload()` lub lokalny state). Przycisk „Usuń zgłoszenie" (wariant `destructive`
z `src/components/ui/button.tsx`) → `window.confirm` → `fetch(DELETE)` → przy sukcesie
`location.href = '/dashboard'`. Inline komunikat błędu przy nieudanym fetchu. Wszystkie
etykiety PL.

**Contract**: Props `{ id: string; reviewStatus: ReviewStatus }`. `fetch` z
`headers: {'Content-Type':'application/json'}`, `method: 'PATCH'|'DELETE'`,
`credentials: 'same-origin'`. Reużycie istniejącego `Button`.

#### 2. Montaż w detalu

**File**: `src/pages/dashboard/submissions/[id].astro`

**Intent**: Pod kartą zgłoszenia wstawić sekcję akcji z `<SubmissionActions client:load id={submission.id} reviewStatus={submission.review_status} />` oraz statyczny badge
bieżącego statusu (mapa etykiet PL). Tylko gdy `submission` istnieje.

**Contract**: Brak generyków/`as` w `{ }` (CLAUDE.md Astro authoring) — ewentualne casty w
frontmatter. Badge w stylistyce dashboardu (light/sewera-blue).

### Success Criteria:

#### Automated Verification:

- Typecheck (astro check) przechodzi: `npm run typecheck`
- Lint przechodzi: `npm run lint`
- Build przechodzi: `npm run build`

#### Manual Verification:

- Detal pokazuje badge bieżącego statusu (PL)
- Zmiana statusu w select → status zapisany (po odświeżeniu widać nowy)
- „Usuń" → confirm → po potwierdzeniu zgłoszenie znika, redirect na `/dashboard`
- Anuluj w confirm → nic się nie dzieje
- Lista dashboardu nadal działa bez client-JS (S-02 nienaruszone)

**Implementation Note**: Po automatach pauza na manualne potwierdzenie przed Fazą 5.

---

## Phase 5: Bramka DB-layer (SQL probes) + smoke

### Overview

Rozszerza manualny gate `access-control-probes.sql` o ścieżki UPDATE/DELETE i column-grant
backstop — dowód, że RLS sama broni niezależnie od warstwy app.

### Changes Required:

#### 1. Rozszerzenie probe'ów

**File**: `supabase/tests/access-control-probes.sql`

**Intent**: Dodać probe'y (rola `authenticated` z JWT non-admin vs admin) dla UPDATE
`review_status` i DELETE, plus probe column-grant backstop (authenticated UPDATE `content`
→ 42501). Wzorzec i konwencje jak istniejące Probe 1–5 (bez `ON_ERROR_STOP`, błąd 42501 JEST
passem).

**Contract**: Nowe probe'y z oczekiwaniami: non-admin UPDATE → 0 wierszy; admin UPDATE →
≥1 wiersz; non-admin DELETE → 0 wierszy; admin DELETE → ≥1 wiersz (ROLLBACK); authenticated
UPDATE `content` → ERROR 42501. Komentarz „Expected outcomes" zaktualizowany.

### Success Criteria:

#### Automated Verification:

- Skrypt parsuje się i wykonuje: `psql "$DATABASE_URL" -f supabase/tests/access-control-probes.sql` (lokalny Supabase)

#### Manual Verification:

- Non-admin UPDATE `review_status` → 0 wierszy (RLS odmawia)
- Admin UPDATE `review_status` → ≥1 wiersz
- Non-admin DELETE → 0 wierszy; admin DELETE → ≥1 wiersz (ROLLBACK)
- authenticated UPDATE `content` → ERROR 42501 (column-grant backstop)
- End-to-end smoke pod ZBUDOWANYM workerem (`npx wrangler dev -c dist/server/wrangler.json`,
  NIE `astro dev` — dev≠prod, lessons.md; sesja admina): admin **same-origin** PATCH→200 (status
  zmienia się) i DELETE→200 (zgłoszenie znika). Potwierdza, że `Origin == request.url.origin`
  trzyma na realnym hoście/proxy Cloudflare (brak false-403 dla prawowitego admina)

**Implementation Note**: To ostatnia faza — po przejściu wszystkich kryteriów zmiana gotowa
do commitu/deployu (patrz Migration Notes).

---

## Testing Strategy

### Unit Tests:

- Walidator `review-status-input` — whitelist (`Object.keys` seal), enum, ignored-by-construction.
- Drift-guard — `REVIEW_STATUSES` ≡ `submissions_review_status_check`.

### Integration Tests:

- Endpoint `PATCH/DELETE /api/submissions/[id]` — macierz auth/origin/walidacji/operacji z
  mockiem krawędzi (SSR client, allowlist).

### Manual Testing Steps:

1. Zaloguj się jako admin, wejdź w detal zgłoszenia.
2. Zmień status w select → odśwież → status zachowany.
3. Kliknij „Usuń" → potwierdź → zgłoszenie znika, redirect na `/dashboard`.
4. Wyloguj się / inny origin → PATCH/DELETE zwraca 403.
5. SQL probe'y UPDATE/DELETE + column-grant backstop (Faza 5).

## Performance Considerations

Bez wpływu — pojedyncze mutacje po PK (`eq('id', id)`), brak nowych zapytań listowych.
`review_status` nie wchodzi do żadnego indeksu (brak filtrowania po nim w v1).

## Migration Notes

- Lokalnie: `npm run db:reset` (rebuild z migracji+seed) + `npm run db:gen-types`.
- **Prod NIE auto-aplikuje migracji**: po merge uruchom `supabase db push` na podłączonym
  prod-projekcie i potwierdź, że `SELECT version FROM supabase_migrations.schema_migrations`
  zawiera `20260619000000`. Zielony deploy app/worker NIE implikuje aktualnego schematu/RLS
  (lessons.md:131-136, CLAUDE.md Deploy).
- Backfill `review_status='new'` jest automatyczny (NOT NULL DEFAULT przy ADD COLUMN).

## References

- Change: `context/changes/admin-submission-triage/change.md`
- Test strategy: `@context/foundation/test-plan.md` (#1 access-control, #3 column-grant backstop)
- Lessons: `context/foundation/lessons.md` (REVOKE-FROM-PUBLIC no-op; push-migrations-to-prod)
- Wzorce: `src/pages/api/submissions.ts` (endpoint), `src/lib/submissions/submission-input.ts`
  (walidator), `src/pages/api/_submissions.test.ts` (test), `src/middleware.test.ts` (auth mock),
  `supabase/migrations/20260605000000_s01_department_optional_and_admin_allowlist_rls.sql` (RLS+grant),
  `supabase/tests/access-control-probes.sql` (DB-layer gate)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Migracja DB — kolumna `review_status` + granty + RLS

#### Automated

- [x] 1.1 Reset DB stosuje migracje czysto: `npm run db:reset` — ec4410c
- [x] 1.2 Typy zregenerowane i zawierają `review_status`: `npm run db:gen-types` — ec4410c
- [x] 1.3 Typecheck przechodzi: `npm run typecheck` — ec4410c

#### Manual

- [x] 1.4 `\d public.submissions` pokazuje `review_status` (NOT NULL, default `new`, CHECK) — ec4410c
- [x] 1.5 Istniejące wiersze mają `review_status = 'new'` (backfill) — ec4410c
- [x] 1.6 Polityki `submissions_admin_update`/`_delete` istnieją (pg_policies) — ec4410c

### Phase 2: Taksonomia TS + drift-guard

#### Automated

- [x] 2.1 Drift-guard przechodzi: `npx vitest run src/lib/submissions/taxonomies.drift.test.ts` — 0d45641
- [x] 2.2 Typecheck przechodzi: `npm run typecheck` — 0d45641
- [x] 2.3 Lint przechodzi: `npm run lint` — 0d45641

#### Manual

- [x] 2.4 Etykiety PL poprawne i kompletne dla 4 kodów — 0d45641

### Phase 3: Endpoint API `PATCH/DELETE /api/submissions/[id]`

#### Automated

- [x] 3.1 Test endpointu przechodzi: `npx vitest run src/pages/api/submissions/_id-endpoint.test.ts` — 43384a5
- [x] 3.2 Test walidatora przechodzi: `npx vitest run src/lib/submissions/review-status-input.test.ts` — 43384a5
- [x] 3.3 Pełny node-suite zielony: `npm test` — 43384a5
- [x] 3.4 Typecheck + lint: `npm run typecheck && npm run lint` — 43384a5

#### Manual

- [x] 3.5 (po Fazie 4) PATCH z sesją admina zmienia status, DELETE usuwa — 52d182e
- [x] 3.6 Żądanie bez sesji / z obcego origin → 403 — 52d182e

### Phase 4: UI island akcji na detalu

#### Automated

- [x] 4.1 Typecheck (astro check) przechodzi: `npm run typecheck` — 535f7c1
- [x] 4.2 Lint przechodzi: `npm run lint` — 535f7c1
- [x] 4.3 Build przechodzi: `npm run build` — 535f7c1

#### Manual

- [x] 4.4 Detal pokazuje badge bieżącego statusu (PL) — 535f7c1
- [x] 4.5 Zmiana statusu w select → status zapisany (po odświeżeniu) — 535f7c1
- [x] 4.6 „Usuń" → confirm → zgłoszenie znika, redirect na `/dashboard` — 535f7c1
- [x] 4.7 Anuluj w confirm → nic się nie dzieje — 535f7c1
- [x] 4.8 Lista dashboardu nadal działa bez client-JS (S-02 nienaruszone) — 535f7c1

### Phase 5: Bramka DB-layer (SQL probes) + smoke

#### Automated

- [x] 5.1 Skrypt wykonuje się: `psql "$DATABASE_URL" -f supabase/tests/access-control-probes.sql` — 52d182e

#### Manual

- [x] 5.2 Non-admin UPDATE `review_status` → 0 wierszy — 52d182e
- [x] 5.3 Admin UPDATE `review_status` → ≥1 wiersz — 52d182e
- [x] 5.4 Non-admin DELETE → 0 wierszy; admin DELETE → ≥1 wiersz (ROLLBACK) — 52d182e
- [x] 5.5 authenticated UPDATE `content` → ERROR 42501 (column-grant backstop) — 52d182e
- [x] 5.6 End-to-end smoke pod ZBUDOWANYM workerem (`wrangler dev -c dist/server/wrangler.json`, NIE `astro dev`; sesja admina): admin same-origin PATCH→200 i DELETE→200 (potwierdza `Origin == request.url.origin` na prod-hoście) — 52d182e
