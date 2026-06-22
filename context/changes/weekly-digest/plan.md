# S-05 Weekly Digest Implementation Plan

## Overview

W każdy poniedziałek rano cron Cloudflare wysyła adminom (allow-lista) plain-text mail
z liczbowym podsumowaniem zgłoszeń z minionego tygodnia kalendarzowego (Europe/Warsaw):
łączna liczba + breakdown wg tematyki i wg oddziału, plus link do dashboardu. Slice reużywa
istniejący agregat RPC, kanał email i scheduled handler — cała nowa logika domenowa ląduje
w `src/lib`, a `src/worker.ts` pozostaje cienkim wiringiem (spójnie ze wzorcem recovery-sweep).

## Current State Analysis

- **Scheduled handler już żyje**: `src/worker.ts:97-124`, cron `*/15 * * * *` (recovery sweep).
  Handler **nie rozgałęzia po cronie** (parametr to `_controller`) — to jedyny realnie nowy
  kawałek logiki sterującej w tym slice.
- **Agregaty gotowe**: RPC `public.dashboard_aggregates(p_from,p_to,p_branch) RETURNS jsonb`
  (`supabase/migrations/20260612000000_s02_dashboard_aggregates_rpc.sql`) + klient TS
  `fetchDashboardAggregates(supabase, range: ResolvedRange)` (`src/lib/dashboard/aggregates.ts:81-108`).
- **Email gotowy**: `sendEmail({to,subject,text,env})` (Resend przez `fetch`, env-gated no-op;
  `src/lib/notifications/email.ts:27-52`) + `resolveAlertRecipients(env)` (z `ALLOWED_ADMIN_EMAILS`,
  fail-closed; `src/lib/notifications/recipients.ts:16-18`).
- **DST-safe primitive gotowy**: `warsawDayStartUtc(dateStr)` (`src/lib/dashboard/range.ts:43-80`)
  zwraca UTC-instant północy warszawskiej; testowany zima/lato/dni przejścia DST.
- **Service-role client**: `createAdminClient(env)` (`src/lib/enrichment/supabase-admin.ts`) — omija
  RLS; używany przez sweep/queue.
- **Brak**: modułu digestu, poniedziałkowego crona, multi-cron dispatchu, oraz źródła absolutnego
  URL aplikacji w kontekście crona (S-04 brał origin z requestu — cron requestu nie ma).

## Desired End State

Po wdrożeniu: w poniedziałek o 07:00 UTC (08:00 Warszawa zimą / 09:00 latem) cron odpala digest;
jeśli w minionym tygodniu były zgłoszenia i jest co najmniej jeden recipient — admin dostaje
plain-text mail z liczbami + linkiem do `/dashboard`. Tydzień bez zgłoszeń → brak maila.
Recovery sweep działa bez zmian na swoim cronie. Weryfikacja: lokalnie przez in-worker fetch
hook (synthetic controller z `cron:"0 7 * * 1"`), na prod przez ręczne wyzwolenie crona na
active deployment.

### Key Discoveries:

- Handler trzeba rozgałęzić po `controller.cron` — dziś ignorowany (`src/worker.ts:97`).
- RPC jest `SECURITY INVOKER` + RLS-gated `is_allowed_admin()` → **cron MUSI wołać przez
  `createAdminClient(env)`** (grant `service_role EXECUTE` zostawiony celowo pod S-05 —
  `context/archive/2026-06-12-admin-dashboard-aggregates/reviews/impl-review.md:38`).
- `aggregates.byWeek` jest przykuty do `now() + 7 tyg.`, **niezależny od `p_from/p_to`** —
  dla digestu czytać `totalRange`/`byTopic`/`byBranch`, **NIE** `byWeek`
  (`supabase/migrations/20260612000000_…sql:57-66`).
- Sekrety w cronie czyta się z `env.*` wprost, **nie** przez `astro:env/server`
  (poza requestem zwraca `undefined`).
- Cron rejestruje się tylko ze **zbudowanego** `dist/server/wrangler.json` — `npm run build`
  przed deployem, potwierdzić obecność crona w zbudowanym configu (`context/foundation/lessons.md:96-101`).

## What We're NOT Doing

- **Brak dedup-store** (tabela/KV) — akceptujemy rzadki double-send przy redelivery crona
  (nice-to-have, Free tier rzadko dubluje, a skip-when-zero tnie najczęstszy przypadek).
