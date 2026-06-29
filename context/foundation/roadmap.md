---
project: "digital idea box"
version: 1
status: draft
created: 2026-05-27
updated: 2026-06-23
prd_version: 1
main_goal: market-feedback
top_blocker: decisions
---

# Roadmap: digital idea box

> Wyprowadzony z `context/foundation/prd.md` (v1) + auto-zbadana baza kodu (2026-05-27).
> Edycja-w-miejscu; archiwizacja gdy zastąpiony.
> Pozycje poniżej są w kolejności zależności. Tabela "Na pierwszy rzut oka" to indeks.

## Vision recap

Management firmy ~270 pracowników nie ma kanału, którym docierają do nich pomysły usprawnień i sygnały o problemach od warstwy wykonawczej — mail do szefa pokazuje incydenty, nie wzorce. Digital Idea Box to anonimowy, sieciowo-bramowany kanał, gdzie każde zgłoszenie AI wzbogaca o ton, klasyfikację i 1-2 zdaniowe podsumowanie, a admin widzi agregaty po dziale i tematyce zamiast surowego stosu uwag. Wedge produktu — ten jeden element, którego usunięcie czyni produkt nieodróżnialnym od fizycznej skrzynki na ścianie — to właśnie AI-strukturyzacja anonimowego strumienia w mapowalny trend operacyjny.

## North star

**S-01: Pierwsza anonimowa submisja → AI wzbogaca → admin widzi w detail view** — najmniejsze zamknięcie pętli `pracownik → AI → admin` z PRD Vision: jedno zgłoszenie pracownika przechodzi przez pełny enrichment (ton + klasyfikacja + podsumowanie) i ląduje w wzbogaconym widoku admina po magic-link logowaniu. Pierwszy Success Criterion ("w pierwszym miesiącu pilota wpada co najmniej N zgłoszeń") wymaga, by ten przepływ działał z prawdziwymi pracownikami — sekwencja stawia go najwcześniej, jak Prerequisites pozwalają.

> Gwiazda przewodnia (north star) — najmniejszy end-to-end slice, którego dostarczenie udowadnia kluczową tezę produktu z PRD Vision; wszystko inne ma sens tylko pod warunkiem, że ten przepływ działa.

## At a glance

| ID    | Change ID                          | Outcome (user can …)                                                              | Prerequisites             | PRD refs                                  | Status   |
| ----- | ---------------------------------- | --------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------- | -------- |
| F-01  | submissions-data-model             | (foundation) tabela submissions + types + RLS gotowe do zapisu/odczytu            | —                         | Business Logic, Access Control, NFR-retention | done     |
| F-02  | auth-refit-magic-link              | (foundation) admin loguje się magic-linkiem; email+password wycofany; allow-list  | —                         | FR-009, Access Control                    | done     |
| F-03  | ai-enrichment-queue                | (foundation) Cloudflare Queue + consumer Worker z retry/backoff; structured logi  | F-01                      | FR-008, FR-018, NFR (<1s response)        | done     |
| F-04  | corporate-network-gate             | (foundation) Cloudflare Access policy CIDR-bypass na worker URL + preview         | —                         | FR-015                                    | dropped  |
| S-01  | first-end-to-end-submission        | Pracownik anonimowo zgłasza, AI wzbogaca, admin widzi w detail view               | F-01, F-02, F-03          | US-01, FR-001..008, FR-009, FR-014, FR-015 | done     |
| S-02  | admin-dashboard-aggregates         | Admin widzi agregaty: licznik z filtrem czasu, pie tematyk, podział oddziałów, listę | S-01                      | FR-010, FR-011, FR-012, FR-013            | done     |
| S-03  | notification-channel-and-ai-alert  | Admin dostaje natychmiastowy alert gdy AI enrichment fail                          | S-01                      | FR-018                                    | done     |
| S-04  | new-submission-instant-notify      | Admin dostaje natychmiastową notyfikację o każdym nowym zgłoszeniu                 | S-03                      | FR-016                                    | done     |
| S-05  | weekly-digest                      | Admin dostaje cotygodniowy mail w poniedziałki 8:00 z podsumowaniem minionego tyg.| S-02, S-03                | FR-017                                    | implementing |
| S-06  | admin-submission-triage            | Admin na detalu zmienia status triage'u zgłoszenia i usuwa spam/off-topic         | S-01, S-02                | — (poza PRD v1; ex-parked §Non-Goals)     | done     |

## Streams

Pomoc nawigacyjna — grupuje pozycje współdzielące łańcuch Prerequisites. Kanoniczna kolejność dalej żyje w grafie zależności poniżej; ta tabela to proponowana kolejność czytania równoległych torów.

