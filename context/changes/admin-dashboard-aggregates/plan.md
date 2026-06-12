# Admin Dashboard z Agregatami (S-02) — Implementation Plan

## Overview

S-02 zamienia placeholder `/dashboard` w jednostronicowy panel agregatów: KPI (licznik w
wybranym zakresie, łącznie od początku, sentyment neg. %), donut tematyk (FR-011), poziome
słupki oddziałów (FR-012), pierścień sentymentu, trend tygodniowy (stałe 8 tygodni) oraz
listę 100 najnowszych zgłoszeń z AI-podsumowaniem klikalną do detail view z S-01 (FR-013).
Całość sterowana globalnym filtrem czasu (FR-010: kroczące 24h/7d/30d/365d + custom range,
default 30 dni) i filtrem oddziału — w pełni SSR przez query params, **zero JS po stronie
klienta, zero bibliotek wykresów** (inline SVG + Tailwind wg `design/design.md`).

## Current State Analysis

- `src/pages/dashboard.astro` — placeholder (karta powitalna + sign-out); jedyny realny
  widok admina to detail view `src/pages/dashboard/submissions/[id].astro:21` czytający
  przez session-bound klienta SSR (`createClient(Astro.request.headers, Astro.cookies)`),
  RLS-gated przez `is_allowed_admin()`.
- Middleware (`src/middleware.ts:6`) guarduje prefix `/dashboard` (redirect nie-admina do
  `/auth/signin`); macierz w `src/middleware.test.ts` pokrywa pod-trasy.
- Warstwa danych jest gotowa od F-01 — indeksy z komentarzami wprost pod S-02
  (`supabase/migrations/20260528000000_create_submissions.sql:85-100`):
  `submissions_created_at_desc_idx` (FR-010), composite `(enrichment_status, created_at DESC)`
  (FR-013), partial `topic`/`branch WHERE enrichment_status='done'` (FR-011/012).
- Taksonomie: `src/lib/submissions/taxonomies.ts` — `TOPICS` (4: Pomysł/Problem/
  Usprawnienie/Inne), `BRANCHES` (9), `TONES` (3), `CLASSIFICATIONS` (5, AI). CHECK-i w
  migracji są z nimi zsynchronizowane (drift guard z Phase 2 test-planu).
- Brak: listy zgłoszeń, jakichkolwiek agregatów (RPC/view nie istnieją), biblioteki
  wykresów i dat (celowo — design.md zakazuje chart-libów), fontu Lato (S-01 jawnie
  odłożył load do S-02 — `src/pages/dashboard/submissions/[id].astro:11-13`), tokenów
  `@theme` dla palety Sewera (detail view używa hexów inline).
- `design/` zawiera kompletny system wizualny: `design.md` (receptury §4.2: TopBar,
  KPICard, BranchChart, SentimentRing, zebra-tabele) + mockupy PNG. Mockup „Przegląd" to
  wzór layoutu; zakładki Tematy/Procesy i „Top procesy" to non-goals PRD (v2).

## Desired End State

Admin po zalogowaniu widzi na `/dashboard` pełny widok „Przegląd": 3 karty KPI, słupki
oddziałów, donut tematyk, pierścień sentymentu, trend 8 tygodni i listę zgłoszeń — wszystko
policzane wyłącznie po wierszach `enrichment_status='done'` (FR-008), przefiltrowane
wybranym zakresem czasu i (opcjonalnie) oddziałem, z poprawnymi liczbami przy dowolnej
liczbie wierszy. Zmiana filtra = nawigacja GET (URL shareable). Klik w wiersz listy
otwiera detail view S-01. Wszystkie etykiety AI (sentyment, AI-tytuł/podsumowanie) niosą
disclaimer (NFR). Weryfikacja: testy jednostkowe logiki agregatów zielone, probe SQL
potwierdza RLS na RPC, widok zgodny z mockupem na seedzie lokalnym.

### Key Discoveries:

- Indeksy pod S-02 istnieją od F-01 z komentarzami FR-010/011/012
  (`supabase/migrations/20260528000000_create_submissions.sql:85-100`) — zero zmian schematu tabeli.
- Partial indexes wymagają `.eq("enrichment_status", "done")`, nigdy `.in([...])`
  (`context/foundation/lessons.md:33-38`).
- FR-011 parenthetical (5 wartości) to relikt sprzed driftu taksonomii — podział robimy po
  `topic` (4 wartości pracownika; decyzja usera w tej sesji planowania); design.md §1.1 ma
  kolory/ikony dokładnie dla tych 4 wartości.
- `design/design.md:8` — „Wykresy są budowane ręcznie (div-y + inline SVG) — brak biblioteki
  chartów"; receptura pierścienia (SentimentRing §4.2) jest gotowa do reużycia dla donuta tematyk.