- **Brak heartbeat-maila** w pusty tydzień — zero zgłoszeń ⇒ brak wysyłki.
- **Brak top-3 wg klasyfikacji AI** — `ai_classification` poza zakresem (count + by-topic + by-branch
  spełnia FR-017).
- **Brak treści/listy per-zgłoszenie w mailu** — tylko agregaty + link do `/dashboard` (anonimowość:
  zero surowej treści/podpisu/`ai_summary` w mailu).
- **Brak nowej migracji** — reuse RPC `dashboard_aggregates`.
- **Brak Slack/Teams** — email only.
- **Brak deep-linku z zakresem tygodnia** w URL dashboardu — link prowadzi do `/dashboard`.

## Implementation Approach

Logika domenowa (okno tygodnia, kompozycja maila, orkiestracja) w `src/lib` — w pełni
unit-testowalna w node-suite. `src/worker.ts` dostaje tylko dispatch po `controller.cron`,
wołający orkiestrator z service-role clientem. Cron dodany do `wrangler.jsonc`. Reużycie
`warsawDayStartUtc`, `fetchDashboardAggregates`, `sendEmail`, `resolveAlertRecipients`,
`createAdminClient` — bez ich modyfikacji.

## Critical Implementation Details

- **Timing & lifecycle.** Cron odpala w UTC; okno danych MUSI być policzone w handlerze przez
  `warsawDayStartUtc` (poprzedni poniedziałek 00:00 → ten poniedziałek 00:00, Warszawa), nigdy
  z czasu triggera. Handler obsługuje teraz **dwa** harmonogramy — dispatch po `controller.cron`
  (dziś ignorowany).
- **Service-role wymagany.** Digest woła RPC przez `createAdminClient(env)` — RLS-gate nie ma
  usera w cronie; user-JWT client zwróciłby 0 wierszy.
- **`byWeek` trap.** Ignoruj `aggregates.byWeek`; użyj `totalRange`/`byTopic`/`byBranch`.
- **Base URL.** Cron nie ma requestu — absolutny URL do linku bierz z env (`APP_BASE_URL`); gdy
  nieustawiony, pomiń linię z linkiem (graceful), nie wysadzaj maila.
- **Weryfikacja lokalna.** Tylko przez tymczasowy in-worker `fetch` hook wołający wyeksportowany
  `scheduled` z syntetycznym controllerem; wrangler scheduled endpoint jest nieużywalny na
  assets-enabled workerze (`context/foundation/lessons.md:82-87`). Build first; potwierdź marker
  w `dist/`.

## Phase 1: Logika digestu (okno + agregaty + builder maila)

### Overview

Czysta logika domenowa + unit-testy. Bez wiringu workera/crona — testowalne w node-suite.

### Changes Required:

#### 1. Okno poprzedniego tygodnia warszawskiego

**File**: `src/lib/dashboard/range.ts`

**Intent**: dodać funkcję liczącą poprzedni pełny tydzień kalendarzowy (pon–niedz) w strefie
Europe/Warsaw jako UTC-instanty, reużywając `warsawDayStartUtc`. To źródło `p_from/p_to` dla RPC.

