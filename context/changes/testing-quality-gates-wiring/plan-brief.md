# Quality-gates wiring — vitest w CI — Plan Brief

> Full plan: `context/changes/testing-quality-gates-wiring/plan.md`
> Research: `context/changes/testing-quality-gates-wiring/research.md`

## What & Why

Rollout Phase 4 test-planu: zatrzaśnięcie podłogi jakości w CI, tak by regresje logiki, dostępu, anonimowości i taksonomii (ryzyka #1-#7) były łapane automatycznie. Research odkrył, że to więcej niż „dodanie kroku": workflow CI jest **martwy od początku istnienia repo** (filtr `branches: [master]` przy jedynym branchu `main` — zero runów w historii), więc faza najpierw ożywia CI, a dopiero potem wpina bramy.

## Starting Point

`ci.yml` istnieje, ale nigdy nie wystartował; deklaruje lint+build z referencją do nieistniejących sekretów. Obie suity vitest (92 testy node + 3 testy workers-contract) są empirycznie CI-ready bez sekretów. `lint` i `typecheck` przechodzą lokalnie. Husky ma plik pre-commit (lint-staged), ale **nigdy nie był aktywowany** (brak `core.hooksPath`, brak skryptu `prepare`) — żaden hook git w tym repo nigdy się nie odpalił; pre-push nie istnieje. Branch protection niedostępna (Free + private → 403).

## Desired End State

Każdy push na `main` przechodzi w GitHub Actions sekwencję lint → unit/integration → typecheck → build → workers-contract; lokalny `git push` jest bramowany przez `npm test` (husky pre-push); test-plan §4/§5/§6 opisuje stan faktyczny zamiast aspiracji.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Czy `test:workers` wchodzi do CI | Tak | Wszystkie źródła wskazywały Phase 4, a empiryczna weryfikacja (czysty runner, zero sekretów, ~23 s) usunęła ostatnie ryzyko. | Research |
| Enforcement „required" | Advisory CI + pre-push hook (`npm test`) | GitHub Free + private nie blokuje merge, a solo-flow pushuje prosto na main — lokalny hook to jedyna realna blokada; bez kosztów. | Plan |
| Typecheck w scope | Tak — wpiąć | §5 deklarował go jako bramę CI bez fazy-właściciela; zweryfikowany zielony (0 errors), więc wpięcie nic nie psuje. | Plan |
| Martwe sekrety w buildzie | Usunąć | Nie istnieją w repo i build ich nie potrzebuje (cała schema `astro:env` optional) — referencja tylko myli. | Research → Plan |
| Build dla workers-suite w CI | Reuse artefaktu (`npx vitest run --config vitest.workers.config.ts` po buildzie) | Build już jest krokiem workflow; podwójny build z `npm run test:workers` to +15 s bez sygnału. | Research → Plan |
| Trigger ręczny | Dodać `workflow_dispatch` | Pozwala odpalić CI przez `gh workflow run` bez pushowania — tani debugging bram. | Plan |
| Aktywacja husky | `"prepare": "husky"` + jednorazowe `npx husky` | Hooki nigdy nie były aktywne (brak hooksPath/shimów) — bez tego pre-push byłby martwy w chwili narodzin. | Plan-review F1 |
| Prettier vs context/ | `context/` do `.prettierignore` | Wskrzeszony lint-staged przepisywałby dokumenty parsowane przez orkiestrator przy każdym commicie. | Plan-review F2 |

## Scope

**In scope:** naprawa triggera ci.yml (master→main + dispatch), kroki `npm test` / `typecheck` / workers-contract w CI, usunięcie martwego bloku env, aktywacja husky (`prepare` + shimy) i `.husky/pre-push` z `npm test`, `context/` w `.prettierignore` (ochrona dokumentów orkiestratora przed lint-staged), rekonsyliacja test-planu (§3/§4/§5/§6).

**Out of scope:** CI-deploy (deploy-plan Phase 6 DEFERRED), GitHub Pro / repo public / PR-flow / branch protection, workers-suite w pre-push, coverage/e2e/MSW/nowe testy, naprawa hintów astro check.

## Architecture / Approach

Trzy addytywne, niezależnie weryfikowalne kroki: workflow (jeden plik YAML, kolejność bram fail-fast wg koszt×sygnał), hook (jeden plik shell), dokumentacja (jeden plik md). Workers-krok musi iść po buildzie — pool czyta zbudowany worker przez `dist/server/wrangler.json`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. ci.yml — trigger + bramy | Pierwszy zielony run w historii repo, 5 bram na main | Niespodzianki ubuntu-runnera (lokalnie wszystko zielone, ale empiria CI = pierwszy run); push wymaga zgody |
| 2. Pre-push gate (husky) | Aktywacja husky (`prepare` + `npx husky`) + `npm test` blokuje push z regresją | Hook omijany `--no-verify`; aktywacja wskrzesza też uśpiony pre-commit (lint-staged) |
| 3. Rekonsyliacja test-planu | §4/§5/§6 zgodne ze stanem repo | Drift dokument↔repo, jeśli faza 1/2 zmieni kształt w trakcie |

**Prerequisites:** zgoda na push na main (weryfikacja fazy 1); `gh` CLI zalogowane.
**Estimated effort:** 1 krótka sesja, 3 fazy (~30-60 min łącznie z weryfikacją runów).

## Open Risks & Assumptions

- Pierwszy run CI to pierwsza empiria na ubuntu-latest — lokalnie wszystko zielone (także w warunkach „czystego runnera"), ale run #1 może ujawnić drobiazgi (np. czas typecheck).
- Advisory enforcement zakłada dyscyplinę: czerwony check na main trzeba naprawiać natychmiast, bo nic nie wymusza naprawy.
- Zakładamy brak zmian w suitach testowych między researchem a implementacją (working tree ma tylko modyfikację test-plan.md).

## Success Criteria (Summary)

- `gh run list` pokazuje zielony run CI na main z bramami lint/test/typecheck/build/workers.
- Celowo złamany test lokalnie zatrzymuje `git push` (pre-push), a w CI ten sam przypadek świeci na czerwono.
- Test-plan nie zawiera już fałszywego baseline „CI dziś robi tylko lint+build"; bramy §5 oznaczone jako wired.
