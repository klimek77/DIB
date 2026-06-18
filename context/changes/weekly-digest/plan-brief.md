# S-05 Weekly Digest — Plan Brief

> Full plan: `context/changes/weekly-digest/plan.md`
> Research: `context/changes/weekly-digest/research.md`

## What & Why

S-05 (PRD FR-017, nice-to-have): poniedziałkowy cron mailuje adminom liczbowe podsumowanie
zgłoszeń z minionego tygodnia. Domyka MVP roadmapy — daje managementowi regularny, agregatowy
puls operacyjny bez logowania na dashboard.

## Starting Point

Wszystkie trzy potrzebne powierzchnie już istnieją: scheduled handler w `src/worker.ts:97-124`
(dziś recovery sweep na `*/15`), agregat RPC `dashboard_aggregates` + klient TS, kanał email
Resend (`sendEmail` + `resolveAlertRecipients`), oraz DST-safe `warsawDayStartUtc`. Brakuje tylko
modułu digestu, poniedziałkowego crona i rozgałęzienia handlera po cronie.

## Desired End State

W poniedziałek 07:00 UTC (08:00 Warszawa zimą / 09:00 latem) admin z allow-listy dostaje
plain-text mail: łączna liczba zgłoszeń minionego tygodnia + breakdown wg tematyki i oddziału +
link do `/dashboard`. Tydzień bez zgłoszeń → brak maila. Recovery sweep działa bez zmian.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Idempotencja wysyłki | Bez dedup-store | Nice-to-have; cron rzadko dubluje; nie wprowadzamy pierwszego primitive dla maila | Plan |
| Pusty tydzień | Pomiń wysyłkę | Brak szumu w skrzynce; darmowa quasi-idempotencja w najczęstszym przypadku | Plan |
| Top-3 AI | Pomiń w MVP | count + by-topic + by-branch spełnia FR-017; bez zmian w RPC | Plan |
| Cron | `0 7 * * 1` | 08:00 Warszawa zimą; latem nigdy przed 08:00 local | Plan |
| Treść maila | Agregaty inline + link | Self-contained, zero treści per-zgłoszenie (anonimowość) | Plan |
| Klient do RPC | `createAdminClient` (service-role) | RPC RLS-gated; cron nie ma usera; grant zostawiony pod S-05 | Research |
| Okno danych | Liczone w handlerze (`warsawDayStartUtc`) | Cron na UTC; DST-safe niezależnie od godziny triggera | Research |
| `byWeek` z RPC | Ignorować | Przykuty do `now()+7tyg.`, nie do `p_from/p_to` | Research |

## Scope

**In scope:** moduł `weekly-digest.ts` (okno + builder + orchestrator), `previousWarsawWeekRange`,
poniedziałkowy cron, dispatch po `controller.cron`, `APP_BASE_URL`, unit-testy, aktualizacja
test-planu, deploy.

**Out of scope:** dedup-store, heartbeat na pusty tydzień, top-3 AI, lista/treść per-zgłoszenie,
nowa migracja, Slack/Teams, deep-link z zakresem tygodnia.

## Architecture / Approach

Logika domenowa w `src/lib` (czyste funkcje, node-testowalne): okno tygodnia → RPC przez
service-role client → builder plain-text → `sendEmail`, ze skipem gdy zero/brak recipientów.
`src/worker.ts` dostaje tylko dispatch `controller.cron` → sweep | digest (cienki wiring,
spójnie z wzorcem recovery-sweep). Cron w `wrangler.jsonc`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Logika digestu | Okno + builder + orchestrator + unit-testy | Poprawność okna na przejściu DST |
| 2. Wiring crona | `0 7 * * 1` + dispatch po cronie, worker-suite | Cron tylko ze zbudowanego configu; multi-cron dispatch |
| 3. Test-plan + deploy | Ryzyko S-05 w test-planie + wdrożenie | RPC `20260612` musi być na prod (lekcja S-04) |

**Prerequisites:** S-02 + S-03 done (są); sekrety email na prod; migracja `20260612` na prod.
**Estimated effort:** ~1–2 sesje, 3 fazy.

## Open Risks & Assumptions

- Cron Cloudflare może rzadko zdublować dostarczenie → przyjęty świadomie rzadki double-send.
- Godzina dostarczenia pływa ±1h z DST (dane zawsze poprawne — okno liczone w handlerze).
- Prod Supabase bywał za migracjami (lekcja S-04) — bez `20260612` digest by 500; weryfikacja w Phase 3.
- `APP_BASE_URL` nieustawiony → mail bez linku (graceful), nie awaria.

## Success Criteria (Summary)

- Poniedziałkowy mail z poprawnymi liczbami tygodnia dociera do adminów (lub pomijany w pusty tydzień).
- Recovery sweep działa bez regresji.
- Zero treści/podpisu zgłoszeń w mailu (anonimowość zachowana).
