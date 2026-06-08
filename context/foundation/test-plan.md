# Test Plan

> Phased test rollout for this project. Strategy is frozen at the top
> (§1–§5); cookbook patterns at the bottom (§6) fill in as phases ship.
> Read before writing any new test.
>
> Refresh: re-run `/10x-test-plan --refresh` when stale (see §8).
>
> Last updated: 2026-06-08

## 1. Strategy

Testy w tym projekcie respektują trzy nienegocjowalne zasady:

1. **Koszt × sygnał.** Wygrywa najtańszy test, który daje realny sygnał dla
   danego ryzyka. Nie promuj do e2e dlatego, że e2e „wydaje się bezpieczniejsze".
   Nie nakładaj modelu wizyjnego na deterministyczny diff, który i tak łapie
   regresję.
2. **Obawy użytkownika to dowód pierwszej klasy.** Ryzyka zakotwiczone w
   „zespół boi się X, a porażka ujawniłaby się gdzieś w obszarze `<area>`"
   ważą tyle samo, co linie PRD czy dane z hot-spotów.
3. **Ryzyka to scenariusze, nie lokalizacje w kodzie.** Ten plan dokumentuje
   *co może się zepsuć* i *dlaczego sądzimy, że jest to prawdopodobne* —
   na podstawie dokumentów, wywiadu i *sygnału* z bazy kodu (churn, struktura,
   baza testów). NIE twierdzi, że wie, która linia odpowiada za porażkę. Tę
   wiedzę produkuje `/10x-research` w każdej fazie rolloutu. Jeśli plan i
   research nie zgadzają się co do tego, gdzie żyje porażka — **research jest
   źródłem prawdy**.

Hot-spot scope użyty do ważenia likelihood: `src/` (bez `node_modules`, `dist`,
`.astro`, plików testowych). 22 commity/30d — sygnał wystarczający.

## 2. Risk Map

Najważniejsze scenariusze porażki, które ten projekt musi chronić, uporządkowane
wg risk = impact × likelihood. Ryzyka to scenariusze porażki w kategoriach
user/biznes, nie nazwy testów. Kolumna Source cytuje *dowód, który wyniósł to
ryzyko na wierzch* — nigdy konkretnego pliku jako „gdzie żyje porażka" (to
zadanie researchu, patrz §1 zasada #3).