| Stream | Theme                              | Chain                                                | Note                                                                                                |
| ------ | ---------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A      | Core wedge & cumulative reporting  | `F-01 → F-03 → S-01 → S-02 → S-05`                  | Trzon market-feedback: dane + AI + north star + agregaty; S-05 dokleja się na końcu, korzysta z S-02 + S-03. |
| B      | Auth refit                         | `F-02`                                               | Wymiana email+password na magic-link + admin allow-list; równolegle z A, łączy się ze Stream A w `S-01`. |
| C      | Operational notifications          | `S-03 → S-04`                                        | Kanał email/Slack + FR-018 alert (must-have) → potem FR-016 nice-to-have. Łączy się ze Stream A w `S-03` przez zależność `S-01`. |
| D      | Pilot launch gate                  | `F-04`                                               | FR-015 CIDR-bypass Access policy — **dropped 2026-06-12**: zamiast network-level gate, link dystrybuowany przez wewnętrzny portal firmowy. F-04 nie blokuje pilotażu.    |

## Baseline

Co jest już w bazie kodu na `2026-05-27` (auto-zbadane + user-confirmed). Fundamenty poniżej zakładają, że to istnieje, i NIE re-scaffoldują.

- **Frontend:** partial — Astro 6 + React 19 + Tailwind 4.2 + scaffold auth, `src/pages/{auth/signin,signup,confirm-email}.astro`, `src/pages/dashboard.astro`, layout + Welcome/Banner/Topbar. Brak formularza pracownika i widgetów dashboardu.
- **Backend / API:** partial — `src/pages/api/auth/{signin,signout,signup}.ts` (Supabase password auth). Brak endpointu submisji i queries admina.
- **Auth:** partial — Supabase SSR (`src/lib/supabase.ts`) + `src/middleware.ts` route guard na `/dashboard` działa. ALE: email+password (zamiast magic-link z FR-009), brak admin allow-list, każdy może się zarejestrować. → Refit w F-02, NIE addytywne dorobienie.
- **Data:** partial — `supabase/config.toml` jest, `schema_paths=[]`, brak migracji, brak `seed.sql`, brak `database.types.ts`. → F-01 zakłada schemat od zera.
- **Deploy / infra:** partial — `wrangler.jsonc` (compatibility_date 2026-05-08, nodejs_compat, ASSETS binding); worker `digital-idea-box.klimek77.workers.dev` żyje; sekrety Supabase wgrane. `.github/workflows/ci.yml` tylko lint+build (deploy odłożony). FR-015 Access świadomie odłożony w `context/deployment/deploy-plan.md` §Phase-5. Brak cron triggers, brak queue bindings.
- **Observability:** present — `wrangler.jsonc` ma `"observability": { "enabled": true }`; `wrangler tail` + Workers Observability dostępne. Brak in-code structured loggera (pino/winston/sentry). Fundamenty F-03 dorzucają structured log calls dla queue/consumer; szerszy in-code logger NIE jest osobnym Foundation w MVP. *Update 2026-06-12:* Sentry error monitoring (errors-only, deny-by-default PII scrub) wpięty we wszystkie 3 runtime'y (client / SSR / queue+cron) jako zmiana ops poza roadmapą → `context/archive/2026-06-11-sentry-observability/`.

## Foundations

### F-01: Submissions data model + types

- **Outcome:** (foundation) tabela `submissions` (z kolumnami enrichment) + RLS policy (anon insert, admin read) + wygenerowane `database.types.ts` gotowe do importu z kodu Worker/Astro.
- **Change ID:** submissions-data-model
- **PRD refs:** Business Logic, Access Control, NFR (retencja, brak identyfikatorów technicznych)
- **Unlocks:** S-01 (zapis submisji + odczyt do detail view), S-02 (queries agregatów), F-03 (consumer aktualizuje wiersz po enrichment)
- **Prerequisites:** —
- **Parallel with:** F-02, F-04
- **Blockers:** —
- **Unknowns:**
  - Kształt enrichment — kolumny w `submissions` vs osobna tabela `ai_enrichments`? Owner: TBD, decyzja w `/10x-plan`. Block: no.
  - Retencja N lat (PRD Q2) — sugerowane 2 lata; faktyczne usuwanie to przyszły cron, nie blokuje schematu. Owner: user (dział prawny). Block: no.
- **Risk:** Schemat to load-bearing kontrakt — wszystkie inne pozycje zapisują/czytają z tej tabeli. Pomyłka w polach AI enrichment (np. brak `enrichment_status: pending|done|failed`) wymusza migrację w F-03 i potencjalnie zmianę kodu w S-01.
- **Status:** done

### F-02: Auth refit — magic-link + admin allow-list

