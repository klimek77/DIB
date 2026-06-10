# Quality-gates wiring — vitest w CI Implementation Plan

## Overview

Ożywiamy martwy workflow CI (filtr `branches: [master]` przy repo mającym tylko `main` — zero runów w historii) i zatrzaskujemy podłogę jakości: `npm test` (unit+integration), workers-contract (Set-Cookie #6) i `typecheck` jako bramy CI, plus lokalny pre-push hook jako realny enforcement w solo-flow, w którym GitHub Free + private repo nie pozwala blokować merge.

## Current State Analysis

Z `research.md` (2026-06-10, wszystko zweryfikowane empirycznie):

- `.github/workflows/ci.yml:3-7` triggeruje na `master`; repo ma wyłącznie `main` → **workflow nigdy nie wystartował** (`gh run list` pusty).
- Dzisiejsze kroki (gdyby działały): npm ci → astro sync → lint → build. Brak `npm test`, `test:workers`, `typecheck`.
- Krok build referuje sekrety `SUPABASE_URL`/`SUPABASE_KEY`, które **nie istnieją** w repo (`gh secret list` pusty) i **nie są potrzebne** — cała schema `astro:env` jest `optional: true` (`astro.config.mjs:17-26`); build przechodzi bez env.
- `npm test`: 92 testy, PASS ~3 s, zero zależności od env/network (wszystkie krawędzie mockowane).
- `npm run test:workers`: 3 testy, PASS ~23 s (w tym build 15 s); pool wskazuje na `dist/server/wrangler.json` (`vitest.workers.config.ts:18`), bindingi miniflare to hardcodowane dummy (`:26-34`), fetch fail-closed — zero egress, zero sekretów. Działa na czystym runnerze; Cloudflare odpala własne testy pool-workers na `ubuntu-latest`.
- `npm run lint` ✅ i `npm run typecheck` ✅ (0 errors / 0 warnings / 6 hints) — zweryfikowane lokalnie podczas planowania.
- Branch protection / rulesets enforcement: **HTTP 403** na Free+private — czerwony check nie zablokuje merge.
- `.husky/pre-commit` istnieje (lint-staged), `pre-push` nie — ale **husky nie jest aktywowany**: brak `.husky/_/` (shimy), `git config core.hooksPath` nieustawione, brak skryptu `prepare` w package.json, `.git/hooks/` ma tylko sample. Żaden hook git nigdy się w tym repo nie odpalił (pre-commit też) — ta sama patologia co martwy workflow CI. Husky 9.1.7 w devDependencies.

## Desired End State

Po zakończeniu: każdy push na `main` uruchamia w GitHub Actions sekwencję lint → unit/integration → typecheck → build → workers-contract; pierwszy zielony run jest w historii repo; lokalny `git push` jest poprzedzony `npm test` przez husky pre-push; test-plan §4/§5/§6 opisuje stan faktyczny (bramy wired, baseline sprostowany).

Weryfikacja końcowa: `gh run list` pokazuje zielony run z 5 bramami; celowo złamany test lokalnie zatrzymuje `git push` (sprawdzone raz, potem revert).

### Key Discoveries:

- Martwy filtr branchy to krok zero — bez niego żadna brama nie istnieje (`.github/workflows/ci.yml:5,7`).
- Workers-suite może reużyć artefakt builda: w CI build już jest krokiem, więc `npx vitest run --config vitest.workers.config.ts` po buildzie unika drugiego builda z `npm run test:workers` (`package.json:11`).
- „Required" na tym repo = advisory CI + lokalny pre-push (decyzja z planowania; GitHub Pro/public odrzucone).
- Sekrety w kroku build to martwy kod — do usunięcia (decyzja z planowania).
- `typecheck` wchodzi do scope'u (decyzja z planowania; §5 deklarował go jako bramę CI bez fazy-właściciela).

## What We're NOT Doing

- CI-deploy (deploy-plan Phase 6 zostaje DEFERRED; deploy nadal lokalny `wrangler deploy`).
- GitHub Pro, repo public, przejście na PR-flow, branch protection/rulesets.
- Pre-push z workers-suite (~23 s z buildem — zostaje tylko w CI; pre-push = `npm test` ~3 s).
- Coverage thresholds, e2e, MSW, nowe testy — faza wpina istniejące suity, nie dodaje testów.
- Naprawa 6 hintów z `astro check` ani warningów `astro-eslint-parser projectService` (nie blokują, osobny temat).
- Sekrety/zmienne repo w GitHub (nic ich nie potrzebuje po usunięciu martwego bloku env).

## Implementation Approach

Trzy małe fazy: (1) jeden plik workflow — naprawa triggera + wpięcie bram + czystka, zweryfikowane pierwszym realnym runem; (2) jeden plik hooka husky; (3) rekonsyliacja test-planu, żeby dokument przestał kłamać o baseline. Kolejność kroków CI wg fail-fast koszt×sygnał: lint (szybki, już był) → unit (~3 s, łapie większość regresji) → typecheck (~40 s) → build (~15 s) → workers (~1 s na gotowym buildzie).

## Critical Implementation Details

- **Workers-krok musi iść PO buildzie** — pool czyta ZBUDOWANY worker przez `dist/server/wrangler.json` (§6.3 test-planu). W CI wywołujemy `npx vitest run --config vitest.workers.config.ts` bezpośrednio (nie `npm run test:workers`), żeby nie płacić drugiego builda.
- **`workflow_dispatch` zadziała dopiero, gdy plik workflow wyląduje na default branchu** — ręczne `gh workflow run` jest możliwe po pierwszym pushu, nie przed.
- **Husky v9: plik hooka to zwykły skrypt shellowy** (samo `npm test` w pliku) — bez `#!/usr/bin/env sh` i sourcingu `husky.sh` (deprecated w v9, usuwane w v10; pre-commit w tym repo już używa gołej formy).
- **Husky wymaga aktywacji, której w repo nigdy nie było** — pliki w `.husky/` odpalają się tylko, gdy `core.hooksPath` wskazuje `.husky/_` (shimy tworzone przez `npx husky`). Bez kroku aktywacji nowy pre-push byłby martwy, a `bash .husky/pre-push` przechodziłby mimo to (fałszywy zielony). Skrypt `"prepare": "husky"` utrwala aktywację po każdym `npm ci`/świeżym clone. Side-effect aktywacji: wskrzesza też uśpiony pre-commit (lint-staged) — zachowanie zamierzone.
- **Push na main wymaga explicit OK użytkownika** (reguła globalna) — weryfikacja fazy 1 ma bramkę manualną.

## Phase 1: ci.yml — naprawa triggera i wpięcie bram

### Overview

Jeden plik: workflow zaczyna w ogóle działać (main + dispatch) i niesie wszystkie bramy z §5 test-planu.

### Changes Required:

#### 1. Workflow CI

**File**: `.github/workflows/ci.yml`

**Intent**: Naprawić martwy filtr branchy (`master`→`main`), dodać ręczny trigger, wpiąć trzy nowe bramy (unit, typecheck, workers-contract) w kolejności fail-fast, usunąć martwy blok env z kroku build.

**Contract**: Triggery: `push`/`pull_request` na `[main]` + `workflow_dispatch:`. Sekwencja kroków (kolejność jest kontraktem — workers po buildzie):

```yaml
- run: npm ci
- run: npx astro sync
- run: npm run lint
- run: npm test
- run: npm run typecheck
- run: npm run build          # bez bloku env — build jest secret-free
- run: npx vitest run --config vitest.workers.config.ts
```

### Success Criteria:

#### Automated Verification:

- Lokalny mirror pełnej sekwencji CI przechodzi: `npm run lint && npm test && npm run typecheck && npm run build && npx vitest run --config vitest.workers.config.ts`

#### Manual Verification:

- Po pushu na main (za explicit zgodą): `gh run list --repo klimek77/DIB` pokazuje pierwszy run w historii; `gh run watch` kończy się zielono ze wszystkimi krokami
- `gh workflow run CI --ref main` (dispatch) uruchamia run ręcznie

**Implementation Note**: Po zakończeniu fazy i przejściu automatów zatrzymaj się na manualne potwierdzenie (push wymaga zgody użytkownika), zanim przejdziesz do fazy 2.

---

## Phase 2: Lokalny pre-push gate (husky)

### Overview

Realny enforcement w solo-flow: regresja node-suite blokuje się lokalnie, zanim wyleci na main.

### Changes Required:

#### 1. Aktywacja husky

**File**: `package.json`

**Intent**: Husky nigdy nie był aktywowany w tym repo (patrz Current State) — bez tego kroku żaden hook nie działa. Dodać skrypt `"prepare": "husky"` (utrwala aktywację po `npm ci`/clone) i jednorazowo uruchomić `npx husky` (tworzy `.husky/_/` z shimami i ustawia `core.hooksPath=.husky/_`).

**Contract**: `scripts.prepare = "husky"`; po aktywacji `git config core.hooksPath` zwraca `.husky/_`. Side-effect: istniejący pre-commit (lint-staged) zaczyna działać — zamierzone.

#### 2. Hook pre-push

**File**: `.husky/pre-push` (nowy plik)

**Intent**: Przed każdym `git push` odpalić `npm test` (~3 s); niezerowy exit przerywa push. Workers-suite celowo poza hookiem (koszt ~23 s — zostaje w CI).

**Contract**: Plik w stylu husky v9 — pojedyncza linia `npm test` (wzorzec: istniejący `.husky/pre-commit:1`).

#### 3. Ochrona context/ przed lint-staged

**File**: `.prettierignore`

**Intent**: Aktywacja husky wskrzesza lint-staged, którego reguła `*.{json,css,md}` → `prettier --write` przepisywałaby dokumenty `context/` przy każdym commicie (realign tabel test-planu, szum w diffach, ryzyko dla parserów orkiestratora — §3 Status literals, checkpointy). Wyłączyć `context/` spod prettiera.

**Contract**: Nowa linia `context/` w `.prettierignore` (obok istniejącej `src/lib/database.types.ts`).

### Success Criteria:

#### Automated Verification:

- `git config core.hooksPath` zwraca `.husky/_`, a katalog `.husky/_/` zawiera shimy (aktywacja faktyczna, nie deklaratywna)
- `.husky/pre-push` istnieje, a `bash .husky/pre-push` kończy się exit 0 (92 testy zielone)
- `.prettierignore` zawiera linię `context/`; `npx prettier --check context/foundation/test-plan.md` raportuje plik jako ignorowany (nie próbuje go formatować)

#### Manual Verification:

- Najbliższy realny push pokazuje output vitest przed wysyłką; jednorazowy sabotaż-test (celowo złamany test → push odmówiony → revert) potwierdza blokadę

---

## Phase 3: Rekonsyliacja test-planu

### Overview

Dokument przestaje kłamać: §5 baseline sprostowany, bramy oznaczone jako wired, §6 niesie wzorzec CI dla poola, notka fazy w §6.6.

### Changes Required:

#### 1. Test-plan — stan bram i baseline

**File**: `context/foundation/test-plan.md`

**Intent**: Zaktualizować §5: zdanie „CI dziś robi tylko lint+build (per roadmap baseline)…" zastąpić stanem faktycznym (CI na main: lint, unit+integration, typecheck, build, workers-contract; advisory na Free+private — merge nie jest blokowany GitHubowo; lokalny pre-push hook = `npm test`). Dodać wiersz bramy `pre-push hook (npm test) | local | required after §3 Phase 4`. W §4 wierszu poola zamienić „CI w Phase 4 — patrz §6.3" na stan dokonany (w CI od Phase 4). W §3 wierszu Phase 4 ustawić Status `complete` — jako OSTATNIĄ czynność fazy, dopiero po przejściu manualnego read-through (3.2); wcześniejszy flip byłby fałszywą deklaracją wewnątrz niedomkniętej fazy.

**Contract**: §5 tabela Quality Gates + akapit pod nią; §4 wiersz „Workers runtime pool"; §3 wiersz Phase 4. Sformułowanie „required after §3 Phase 4" w wierszach unit+integration zostaje (teraz jest faktem, nie obietnicą).

#### 2. Test-plan — cookbook §6.3 i notka fazy §6.6

**File**: `context/foundation/test-plan.md`

**Intent**: W §6.3 dopisać wzorzec CI: pool w CI reużywa artefakt builda — krok `npx vitest run --config vitest.workers.config.ts` PO `npm run build` (lokalne `npm run test:workers` nadal builduje samo). W §6.6 dodać 2-3-linijkową notkę Phase 4 z lekcją o OBU martwych „skonfigurowanych" mechanizmach: ci.yml (filtr `master` przy branchu `main` — nigdy nie wystartował) i husky (brak aktywacji — hooki nigdy się nie odpalały); plus enforcement advisory+pre-push na Free+private.

**Contract**: §6.3 (dopisek do „Run:"), nowa pozycja listy w §6.6. Bez zmian w §1-§2, §7, §8 (poza „Last updated" w nagłówku).

### Success Criteria:

#### Automated Verification:

- `grep -n "CI dziś robi tylko lint+build" context/foundation/test-plan.md` nie zwraca nic; `grep -n "pre-push" context/foundation/test-plan.md` zwraca nowy wiersz bramy

#### Manual Verification:

- Read-through §3/§4/§5/§6: każda deklaracja zgodna ze stanem repo (workflow, hook, statusy faz)

---

## Testing Strategy

### Unit Tests:

- Brak nowych testów — faza wpina istniejące suity (92 + 3 testy) jako bramy.

### Integration Tests:

- Brak nowych — workers-contract (`src/pages/auth/_callback.workers.test.ts`) wchodzi do CI bez zmian.

### Manual Testing Steps:

1. Push fazy 1 na main (za zgodą) → `gh run watch` zielony, 5 bram widocznych w logu runa.
2. `gh workflow run CI --ref main` → dispatch działa.
3. Celowo złamać jeden test lokalnie → `git push` odmawia (pre-push) → revert.

## Performance Considerations

Szacowany czas runa CI: ~3-4 min (npm ci to największy koszt; cache npm już skonfigurowany w setup-node). Workers-krok na gotowym buildzie to ~1 s. Pre-push dodaje ~3 s do każdego pusha.

## Migration Notes

Brak migracji danych. Rollback = revert commitów (workflow i hook są addytywne). Gdy wróci temat CI-deploy (deploy-plan Phase 6), sekrety wejdą do osobnego deploy joba, nie do builda.

## References

- Related research: `context/changes/testing-quality-gates-wiring/research.md`
- Test-plan (frozen strategy + cookbook): `context/foundation/test-plan.md` §3-§6
- Decyzja „pool do CI w Phase 4": `context/archive/2026-06-09-testing-auth-abuse-boundary/research.md` (Q4)
- Workflow: `.github/workflows/ci.yml`; hook-wzorzec: `.husky/pre-commit:1`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: ci.yml — naprawa triggera i wpięcie bram

#### Automated

- [x] 1.1 Lokalny mirror pełnej sekwencji CI przechodzi (lint, test, typecheck, build, workers) — cdb3c86

#### Manual

- [x] 1.2 Pierwszy run w historii repo zielony po pushu na main (`gh run watch`) — cdb3c86
- [x] 1.3 `gh workflow run CI --ref main` uruchamia run ręcznie — cdb3c86

### Phase 2: Lokalny pre-push gate (husky)

#### Automated

- [x] 2.1 Aktywacja husky faktyczna: `core.hooksPath` == `.husky/_`, shimy obecne — 746b308
- [x] 2.2 `.husky/pre-push` istnieje; `bash .husky/pre-push` exit 0 — 746b308
- [x] 2.3 `context/` w `.prettierignore`; prettier ignoruje test-plan.md — 746b308

#### Manual

- [x] 2.4 Realny push pokazuje vitest przed wysyłką; sabotaż-test potwierdza blokadę — 746b308

### Phase 3: Rekonsyliacja test-planu

#### Automated

- [ ] 3.1 Grep: brak przestarzałego baseline; nowy wiersz pre-push obecny w §5

#### Manual

- [ ] 3.2 Read-through §3/§4/§5/§6 zgodny ze stanem repo
