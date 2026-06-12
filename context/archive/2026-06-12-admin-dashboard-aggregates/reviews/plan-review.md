<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Admin Dashboard z Agregatami (S-02)

- **Plan**: `context/changes/admin-dashboard-aggregates/plan.md`
- **Mode**: Deep
- **Date**: 2026-06-12
- **Verdict**: REVISE → **SOUND po triage** (wszystkie findingi naprawione w planie)
- **Findings**: 1 critical, 2 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING → naprawione (F2) |
| Plan Completeness | FAIL → naprawione (F1, F3, F4) |

## Grounding

6/6 paths ✓ (dashboard.astro, [id].astro, taxonomies.ts, global.css, probes.sql, migrations/) ·
skrypty `db:gen-types`/`db:reset`/`db:seed-admins` ✓ · `/api/auth/signout.ts` ✓ ·
wzorzec `@theme`/`--font-dm-sans` w global.css ✓ (self-hosted fonts = precedens anonimowości) ·
`teal` nieużywany w src ✓ (token bez kolizji) · brief↔plan ✓

## Findings

### F1 — Tytuły faz w Progress ≠ nagłówki faz w treści (3/3)

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — szybka decyzja; fix oczywisty i wąski
- **Dimension**: Plan Completeness
- **Location**: `## Progress` vs nagłówki `## Phase 1–3`
- **Detail**: Wszystkie trzy tytuły `### Phase N:` w Progress różniły się od nagłówków w treści (skróty, brakujące sufiksy FR), a część pozycji N.M była przyciętymi parafrazami bulletów Success Criteria. /10x-implement parsuje Progress mechanicznie — rozjazd łamie parser i przypisywanie SHA.
- **Fix**: Tytuły faz i pozycje N.M wyrównane do verbatim z treści.
- **Decision**: FIXED

### F2 — by_week liczony podwójnie: SQL i mapper TS muszą wyprodukować identyczne klucze tygodni

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — realny tradeoff; warto się zatrzymać
- **Dimension**: Blind Spots
- **Location**: Phase 1 — zmiana #1 (RPC) i #5 (mapper)
- **Detail**: SQL zwracał klucze `date_trunc('week', … Warsaw)`, a mapper NIEZALEŻNIE budował 8 kubełków przez Intl i dopasowywał klucze — rozjazd (serializacja/DST/początek tygodnia) po cichu zerowałby kubełek (wykres kłamie bez błędu). Etykieta „T{nr ISO}" nie miała właściciela.
- **Fix A ⭐ (zastosowany)**: zero-fill przeniesiony do SQL — RPC zwraca DOKŁADNIE 8 wierszy (`generate_series` LEFT JOIN counts, `{week_start, iso_week: to_char(…,'IW'), count}`, jawny ORDER BY); mapper pass-through z walidacją `length === 8`; etykieta = `T{isoWeek}` z RPC.
  - Strength: jedna implementacja matematyki tygodni tam, gdzie już żyje TZ-logika; znika klasa błędu i problem etykiety naraz.
  - Tradeoff: logika kubełków poza vitestem (pokrycie: manualny seed-check 1.8).
  - Confidence: HIGH — generate_series + LEFT JOIN to podręcznikowy wzorzec.
  - Blind spot: kolejność jsonb_agg wymaga jawnego ORDER BY (ujęte w kontrakcie).
- **Fix B (odrzucony)**: fill w TS + helper isoWeek + fixture serializacji PostgREST — pułapka zostaje, Confidence MEDIUM.
- **Decision**: FIXED (Fix A)

### F3 — Sprzeczne kryterium: „powrót zachowuje parametry" vs link „wróć" → goły /dashboard

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — szybka decyzja; fix oczywisty i wąski
- **Dimension**: Plan Completeness (wewnętrzna sprzeczność)
- **Location**: Phase 2 — Manual Verification (+ Progress 2.7)
- **Detail**: Kryterium żądało zachowania parametrów przy powrocie wskazując link „wróć" detail view (goły `/dashboard` = reset), podczas gdy edycja detail view jest jawnie w „What We're NOT Doing" — niespełnialne, ryzyko złamania zakresu.
- **Fix**: Kryterium przeredagowane — powrót wstecz przeglądarki zachowuje stan (URL GET); link „wróć" świadomie wraca do widoku domyślnego; detail view nietknięty. Progress 2.7 zsynchronizowany.
- **Decision**: FIXED

### F4 — Probe 6: przypadek 42501 musi mieć własny blok transakcji

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — szybka decyzja; fix oczywisty i wąski
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — zmiana #2 (probe)
- **Detail**: Konwencja pliku probe'ów: każdy probe = osobny BEGIN…ROLLBACK; błąd przerywa transakcję (wzorzec Probe 3). Połączenie (a)/(b)/(c) w jednym bloku sprawiłoby, że błąd z (c) ubija wyniki (a)/(b).
- **Fix**: Dopisany wymóg osobnego bloku BEGIN…ROLLBACK dla przypadku (c).
- **Decision**: FIXED

## Zweryfikowane i czyste (bez findingów)

- Grant-hygiene RPC zgodny z lekcją o auto-grantach Supabase (REVOKE jawny z ról, GRANT authenticated; service_role zachowuje grant dla S-05).
- SECURITY INVOKER + RLS `is_allowed_admin()` — defense-in-depth spójny z detail view (ryzyko #1 test-planu).
- `@fontsource/lato` trzyma precedens self-hostingu fontów z gwarancji anonimowości (`global.css:1-2`).
- Token `--color-teal` bez kolizji (zero użyć `teal` w src; nadpisuje tylko goły utility).
- Lista pod composite index z `.eq("enrichment_status","done")` — pin lekcji partial-index.
- Zero JS klienta = negative space test-planu §7 nienaruszony (bez E2E).
- Rollback migracji opisany (DROP FUNCTION; migracja czysto addytywna).
- Lean: wszystkie extras to jawne decyzje usera z sesji planowania; paski neg/innow z mockupu jawnie de-scoped.