- **Outcome:** (foundation) admin loguje się magic-linkiem na firmowy email; email+password wycofany; allow-list (env-var konfigurowana ręcznie per shape-notes) gateuje, kto w ogóle może się zalogować; middleware nadal enforcuje guard na `/dashboard`.
- **Change ID:** auth-refit-magic-link
- **PRD refs:** FR-009, Access Control (ścieżka admina)
- **Unlocks:** S-01 (admin musi się zalogować, żeby zobaczyć wzbogacone zgłoszenie w detail view — zamknięcie north-star pętli)
- **Prerequisites:** —
- **Parallel with:** F-01, F-04
- **Blockers:** —
- **Unknowns:**
  - Źródło allow-list — env-var (ALLOWED_ADMIN_EMAILS) vs DB table? Per shape-notes "konfigurowana ręcznie", env-var domyślnie. Owner: TBD, decyzja w `/10x-plan`. Block: no.
- **Risk:** To refit, nie add — błędna sekwencja zostawia dwie równoległe ścieżki login (password + magic), z których obie "działają" ale żadna nie odpowiada PRD. Najpierw wytnij stare endpointy `/api/auth/signin` (password) i `/api/auth/signup`, dopiero potem podłącz `signInWithOtp` Supabase + callback.
- **Status:** done

### F-03: Async AI enrichment plumbing — Cloudflare Queue + consumer Worker

- **Outcome:** (foundation) Cloudflare Queue zaglądana przez consumer Worker; submisja z S-01 wystawia job na kolejkę (fire-and-forget, <1s response per NFR), consumer ciągnie job, wywołuje dostawcę AI, retry/backoff przy błędach przejściowych, emit structured event przy końcowym fail (źródło sygnału dla S-03 FR-018 alertu).
- **Change ID:** ai-enrichment-queue
- **PRD refs:** FR-008 (graceful degradation, queue dla pending enrichment), NFR (potwierdzenie <1s niezależnie od stanu AI), Devil's Advocate #2 z `infrastructure.md` (Worker CPU-time wymusza async)
- **Unlocks:** S-01 (asynchroniczna ścieżka AI — fundament north-star), S-03 (event emission dla FR-018 alertu)
- **Prerequisites:** F-01 (consumer pisze wzbogacenie z powrotem do wiersza `submissions`)
- **Parallel with:** F-02, F-04
- **Blockers:** —
- **Unknowns:**
  - ✅ Dostawca AI / model — **RESOLVED 2026-06-02:** OpenAI `gpt-4o-mini` via Structured Outputs (strict JSON schema). Anthropic `claude-haiku` = pre-vetted alternatywa (oba tokeny API dostępne; brak local LLM). Block: no.
  - Spending cap dla retry loop — per Unknown Unknowns #2 z `infrastructure.md`, retry na transient AI errors może spalić CPU-ms; Cloudflare Spend Limit manual, ale jest. Owner: TBD w `/10x-plan`. Block: no.
- **Risk:** Worker CPU-time limit (10ms free / 30s paid) sprawia, że synchroniczne wołanie AI z HTTP handlera jest pułapką długoterminową. Budowanie F-03 PRZED S-01 zapobiega temu, że ktoś zacznie od synchronicznego `fetch(AI)` w endpoint'cie submisji i potem trzeba przepisywać. Lokalna weryfikacja cron/queue wymaga `wrangler dev --test-scheduled`, NIE samego `astro dev` (Vite plugin nie obsługuje non-HTTP triggers).
- **Status:** done

### F-04: Network gate — Cloudflare Access CIDR bypass policy

- **Outcome:** (foundation) Access policy na URL worker'a (+ subdomeny preview) z selektorem `IP ranges include {corporate CIDR}` i akcją Bypass. Próba dostępu spoza CIDR-a + spoza WARP nie nawiązuje połączenia z aplikacją (network-level deny, NIE warstwa aplikacyjna).
- **Change ID:** corporate-network-gate
- **PRD refs:** FR-015, US-01 AC#1 (próba spoza firmowej sieci nie nawiązuje połączenia)
- **Unlocks:** ścieżka weryfikacyjna pilotażu (FR-015 acceptance test: "próba otwarcia linka spoza firmowej sieci nie nawiązuje połączenia z aplikacją"). Niezależnie od slice'ów developmentu — można rozwijać S-01..S-05 na publicznym workers.dev przed wpięciem F-04, ale BEZ F-04 nie wolno otworzyć pilotażu.
- **Prerequisites:** —
- **Parallel with:** F-01, F-02, F-03, wszystkie slice'y developmentu
- **Blockers:** korporacyjny zakres CIDR — owner: user/IT. Bez tego policy się nie skonfiguruje konkretnie.
- **Unknowns:**
  - Korporacyjny CIDR (lista zakresów) — Owner: user / IT. Block: **yes** (policy wymaga konkretnych zakresów).
  - SMTP / firmowa domena dla magic-link delivery (per Pre-Mortem z `infrastructure.md` — soft-block przez korporacyjny spam filter) — Owner: user / IT, faktyczne wykonanie w F-02. Block: no (osobne ryzyko, nie blokuje konfiguracji Access).