- PostgREST nie robi GROUP BY bez RPC, a domyślny `max_rows=1000` Supabase ucina fetch-all
  po cichu (błędne liczniki dla zakresu rocznego) — agregaty muszą policzyć się w SQL.
- Supabase auto-grantuje EXECUTE na nowych funkcjach rolom `anon`/`authenticated` wprost —
  REVOKE musi wymieniać role jawnie (`context/foundation/lessons.md:75-80`).
- S-05 (weekly digest) wg roadmapy „re-używa agregacji z dashboardu" — RPC wywoływalne
  service-role'em jest tym punktem reużycia.

## What We're NOT Doing

- Zakładek Tematy (AI-parafrazy) i Procesy z mockupu — grupowanie/meta-pomysły to non-goal
  PRD (v2); TabNav nie powstaje, widok jest jeden.
- Paginacji listy (limit 100 + licznik „pokazano X z N" zamiast), eksportów (PDF/CSV),
  real-time/live updates — non-goals PRD.
- Żadnych wysp React na dashboardzie ani liczenia/filtrowania danych po stronie klienta —
  to utrzymuje negative space test-planu §7 (brak E2E; trigger re-ewaluacji NIE odpala).
- Zmian w detail view `[id].astro` (hexy inline zostają; migracja na tokeny `@theme` to
  osobny, opcjonalny refactor poza S-02).
- Indeksu na `ai_tone` i innych „hardenów" pod przyszłe query — skala (≤ setki wierszy/m-c)
  tego nie uzasadnia (lesson: don't harden a consumer that doesn't exist).
- Cache'owania agregatów — PRD: dashboard odświeża się przy załadowaniu strony.
- Filtra po `department` i po `ai_classification` — poza decyzjami tej sesji.

## Implementation Approach

Jedna funkcja SQL `dashboard_aggregates(p_from, p_to, p_branch)` (SECURITY INVOKER — RLS
`is_allowed_admin()` gateuje wiersze, defense-in-depth jak w detail view) zwraca jednym
round-tripem wszystkie agregaty: total w zakresie, total od początku, group-by topic /
branch / ai_tone oraz 8 tygodniowych kubełków (`date_trunc` w Europe/Warsaw — DST-safe).
Lista zgłoszeń idzie osobnym zapytaniem PostgREST pod composite index. Moduł
`src/lib/dashboard/` trzyma całą logikę (parsowanie parametrów, granice dni Warsaw,
mapper dosypujący zera z taksonomii, geometria łuków donuta) jako czyste, testowalne
funkcje — strona `.astro` jest cienka. UI w dwóch fazach (szkielet+lista, potem wykresy)
wg receptur `design/design.md` §4.2, wykonanie wspierane pluginem
`frontend-design:frontend-design` z mockupami PNG jako referencją.

## Critical Implementation Details

- **Grant hygiene RPC**: po `CREATE FUNCTION` jawnie
  `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated;` potem `GRANT EXECUTE ... TO authenticated;`
  (auto-grant Supabase trafia role wprost — lessons.md:75-80). `service_role` zachowuje
  swój domyślny grant (potrzebny dla S-05). Funkcja MUSI być SECURITY INVOKER — DEFINER
  ominąłby RLS i otworzył agregaty każdemu zalogowanemu (ryzyko #1 test-planu).
- **Zero-fill: podział odpowiedzialności**: `jsonb_object_agg` zwraca tylko obecne klucze —
  mapper w TS dosypuje zera dla `TOPICS`/`BRANCHES`/`TONES` (test pinuje pełen kształt).
  `by_week` jest wyjątkiem: zero-fill i matematyka tygodni (Warsaw, ISO) żyją WYŁĄCZNIE
  w SQL (`generate_series` + `to_char(…, 'IW')`) — mapper nie buduje kubełków, tylko
  waliduje, że przyszło dokładnie 8. Nigdy nie implementuj tygodni po obu stronach —
  rozjazd kluczy po cichu zeruje kubełek na wykresie.
- **Lista pod partial/composite index**: `.eq("enrichment_status", "done")` — nigdy
  `.in(["done"])` (lessons.md:33-38); sortowanie `created_at DESC` + `.limit(100)`.
- **Tailwind v4 token `--color-teal`**: definicja w `@theme` nadpisuje TYLKO goły utility
  `teal` (design.md używa `text-teal`); odcienie `teal-500` itd. zostają z palety — nie
  „naprawiać" tego.
- **Manualna weryfikacja lokalna**: przed `wrangler dev` zawsze `npm run build` i
  potwierdzenie, że build się ukończył (lessons.md: stale-bundle po EPERM na Windows).
- **Brak JS klienta jest kontraktem**: filtry to linki + formularz GET z przyciskiem
  „Zastosuj" (bez auto-submit-on-change wymagającego JS). Jeśli w trakcie implementacji
  pojawi się pokusa wyspy React — to zmiana decyzji testowej (§7) i wymaga powrotu do plana.

---

## Phase 1: Agregaty — migracja RPC, moduł `src/lib/dashboard/`, testy

### Overview

Cała warstwa danych i logiki: funkcja SQL agregatów z poprawnymi grantami i probe'em RLS,
regeneracja typów, moduł lib z parsowaniem zakresów (Europe/Warsaw) i mapowaniem wyników,
testy jednostkowe. Po tej fazie `npx vitest run src/lib/dashboard/` jest zielone, a
`SELECT public.dashboard_aggregates(...)` na lokalnym seedzie zwraca sensowny JSON.

### Changes Required:

#### 1. Migracja: funkcja agregatów

**File**: `supabase/migrations/20260612000000_s02_dashboard_aggregates_rpc.sql`

**Intent**: Jedna funkcja SQL liczy wszystkie agregaty dashboardu jednym round-tripem,
wyłącznie po wierszach `done` (FR-008), z opcjonalnym filtrem oddziału; RLS pozostaje
jedyną bramą dostępu do wierszy.

**Contract**: `public.dashboard_aggregates(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL) RETURNS jsonb`,
`LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp`. Zwraca obiekt
z kluczami: `total_range` (count done w `[p_from, p_to)` + branch), `total_all` (count done,
branch, bez zakresu), `by_topic` / `by_branch` / `by_tone` (jsonb_object_agg po GROUP BY;
`by_tone` pomija `ai_tone IS NULL`), `by_week` (tablica DOKŁADNIE 8 elementów
`{week_start, iso_week, count}`: `generate_series` po początkach tygodni
`date_trunc('week', now() AT TIME ZONE 'Europe/Warsaw') - interval '7 weeks' … '0 weeks'`
LEFT JOIN zliczeń po `date_trunc('week', created_at AT TIME ZONE 'Europe/Warsaw')`,
`iso_week = to_char(week_start, 'IW')`, `coalesce(count, 0)`, jawny `ORDER BY week_start`
w `jsonb_agg` — zero-fill i CAŁA matematyka tygodni żyją wyłącznie w SQL; okno trendu jest
STAŁE, niezależne od `p_from`/`p_to`; filtr `p_branch` obowiązuje). Wszystkie predykaty używają
`enrichment_status = 'done'` (równość — zgodność z partial indexes). Po definicji: REVOKE/GRANT
wg Critical Implementation Details. Komentarz nagłówkowy dokumentuje INVOKER-by-design.

#### 2. Probe RLS dla funkcji

**File**: `supabase/tests/access-control-probes.sql`

**Intent**: Domknąć ryzyko #1 — potwierdzić, że RPC nie omija RLS: nie-admin dostaje
zera (nie błąd), anon dostaje 42501 na EXECUTE.

**Contract**: Append „Probe 6" w konwencji pliku (SET LOCAL ROLE + claims): (a) authenticated
spoza allow-listy → `total_range = 0` mimo zaseedowanego wiersza `done`; (b) admin z
allow-listy → `total_range ≥ 1`; (c) `SET LOCAL ROLE anon; SELECT public.dashboard_aggregates(...)`
→ ERROR 42501 (błąd JEST passem). Przypadek (c) MUSI iść w osobnym bloku BEGIN…ROLLBACK
(precedens Probe 3 — błąd przerywa transakcję i ubiłby wyniki (a)/(b) w tym samym bloku).
Zaktualizować nagłówkowy spis probe'ów.

#### 3. Regeneracja typów

**File**: `src/lib/database.types.ts` (generowany)

**Intent**: `npm run db:gen-types` po `npm run db:reset` — sekcja `Functions` zyskuje
`dashboard_aggregates`. Nie edytować ręcznie.

**Contract**: Diff zawiera wyłącznie wygenerowaną sygnaturę funkcji.

#### 4. Parsowanie i rozwiązywanie zakresu czasu

**File**: `src/lib/dashboard/range.ts` (nowy)

**Intent**: Czysta logika FR-010: presety kroczące, custom range w granicach dni
Europe/Warsaw, walidacja parametrów URL z bezpiecznym fallbackiem — bez żadnej biblioteki dat.

**Contract**: `resolveRange(now: Date, params: URLSearchParams): ResolvedRange` gdzie
`ResolvedRange = { preset: "24h"|"7d"|"30d"|"1y"|"custom", fromIso: string, toIso: string, branch: Branch|null, label: string }`.
Zasady: presety = `now − {24h, 7×24h, 30×24h, 365×24h}` do `now`; default `30d`; `custom`
wymaga OBU poprawnych dat `from`/`to` (`YYYY-MM-DD`, `from ≤ to`) — inaczej cichy fallback
do defaultu; granice custom: `[warsawDayStartUtc(from), warsawDayStartUtc(to + 1 dzień))`;
`branch` walidowany przeciw `BRANCHES`, nieznany → `null`. Pomocnik
`warsawDayStartUtc(dateStr: string): Date` liczy UTC-instant północy Europe/Warsaw przez
`Intl.DateTimeFormat` (offset z `formatToParts`) — snippet, bo to jedyny nieoczywisty kawałek:

```ts
// Offset Warszawy dla danej doby pobieramy z Intl (DST-safe, zero zależności):
// format daty w strefie Europe/Warsaw z timeZoneName:"longOffset" → "GMT+02:00",
// parsujemy ±HH:MM i odejmujemy od północy UTC tej daty.
```

`label` = czytelny opis zakresu pl-PL do chipa w TopBar (np. „Ostatnie 30 dni · 13 maj – 12 cze 2026").

#### 5. Wywołanie RPC, mapper i query listy

**File**: `src/lib/dashboard/aggregates.ts` (nowy)

**Intent**: Jedyne miejsce, które rozmawia z Supabase dla dashboardu: woła RPC, mapuje
jsonb na pełny, zero-filled kształt dla UI, pobiera listę zgłoszeń.

**Contract**:
- `fetchDashboardAggregates(supabase, range): Promise<DashboardAggregates>` —
  `DashboardAggregates = { totalRange: number, totalAll: number, byTopic: Record<Topic, number>, byBranch: Record<Branch, number>, byTone: Record<Tone, number>, byWeek: Array<{ weekStartIso: string, isoWeek: string, count: number }>, negPct: number | null }`.
  Mapper dosypuje zera ze stałych `TOPICS`/`BRANCHES`/`TONES`; `byWeek` jest pass-through
  z RPC (SQL zwraca gotowe, zero-filled 8 kubełków — mapper tylko waliduje `length === 8`
  i rzuca przy innym kształcie, NIE liczy żadnej matematyki tygodni),
  `negPct = round(100 × Negatywny / totalRange)` albo `null`
  gdy `totalRange === 0` (UI pokazuje „—", nie NaN).
- `fetchSubmissionsList(supabase, range, limit = 100): Promise<SubmissionListItem[]>` —
  select `id, created_at, branch, topic, ai_title, ai_summary, ai_tone`,
  `.eq("enrichment_status", "done")` + `.gte/.lt(created_at)` + opcjonalne `.eq("branch", b)`,
  `.order("created_at", { ascending: false })`, `.limit(limit)`.
- Błąd RPC/selecta propaguje wyjątkiem (strona pokaże stan błędu z retry per design §4.2) —
  bez cichych pustych danych.

#### 6. Testy jednostkowe modułu

**File**: `src/lib/dashboard/range.test.ts`, `src/lib/dashboard/aggregates.test.ts` (nowe)

**Intent**: Test-plan: „dane agregatów się zgadzają — test logiki" + krawędzie TZ.
Wzorzec mockowania na krawędzi (jak `src/pages/api/_submissions.test.ts`) — mock klienta
Supabase, nie modułów wewnętrznych.

**Contract**: range: każdy preset, default przy braku/śmieciowych parametrach, custom
poprawny / niepełny / `from > to` → fallback, `warsawDayStartUtc` dla dat zimowych (+01:00),
letnich (+02:00) i dób przejścia DST (2026-03-29, 2026-10-25), walidacja branch.
aggregates: zero-fill pełnego kształtu topic/branch/tone przy pustym jsonb, `negPct`
(wartość, zaokrąglenie, `null` przy 0), `byWeek` pass-through z walidacją `length === 8`
(błąd przy innym kształcie — pin kontraktu SQL), builder listy ustawia `.eq` na
statusie (pin lekcji partial-index) i wszystkie filtry, propagacja błędu RPC.

### Success Criteria:

#### Automated Verification:

- Migracja aplikuje się czysto: `npm run db:reset`
- Typy zregenerowane bez ręcznych edycji: `npm run db:gen-types` (diff tylko `Functions`)
- Testy modułu zielone: `npx vitest run src/lib/dashboard/`
- Pełna suita node zielona: `npm test`
- Typecheck przechodzi: `npm run typecheck`
- Lint przechodzi: `npm run lint`

#### Manual Verification:

- Probe 6 w `supabase/tests/access-control-probes.sql` daje oczekiwane wyniki (non-admin → 0, admin → ≥1, anon → 42501)
- `SELECT public.dashboard_aggregates(now() - interval '30 days', now(), NULL);` na lokalnym seedzie zwraca spójny JSON (suma `by_topic` = `total_range`)

**Implementation Note**: Po ukończeniu fazy i zielonych bramkach automatycznych zatrzymaj
się na manualne potwierdzenie probe'ów zanim ruszy Phase 2.

---

## Phase 2: Szkielet UI — tokeny, Lato, TopBar + filtry, KPI, lista (FR-010 + FR-013)

### Overview

Przebudowa `/dashboard` na realny widok: tokeny `@theme` palety Sewera, font Lato, TopBar
z filtrem oddziału i chipem zakresu, pasek presetów czasu + custom range (GET, bez JS),
3 karty KPI i pełna lista zgłoszeń. Po tej fazie FR-010 i FR-013 działają end-to-end;
miejsca na wykresy z Phase 3 mają placeholdery. UI wykonywane z pluginem
`frontend-design:frontend-design`, z `design/dashboard-przegląd.PNG` + `design.md` §4.2
jako referencją.

### Changes Required:

#### 1. Tokeny designu i font dashboardu

**File**: `src/styles/global.css`, `package.json`

**Intent**: Domknąć dług z S-01 („loading the webfont is an S-02 concern") i dać nowym
komponentom semantyczne klasy zamiast hexów inline.

**Contract**: `npm i @fontsource/lato` (importy wag 400/700/900 w `global.css`, wzorzec jak
dm-sans). W bloku `@theme`: `--font-lato`, `--color-sewera-primary: #0176D0`,
`--color-sewera-cta: #006BBB`, `--color-sewera-dark: #15377B`, `--color-success: #44872E`,
`--color-warning: #DB6600`, `--color-danger: #FF0000`, `--color-teal: #299FAB`
(design.md §3.1; uwaga z Critical Details o gołym `teal`). Świat formularza (dark/emerald)
nietknięty — zasada §5.1 „nie mieszaj światów".

#### 2. Strona dashboardu

**File**: `src/pages/dashboard.astro` (przebudowa)

**Intent**: Cienki frontmatter: `resolveRange` z `Astro.url.searchParams`, klient SSR
(jak detail view — RLS gate), `Promise.all([fetchDashboardAggregates, fetchSubmissionsList])`,
render widoku w świecie light/Lato/sewera. Stan błędu zapytań → komunikat + przycisk
„Spróbuj ponownie" (recipe §4.2 retry), nie pusta strona.

**Contract**: Layout per mockup: TopBar (chip „Sewera", podtytuł „Hub Sugestii — dashboard",
po prawej select oddziału + chip zakresu, sign-out przeniesiony z placeholdera); pod nim
pasek filtra czasu: presety `24h / Tydzień / Miesiąc / Rok` jako linki GET zachowujące
`branch` + sekcja custom (dwa natywne `<input type="date">` + przycisk „Zastosuj" w jednym
formularzu GET z selectem oddziału); kontener `max-w-[1100px]`; rząd 3 kart KPI
(„Wpisy — wybrany zakres" `totalRange`, „Łącznie od początku" `totalAll`,
„Sentyment neg." `negPct ?? "—"` + mikro-disclaimer AI); grid `grid-cols-[1fr_340px]`
z placeholderami kart wykresów (Phase 3); pełnoszerokie `<SubmissionsList>`; stopka.
Parametry URL: `?range=24h|7d|30d|1y|custom&from=&to=&branch=`. Strona NIE liczy nic
sama — wszystkie liczby przychodzą z modułu lib.

#### 3. Lista zgłoszeń

**File**: `src/components/dashboard/SubmissionsList.astro` (nowy)

**Intent**: FR-013 — zebra-lista wierszy klikalnych do detail view, z AI-podsumowaniem
i disclaimerem AI na nagłówku karty (NFR), licznikiem „pokazano X z N" w stopce.

**Contract**: Props: `items: SubmissionListItem[]`, `totalRange: number`. Karta z
SectionHeader (recipe §4.2) + badge „AI-generated, może być stronnicze" (wzorzec z detail
view). Wiersz = `<a href="/dashboard/submissions/{id}">`: kropka tonu (paleta §1.1),
chip tematyki (ikona+kolor §1.1 „Kolory kategorii"), `ai_title` bold (fallback: topic gdy
null), `ai_summary` `text-[13px]` (fallback: początek treści nie jest dostępny — pokaż „—"),
po prawej oddział + data `toLocaleString("pl-PL")`. Zebra + separatory wg §5.6. Pusty
zakres → komunikat „Brak zgłoszeń w wybranym zakresie". Stopka: „pokazano min(100, N) z N".

### Success Criteria:

#### Automated Verification:

- Testy zielone: `npm test`
- Typecheck przechodzi: `npm run typecheck`
- Lint przechodzi: `npm run lint`
- Build przechodzi: `npm run build`

#### Manual Verification:

- Widok zgodny z mockupem (TopBar/KPI/lista) na seedzie lokalnym (`npm run build` + `wrangler dev`)
- Filtry działają przez URL: presety, custom range, branch — odświeżenie strony zachowuje stan; default = 30 dni
- Klik w wiersz listy otwiera detail view S-01; powrót wstecz przeglądarki zachowuje stan filtrów (URL GET), a link „wróć" detail view świadomie wraca do widoku domyślnego (detail view nietknięty)
- Nie-admin / niezalogowany nadal dostaje redirect (middleware nietknięty)
- Wpisy `pending`/`failed` nie pojawiają się nigdzie (FR-008)
- Widok używalny na szerokości mobilnej (NFR; grid zwija się do 1 kolumny `max-lg`)

**Implementation Note**: Po zielonych bramkach zatrzymaj się na manualne potwierdzenie
wizualne zanim ruszy Phase 3.

---

## Phase 3: Wykresy — DonutRing (tematyki + sentyment), BranchChart, WeeklyChart (FR-011 + FR-012 + extras)

### Overview

Geometria łuków jako czysta funkcja + cztery karty wykresów wpięte w grid strony:
donut tematyk (FR-011), słupki oddziałów (FR-012), pierścień sentymentu i trend 8 tygodni.
Stany puste. UI nadal zero-JS, inline SVG wg receptur §4.2.

### Changes Required:

#### 1. Geometria donuta

**File**: `src/lib/dashboard/donut.ts`, `src/lib/dashboard/donut.test.ts` (nowe)

**Intent**: Policzalna, testowalna matematyka pierścienia (recipe „SentimentRing" §4.2) —
SVG strokes z dasharray/dashoffset, start od góry.

**Contract**: `donutSegments(values: Array<{ value: number; color: string }>, r = 54): Segment[]`
gdzie `Segment = { color, dasharray, dashoffset }`; obwód `2πr`, start `offset = obwód × 0.25`,
kolejne offsety kumulują poprzednie segmenty, segmenty `value === 0` pominięte. Testy
pinują: sumę dasharray = obwód, pojedynczy niezerowy segment = pełne koło, wszystkie zera
→ pusta tablica (UI pokazuje sam tor `#E8E8E8` + „brak danych").

#### 2. Komponent pierścienia (współdzielony)

**File**: `src/components/dashboard/DonutRing.astro` (nowy)

**Intent**: Jeden komponent dla obu pierścieni (tematyki i sentyment) — różnią się tylko
danymi, kolorami i legendą.

**Contract**: Props: `segments` (z `donutSegments`), `centerValue`, `centerLabel`,
`legend: Array<{ label, value, pct, color }>`. SVG `viewBox 0 0 128 128`, `strokeWidth 14`,
`strokeLinecap round`, tor `#E8E8E8`; centrum `text-[22px] font-extrabold text-sewera-dark`;
legenda wg recipe. Karta tematyk: kolory kategorii §1.1, bez disclaimera (pole pracownika).
Karta „Sentyment": kolory `#44872E/#FF0000/#D6D6D6` + badge disclaimera AI w nagłówku karty (NFR).

#### 3. Słupki oddziałów

**File**: `src/components/dashboard/BranchChart.astro` (nowy)

**Intent**: FR-012 — poziome słupki per oddział wg recipe „Słupek poziomy (BranchChart)".

**Contract**: Props: `byBranch: Record<Branch, number>`. Wiersze posortowane malejąco po
liczbie, wszystkie oddziały włącznie z zerami; szerokość = `count/max×100%` (guard `max ≥ 1`);
etykieta `w-[90px]`, wartość `text-sewera-dark`. Przy aktywnym filtrze oddziału widget
pokazuje jeden słupek (semantyka jednolita — bez wyjątków). Segmentowane paski neg/innow
z mockupu POMIJAMY (tone-per-branch wymagałoby dodatkowego wymiaru agregacji — poza zakresem).

#### 4. Trend tygodniowy

**File**: `src/components/dashboard/WeeklyChart.astro` (nowy)

**Intent**: Słupki pionowe ostatnich 8 tygodni wg recipe „WeeklyChart" — stałe okno,
niezależne od filtra czasu (komunikuje to podtytuł karty „ostatnie 8 tygodni").

**Contract**: Props: `byWeek: Array<{ weekStartIso, isoWeek, count }>` (zawsze 8). Wysokość
`round(count/max×56)px` (guard `max ≥ 1`), bieżący tydzień (ostatni element) `bg-sewera-primary`,
pozostałe `bg-blue-200`, wartość nad słupkiem, etykieta pod = `T{isoWeek}` — numer tygodnia
przychodzi z RPC, komponent nie liczy żadnej matematyki dat.

#### 5. Wpięcie w stronę

**File**: `src/pages/dashboard.astro` (edycja)

**Intent**: Zastąpić placeholdery z Phase 2 kartami wykresów w układzie mockupu:
lewa kolumna — „Wpisy wg oddziałów" + „Kategorie wpisów" (donut tematyk); prawa (340px) —
„Trend tygodniowy" + „Sentyment". Lista zostaje pełnoszerokie poniżej.

**Contract**: Wyłącznie kompozycja — strona dalej nie liczy nic poza wywołaniami
`donutSegments` na danych z lib w frontmatterze (SSR).

### Success Criteria:

#### Automated Verification:

- Testy geometrii i całego modułu zielone: `npx vitest run src/lib/dashboard/`
- Pełna suita zielona: `npm test`
- Typecheck przechodzi: `npm run typecheck`
- Lint przechodzi: `npm run lint`
- Build przechodzi: `npm run build`

#### Manual Verification:

- Liczby na wykresach zgadzają się z seedem (suma donuta tematyk = licznik KPI; słupki oddziałów = liczby per oddział)
- Pusty zakres: pierścienie pokazują tor + „brak danych", trend pokazuje zera, strona nie wygląda na zepsutą
- Sentyment ring i KPI neg. % mają widoczny disclaimer AI (NFR)
- Układ odpowiada `design/dashboard-przegląd.PNG` (minus „Top procesy", paski neg/innow i zakładki); responsywność mobile OK
- Filtr oddziału przefiltrowuje wszystkie widgety (BranchChart z jednym słupkiem — zgodnie z decyzją o jednolitej semantyce)

---

## Testing Strategy

### Unit Tests:

- `range.test.ts` — presety kroczące, fallbacki walidacji, granice dni Warsaw + DST
  (29.03.2026, 25.10.2026), walidacja branch.
- `aggregates.test.ts` — zero-fill z taksonomii, `negPct` (w tym `null` przy 0), 8 kubełków
  tygodni, builder listy (pin `.eq("enrichment_status","done")`), propagacja błędów.
- `donut.test.ts` — kumulacja offsetów, pełne koło przy jednym segmencie, puste przy zerach.
- Mockowanie wyłącznie na krawędzi (klient Supabase) — wzorzec `src/pages/api/_submissions.test.ts`.

### Integration Tests:

- Brak osobnej warstwy route-testów dla `.astro` (nie ma w repo wzorca renderowania stron
  w vitest); kompozycja strony jest cienka, a logika w 100% w `src/lib/dashboard/` —
  zgodnie z test-plan §1 (koszt × sygnał).

### Manual Testing Steps:

1. `npm run db:reset` + probe 6 (Studio/psql) — wyniki jak w Phase 1.
2. Seed z wpisami `done` w różnych tematykach/oddziałach/tonach + co najmniej 1 `pending`
   i 1 `failed` → niewidoczne nigdzie na dashboardzie.
3. `npm run build` (potwierdź ukończenie) + `wrangler dev` → przejdź presety, custom range
   obejmujący przejście DST, filtr oddziału, klik do detail view i powrót.
4. Porównanie wizualne z `design/dashboard-przegląd.PNG` (desktop + zwężone okno).

Bez E2E (test-plan §7 — dashboard nie liczy nic client-side; trigger re-ewaluacji nie
odpala). Bez Strykera (agregaty poza top-ryzykami mapy §2).

## Performance Considerations

Jeden RPC + jedno query listy na render (zamiast ~25 countów REST — limit subrequestów
Workers i latency). Indeksy F-01 obsługują predykaty (równość na `enrichment_status`).
Skala (≤ tysiące wierszy) nie wymaga cache ani dalszych indeksów; `ai_tone` group-by działa
na partial-index-filtered zbiorze done-rows — akceptowalne, nie indeksować na zapas.

## Migration Notes

Migracja czysto addytywna (CREATE FUNCTION + granty) — zero zmian danych i tabel.
Rollback: `DROP FUNCTION public.dashboard_aggregates(timestamptz, timestamptz, text);`.
Po wdrożeniu na remote: `supabase db push` zgodnie z dotychczasowym flow projektu.

## References

- Zmiana: `context/changes/admin-dashboard-aggregates/change.md`
- Roadmapa S-02: `context/foundation/roadmap.md` (§Slices S-02)
- PRD: FR-008, FR-010..FR-013, NFR (disclaimer AI, mobile) — `context/foundation/prd.md`
- Design: `design/design.md` (§1 tokeny, §4.2 receptury, §5 zasady) + `design/dashboard-przegląd.PNG`
- Lekcje: `context/foundation/lessons.md` (partial index `.eq`, REVOKE explicit, composite
  ORDER BY, build-before-verify)
- Test-plan: `context/foundation/test-plan.md` (§6.1, §6.2, §7)
- Prior art: `context/archive/2026-06-4-first-end-to-end-submission/plan.md` (wzorzec
  detail view, klient SSR), `supabase/migrations/20260528000000_create_submissions.sql` (indeksy)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Agregaty — migracja RPC, moduł `src/lib/dashboard/`, testy

#### Automated

- [x] 1.1 Migracja aplikuje się czysto: `npm run db:reset` — c02d2ed
- [x] 1.2 Typy zregenerowane bez ręcznych edycji: `npm run db:gen-types` (diff tylko `Functions`) — c02d2ed
- [x] 1.3 Testy modułu zielone: `npx vitest run src/lib/dashboard/` — c02d2ed
- [x] 1.4 Pełna suita node zielona: `npm test` — c02d2ed
- [x] 1.5 Typecheck przechodzi: `npm run typecheck` — c02d2ed
- [x] 1.6 Lint przechodzi: `npm run lint` — c02d2ed

#### Manual

- [x] 1.7 Probe 6 w `supabase/tests/access-control-probes.sql` daje oczekiwane wyniki (non-admin → 0, admin → ≥1, anon → 42501) — c02d2ed
- [x] 1.8 `SELECT public.dashboard_aggregates(now() - interval '30 days', now(), NULL);` na lokalnym seedzie zwraca spójny JSON (suma `by_topic` = `total_range`) — c02d2ed

### Phase 2: Szkielet UI — tokeny, Lato, TopBar + filtry, KPI, lista (FR-010 + FR-013)

#### Automated

- [x] 2.1 Testy zielone: `npm test` — 5fa4fc5
- [x] 2.2 Typecheck przechodzi: `npm run typecheck` — 5fa4fc5
- [x] 2.3 Lint przechodzi: `npm run lint` — 5fa4fc5
- [x] 2.4 Build przechodzi: `npm run build` — 5fa4fc5

#### Manual

- [x] 2.5 Widok zgodny z mockupem (TopBar/KPI/lista) na seedzie lokalnym (`npm run build` + `wrangler dev`) — 5fa4fc5
- [x] 2.6 Filtry działają przez URL: presety, custom range, branch — odświeżenie strony zachowuje stan; default = 30 dni — 5fa4fc5
- [x] 2.7 Klik w wiersz listy otwiera detail view S-01; powrót wstecz przeglądarki zachowuje stan filtrów (URL GET), a link „wróć" detail view świadomie wraca do widoku domyślnego (detail view nietknięty) — 5fa4fc5
- [x] 2.8 Nie-admin / niezalogowany nadal dostaje redirect (middleware nietknięty) — 5fa4fc5
- [x] 2.9 Wpisy `pending`/`failed` nie pojawiają się nigdzie (FR-008) — 5fa4fc5
- [x] 2.10 Widok używalny na szerokości mobilnej (NFR; grid zwija się do 1 kolumny `max-lg`) — 5fa4fc5

### Phase 3: Wykresy — DonutRing (tematyki + sentyment), BranchChart, WeeklyChart (FR-011 + FR-012 + extras)

#### Automated

- [x] 3.1 Testy geometrii i całego modułu zielone: `npx vitest run src/lib/dashboard/` — 8c2b1dd
- [x] 3.2 Pełna suita zielona: `npm test` — 8c2b1dd
- [x] 3.3 Typecheck przechodzi: `npm run typecheck` — 8c2b1dd
- [x] 3.4 Lint przechodzi: `npm run lint` — 8c2b1dd
- [x] 3.5 Build przechodzi: `npm run build` — 8c2b1dd

#### Manual

- [x] 3.6 Liczby na wykresach zgadzają się z seedem (suma donuta tematyk = licznik KPI; słupki oddziałów = liczby per oddział) — 8c2b1dd
- [x] 3.7 Pusty zakres: pierścienie pokazują tor + „brak danych", trend pokazuje zera, strona nie wygląda na zepsutą — 8c2b1dd
- [x] 3.8 Sentyment ring i KPI neg. % mają widoczny disclaimer AI (NFR) — 8c2b1dd
- [x] 3.9 Układ odpowiada `design/dashboard-przegląd.PNG` (minus „Top procesy", paski neg/innow i zakładki); responsywność mobile OK — 8c2b1dd
- [x] 3.10 Filtr oddziału przefiltrowuje wszystkie widgety (BranchChart z jednym słupkiem — zgodnie z decyzją o jednolitej semantyce) — 8c2b1dd