**Contract**: `previousWarsawWeekRange(now: Date): ResolvedRange` — zwraca `ResolvedRange` z
`fromIso` = poprzedni poniedziałek 00:00 Warszawa (UTC ISO), `toIso` = ten poniedziałek 00:00
Warszawa (UTC ISO), `branch: null`, `preset: "custom"`, `label` pl-PL (np. „8–14 czerwca 2026").
Non-obvious: „poniedziałek tygodnia zawierającego (now − 7 dni)" liczyć po **warszawskim**
dniu tygodnia, nie po `getUTCDay()` na surowym `now` (różnica strefy może przesunąć dobę);
wyznacz datę kalendarzową Warszawy dla `now` (przez `Intl.DateTimeFormat` z `timeZone:"Europe/Warsaw"`),
cofnij do poniedziałku, odejmij 7 dni, a granice policz `warsawDayStartUtc`.

#### 2. Builder + orchestrator digestu

**File**: `src/lib/notifications/weekly-digest.ts` (nowy)

**Intent**: złożyć treść maila z agregatów i zorkiestrować wysyłkę; pominąć gdy brak recipientów
albo zero zgłoszeń w oknie. Wzorować na `new-submission-alert.ts` (builder czysty + orchestrator
w try/catch z logiem zdarzenia).

**Contract**:
- `buildWeeklyDigest(aggregates: DashboardAggregates, range: ResolvedRange, baseUrl: string | undefined): { subject: string; text: string }` —
  subject pl-PL z zakresem (np. „Tygodniowe podsumowanie zgłoszeń — 8–14 czerwca 2026"); text:
  `totalRange` + sekcja „wg tematyki" (po `byTopic`) + „wg oddziału" (po `byBranch`), linie
  `\n`-joined; linia `Dashboard: ${baseUrl}/dashboard` tylko gdy `baseUrl` zdefiniowany. Bez
  żadnych pól treści/`ai_summary`.
- `sendWeeklyDigest(env: Env, now: Date, deps?: { fetchImpl?: typeof fetch }): Promise<{ sent: boolean }>` —
  orkiestracja: `resolveAlertRecipients(env)` → guard pusty → `previousWarsawWeekRange(now)` →
  `fetchDashboardAggregates(createAdminClient(env), range)` → guard `totalRange === 0` →
  `buildWeeklyDigest(...)` → `sendEmail({to,subject,text,env,fetchImpl})` w try/catch
  (log `weekly_digest_sent` / `weekly_digest_skipped` / `weekly_digest_failed`). Zwraca `{sent}`.

#### 3. Env: base URL aplikacji

**File**: `src/worker-env.d.ts`, `.env.example`

**Intent**: dodać opcjonalny `APP_BASE_URL` (absolutny URL aplikacji) czytany w kontekście workera;
brak → digest pomija linię linku.

**Contract**: `APP_BASE_URL?: string` w globalnym `Env`; stub + komentarz w `.env.example`.

#### 4. Testy jednostkowe

**File**: `src/lib/dashboard/range.test.ts` (rozszerzenie), `src/lib/notifications/weekly-digest.test.ts` (nowy)

**Intent**: zapieczętować poprawność okna (DST) i kształt maila + warunki pominięcia.

**Contract**: `previousWarsawWeekRange` — poniedziałek zimowy (CET, +01:00), letni (CEST, +02:00),
tygodnie z przejściem DST (2026-03-29, 2026-10-25); `[pon, pon)` UTC poprawne. `buildWeeklyDigest`
— subject/text zawierają totale + tematyki + oddziały; link obecny gdy `baseUrl`, pominięty gdy
`undefined`; **brak** pól surowej treści. `sendWeeklyDigest` — skip (bez wołania `sendEmail`) gdy
zero recipientów oraz gdy `totalRange===0`; przy danych woła `sendEmail` z poprawnym `to/subject/text`
(mock agregatów + `fetchImpl`).

### Success Criteria:

#### Automated Verification:

- Unit testy przechodzą: `npx vitest run src/lib/dashboard/range.test.ts src/lib/notifications/weekly-digest.test.ts`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`

#### Manual Verification:

- Wyrenderowany text digestu dla przykładowego tygodnia czyta się poprawnie po polsku (subject + body)

**Implementation Note**: Po zielonych testach automatycznych zatrzymaj się na potwierdzenie manualne, zanim przejdziesz do Phase 2.

---

## Phase 2: Wiring crona + dispatch w worker.ts

### Overview

Dodanie poniedziałkowego crona i rozgałęzienie scheduled handlera; `worker.ts` pozostaje cienki.

### Changes Required:

#### 1. Cron trigger

**File**: `wrangler.jsonc`

**Intent**: zarejestrować poniedziałkowy cron obok istniejącego sweepu.

**Contract**: `"triggers": { "crons": ["*/15 * * * *", "0 7 * * 1"] }`.

#### 2. Dispatch po cronie

**File**: `src/worker.ts`, opcjonalnie `src/lib/scheduled/route-cron.ts` (nowy, czysty)

**Intent**: rozgałęzić `scheduled` po `controller.cron`: gałąź sweepu (istniejąca, bez zmian) vs
gałąź digestu (`sendWeeklyDigest(env, new Date())`). Dla testowalności node-side wydzielić czysty
`routeScheduledCron(cron: string): "sweep" | "digest" | "unknown"`.

**Contract**: `scheduled(controller, env, _ctx)` czyta `controller.cron`; `"*/15 * * * *"` → sweep,
`"0 7 * * 1"` → `await sendWeeklyDigest(env, new Date())`. Obie gałęzie awaitowane; brak `waitUntil`.

#### 3. Test routera + worker-suite

**File**: `src/lib/scheduled/route-cron.test.ts` (jeśli wydzielony)

**Intent**: zapieczętować mapowanie cron→job.

**Contract**: `routeScheduledCron` mapuje oba znane crony i `"unknown"` dla nieznanego.

### Success Criteria:

#### Automated Verification:

- Test routera przechodzi (jeśli wydzielony): `npx vitest run src/lib/scheduled/route-cron.test.ts`
- Workers-suite zielony (builduje first): `npm run test:workers`
- Typecheck + lint: `npm run typecheck && npm run lint`
- Zbudowany config niesie cron: `grep "0 7 \* \* 1" dist/server/wrangler.json`

#### Manual Verification:

- In-worker fetch hook (tymczasowy, wołający `scheduled` z `{cron:"0 7 * * 1"}`) odpala ścieżkę
  digestu: z zaseedowanymi danymi → mail do `onboarding@resend.dev` (sandbox); bez danych → log
  `weekly_digest_skipped`. Hook usunięty przed commitem.
- Recovery sweep nadal odpala się na swoim cronie (brak regresji).

**Implementation Note**: Po zielonych testach automatycznych zatrzymaj się na potwierdzenie manualne, zanim przejdziesz do Phase 3.

---

## Phase 3: Test-plan + deploy

### Overview

Dopisanie ryzyka S-05 do test-planu i wdrożenie na produkcję z weryfikacją crona i schematu DB.

### Changes Required:

#### 1. Aktualizacja test-planu

**File**: `context/foundation/test-plan.md`

**Intent**: odzwierciedlić S-05 w strategii testów per konwencja projektu.

**Contract**: dodać wiersz ryzyka S-05 do §2 (np. „digest: złe okno tygodnia / wyciek treści w
mailu / podwójna wysyłka"), notkę do §3 (faza/zakres), oraz zdjąć S-05 z §7 „czego świadomie
nie testujemy" (przenieść z „póki niewdrożone").

#### 2. Deploy + weryfikacja prod

**File**: — (operacja deploy, nie edycja pliku)

**Intent**: zbudować i wdrożyć worker z nowym cronem; potwierdzić prerekwizyty prod.

**Contract**: `npm run build` → `wrangler deploy`. Przed/po: potwierdzić że prod Supabase ma
migrację `20260612` (RPC) — `SELECT version FROM supabase_migrations.schema_migrations`; brak →
`supabase db push` (lekcja S-04). Ustawić sekrety prod: `RESEND_API_KEY`, `ALERT_FROM`,
`ALLOWED_ADMIN_EMAILS`, `APP_BASE_URL`.

### Success Criteria:

#### Automated Verification:

- Pełna node-suite: `npm test`
- Workers-suite: `npm run test:workers`
- Typecheck + lint: `npm run typecheck && npm run lint`

#### Manual Verification:

- `test-plan.md` odzwierciedla S-05 (§2/§3/§7) — review
- Prod `schema_migrations` zawiera `20260612` (RPC istnieje na prod)
- Sekrety prod ustawione (`RESEND_API_KEY`, `ALERT_FROM`, `ALLOWED_ADMIN_EMAILS`, `APP_BASE_URL`)
- `wrangler deploy` OK; cron `0 7 * * 1` widoczny w deployments/dashboard
- Ręczne wyzwolenie crona na active deployment → mail digestu dociera (lub `weekly_digest_skipped` gdy pusty tydzień)

---

## Testing Strategy

### Unit Tests:

- `previousWarsawWeekRange`: granice tygodnia zima/lato + dni przejścia DST (2026-03-29, 2026-10-25).
- `buildWeeklyDigest`: kształt subject/text, totale + tematyki + oddziały, link obecny/pominięty, brak surowej treści.
- `sendWeeklyDigest`: skip-when-zero, skip-when-no-recipients, happy-path woła `sendEmail` z poprawnym payloadem.
- `routeScheduledCron`: mapowanie cron→job.

### Integration Tests:

- Workers-suite (`test:workers`) pozostaje zielony po dodaniu dispatchu (brak regresji sweepu).

### Manual Testing Steps:

1. `npm run build`; potwierdź oba crony w `dist/server/wrangler.json`.
2. Tymczasowy in-worker fetch hook woła `scheduled` z `{cron:"0 7 * * 1"}`; zaseeduj 2-3 zgłoszenia
   w oknie minionego tygodnia → potwierdź mail (sandbox). Wyzeruj → potwierdź `weekly_digest_skipped`.
3. Usuń hook; potwierdź recovery sweep nadal działa na `*/15`.
4. Po deployu: ręcznie wyzwól cron na active deployment, potwierdź dostarczenie.

## Performance Considerations

Pomijalne: jedno wywołanie RPC + jeden mail raz w tygodniu. RPC agreguje po indeksowanych
predykatach `enrichment_status = 'done'`.

## Migration Notes

Brak nowej migracji — reuse RPC `dashboard_aggregates` (`20260612`). Jedyny prerekwizyt DB to
obecność tej migracji na prod (weryfikacja w Phase 3).

## References

- Research: `context/changes/weekly-digest/research.md`
- Agregaty: `src/lib/dashboard/aggregates.ts:81-131`, `supabase/migrations/20260612000000_s02_dashboard_aggregates_rpc.sql`
- DST helper: `src/lib/dashboard/range.ts:43-80`
- Email: `src/lib/notifications/{email.ts:27-52,recipients.ts:16-18,new-submission-alert.ts:31-64}`
- Scheduled handler: `src/worker.ts:97-124`; cron config: `wrangler.jsonc:20-22`
- Lekcje: `context/foundation/lessons.md:82-101,131-136`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Logika digestu (okno + agregaty + builder maila)

#### Automated

- [x] 1.1 Unit testy przechodzą: `npx vitest run src/lib/dashboard/range.test.ts src/lib/notifications/weekly-digest.test.ts` — 56ee586
- [x] 1.2 Typecheck: `npm run typecheck` — 56ee586
- [x] 1.3 Lint: `npm run lint` — 56ee586

#### Manual

- [x] 1.4 Text digestu czyta się poprawnie po polsku (subject + body) dla przykładowego tygodnia — 56ee586

### Phase 2: Wiring crona + dispatch w worker.ts

#### Automated

- [x] 2.1 Test routera przechodzi (jeśli wydzielony): `npx vitest run src/lib/scheduled/route-cron.test.ts` — a6a9fee
- [x] 2.2 Workers-suite zielony: `npm run test:workers` — a6a9fee
- [x] 2.3 Typecheck + lint: `npm run typecheck && npm run lint` — a6a9fee
- [x] 2.4 Zbudowany config niesie cron: `grep "0 7 \* \* 1" dist/server/wrangler.json` — a6a9fee

#### Manual

- [x] 2.5 In-worker hook odpala ścieżkę digestu (mail przy danych / skip przy zerze), hook usunięty przed commitem — a6a9fee
- [x] 2.6 Recovery sweep nadal działa na `*/15` (brak regresji) — a6a9fee

### Phase 3: Test-plan + deploy

#### Automated

- [x] 3.1 Pełna node-suite: `npm test` — 8522b07
- [x] 3.2 Workers-suite: `npm run test:workers` — 8522b07
- [x] 3.3 Typecheck + lint: `npm run typecheck && npm run lint` — 8522b07

#### Manual

- [x] 3.4 `test-plan.md` odzwierciedla S-05 (§2/§3/§7)
- [x] 3.5 Prod `schema_migrations` zawiera `20260612` (RPC na prod)
- [x] 3.6 Sekrety prod ustawione (RESEND_API_KEY, ALERT_FROM, ALLOWED_ADMIN_EMAILS, APP_BASE_URL)
- [x] 3.7 `wrangler deploy` OK; cron `0 7 * * 1` zarejestrowany
- [~] 3.8 Ręczne wyzwolenie crona na active deployment → mail dociera (lub skip gdy pusty tydzień) — 2026-06-22: ROOT CAUSE pierwszego nieodpalenia = cron `0 7 * * 1` nigdy nie zarejestrowany na aktywnym deploymencie. Deploy upload-wersji / secret-change NIE aplikuje `triggers.crons` z configu; trwał tylko stary `*/15` z wcześniejszego pełnego `wrangler deploy`. Dowód: eksport Observability (pon 01:15→07:00 UTC) — wyłącznie `*/15`, zero `0 7 * * 1`/`weekly_digest*`/`scheduled_unknown_cron`; przy ticku 07:00 poszedł tylko sweep. Brak Sentry = oczekiwany (catch-all w `sendWeeklyDigest`, nie re-throw). Fix: `npx wrangler triggers deploy -c dist/server/wrangler.json` → output potwierdza oba crony (`*/15` + `0 7 * * 1`). Kanał maila zweryfikowany pośrednio: S-04 instant-notify dochodzi na prod (ten sam `sendEmail`/`from`/odbiorcy). Pozostaje ŻYWE potwierdzenie przy pierwszym realnym firingu: **pon 2026-06-29 07:00 UTC**. Trwały fix (pipeline): „Deploy command" w Workers Builds musi aplikować triggery (`wrangler deploy -c dist/server/wrangler.json`) albo dodać krok `wrangler triggers deploy` — do dokończenia po odczycie obecnej komendy.
