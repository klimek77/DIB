<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Sentry Error Monitoring (Astro + Cloudflare Workers)

- **Plan**: context/changes/sentry-observability/plan.md
- **Scope**: Phases 1–4 of 4 (full plan)
- **Date**: 2026-06-11
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Kontekst: 15/15 zaplanowanych zmian obecnych, zero MISSING, zero CRITICAL. Granica importu SDK utrzymana (tylko `worker.ts` + `sentry-server-options.ts` + `sentry.client.config.ts`). Odstępstwa od litery planu (`enabled:{server:false}` zamiast `autoInstrumentation`, `unstable_sentryVitePluginOptions` zamiast deprecated `sourceMapsUploadOptions`, `vite.define` zamiast `PUBLIC_`) udokumentowane inline i uzasadnione realnym API SDK v10. Bramki automatyczne ponownie zielone podczas przeglądu: lint, typecheck (0 błędów), `npm test` (92/92), build, `test:workers:run` (3/3), `git grep "sentry-verify"` w źródłach czysty. Nie podniesiono do findingów: gating capture'a na "markFailed nie rzucił" (spójny z istniejącym `emitFailureSignal`) i 4-linijkowa duplikacja redaktora (udokumentowana, poniżej progu ekstrakcji).

## Findings

### F1 — Brak dummy-bindingu SENTRY_DSN w testach workers

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (data safety)
- **Location**: vitest.workers.config.ts:26-34
- **Detail**: Pool workers ładuje `dist/server/.dev.vars`; reguła zapisana w samym pliku każe dawać dummy override każdemu sekretowi. `SENTRY_DSN` go nie ma — realny DSN pozostawiony w `.dev.vars` (faza 4 go tam wkładała, setup.md:66-67) zainicjalizuje SDK w izolacie testowym i testy kontraktowe mogą wysłać eventy do Sentry. Powiązane: `.env.example:5` zaprasza do wpisania DSN lokalnie, choć setup.md:58 mówi "Local dev needs nothing here".
- **Fix**: Dodaj `SENTRY_DSN: ""` do bloku `bindings` miniflare (+ komentarz "leave empty locally" w `.env.example`).
- **Decision**: FIXED

### F2 — Capture seam bez try/catch

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (reliability)
- **Location**: src/lib/observability/sentry-server-options.ts:93-100 (call sites: consumer.ts:153, 213; submissions.ts:59)
- **Detail**: `captureServerError` nie ma wewnętrznego try/catch i żaden call site go nie owija. Rzut z `Sentry.captureException`: w consumer.ts pomija `message.ack()` → redelivery (idempotentnie bezpieczna, ale hałaśliwa); w submissions.ts zamienia kontrolowany polski 500 JSON w generyczny unhandled response. SDK z założenia nie rzuca, ale hot-path endpointu anonimowości nie powinien wisieć na inwariancie strony trzeciej.
- **Fix**: Jeden `try { … } catch { /* capture must never break the flow */ }` wewnątrz `captureServerError`.
- **Decision**: FIXED

### F3 — Scrub PII bez testu regresyjnego (plan jawnie zrezygnował z testów)

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/observability/sentry-server-options.ts (beforeSend) + src/lib/enrichment/consumer.ts (gating captureError)
- **Detail**: Plan postanowił "No new unit tests are required for SDK wiring (it's configuration)". Skutek: jedyny egzekutor twardego ograniczenia anonimowości w Sentry — `beforeSend` usuwający `event.request`/`event.user` i redagujący `EnrichmentError` — nie ma żadnego pinu (grep w `*.test.ts`: zero trafień). Usunięcie `delete event.request` przy "upraszczaniu" byłoby niewidoczne dla każdej bramki §5 test-planu. Test-plan §2 risk #2 wprost nazywa tę klasę ("brak PII w ścieżce błędu"). `buildServerSentryOptions` to czysta funkcja — test node-pool ~20 linii. Finding przeciw PLANOWI, nie implementacji.
- **Fix A ⭐ Recommended**: Dodaj node-poolowy unit test scrubu (beforeSend: request/user usunięte, EnrichmentError zredagowany) + asercję gatingu `captureError` w consumer.test.ts.
  - Strength: Pinuje twarde ograniczenie projektu przeciw cichej regresji; wzorce §6.1/6.2 czynią to tanim (~1 plik).
  - Tradeoff: Wykracza poza literę planu; minimalny przyrost utrzymania.
  - Confidence: HIGH — czysta funkcja, gotowe wzorce mocków w repo.
  - Blind spot: Test pinuje opcje SDK, nie zachowanie ingestu (to pokrywa F5/panel).