| # | Risk (failure scenario) | Impact | Likelihood | Source (evidence — not anchor) |
|---|--------------------------|--------|------------|--------------------------------|
| 1 | Zalogowany nie-admin (lub usunięty admin) odczytuje cudze zgłoszenie przez detail view, albo RLS przepuszcza dowolnego authenticated principal → łamie guardrail „zero wycieku poza adminów" | High | High | PRD Guardrails „Zero wycieku poza adminów" + Access Control; interview Q1, Q4; archive `2026-05-28-submissions-data-model/plan.md`, `2026-06-01-auth-refit-magic-link/plan.md`, `2026-06-4-first-end-to-end-submission/plan.md`; hot-spot dir `src/pages` (26 commits/30d) |
| 2 | Deanonimizacja: system zapisuje IP / identyfikator nadawcy, albo PII/podpis wycieka do logów lub treści błędów | High | Medium | PRD Guardrails „Twarda anonimowość" + NFR „nie zbiera identyfikatorów technicznych"; interview Q1, Q4; archive `2026-06-02-ai-enrichment-queue/plan.md`, `2026-06-4-first-end-to-end-submission/plan.md` |
| 3 | Anonimowy nadawca podstawia w payloadzie pola wzbogacenia / status / id, a server-side whitelist ma lukę → sfałszowane atrybuty AI, admin decyduje na fałszywych danych | Medium | Medium | archive `2026-05-28-submissions-data-model/plan.md` (column grants), `2026-06-4-first-end-to-end-submission/plan.md` (payload whitelist); interview Q1 |
| 4 | Formularz pokazuje „dziękujemy" <1s, ale DB CHECK odrzuca (drift taksonomii) lub insert OK a enqueue pada po cichu → ciche zgubienie zgłoszenia, nigdy nie trafia do dashboardu | High | Medium | PRD FR-008 + NFR (<1s); archive `2026-05-29-submissions-data-model-hardening/plan.md` (CHECK drift), `2026-06-02-ai-enrichment-queue/plan.md`, `2026-06-4-first-end-to-end-submission/plan.md` (insert/enqueue rozdzielone); hot-spot dir `src/lib` (23 commits/30d) |
| 5 | Spam magic-linków / enumeracja adminów: powtarzane żądania OTP zalewają skrzynkę, wpadają w SMTP rate-limit, albo ujawniają, który email jest na allow-liście | Medium | Medium | interview Q4 (wprost); PRD FR-009 + Access Control; archive `2026-06-01-auth-refit-magic-link/plan.md` (non-enumeration); abuse lens (resource abuse + enumeration) |
| 6 | Magic-link cookie / PKCE nie round-trip na runtime Workers (prod ≠ dev) → admin nie zaloguje się na produkcji mimo że lokalnie działa | High | Medium | archive `2026-06-01-auth-refit-magic-link/plan.md` (PKCE cookie); roadmap S-01 risk + infrastructure Devil's Advocate #3; hot-spot dir `src/pages` (auth flow, 26 commits/30d) |
| 7 | Kolejka AI: duplikat dostarczenia bez compare-and-swap nadpisuje/dubluje wzbogacenie i pali tokeny; albo wiersz wisi w `processing` na zawsze | Medium | Medium | archive `2026-06-02-ai-enrichment-queue/plan.md` (idempotency CAS, retry/DLQ); częściowo pokryte istniejącymi testami w `src/lib/enrichment/` |

**Impact × Likelihood rubric.** High = user traci dostęp/dane/pieniądze lub
porażka jest publicznie widoczna / obszar zmienia się tygodniowo lub już się tu
sparzyliśmy. Medium = feature degraduje, istnieje workaround, dotyczy części
userów / obszar ruszany okazjonalnie, bywał źródłem bugów. Low = kosmetyka,
łatwo odwracalne / kod stabilny, rzadko ruszany.

