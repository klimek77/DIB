# Admin Dashboard z Agregatami (S-02) — Plan Brief

> Full plan: `context/changes/admin-dashboard-aggregates/plan.md`

## What & Why

Zamieniamy placeholder `/dashboard` w realny panel admina: licznik zgłoszeń z filtrem
czasu, podział wg tematyki i oddziału, sentyment, trend tygodniowy oraz lista zgłoszeń
z AI-podsumowaniami klikalna do detail view z S-01. To slice S-02 roadmapy (FR-010..013)
— rdzeń wedge'a produktu: AI-strukturyzacja anonimowego strumienia w mapowalny trend
zamiast surowego stosu uwag.

## Starting Point

S-01 zostawił działający łańcuch pracownik → AI → admin z detail view i guardami
(middleware + RLS `is_allowed_admin()`), a F-01 — indeksy zaprojektowane wprost pod te
agregaty (partial `topic`/`branch WHERE done`, `created_at DESC`). Dashboard sam w sobie
to dziś karta powitalna; nie istnieje żadna lista ani agregat. Folder `design/` ma pełny
system wizualny z recepturami wykresów (inline SVG, bez bibliotek) i mockup docelowego widoku.

## Desired End State

Admin po zalogowaniu widzi jeden widok: 3 KPI (wpisy w zakresie, łącznie, sentyment neg. %),
donut tematyk, słupki oddziałów, pierścień sentymentu, trend 8 tygodni i listę 100
najnowszych zgłoszeń — wszystko tylko z wierszy wzbogaconych (FR-008), sterowane filtrem
czasu (default: ostatnie 30 dni) i oddziału przez URL, z disclaimerami na etykietach AI.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Podział „wg tematyki" (FR-011) | `topic` (4 wartości pracownika), nie `ai_classification` | Parenthetical FR-011 to relikt sprzed driftu taksonomii; indeks i kolory designu istnieją dla `topic` |
| Forma wykresu tematyk | Donut inline-SVG (receptura SentimentRing) | Spełnia literę „wykres kołowy" pozostając w języku designu, zero zależności |
| Extras z mockupu | Wszystkie 4: sentyment ring, KPI neg. %, trend tygodniowy, filtr oddziału | Świadome rozszerzenie ponad FR-y do pełnego widoku „Przegląd" (bez zakładek Tematy/Procesy — non-goals) |
| Filtr czasu | Globalny dla całego widoku; trend zawsze stałe 8 tygodni | Jeden model mentalny; bucketowanie tygodniowe nie ma sensu dla zakresu 24h |
| Semantyka presetów | Okna kroczące (24h/7d/30d/365d), default 30 dni | Najprostsza semantyka; kadencja zarządcza i kryterium pilota są miesięczne |
| Lista (FR-013) | Najnowsze 100 z zakresu + „pokazano X z N", bez paginacji | Strona nie puchnie przy zakresie rocznym; decyzja „bez paginacji" z roadmapy utrzymana |
| Agregacja | Jedna funkcja SQL `dashboard_aggregates` (SECURITY INVOKER, RLS) | PostgREST nie umie GROUP BY, fetch-all ucina się na 1000 wierszy, ~25 countów zjada limit subrequestów; S-05 reużyje RPC |
| Wykresy i datepicker | Inline SVG + natywne `<input type="date">`, zero bibliotek | Mandat design.md („brak biblioteki chartów") + minimalny datepicker z roadmapy |
| Klient JS na dashboardzie | Zero (SSR + GET) | Utrzymuje negative space test-planu §7 — bez E2E i bez wysp React |

## Scope

**In scope:** RPC agregatów + probe RLS, moduł `src/lib/dashboard/` (zakresy Warsaw-TZ,
mapper, lista, geometria donuta) z testami, tokeny `@theme` + font Lato, przebudowa
`dashboard.astro` (TopBar, filtry, KPI, lista), 4 karty wykresów.

**Out of scope:** zakładki Tematy/Procesy (non-goals PRD), paginacja, eksporty, real-time,
zmiany w detail view, indeks na `ai_tone`, cache, filtry po department/klasyfikacji AI.

## Architecture / Approach

Jeden round-trip SQL (`dashboard_aggregates(from, to, branch?)` — INVOKER, więc RLS
`is_allowed_admin()` gateuje dane) + osobne query listy pod composite index. Cała logika
(parsowanie URL, granice dni Europe/Warsaw z obsługą DST, zero-fill z taksonomii, łuki SVG)
żyje w czystych funkcjach `src/lib/dashboard/` — strona `.astro` tylko komponuje. Filtry to
linki i formularz GET; wykresy to statyczny SVG renderowany na serwerze wg receptur
`design/design.md` §4.2 (wykonanie UI z pluginem frontend-design i mockupami PNG).

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Agregaty (RPC + lib + testy) | Poprawne liczby dla każdego zakresu/filtra, probe RLS | Grant hygiene funkcji (auto-grant Supabase); krawędzie DST w custom range |
| 2. Szkielet UI (filtry, KPI, lista) | FR-010 + FR-013 end-to-end w świecie light/Lato/sewera | Wierność mockupowi bez JS (filtr = GET z przyciskiem) |
| 3. Wykresy (donut ×2, słupki, trend) | FR-011 + FR-012 + extras; stany puste | Geometria łuków (krawędzie: jeden segment, zero danych) |

**Prerequisites:** S-01 done (jest), lokalny Supabase + seed, `.dev.vars`.
**Estimated effort:** ~3 sesje (1 faza = 1 sesja).

## Open Risks & Assumptions

- Zakładamy, że dla wierszy `done` pole `ai_tone` jest zawsze wypełnione (konsument F-03
  tak pisze); mapper i tak traktuje braki jako 0.
- Trend tygodniowy ignoruje filtr czasu (stałe 8 tygodni) — jeśli w użyciu okaże się to
  mylące, to korekta UX w follow-upie, nie w tym planie.
- `--color-teal` w `@theme` nadpisuje goły utility `teal` (zamierzone, design.md); odcienie
  palety zostają.

## Success Criteria (Summary)

- Admin widzi poprawne agregaty i listę dla dowolnego zakresu/oddziału; suma donuta = licznik KPI; probe RLS przechodzi.
- Zgłoszenia `pending`/`failed` są niewidoczne w każdym widgecie (FR-008); etykiety AI niosą disclaimer (NFR).
- Wszystkie bramki zielone (`npm test`, typecheck, lint, build) bez nowych zależności poza `@fontsource/lato`.
