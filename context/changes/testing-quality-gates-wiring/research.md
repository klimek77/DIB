---
date: 2026-06-10T13:37:49+02:00
researcher: Claude Code
git_commit: ccfe70d8fee628939cbe2e1fce690d11b79e6458
branch: main
repository: DIB
topic: "Phase 4 Quality-gates wiring — wpięcie vitest (npm test) do CI; czy npm run test:workers też wchodzi"
tags: [research, ci, quality-gates, vitest, pool-workers, github-actions, testing]
status: complete
last_updated: 2026-06-10
last_updated_by: Claude Code
---

# Research: Quality-gates wiring — vitest w CI (Phase 4)

**Date**: 2026-06-10T13:37:49+02:00
**Researcher**: Claude Code
**Git Commit**: ccfe70d8fee628939cbe2e1fce690d11b79e6458
**Branch**: main
**Repository**: DIB (github.com/klimek77/DIB, private)

## Research Question

Rollout Phase 4 test-planu (§3): wpiąć `npm test` (vitest run) do CI jako wymaganą bramę, tak by regresje logiki, dostępu, anonimowości i taksonomii blokowały merge (§5). Do rozstrzygnięcia: czy `npm run test:workers` (pool-workers, kontrakt Set-Cookie #6) też wchodzi do CI — §4 i §6.3 test-planu wskazują CI w Phase 4.

## Summary

1. **CI jest dziś martwe, nie „lint+build".** `.github/workflows/ci.yml:5,7` filtruje `branches: [master]`, a repo ma wyłącznie `main` (default branch = `main`). GitHub Actions pokazuje **zero runów w historii repo**. Zdanie „CI dziś robi tylko lint+build" (test-plan §5, roadmap baseline) opisuje treść pliku, nie rzeczywistość. Naprawa filtra branchy to krok zero tej fazy — bez niego żadna brama nie istnieje.
2. **Odpowiedź na pytanie otwarte: TAK — `npm run test:workers` wchodzi do CI.** Wszystkie wcześniejsze ustalenia na to wskazują (test-plan §4 i §6.3; archive Phase 3: research Q4 i plan „No CI wiring of the workers pool — deferred to Phase 4"), a empiryczna weryfikacja usuwa jedyne ryzyko praktyczne: obie suity przechodzą na warunkach czystego runnera **bez żadnych sekretów** (bez `.env`, bez `.dev.vars`). Koszt: ~23 s lokalnie (w tym build 15 s). Cloudflare odpala własne testy pool-workers na `ubuntu-latest` (Windows mają wykluczone za flakiness) — nasz CI też jest ubuntu.
3. **Sekrety w CI są zbędne.** ci.yml przekazuje `secrets.SUPABASE_URL/KEY` do builda, ale (a) te sekrety **nie istnieją** w repo (`gh secret list` → pusto; deploy-plan Phase 6 „DEFERRED. No GitHub Actions secrets set"), (b) build ich nie potrzebuje — wszystkie pola schemy `astro:env` są `optional: true` (`astro.config.mjs:17-26`), build przechodzi bez env w ogóle (zweryfikowane). Workers-suite wstrzykuje hardcodowane dummy bindingi (`vitest.workers.config.ts:26-34`), a test stubuje `globalThis.fetch` fail-closed — zero egress.
4. **„Required" ≠ wymuszalne na tym repo.** Repo jest prywatne na planie Free: branch protection i rulesets-z-enforcementem zwracają 403 / wymagają Pro (potwierdzone w docs GitHuba). Czerwony check na PR będzie widoczny, ale nie zablokuje merge. Realne opcje: (a) gate advisory + dyscyplina (solo dev i tak pushuje prosto na main), (b) GitHub Pro (~4 USD/mies.), (c) repo public, (d) lokalny pre-push hook (husky już jest; pre-push brak). Decyzja należy do planu.
5. **Gap przy okazji:** §5 test-planu listuje `typecheck` (= `astro check`) jako required „local + CI" bez warunku fazy, a ci.yml go nie uruchamia. Naturalny kandydat do scope'u tej fazy (decyzja w planie).

## Detailed Findings

### 1. Stan faktyczny CI (martwy workflow)

- `.github/workflows/ci.yml:3-7` — trigger `push`/`pull_request` z filtrem `branches: [master]`.
- Repo: jedyny branch `main` (lokalnie i origin); `gh api repos/klimek77/DIB --jq .default_branch` → `main`.
- `gh run list --repo klimek77/DIB` → **pusto** (workflow nigdy nie wystartował).
- `gh secret list` / `gh variable list` → **pusto**; ci.yml:22-24 referuje nieistniejące sekrety (puste stringi w env builda — build i tak przechodzi, patrz #3).
- Kroki dzisiejszego ci.yml:12-24: checkout → setup-node 22 (cache npm) → `npm ci` → `npx astro sync` → `npm run lint` → `npm run build`. Brak `npm test`, brak `test:workers`, brak `typecheck`.
- Źródło rozjazdu master/main: scaffold z 10x-astro-starter; nikt nie zauważył, bo workflow „wyglądał na skonfigurowany".

### 2. `npm test` (node-suite) — CI-ready as-is

- `package.json:10` — `"test": "vitest run"`; config `vitest.config.ts:13-21` (include `src/**/*.{test,spec}.ts`, exclude `**/*.workers.test.ts`, alias `@/* → ./src/*`, env node, brak setup files).
- Empirycznie (na warunkach czystego runnera — bez `.env`, bez zmiennych Supabase/OpenAI w shellu): **10 plików, 92 testy, PASS, ~2.8 s** (vitest duration 1.10 s).
- Zero zależności od env/network/build artifacts — wszystkie krawędzie mockowane:
  - `src/middleware.test.ts:6,10,15` — mock `astro:middleware`, `@/lib/supabase`, allowlist;
  - `src/lib/auth/allowlist.test.ts:9,14` — `vi.doMock("astro:env/server")`;
  - `src/pages/api/_submissions.test.ts:18,28` — mock `@/lib/runtime-env` (QUEUE) + supabase-admin;
  - `src/pages/api/auth/_signin.test.ts:6,11` — mock supabase + allowlist;
  - `src/lib/enrichment/*.test.ts` — czysta dependency injection;
  - `src/lib/submissions/taxonomies.drift.test.ts:16` — czyta `supabase/migrations/*.sql` z repo (fs-only, portable `fileURLToPath`).
- Vitest nie auto-ładuje `.env` do `process.env`; żaden test go nie czyta.

### 3. `npm run test:workers` (workers-suite) — CI-ready, build jako prerekwizyt

- `package.json:11` — `"test:workers": "npm run build && vitest run --config vitest.workers.config.ts"` (build wbudowany w skrypt).
- `vitest.workers.config.ts:18` — pool wskazuje na ZBUDOWANY worker: `./dist/server/wrangler.json` (stąd prerekwizyt build, zgodnie z §6.3 test-planu).
- `vitest.workers.config.ts:26-34` — bindingi miniflare to **hardcodowane wartości dummy** (`SUPABASE_URL: https://testref.supabase.co`, `SUPABASE_KEY: test-anon-key`, itd.) — sekrety nie są czytane z env.
- `dist/server/.dev.vars` (realne lokalne sekrety) jest gitignored — na CI nie istnieje; **zweryfikowano, że suite przechodzi bez niego** (same bindingi wystarczają).
- `src/pages/auth/_callback.workers.test.ts:79-97` — stub `globalThis.fetch` **fail-closed** (rzuca na każdy niezamockowany outbound) — dowód zerowego egress; KV `SESSION`, queues `dib-enrichment(+dlq)`, `IMAGES` symuluje miniflare bez logowania do Cloudflare.
- Empirycznie (czyste warunki): **1 plik, 3 testy, PASS, ~22.7 s** (astro build 14.9 s + vitest 1.06 s).
- `workerd` instaluje się przez platform-specific npm optional dep (`@cloudflare/workerd-linux-64` na ubuntu) — cache npm w setup-node go obejmuje.

### 4. Build nie wymaga sekretów (empirycznie + docs)

- `astro.config.mjs:17-26` — wszystkie 5 pól schemy (`SUPABASE_URL`, `SUPABASE_KEY`, `ALLOWED_ADMIN_EMAILS`, `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`): `context: "server", access: "secret", optional: true`.
- Empirycznie: `astro build` przechodzi bez `.env` i bez env vars; jedyny warning: sitemap bez `site` (non-fatal).
- Docs Astro (checked 2026-06-10): sekrety walidowane domyślnie w runtime (`validateSecrets: false`); walidacja build-time może odpalić się przy imporcie `astro:env/server` w prerenderowanych ścieżkach — u nas nie trip-uje (i `optional: true` neutralizuje wymóg). Na Cloudflare realne wartości i tak przychodzą jako bindingi Workers w runtime, nie w buildzie.
- Wniosek: kroki `env: SUPABASE_URL/KEY` w ci.yml:22-24 są martwym kodem — do usunięcia albo świadomego zostawienia (decyzja planu).

### 5. Enforcement „required" na GitHub Free + private — niedostępny

- `gh api repos/klimek77/DIB/branches/main/protection` → **HTTP 403** „Upgrade to GitHub Pro or make this repository public".
- Docs GitHub (checked 2026-06-10, pliki gated-features w github/docs): protected branches, rulesets (enforcement), merge queue, CODEOWNERS — na planie Free tylko repo publiczne; rulesets „Evaluate" mode jest enterprise-only.
- Realistyczny obraz: check z testami będzie się uruchamiał na push/PR i świecił na czerwono, ale przycisku merge nie zablokuje. Ścieżki: advisory + dyscyplina / GitHub Pro / repo public / lokalny pre-push hook (`.husky/pre-commit` dziś robi tylko lint-staged; pre-push nie istnieje).
- Kontekst praktyczny: projekt jest solo; commity lądują bezpośrednio na main (bez PR), więc nawet enforcement na PR nie objąłby dzisiejszego flow — sygnał z CI na push jest post-hoc z natury.

### 6. pool-workers w GitHub Actions — oficjalnie wspierane (checked 2026-06-10)

- `@cloudflare/vitest-pool-workers@0.16.14` ma peer dep `vitest ^4.1.0` — nasza para (^0.16.14 + ^4.1.8) jest oficjalnie wspierana.
- Cloudflare we własnym CI (`workers-sdk/.github/workflows/test-and-check.yml`) odpala testy pool-workers na `ubuntu-latest`; Windows jest wykluczony za flakiness. `cloudflare/templates` używa zwykłego `runs-on: ubuntu-latest`.
- glibc: workerd wymaga ≥ 2.32; ubuntu-latest (24.04, glibc 2.39) — bez problemu.
- Znane problemy NIE dotyczą naszego użycia: `--max-workers=1 --no-isolate` wymagane tylko dla WebSockets+DO (nie używamy); brak natywnego V8 coverage (nie mierzymy); issue #13581 (init fail z vitest 4.1) dotyczył pool-workers 0.14.x, nie 0.16.x.
- `fetchMock` usunięty w 0.13.0 — już zaadresowane lokalnie (stub `globalThis.fetch`, §6.3 test-planu).

### 7. Gap: typecheck w §5 vs ci.yml

- test-plan §5 (`context/foundation/test-plan.md:119`): `typecheck` (= `astro check`) — „local + CI", required **bez** warunku „after Phase N".
- ci.yml nie uruchamia `npm run typecheck`. Roadmap baseline (roadmap.md:61) potwierdza „only lint+build".
- Phase 4 to jedyna faza „quality-gates wiring" — jeśli nie tu, to nigdzie. Kandydat do scope'u; lessons.md ostrzega przed rozdmuchiwaniem scope'u, ale to nie jest hardening nieistniejącego konsumenta — `npm run typecheck` istnieje i jest deklarowany jako brama.

### 8. Koszt i kształt docelowego workflow (dane dla planu)

- Pomiar lokalny: `npm test` ~2.8 s; `test:workers` ~22.7 s (z buildem). Na runnerze ubuntu z zimnym `npm ci` całość CI ≈ 3–4 min (npm ci to największy koszt; cache npm już skonfigurowany w ci.yml:17).
- `test:workers` zawsze rebuilduje (skrypt = `npm run build && …`). W CI build już jest krokiem — dwie opcje dla planu:
  - (a) po istniejącym kroku `npm run build` dodać `npx vitest run --config vitest.workers.config.ts` (reuse artefaktu, bez drugiego builda);
  - (b) wywołać `npm run test:workers` i zaakceptować podwójny build (+15 s, prostsze, identyczne z lokalnym).
- `npx astro sync` już jest w workflow (ci.yml:19) — node-suite go nie wymaga (alias only), ale nie przeszkadza.
- Node: CI pin 22, `.nvmrc` = 22.14.0; lokalna weryfikacja szła na Node 24 — niskie ryzyko, ale plan może ujednolicić na 22 (zgodnie z .nvmrc).

## Code References

- `.github/workflows/ci.yml:3-7` — martwy filtr `branches: [master]` (repo ma tylko `main`)
- `.github/workflows/ci.yml:12-24` — dzisiejsze kroki: npm ci → astro sync → lint → build (z referencją do nieistniejących sekretów)
- `package.json:10-13` — skrypty `test`, `test:workers`, `typecheck`, `lint`
- `vitest.config.ts:13-21` — node-suite: include/exclude, alias `@/*`
- `vitest.workers.config.ts:18` — pool → `dist/server/wrangler.json` (build = prerekwizyt)
- `vitest.workers.config.ts:26-34` — dummy bindingi miniflare (sekrety nie z env)
- `astro.config.mjs:17-26` — schema `astro:env`: wszystkie pola `optional: true` → build bez sekretów
- `src/pages/auth/_callback.workers.test.ts:79-97` — fail-closed stub fetch (zero egress)
- `.husky/pre-commit:1` — tylko `npx lint-staged`; pre-push nie istnieje
- `.nvmrc:1` — 22.14.0
- `wrangler.jsonc:5-6,32-46` — compatibility_date 2026-05-08, nodejs_compat, queues

## Architecture Insights

- Obie suity vitest są zaprojektowane „CI-first": node-suite mockuje wszystkie krawędzie (zero env), workers-suite ma sekrety jako dummy bindingi w configu i fail-closed fetch. Nic nie trzeba zmieniać w testach, żeby weszły do CI — to czysta zmiana workflow.
- Rozdział suit (osobny projekt vitest dla workers) z Phase 3 okazał się dobrą decyzją także dla CI: `npm test` zostaje szybkie (~3 s), a koszt builda płaci tylko workers-suite.
- Wzorzec „build jest prerekwizytem poola" (§6.3) przenosi się na CI wprost: krok build już istnieje, więc reuse artefaktu jest naturalny.
- Brama CI nie zastępuje manualnego preview smoke (#6): workerd nie ma realnej domeny/emaila, więc oś `SameSite=Lax` cross-origin nadal wymaga preview deploy (archive Phase 3, research Q4).

## Historical Context (from prior changes)

- `context/archive/2026-06-09-testing-auth-abuse-boundary/research.md` (Q4, lines ~343-424) — rekomendacja: workers-suite jako osobny projekt, „Wire it into CI in Phase 4 alongside `npm test`"; pool nie zastępuje preview smoke.
- `context/archive/2026-06-09-testing-auth-abuse-boundary/plan.md:72` — „No CI wiring of the workers pool — deferred to test-plan Phase 4".
- `context/foundation/roadmap.md:61` — baseline: „`.github/workflows/ci.yml` only lint+build (deploy odłożony)".
- `context/foundation/roadmap.md:122` — FR-015 (network gate) testowalny tylko z firmowej sieci — NIE wchodzi do CI (potwierdza §7 test-planu).
- `context/deployment/deploy-plan.md:92-93` — Phase 6 „DEFERRED. No GitHub Actions secrets set"; deploy = lokalny `wrangler deploy`.
- `context/foundation/tech-stack.md:24,139` — CI/CD na GitHub Actions to default startera; setup pipeline'u świadomie poza scope'em tamtej decyzji.
- `context/foundation/test-plan.md:84,99,119-126,173-187` — definicja Phase 4, wiersz §4 o pool („CI w Phase 4 — patrz §6.3"), tabela bram §5, cookbook §6.3.

## Related Research

- `context/archive/2026-06-09-testing-auth-abuse-boundary/research.md` — pool-workers: koszt, kontrakt Set-Cookie, decyzja o osobnym projekcie vitest.
- `context/archive/2026-06-08-testing-submission-durability-taxonomy/` — wzorce testów wpinanych teraz do bramy (drift guard, insert/enqueue).

## Open Questions

Decyzje do podjęcia w `/10x-plan` (research dostarcza grounding, nie rozstrzyga):

1. **Ścieżka enforcement:** advisory check (Free+private, bez blokady merge) vs GitHub Pro vs repo public vs lokalny pre-push hook (husky). Test-plan §5 mówi „required" — plan musi zdefiniować, co „required" znaczy operacyjnie na tym repo (rekomendacja researchu: advisory + ewentualny pre-push hook; upgrade płatny nieuzasadniony dla solo-projektu w MVP).
2. **Czy wpiąć też `typecheck`** (`astro check`) — §5 deklaruje go jako bramę CI, ci.yml go nie ma; jedyna faza wiring to ta.
3. **Reuse builda vs podwójny build** dla workers-suite w CI (opcje 8a/8b powyżej).
4. **Los martwych sekretów w ci.yml** (`SUPABASE_URL/KEY` w kroku build): usunąć (build ich nie potrzebuje) czy zostawić do czasu CI-deploy (deploy-plan Phase 6 nadal DEFERRED).
5. **Trigger po naprawie:** sam `push: [main]` czy też `pull_request: [main]` — przy solo-flow bez PR-ów `pull_request` jest na zapas (nie szkodzi; rekomendacja: zostawić oba).