Kolejność wg impact × likelihood: chroń High × High (#1) najpierw. Network gate
FR-015 (high-impact, but feature `blocked` i testowalny tylko z wnętrza firmowej
sieci) NIE jest ryzykiem testowym tutaj — patrz §7.

### Risk Response Guidance

| Risk | What would prove protection | Must challenge | Context `/10x-research` must ground | Likely cheapest layer | Anti-pattern to avoid |
|------|-----------------------------|----------------|--------------------------------------|-----------------------|-----------------------|
| #1 | Nie-admin / usunięty admin dostaje 403 lub redirect zarówno na liście, jak i na detail view pojedynczego zgłoszenia; RLS sam blokuje SELECT (defense in depth) | „middleware na `/dashboard` root wystarczy"; „zalogowany == uprawniony" | gdzie egzekwowana jest allow-lista (app vs DB), kształt guarda routingu na detail route, czy RLS jest DB-gated czy otwarte | integration (route + mocked Supabase) + weryfikacja RLS | happy-path-only; test tylko warstwy app gdy DB pozostaje otwarte |
| #2 | Insert nie zawiera IP/identyfikatora nadawcy; logi i ciała błędów nie zawierają treści ani podpisu; payload wysyłany do AI nie zawiera podpisu | „skoro endpoint jest anon, to na pewno nic nie logujemy"; „błąd nie wycieknie PII" | co dokładnie wchodzi do insertu, co trafia do logów/observability, co do promptu AI | unit (kształt payloadu i promptu) + integration (brak PII w ścieżce błędu) | asercja skopiowana z implementacji; pominięcie ścieżki błędu/wyjątku |
| #3 | Klient wysyłający pola wzbogacenia / `id` / status dostaje je odrzucone lub zignorowane; column-grants w DB blokują zapis nawet przy luce w whitelist | „whitelist po stronie app wystarczy" | pełna lista pól dozwolonych vs grantów kolumnowych w DB, gdzie kończy się czarna lista | unit (whitelist) + weryfikacja grantów kolumnowych | luka w czarnej liście; brak testu backstopu DB-grant |
| #4 | „Sukces w UI" ⇒ trwały wiersz w DB **albo** czysty błąd; taksonomie ≡ enumy CHECK w migracji; enqueue-fail nie gubi danych po cichu | „status 200 == zapisane i zakolejkowane"; „taksonomie zawsze zgodne z DB" | mapowanie `taxonomies.ts` ↔ CHECK w migracji, sekwencja insert/enqueue, zachowanie przy enqueue-fail | unit (drift guard: taxonomy ≡ CHECK) + integration (insert/enqueue) | snapshot bez znaczenia; brak pokrycia ścieżki enqueue-fail |
| #5 | Powtarzane żądania OTP są dławione (built-in Supabase) i bramowane allow-listą fail-closed; odpowiedź nie ujawnia istnienia konta | „flood się sam nie zdarzy"; „trzeba dopisać własny rate-limiter" (najpierw zweryfikuj built-in!) | czy Supabase OTP ma wbudowany throttle, jak fail-closed zachowuje się allow-lista, czy odpowiedź jest jednakowa dla konta i nie-konta | integration (allow-list fail-closed + non-enumeration) | testowanie rate-limitera, którego nie ma — najpierw zweryfikuj built-in |
| #6 | Callback ustawia trwałe cookie sesji na runtime Workers; admin pozostaje zalogowany po round-tripie na prod | „działa lokalnie == działa w prod" | kształt Set-Cookie na streaming response Workers, format i przekazanie PKCE verifier | contract/integration na callbacku + manualny smoke na preview deploy | unit mockujący cookie bez runtime Workers (fałszywy zielony) |
| #7 | Drugie dostarczenie tego samego joba nie woła AI ponownie ani nie nadpisuje wyniku; stale `processing` jest odzyskiwany | „status 200 == sukces"; „retry zawsze bezpieczny" | mechanizm CAS `pending → processing`, próg stale-reclaim, granica transient vs permanent | unit (idempotency / branching — rozszerzyć istniejące w `src/lib/enrichment/`) | retry-loop bez idempotencji; konflacja transient/permanent |

## 3. Phased Rollout

Każdy wiersz to dyskretna faza rolloutu, która otworzy własny change folder
przez `/10x-new`. Status przesuwa się od lewej do prawej; orkiestrator
aktualizuje Status, gdy artefakty pojawiają się na dysku.

| # | Phase name | Goal (one line) | Risks covered | Test types | Status | Change folder |
|---|------------|-----------------|---------------|------------|--------|---------------|
| 1 | Access-control & anonimowość core | Nikt niepowołany nie czyta zgłoszeń; nigdzie nie zapisujemy IP/identyfikatora; nie da się sfałszować pól AI | #1, #2, #3 | integration (route + RLS), unit (payload/whitelist/no-PII) | complete | context/changes/testing-access-control-anonymity/ |
| 2 | Trwałość submisji & integralność taksonomii | „Sukces w UI" = trwały wiersz albo czysty błąd; brak cichej utraty; brak driftu taksonomii | #4, #7 | unit (drift guard), integration (insert/enqueue, idempotency) | not started | — |
| 3 | Auth & granica nadużyć | Brak spamu/enumeracji magic-linków; sesja round-trip na prod | #5, #6 | integration (allow-list/enumeration), contract (Set-Cookie) + manual preview smoke | not started | — |
| 4 | Quality-gates wiring | Zatrzaśnij podłogę jakości w CI | cross-cutting | wpięcie gate'ów (vitest unit+integration w CI) | not started | — |

**Status vocabulary** (fixed — parser literals): `not started` → `change opened`
→ `researched` → `planned` → `implementing` → `complete`.

## 4. Stack

Klasyczna baza testów tego projektu. Narzędzia AI-native (jeśli są) noszą datę
`checked:`. Rekomendacje są ugruntowane w lokalnych manifestach/configach plus
MCP/narzędziach faktycznie wystawionych w bieżącej sesji.

| Layer | Tool | Version | Notes |
|-------|------|---------|-------|
| unit + integration | Vitest | ^4.1.8 | node env; `@/*` alias mirror tsconfig; obecne testy pure-logic z mockami queue/Supabase/OpenAI |
| API / route testing | Vitest + ręczne mocki klientów | ^4.1.8 | brak MSW; route testy mockują admin client + QUEUE binding (wzorzec z `src/pages/api/submissions.test.ts`) |
| Workers runtime pool | `@cloudflare/vitest-pool-workers` | none yet — see Phase 3 | dodać tylko jeśli test wymaga żywego runtime Workers (np. Set-Cookie round-trip #6) |
| e2e | — | none yet | poza scope MVP; krytyczne flow weryfikowane manualnie pod `wrangler dev` / preview |
| accessibility | — | none yet | poza scope (negative space §7 — UI nie testujemy) |
| AI-native | — | n/a | brak dedykowanej warstwy — patrz §7 (deterministyczne asercje pokrywają sygnał taniej) |

**Stack grounding tools (current session):**
- Docs: Context7 — dostępny; nie odpytywany przy pisaniu strategii (stack znany z manifestów); użyć w `/10x-research` dla aktualnych API Supabase SSR / Cloudflare Queues; checked: 2026-06-08
- Search: Exa.ai — dostępny; nieużywany (źródła lokalne wystarczyły); checked: 2026-06-08
- Runtime/browser: claude-in-chrome — dostępny; nieużywany (UI poza scope testów per §7); checked: 2026-06-08
- Provider/platform: GitHub `gh` CLI + Linear MCP — dostępne; brak Supabase/Cloudflare MCP w tej sesji; potencjalna rola: brama jakości w CI (Phase 4); checked: 2026-06-08

## 5. Quality Gates

Pełny zestaw bram, które muszą przejść, zanim zmiana trafi na produkcję.
„Required after §3 Phase N" znaczy, że brama jest egzekwowana po wdrożeniu tej
fazy; wcześniej jest `planned`.

| Gate | Where | Required? | Catches |
|------|-------|-----------|---------|
| lint (`npm run lint`) | local + CI | required | drift składni / styl |
| typecheck (`npm run typecheck` = `astro check`) | local + CI | required | drift typów |
| unit + integration (`npm test` = `vitest run`) | local + CI | required after §3 Phase 4 | regresje logiki, dostępu, anonimowości, taksonomii |
| manual preview smoke (auth round-trip) | między merge a prod | required after §3 Phase 3 | prod-only failures (Set-Cookie na Workers, #6) |
| manual SQL-probe (`supabase/tests/access-control-probes.sql`) | local/staging | required after §3 Phase 1 | RLS SELECT gate (`is_allowed_admin()`) + anon column-grant backstop (#1/#3 DB layer) |
| post-edit hook | local (agent loop) | optional | regresje w czasie edycji (Module 3 Lesson 3) |

CI dziś robi tylko lint+build (per roadmap baseline); wpięcie `npm test` jako
bramy jest własnością §3 Phase 4. Nie listujemy bram bez fazy, która je wpina.

## 6. Cookbook Patterns

Jak dodawać nowe testy w tym projekcie. Każda podsekcja wypełnia się, gdy
odpowiednia faza rolloutu dostarczy wzorzec; wcześniej brzmi „TBD — see §3
Phase N".

### 6.1 Adding a unit test

- **Location**: obok testowanej jednostki w `src/lib/<obszar>/` (np.
  `src/lib/submissions/`).
- **Naming**: `<module>.test.ts` (vitest `include: src/**/*.{test,spec}.ts`).
- **Reference test**: `src/lib/submissions/submission-input.test.ts` (istniejący wzorzec).
- **Run locally**: `npm test` (`vitest run`).
- **Allow-lista fail-closed**: `src/lib/auth/allowlist.test.ts` — testuje
  `isAllowedAdmin()`/`isAllowlistConfigured()`. Lista jest mrożona w `Set` przy
  imporcie modułu, więc każdy scenariusz wczytuje moduł od nowa helperem
  `loadAllowlist(emails)` (`vi.resetModules()` + `vi.doMock("astro:env/server", …)`
  + dynamiczny `import("./allowlist")`); mutacja env po imporcie NIE przebuduje Setu.
- **Whitelist „ignored by construction"**: `submission-input.test.ts` pieczętuje
  dokładny zestaw kluczy przez `expect(Object.keys(value).sort()).toEqual([...])` —
  dorzuć wstrzykiwane pola serwerowe (`id`/`enrichment_*`/`ai_*`) do payloadu i
  potwierdź ich brak w zwalidowanej wartości.

### 6.2 Adding an integration test (route + side-effect)

- **Reference test**: `src/pages/api/submissions.test.ts` (mock admin client + QUEUE binding).
- **Mocking policy**: mockuj tylko na krawędzi (Supabase client, QUEUE, OpenAI); nie mockuj modułów wewnętrznych.
- **Middleware route-guard (#1)**: `src/middleware.test.ts` — importuje `onRequest`
  z zamockowanymi krawędziami: `astro:middleware` (`defineMiddleware` jako identity
  passthrough → `onRequest` to goła funkcja `(context, next)`), `@/lib/supabase`
  (`createClient` → stub `auth.getUser` albo `null`) i `@/lib/auth/allowlist`
  (`isAllowedAdmin` → kontrolowalny boolean). Driver: sztuczny `context` + `next: vi.fn()`;
  macierz pokrywa pod-trasę `/dashboard/submissions/<id>` (nie tylko root), redirect
  nie-admina/niezalogowanego do `/auth/signin` i passthrough admina.
- Pełny wzorzec dla insert/enqueue (#4) — TBD, uzupełni §3 Phase 2.

### 6.3 Adding an auth / Workers-runtime test

- TBD — see §3 Phase 3 (allow-list fail-closed, non-enumeration, Set-Cookie round-trip; ewentualny `@cloudflare/vitest-pool-workers`).

### 6.4 Adding a queue/consumer idempotency test

- **Reference test**: `src/lib/enrichment/consumer.test.ts`, `enrich.test.ts` (istniejące).
- Rozszerzenie o pełną macierz transient/permanent + stale-reclaim — TBD, uzupełni §3 Phase 2.

### 6.5 Adding a taxonomy drift-guard test

- TBD — see §3 Phase 2 (asercja `taxonomies.ts` ≡ enumy CHECK w migracji).

### 6.6 Per-rollout-phase notes

(Opcjonalne. Po każdej fazie `/10x-implement` dopisze 2-3 linijki o tym, co
faza nauczyła — np. nowy katalog fixture'ów do reużycia.)

- **Phase 1 (access-control & anonimowość core)** ustanowiła: (1) wzorzec
  `loadAllowlist(emails)` — reset modułu + `vi.doMock("astro:env/server")` +
  dynamiczny import — do testowania modułów mrożących stan z env przy imporcie;
  (2) mockowanie wirtualnych modułów Astro (`astro:middleware`, `astro:env/server`)
  w czystym node-vitest, bez pluginu Astro; (3) lokalizację bramy DB-layer:
  `supabase/tests/access-control-probes.sql` (uruchamiana ręcznie — patrz §6.7).

### 6.7 Running the DB-layer access-control SQL probes (#1/#3)

- **Script**: `supabase/tests/access-control-probes.sql` (manual gate, wired in §5).
- **Where**: lokalny lub staging Supabase (schemat `auth` + `auth.jwt()` muszą
  istnieć — goły Postgres ich nie ma), z zaseedowaną allow-listą
  (`npm run db:seed-admins`). Uruchom jako rola uprzywilejowana — domyślny
  `postgres` w Studio, albo psql jako owner service-role/postgres.
- **Run**: wklej blok probe do edytora SQL w Studio, albo
  `psql "$DATABASE_URL" -f supabase/tests/access-control-probes.sql` (NIE dawaj
  `--set ON_ERROR_STOP=1` — Probe 3 celowo rzuca 42501 i przerwałby plik).
- **Expected outcomes**:
  - Probe 1 — non-admin SELECT → **0 wierszy** (RLS odmawia mimo zaseedowanego wiersza).
  - Probe 2 — admin SELECT → **≥ 1 wiersz** (brama wpuszcza email z allow-listy).
  - Probe 3 — anon insert do `id`/`enrichment_status`/`ai_title` → **ERROR 42501** (błąd JEST passem).
  - Probe 4 — anon insert do pięciu nadanych kolumn → **sukces** (potem ROLLBACK).
  - Probe 5 — SELECT byłego admina → **≥ 1 przed** DELETE z allow-listy, **0 po**.
- **Usunięcie admina to manualny krok w DB.** `db:seed-admins` jest *additive-only* i
  nigdy nie kasuje, więc allow-lista app (`ALLOWED_ADMIN_EMAILS`) i allow-lista DB
  (`admin_allowlist`) po cichu się rozjeżdżają przy usunięciu: middleware blokuje
  byłego admina po redeployu, ale nieaktualny wiersz w `admin_allowlist` nadal
  przepuszcza *bezpośredni* odczyt przez PostgREST. Zamknij to przez:
  `DELETE FROM public.admin_allowlist WHERE email = '<email>';`
- **Scope note**: Probe 3/4 (rola anon) testują *backstop* grantów kolumnowych, który
  żywy endpoint omija (insert przez service-role). To regression fence, nie test ścieżki produkcyjnej.

## 7. What We Deliberately Don't Test

Wykluczenia ustalone podczas rolloutu (wywiad Phase 2, Q5). Przyszli
kontrybutorzy respektują je, dopóki założenie się nie zmieni.

- **Snapshoty UI stron statycznych** (welcome / marketing / landing) — psują się przy każdej zmianie stylu, nie łapią defektów. Re-evaluate jeśli statyczna strona zacznie nieść logikę. (Source: Phase 2 interview Q5.)
- **Wizualne testy wykresów dashboardu** — wystarczy, że dane agregatów się zgadzają (test logiki), piksele nie. Re-evaluate jeśli wykres zacznie liczyć/filtrować po stronie klienta. (Source: Phase 2 interview Q5.)
- **Poprawność/halucynacje treści AI** (ton / klasyfikacja / summary) — PRD świadomie akceptuje ryzyko (admin klika w detail i czyta surowy tekst ≤800 zn.; etykiety oznaczone jako AI). Testujemy *kształt* wyjścia (enum w taksonomii), nie *trafność*. (Source: PRD FR-005..007 Socrates.)
- **Network gate FR-015** — feature F-04 `blocked`; testowalny tylko z wnętrza firmowej sieci, nie z CI → manualny smoke przy starcie pilota, nie faza rolloutu. (Source: roadmap F-04, PRD FR-015.)
- **Nice-to-have S-04 (instant notify) / S-05 (weekly digest)** — póki niewdrożone; wejdą do mapy ryzyk przy ich rollout. (Source: roadmap S-04/S-05 `proposed`.)

## 8. Freshness Ledger

- Strategy (§1–§5) last reviewed: 2026-06-08
- Stack versions last verified: 2026-06-08
- AI-native tool references last verified: 2026-06-08

Refresh (`/10x-test-plan --refresh`) when:

- a new top-3 risk surfaces from the roadmap or archive,
- a recommended tool's `checked:` date is older than three months,
- the project's tech stack changes (new framework, new test runner),
- §7 negative-space no longer matches what the team believes.