- **Fix B**: Zostań przy decyzji planu (konfiguracji nie testujemy), zapisz jako lesson.
  - Strength: Zero scope creep; spójne z literą planu i werdyktem plan-review.
  - Tradeoff: Strażnik anonimowości pozostaje niechroniony — regresja wykrywalna tylko ręcznym audytem eventów.
  - Confidence: MED — zależy od częstości przyszłych zmian w module.
  - Blind spot: Nie wiemy, jak często moduł będzie ruszany.
- **Decision**: FIXED via Fix A — nowy `src/lib/observability/sentry-server-options.test.ts` (7 testów: posture, beforeSend request/user, redakcja EnrichmentError z/bez statusu, non-EnrichmentError untouched, breadcrumb bodies, no-op seam) + 5 testów gatingu `captureError` w `consumer.test.ts`.

### F4 — Console breadcrumbs nieskrubowane po stronie klienta

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: sentry.client.config.ts:31-40
- **Detail**: `beforeBreadcrumb` filtruje tylko fetch/xhr. Breadcrumby kategorii "console" (domyślne w browser SDK) przechodzą z pełnymi argumentami. Dziś bezpieczne (zero `console.*` w komponentach klienckich), ale to jedyna dziura allow-by-default w deklarowanym deny-by-default — przyszły `console.log(content)` w komponencie React pojedzie na breadcrumbie przy następnym błędzie klienta.
- **Fix**: `if (breadcrumb.category === "console") return null;` w kliencie.
- **Decision**: FIXED

### F5 — Ingest-side IP: potwierdź panelowy switch

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: setup.md:100-104 (ustawienie panelu Sentry)
- **Detail**: Audyt fazy 4 wykrył (lessons.md utrwalił), że ingest Sentry dokleja IP połączenia PO stronie serwera, za plecami SDK. Mitygacja ("Prevent Storing of IP Addresses") to checkbox w panelu, nie kod — z repo nie da się zweryfikować, że jest włączony.
- **Fix**: Potwierdź w panelu Sentry, że switch jest ON; odnotuj w setup.md.
- **Decision**: FIXED — user potwierdził switch ON; odnotowane w setup.md (2026-06-11).

### F6 — Higiena commitów: obce artefakty w commitach faz

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: commity b61896d (p2), d13beda (pre-p1)
- **Detail**: (a) `.claude/.10x-cli-manifest.json` — stan narzędzia 10x-cli, niezwiązany z Sentry — wjechał do commita fazy 2. (b) Zależności `@sentry/*` dodane faktycznie w d13beda ("chore: add Stryker mutation testing"), nie w e6c1435 (p1) — Progress przypisuje gate 1.1 do e6c1435, a diff `e6c1435^..HEAD` nie zawiera package.json. Treść poprawna, ślad audytowy mylący.
- **Fix**: Bez przepisywania historii — nawyk: selektywny `git add` per zmiana; w Progress przypisywać SHA commita, który realnie niesie zmianę.
- **Decision**: FIXED + ACCEPTED-AS-RULE: "Stage phase commits selectively — a phase commit carries only its phase's files" (adnotacja d13beda przy gate 1.1 w plan.md Progress).

### F7 — Błędy renderu stron Astro niewidoczne dla Sentry

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (coverage)
- **Location**: setup.md:112-114 (udokumentowany caveat)
- **Detail**: Adapter `handle` konwertuje błędy renderu stron na error response zanim dotrą do `withSentry` — under-reporting, nie wyciek. Świadomie udokumentowane w setup.md. "Zero eventów z renderu" nie znaczy "zero błędów renderu".
- **Fix**: Brak akcji teraz; jeśli SSR-rendering zacznie nieść logikę, rozważ capture na poziomie middleware.
- **Decision**: FIXED (user wybrał "fix now" mimo propozycji odroczenia) — `src/middleware.ts` owija pipeline w try/catch: capture body-free deskryptora (`Astro render error: <err.name>` + pathname jako `reason`) przez guarded seam i re-throw; test w `middleware.test.ts` (mock seamu, asercja że message z user content nie wycieka); caveat #4 w setup.md oznaczony jako zamknięty.

## Triage summary (2026-06-11)

- **Fixed**: F1 (dummy `SENTRY_DSN` binding + komentarz w .env.example), F2 (try/catch w seamie), F3 (Fix A — testy scrubu + gatingu), F4 (drop console breadcrumbs w kliencie), F5 (panel switch potwierdzony ON), F7 (middleware render-error capture + test)
- **Rule + fixed**: F6 (lesson "Stage phase commits selectively" + adnotacja d13beda w plan.md Progress)
- **Po triage wszystkie bramki zielone**: lint 0 błędów, typecheck 0 błędów, node 105/105 (+13 nowych testów), build Complete, workers 3/3.