- **Risk:** FR-015 jest testowalne **tylko z wewnątrz korporacyjnej sieci** — CI GitHub Actions nie jest tam. Smoke-test "spoza VPN nie łączy" musi być wykonany ręcznie przez dewelopera na firmowym łączu albo via worker-internal scheduled health-check, NIE z CI. Plan to zaadresować w `/10x-plan` dla tego fundamentu, nie później.
- **Status:** dropped
- **Decision 2026-06-12:** Cloudflare Access CIDR-bypass policy usunięty z zakresu MVP. Zamiast network-level gate — link do formularza dystrybuowany wyłącznie przez wewnętrzny portal firmowy. Anonimowość gwarantowana server-side (brak IP/identyfikatora w DB, RLS). Aplikacja pozostaje na Cloudflare Workers.

## Slices

### S-01: Pierwsza anonimowa submisja → AI wzbogaca → admin widzi w detail view

- **Outcome:** Pracownik z firmowej sieci otwiera link, czyta welcome screen, wypełnia formularz (oddział z listy (wymagane), dział z listy (opcjonalne), opcjonalny podpis, tematyka z listy, treść ≤800 znaków z licznikiem), wysyła; widzi "dziękujemy" w <1s. W tle: zgłoszenie ląduje w DB z flagą `enrichment_pending`, F-03 ściąga z kolejki, woła AI, pisze ton + klasyfikację + podsumowanie z powrotem do wiersza. Admin loguje się magic-linkiem (allow-list-gated) i widzi to jedno zgłoszenie z pełną treścią + wzbogaceniami AI (oznaczonymi "AI-generated, może być stronnicze") + podpisem jeśli był + datą + działem.
- **Change ID:** first-end-to-end-submission
- **PRD refs:** US-01 (cała), FR-001 (form opened from intranet/Slack), FR-002 (welcome screen), FR-003 (form fields), FR-004 (confirmation), FR-005 (AI ton), FR-006 (AI klasyfikacja), FR-007 (AI summary), FR-008 (graceful degradation — submisja akceptowana gdy AI fail), FR-009 (admin magic-link), FR-014 (detail view), FR-015 (US-01 AC#1 — network gate part of acceptance), NFR (potwierdzenie <1s, AI-generated disclaimer, brak identyfikatorów technicznych)
- **Prerequisites:** F-01 (schema), F-02 (admin login), F-03 (async enrichment plumbing)
- **Parallel with:** — (jedyny slice gotowy po fundamentach; wszystko inne zależy od S-01)
- **Blockers:** —
- **Unknowns:**
  - ✅ PRD Q4: dostawca AI / model — **RESOLVED 2026-06-02:** OpenAI `gpt-4o-mini` (Structured Outputs). Block: no.
  - ✅ PRD Q6: źródło + wymagalność list — **RESOLVED 2026-06-02:** hardcoded w `src/lib/submissions/taxonomies.ts` (DEPARTMENTS/BRANCHES) + CHECK w migracji; listy stałe per firma. **oddział (branch) = pole wymagane** (schema już `NOT NULL` ✓), **dział (department) = pole opcjonalne** (schema obecnie `NOT NULL` → wymaga migracji `ALTER COLUMN department DROP NOT NULL` przy budowie S-01). Block: no.
  - ✅ PRD Q7: format etykiet tonu na wyjściu AI — **RESOLVED (F-03, shipped):** ton = stały 3-wartościowy enum `Pozytywny | Negatywny | Neutralny` (CHECK w migracji F-01 `20260528000000` + `TONES` w `src/lib/submissions/taxonomies.ts` + Structured-Output schema konsumenta F-03). Nie skala 1-5, nie frustracja/entuzjazm. Block: no.
  - PRD Q1: limit treści 800 znaków — Owner: user (consult firmy). Block: no (domyślnie 800).
- **Risk:** Największy pojedynczy slice (form + admin login + AI enrichment + detail view) w 3-tygodniowym budżecie. Jeśli ten slice przekroczy budżet, cała roadmap się sypie. Bardzo wąsko zakresuj — S-02/S-03 to parking dla wszystkiego, co nie jest absolutnie wymagane do zamknięcia pętli `pracownik → AI → admin` dla pojedynczego zgłoszenia. Magic-link callback na Workers z `@supabase/ssr` ma historię Set-Cookie quirks (per Devil's Advocate #3 `infrastructure.md`) — przetestuj end-to-end zanim ogłosisz auth zrobione.
- **Status:** done

### S-02: Admin dashboard z agregatami

- **Outcome:** Admin po zalogowaniu widzi w jednym widoku: (a) licznik zgłoszeń z filtrem czasu 24h / tydzień / miesiąc / rok / custom range, (b) wykres kołowy podziału zgłoszeń wg tematyki (pomysł / zgłoszenie / propozycja / błąd / skarga), (c) podział zgłoszeń wg oddziału, (d) listę zgłoszeń z AI-podsumowaniem każdego, klikalną do detail view z S-01.
- **Change ID:** admin-dashboard-aggregates
- **PRD refs:** FR-010 (licznik z filtrem czasu), FR-011 (pie chart tematyk), FR-012 (podział oddziałów), FR-013 (lista zgłoszeń z AI-summary)
- **Prerequisites:** S-01 (potrzebuje submisji w DB + admin login + detail view jako target listy)
- **Parallel with:** S-03 (różne surface'y; oba zależą od S-01, oba można rozwijać niezależnie)
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Agregaty są mechaniczne (SQL count + group-by), ale wybór biblioteki wykresów (recharts / Chart.js / Apex) wpływa na bundle size i utrzymanie — decyzja stack-shaped do `/10x-plan`. Custom range filter na froncie (FR-010) wymaga datepickera — wybierz minimalny, nie pełne kalendarze biznesowe. PRD nie wspomina paginacji listy zgłoszeń — przy oczekiwanej skali (kilkadziesiąt do kilkuset/m-c) prosta tabela bez paginacji wystarczy do MVP.
- **Status:** done

### S-03: Notification channel + FR-018 alert na fail AI enrichment

- **Outcome:** Wybrany kanał notyfikacyjny (email lub firmowy komunikator) skonfigurowany; consumer Worker z F-03 emituje event na końcowy fail enrichment (po wyczerpaniu retry), notyfikacja ląduje natychmiast u admina z kontekstem (ID zgłoszenia, error type, czas). Bez tego alertu kolejka zalegających niewzbogaceń rośnie w ciszy (per Socrates round na FR-008 → FR-018).
- **Change ID:** notification-channel-and-ai-alert
- **PRD refs:** FR-018 (must-have alert na enrichment failure)
- **Prerequisites:** S-01 (potrzebuje działającej ścieżki enrichment, żeby było co alertować; transitively F-03)
- **Parallel with:** S-02
- **Blockers:** —
- **Unknowns:**
  - ✅ PRD Q5: format powiadomień — **RESOLVED 2026-06-02:** email only dla MVP (Supabase SMTP / Resend / Cloudflare Email). Slack/Teams → v2. Block: no.
- **Risk:** Jeśli kanał wybrany to email — wystarczy Supabase Auth SMTP albo Cloudflare Email Workers / Resend. Slack dodaje webhook + secret management — buduje warstwę, która nic nie daje dla must-have FR-018 (alert spadnie do email równie dobrze). Pchaj Slacka do v2.
- **Status:** done

### S-04: Natychmiastowa notyfikacja admina o każdym nowym zgłoszeniu

- **Outcome:** Po przyjęciu zgłoszenia (przed enrichment lub po — do decyzji w planie) admin dostaje powiadomienie na ten sam kanał co S-03, z minimalnym kontekstem (czas, dział, tematyka) i linkiem do detail view (gated przez auth).
- **Change ID:** new-submission-instant-notify
- **PRD refs:** FR-016 (nice-to-have instant notification)
- **Prerequisites:** S-03 (kanał już skonfigurowany)
- **Parallel with:** S-05
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Nice-to-have. Jeśli 3-tygodniowy budżet się duszą, S-04 spada poniżej linii — FR-018 alert (S-03) jest must-have, S-04 nie. Trigger: na wpisaniu wiersza do `submissions` (database webhook lub w endpoint'cie po insert), nie w consumer'ze F-03 (consumer odpala się po Q1-time, nie real-time).
- **Status:** done

### S-05: Cotygodniowy mail-digest w poniedziałek 8:00

- **Outcome:** W każdy poniedziałek o 8:00 Europe/Warsaw admin dostaje mail z podsumowaniem zgłoszeń poprzedniego tygodnia: liczba zgłoszeń, breakdown wg tematyki, breakdown wg oddziału, opcjonalnie top-3 tematów wg klasyfikacji AI.
- **Change ID:** weekly-digest
- **PRD refs:** FR-017 (nice-to-have weekly mail)
- **Prerequisites:** S-02 (digest re-używa agregacji z dashboardu), S-03 (re-używa skonfigurowanego kanału)
- **Parallel with:** S-04
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Nice-to-have. Cron Triggers na Workers działają na UTC; DST gotcha (Europe/Warsaw = UTC+1 zimą, UTC+2 latem) — nie trzymaj trigger time literalnie. Per Devil's Advocate #5 z `infrastructure.md`: lepiej policzyć weekly window wewnątrz handlera (od poniedziałku-7d 00:00 do poniedziałku 00:00 lokalnie) niż polegać na tym, że trigger odpali dokładnie 08:00 Warszawa. Consumer musi być idempotentny (Workers nie gwarantuje at-least-once na Free tier).
- **Status:** done — wdrożony 2026-06-19; okno tygodnia DST-correct (unit-tested `previousWarsawWeekRange`). **2026-06-29: cron NAPRAWIONY i zweryfikowany end-to-end.** Diagnoza: `0 7 * * 1` nie był zarejestrowany w schedulerze (deploye przez Workers Builds = version-upload, nie rejestrują triggerów — lessons.md:148; potwierdzone `wrangler deployments list`: brak czystego `wrangler deploy` od 22.06). Fix: `wrangler triggers deploy -c dist/server/wrangler.json` + pełny `wrangler deploy` — oba crony zarejestrowane na poziomie skryptu, persystują przez przyszłe uploady (lessons.md:149). Ścieżka digestu potwierdzona na active deployment przez on-demand trigger (lessons.md:142): okno 22–28.06, `{sent:true}`, realny send Resend; temp route usunięty (route→404, Version 698fdfe2). Pozostaje tylko naturalna obserwacja autonomicznego firingu w pon 2026-07-06. GitHub #12 zamknięty 2026-06-29.

### S-06: Admin triage — status zgłoszenia + usuwanie (pełny CRUD)

- **Outcome:** Admin na detalu zgłoszenia widzi badge bieżącego statusu i może (a) zmienić status triage'u (`nowe → w trakcie → rozpatrzone → odrzucone`) oraz (b) twardo usunąć zgłoszenie (moderacja spamu/off-topic). Obie akcje idą przez sesję admina (SSR cookie-client → RLS + column-scoped grant jako backstop), bramkowane allow-listą i same-origin. Status to wyłącznie metadana-badge — NIE zmienia listy, agregatów ani weekly-digestu; anonimowość nadawcy nienaruszona (status/delete to operacje admina, nie tożsamość).
- **Change ID:** admin-submission-triage
- **PRD refs:** — (poza zakresem PRD v1). Dodane, by aplikacja demonstrowała **pełny CRUD** — wymóg zaliczenia kursu (10xDevs), nie decyzja produktowa o odparkowaniu Non-Goal. Pierwotnie w §Non-Goals / Parked.
- **Prerequisites:** S-01 (detail view jako miejsce akcji + magic-link admin login), S-02 (dashboard jako target redirectu po delete)
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Mutacje admina na anonimowych danych — kluczowe, by szły przez sesję admina (RLS aktywne), nie service-role; UPDATE column-scoped do `review_status` (42501 backstop na inne kolumny), DELETE twardy bez audytu. Zakres ciasny: brak filtrowania listy/agregatów po statusie (zero ryzyka dla S-02/S-05). Świadomie sprzeczne z PRD §Non-Goals „admin tylko czyta i agreguje" — uzasadnione wymogiem CRUD kursu, nie potrzebą produktu.
- **Status:** done

## Backlog Handoff

| Roadmap ID | Change ID                          | Suggested issue title                                                | Ready for `/10x-plan` | Notes                                                          |
| ---------- | ---------------------------------- | -------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------- |
| F-01       | submissions-data-model             | Foundation: tabela submissions + types + RLS                          | yes                   | Run `/10x-plan submissions-data-model`                         |
| F-02       | auth-refit-magic-link              | Foundation: refit auth na magic-link + admin allow-list               | yes                   | Run `/10x-plan auth-refit-magic-link`. Wytnij stare endpointy. |
| F-03       | ai-enrichment-queue                | Foundation: queue + consumer Worker dla AI enrichment                 | yes                   | Q4 resolved 2026-06-02 (OpenAI gpt-4o-mini). Run `/10x-plan ai-enrichment-queue`. |
| F-04       | corporate-network-gate             | Foundation: Cloudflare Access CIDR-bypass policy                      | no                    | **Dropped 2026-06-12**: link dystrybuowany przez intranet firmowy, network-level gate niepotrzebny. |
| S-01       | first-end-to-end-submission        | North star: pierwsza anonimowa submisja + admin detail view           | yes                   | F-01/F-02/F-03 done; Q4/Q6/Q7 resolved. Run `/10x-plan first-end-to-end-submission` (zrób migrację department DROP NOT NULL per Q6). |
| S-02       | admin-dashboard-aggregates         | Admin dashboard: licznik + pie + oddziały + lista                     | no                    | Prereq S-01                                                    |
| S-03       | notification-channel-and-ai-alert  | Kanał notyfikacji + FR-018 alert na enrichment fail                   | no                    | Prereq S-01                                                    |
| S-04       | new-submission-instant-notify      | Natychmiastowa notyfikacja admina o nowym zgłoszeniu                  | no                    | Prereq S-03; nice-to-have                                      |
| S-05       | weekly-digest                      | Cotygodniowy mail-digest w poniedziałek 8:00                          | no                    | Prereq S-02, S-03; nice-to-have                                |
| S-06       | admin-submission-triage            | Admin triage: status zgłoszenia + usuwanie (pełny CRUD, poza-PRD)     | n/a (done)            | Dostarczone 2026-06-23 dla wymogu CRUD zaliczenia kursu; zmiana spoza roadmapy MVP. |

## Open Roadmap Questions

> Wszystkie trzy rozwiązane 2026-06-02. Treść pytań zachowana; rozwiązanie dopisane.

1. ✅ **N startowe zgłoszenia pilota** — ile zgłoszeń w pierwszym miesiącu pilota uznajemy za "produkt zadziałał"? — Owner: user (consult firmy). Block: roadmap-wide. **RESOLVED 2026-06-02:** ≥10 zgłoszeń w pierwszym miesiącu (≈2–4/tydzień). Metryka sukcesu pilota; nie blokuje żadnego slice'u.
2. ✅ **Wybór dostawcy AI** — który dostawca / model? — Owner: user. Block: F-03, S-01. **RESOLVED 2026-06-02:** OpenAI `gpt-4o-mini` przez Structured Outputs (strict JSON schema) dla tonu + klasyfikacji (5 kategorii) + podsumowania. Async → latency bez znaczenia, koszt znikomy na tej skali. Anthropic `claude-haiku` = pre-vetted alternatywa (oba tokeny API dostępne; brak local LLM). Treść anonimowa opuszcza firmę do zewn. API pod DPA + no-training.
3. ✅ **Format powiadomień admina** (FR-016 / FR-017 / FR-018) — Owner: user + IT. Block: S-03. **RESOLVED 2026-06-02:** email only dla MVP (Supabase SMTP / Resend / Cloudflare Email). Slack/Teams → v2.

## Parked

- **Multi-tenancy / SaaS dla wielu firm.** Why parked: PRD §Non-Goals — jedna firma = jedna instancja; brak panelu klientów, brak billowania, brak izolacji per tenant. Twardy scale ceiling ~270 pracowników dopina temat.
- **Komentarze admina / kanał zwrotny do pracownika.** Why parked: PRD §Non-Goals — kanał zwrotny i komentarze pozostają poza zakresem; twarda anonimowość uniemożliwia kanał zwrotny do anonimowego nadawcy. *Aktualizacja 2026-06-23: status-triage zgłoszeń („zaznacz jako rozpatrzone" — nowe/w trakcie/rozpatrzone/odrzucone) + usuwanie — pierwotnie parkowane tu jako część „workflow statusów" — dostarczone jako S-06 (`admin-submission-triage`) dla wymogu pełnego CRUD do zaliczenia kursu. Stanowisko produktowe („admin tylko czyta i agreguje") bez zmian; parked pozostają już tylko komentarze i kanał zwrotny.*
- **Hierarchia ról adminów (team-lead per dział, read-only audytor).** Why parked: PRD §Non-Goals — płaski model, każdy admin widzi wszystko; jeden poziom uprawnień.
- **Algorytm "podobnych" zgłoszeń / auto-generowanie meta-pomysłów po progu N.** Why parked: PRD §Non-Goals — AI klasyfikuje pojedyncze zgłoszenie i nic więcej; grupowanie i meta-pomysły są explicite wycięte do v2.
- **Edge cases dostępu: kontraktorzy / audytorzy / goście / nowi pracownicy przed konfiguracją VPN.** Why parked: PRD §Non-Goals — MVP jest dla pracowników etatowych z firmowym VPN-em; inne osoby używają kanałów poza systemem (mail).
- **Real-time / live updates dashboardu, natywne aplikacje mobilne, eksport raportów (PDF/CSV).** Why parked: PRD §Non-Goals — dashboard odświeża się przy załadowaniu strony; formularz responsywny w przeglądarce (nie native app); eksporty mogą wrócić w v2.
- **Retention auto-delete cron** (po N latach od daty wysłania). Why parked: PRD NFR wskazuje politykę retencji jako wymóg, ale data N (sugerowane 2 lata) ma być potwierdzona z DPO; MVP nie usuwa nic, dane lądują z timestampem `created_at` — cron retencyjny wpada do v2 lub gdy DPO odpowie.

## Done

- **F-01: (foundation) tabela `submissions` (z kolumnami enrichment) + RLS policy (anon insert, admin read) + wygenerowane `database.types.ts` gotowe do importu z kodu Worker/Astro.** — Archived 2026-05-29 → `context/archive/2026-05-28-submissions-data-model/`. Lesson: —.
- **F-02: (foundation) admin loguje się magic-linkiem na firmowy email; email+password wycofany; allow-list (env-var konfigurowana ręcznie per shape-notes) gateuje, kto w ogóle może się zalogować; middleware nadal enforcuje guard na `/dashboard`.** — Archived 2026-06-02 → `context/archive/2026-06-01-auth-refit-magic-link/`. Lesson: —.
- **F-03: (foundation) Cloudflare Queue zaglądana przez consumer Worker; submisja z S-01 wystawia job na kolejkę (fire-and-forget, <1s response per NFR), consumer ciągnie job, wywołuje dostawcę AI, retry/backoff przy błędach przejściowych, emit structured event przy końcowym fail (źródło sygnału dla S-03 FR-018 alertu).** — Archived 2026-06-05 → `context/archive/2026-06-02-ai-enrichment-queue/`. Lesson: —.
- **S-01: Pracownik z firmowej sieci otwiera link, czyta welcome screen, wypełnia formularz (oddział z listy (wymagane), dział z listy (opcjonalne), opcjonalny podpis, tematyka z listy, treść ≤800 znaków z licznikiem), wysyła; widzi "dziękujemy" w <1s. W tle: zgłoszenie ląduje w DB z flagą `enrichment_pending`, F-03 ściąga z kolejki, woła AI, pisze ton + klasyfikację + podsumowanie z powrotem do wiersza. Admin loguje się magic-linkiem (allow-list-gated) i widzi to jedno zgłoszenie z pełną treścią + wzbogaceniami AI (oznaczonymi "AI-generated, może być stronnicze") + podpisem jeśli był + datą + działem.** — Archived 2026-06-06 → `context/archive/2026-05-28-first-end-to-end-submission/`. Lesson: —.
- **S-02: Admin po zalogowaniu widzi w jednym widoku: (a) licznik zgłoszeń z filtrem czasu 24h / tydzień / miesiąc / rok / custom range, (b) wykres kołowy podziału zgłoszeń wg tematyki (pomysł / zgłoszenie / propozycja / błąd / skarga), (c) podział zgłoszeń wg oddziału, (d) listę zgłoszeń z AI-podsumowaniem każdego, klikalną do detail view z S-01.** — Archived 2026-06-12 → `context/archive/2026-06-12-admin-dashboard-aggregates/`. Lesson: —.
- **S-03: Wybrany kanał notyfikacyjny (email lub firmowy komunikator) skonfigurowany; consumer Worker z F-03 emituje event na końcowy fail enrichment (po wyczerpaniu retry), notyfikacja ląduje natychmiast u admina z kontekstem (ID zgłoszenia, error type, czas). Bez tego alertu kolejka zalegających niewzbogaceń rośnie w ciszy (per Socrates round na FR-008 → FR-018).** — Archived 2026-06-15 → `context/archive/2026-06-13-notification-channel-and-ai-alert/`. Lesson: —.
- **S-04: Po przyjęciu zgłoszenia (przed enrichment lub po — do decyzji w planie) admin dostaje powiadomienie na ten sam kanał co S-03, z minimalnym kontekstem (czas, dział, tematyka) i linkiem do detail view (gated przez auth).** — Archived 2026-06-18 → `context/archive/2026-06-15-new-submission-instant-notify/`. Lesson: push Supabase migrations to prod as part of deploy.
- **S-06: Admin na detalu zgłoszenia zmienia status triage'u (nowe → w trakcie → rozpatrzone → odrzucone) i twardo usuwa zgłoszenie; obie akcje przez sesję admina (RLS + column-grant backstop), status to metadana-badge nie zmieniająca agregatów/listy/digestu.** — Archived 2026-06-23 → `context/archive/2026-06-19-admin-submission-triage/`. Lesson: —. (Zmiana spoza roadmapy MVP — dodana dla wymogu pełnego CRUD do zaliczenia kursu; dostarcza status-triage pierwotnie parkowany w §Non-Goals.)
