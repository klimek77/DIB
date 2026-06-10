<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Quality-gates wiring — vitest w CI

- **Plan**: context/changes/testing-quality-gates-wiring/plan.md
- **Scope**: Phase 2 of 3
- **Date**: 2026-06-10
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Evidence

- Drift: 3/3 planowane zmiany MATCH (pre-push zweryfikowany byte-level: LF, bez shebang, bez husky.sh — wzorzec v9); zero EXTRA w commicie 746b308.
- Aktywacja realna: `core.hooksPath=.husky/_`, pełny zestaw shimów; realna ścieżka `./.husky/_/pre-push` → exit 0 (92/92).
- Shimy nie są commitowane (`.husky/_/.gitignore` = `*`; `git ls-files` czyste); graceful-degradation husky 9.1.7 (brak .git, HUSKY=0, brak skryptu hooka) zweryfikowane w źródle node_modules.
- Kryterium 2.4 z żywym dowodem w sesji: sabotaż-test → push odmówiony (husky pre-push exit 1), revert → push przeszedł z widocznym vitest; CI dla 746b308 zielone (1m27s).

## Findings

### F1 — "prepare": "husky" wywali npm ci --omit=dev

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (reliability)
- **Location**: package.json:19
- **Detail**: npm odpala `prepare` także przy `npm ci --omit=dev`; binarka husky (devDependency) wtedy nie istnieje → exit 127 → cały install pada. Graceful-paths husky 9.1.7 wymagają obecności pakietu. Dziś zero wpływu (brak prod-install pipeline'u); zgodne z literą planu.
- **Fix A ⭐**: Zostawić as-is; udokumentować escape (`npm ci --ignore-scripts`) w notce §6.6 podczas fazy 3.
- **Fix B**: `"prepare": "husky || true"` — maskuje realne błędy aktywacji (cicho martwe hooki = patologia, którą faza naprawiała).
- **Decision**: FIXED via Fix A — zakolejkowane do follow-ups/review-fixes.md (wykonanie w fazie 3)

### F2 — `npx lint-staged` może ściągnąć latest z registry

- **Severity**: 👁 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Safety & Quality (supply-chain)
- **Location**: .husky/pre-commit:1
- **Detail**: Przy braku node_modules i ustawionym hooksPath `npx` pobrałby najnowszy lint-staged z registry (ignorując pin) i wykonał przy commicie. Shim prepend'uje node_modules/.bin do PATH, więc `npx` jest zbędne.
- **Fix**: Gołe `lint-staged` — fail-closed (127) zamiast registry-fetch.
- **Decision**: FIXED — `.husky/pre-commit` = `lint-staged`; realna ścieżka shima zweryfikowana (exit 0)

### F3 — CRLF w working-tree kopii pre-commit

- **Severity**: 👁 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Pattern Consistency
- **Location**: .husky/pre-commit (working tree; index miał LF)
- **Detail**: Plik sprzed normalizacji .gitattributes (`i/lf w/crlf`), nigdy nie re-smudged; empirycznie nieszkodliwy, sprzeczny z regułą repo.
- **Fix**: Lokalny renormalize (rm + git checkout).
- **Decision**: FIXED — `git ls-files --eol` → `i/lf w/lf`

### F4 — Niezakotwiczony wzorzec `context/` w .prettierignore

- **Severity**: 👁 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Safety & Quality
- **Location**: .prettierignore:2
- **Detail**: Niezakotwiczone `context/` matchuje katalog o tej nazwie na każdej głębokości; przyszły `src/.../context/` cicho straciłby formatowanie.
- **Fix**: Zakotwiczyć: `/context/`.
- **Decision**: FIXED — linia = `/context/`; `prettier --file-info context/foundation/test-plan.md` → ignored:true

### F5 — Bypassy gate'a (HUSKY=0, --no-verify) nieudokumentowane

- **Severity**: 👁 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Plan Adherence (forward-looking)
- **Location**: N/A (dokumentacja §6.6)
- **Detail**: Fail-closed poprawny; świadome bypassy (`HUSKY=0`, `git push --no-verify`) istnieją tylko jako wiedza plemienna.
- **Fix**: Jedna linia w notce §6.6 podczas fazy 3.
- **Decision**: FIXED — zakolejkowane do follow-ups/review-fixes.md (wykonanie w fazie 3)
