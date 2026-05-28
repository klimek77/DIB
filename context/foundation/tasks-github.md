---
project: "digital idea box"
mirrors: context/foundation/roadmap.md
roadmap_version: 1
system: github-issues
repository: klimek77/DIB
created: 2026-05-28
updated: 2026-05-28
---

# Task Management — GitHub mirror of roadmap.md

> Derywat `context/foundation/roadmap.md` (v1) zmigrowany do GitHub Issues 2026-05-28.
> Ta strona jest jednokierunkowym lustrem: roadmap = źródło prawdy, GitHub = warstwa operacyjna.
> Jeśli zmieni się roadmap → zaktualizuj odpowiednie issue. Jeśli zmieni się issue (np. status:ready→status:blocked) → odbij to w roadmap. Drift po obu stronach = trzeba ręcznie reconcile.

## Wybrany system zadań

**GitHub Issues** w repozytorium [`klimek77/DIB`](https://github.com/klimek77/DIB).

Uzasadnienie wyboru:

- Repo jest tu, w `klimek77/DIB` — zero dodatkowej platformy do utrzymania, zero kont, zero kosztów.
- `gh` CLI jest agent-friendly: deterministyczne exit codes, JSON output (`--json`), bez interaktywnych promptów. Pasuje pod 5 kryteriów z `infrastructure.md` (CLI-first, scriptable API).
- Issue ↔ commit ↔ PR linkowanie wbudowane (`#N` w commit message zamknie issue na merge do `main`).
- Labels + filtrowanie + projects (kanban) dostępne bez konfiguracji — wystarczy na MVP backlog ~12 pozycji + przyszłe sub-taski z `/10x-plan`.
- Alternatywy (Linear, Jira, Notion, Airtable) odpadają na czas MVP: dodatkowa platforma, dodatkowy kontekst, dodatkowy auth. Skala (1 dev, 12 issues) nie uzasadnia kosztu.

Nie używamy: GitHub Projects (boards) — na razie. Filtry po labelach wystarczają; board dodamy gdy backlog przekroczy ~30 issues.

## Format issue (zatwierdzony)

Każde issue ma:

- **Tytuł:** `[ID] <suggested issue title z roadmap.md>` — np. `[F-01] Foundation: tabela submissions + types + RLS`.
- **Body (pełny):** Outcome, PRD refs, Prerequisites, Parallel with, Blockers, Unknowns, Risk, Status — kopia z roadmap.md, sekcje 1:1.
- **Labels:** dokładnie 4 (po jednej z każdej grupy: `type:*`, `prio:*`, `status:*`, `stream:*`). Wyjątek: `type:question` ma tylko 1 label (sekcje "prio/status/stream" nie aplikują do PRD-pytań).
- **Cross-refs:** w body sekcja `Prerequisites:` używa składni `#N` zamiast `S-01`/`F-03`, żeby GitHub UI rysował powiązania automatycznie.

PRD-pytania (PRD-Q3, Q4, Q5) są **osobnymi issues** (#1–#3), nie sub-checkboxami w F-/S-issue. Powód: pytanie zamknięte → 1 issue closed → 1 audytowalny moment decyzji + jego treść w komentarzach. Sub-checkbox tego nie daje.

## Schemat etykiet (13 etykiet, 4 grupy)

| Grupa     | Label              | Znaczenie                                              | Kolor   |
| --------- | ------------------ | ------------------------------------------------------ | ------- |
| `type`    | `type:foundation`  | Cross-cutting foundation (enabler)                     | #1d76db |
|           | `type:slice`       | Vertical user-visible slice                            | #5319e7 |
|           | `type:question`    | Decision-pending open question (PRD)                   | #d876e3 |
| `prio`    | `prio:north-star`  | The validation milestone of the roadmap                | #fbca04 |
|           | `prio:must-have`   | PRD must-have FR                                       | #d93f0b |
|           | `prio:nice-to-have`| PRD nice-to-have FR                                    | #c2e0c6 |
| `status`  | `status:ready`     | No blockers; plan & implement now                      | #0e8a16 |
|           | `status:blocked`   | Has a Block:yes unknown; resolve first                 | #b60205 |
|           | `status:proposed`  | Waiting on an upstream item                            | #bfd4f2 |
| `stream`  | `stream:A`         | Core wedge & cumulative reporting (F-01→F-03→S-01→S-02→S-05) | #c5def5 |
|           | `stream:B`         | Auth refit (F-02)                                      | #c5def5 |
|           | `stream:C`         | Operational notifications (S-03→S-04)                  | #c5def5 |
|           | `stream:D`         | Pilot launch gate (F-04)                               | #c5def5 |

## Issue mapping (12 issues)

| Roadmap ID | Issue                                                                                                            | Status      | Stream | Prereqs            |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ----------- | ------ | ------------------ |
| PRD-Q3     | [#1](https://github.com/klimek77/DIB/issues/1) `[PRD-Q3] N startowe zgłoszenia pilota`                           | open        | —      | —                  |
| PRD-Q4     | [#2](https://github.com/klimek77/DIB/issues/2) `[PRD-Q4] Wybór dostawcy AI / modelu`                             | open        | —      | —                  |
| PRD-Q5     | [#3](https://github.com/klimek77/DIB/issues/3) `[PRD-Q5] Format powiadomień admina`                              | open        | —      | —                  |
| F-01       | [#4](https://github.com/klimek77/DIB/issues/4) `[F-01] Submissions data model + types`                           | ready       | A      | —                  |
| F-02       | [#5](https://github.com/klimek77/DIB/issues/5) `[F-02] Auth refit — magic-link + admin allow-list`               | ready       | B      | —                  |
| F-03       | [#6](https://github.com/klimek77/DIB/issues/6) `[F-03] AI enrichment plumbing — Cloudflare Queue + consumer`     | blocked     | A      | #4 · blocked by #2 |
| F-04       | [#7](https://github.com/klimek77/DIB/issues/7) `[F-04] Network gate — Cloudflare Access CIDR bypass policy`      | blocked     | D      | — · blocked by CIDR |
| S-01       | [#8](https://github.com/klimek77/DIB/issues/8) `[S-01] North star: anonimowa submisja → AI → admin detail view`  | blocked     | A      | #4 #5 #6 · blocked by #2 #3 + Q6, Q7 |
| S-02       | [#9](https://github.com/klimek77/DIB/issues/9) `[S-02] Admin dashboard z agregatami`                             | proposed    | A      | #8                 |
| S-03       | [#10](https://github.com/klimek77/DIB/issues/10) `[S-03] Notification channel + FR-018 alert na fail AI`         | proposed    | C      | #8                 |
| S-04       | [#11](https://github.com/klimek77/DIB/issues/11) `[S-04] Natychmiastowa notyfikacja admina o nowym zgłoszeniu`   | proposed    | C      | #10                |
| S-05       | [#12](https://github.com/klimek77/DIB/issues/12) `[S-05] Cotygodniowy mail-digest`                               | proposed    | A      | #9 #10             |

## Graf zależności (issue → issue)

```
#1 PRD-Q3 ─────────────────► (metryka pilota, blokuje nikogo strukturalnie)
#2 PRD-Q4 ─────► #6 ─────► #8 ─────► #9, #10
                          │            ▲
                          │            └─── #11 (przez #10), #12 (przez #9+#10)
#3 PRD-Q5 ─────► #10 (soft, email default działa)
#4 F-01 ──────► #6, #8
#5 F-02 ──────► #8
#6 F-03 ──────► #8
#7 F-04 ──────► (równolegle, blok dla pilot launch, nie dev)
#8 S-01 ──────► #9, #10
#9 S-02 ──────► #12
#10 S-03 ─────► #11, #12
```

Najwyższe fan-out (jedna decyzja odblokowuje N issues):

1. **#2 (PRD-Q4)** — odblokowuje #6 (F-03), #8 (S-01) i transitively cały Stream A poniżej.
2. **#4 (F-01)** — odblokowuje #6 i #8; status:ready, można startować bez decyzji userowych.
3. **#5 (F-02)** — odblokowuje #8; status:ready; równoległe ze Stream A.

## Konwencje pracy

### Tworzenie sub-tasków z `/10x-plan`

Gdy `/10x-plan <change-id>` produkuje plan implementacyjny (np. `/10x-plan submissions-data-model` → plan dla #4):

- Nie zamykaj F-/S-issue. Zostaje otwarty jako epic.
- Twórz **task-issues** per krok planu w tym samym repo, z labelem `type:slice` lub bez (TBD — pierwsze użycie ustali konwencję).
- Linkuj task-issues do epica przez `Closes #4` / `Part of #4` w body i/lub przez section `### Tasks` w body epica jako checklist (`- [ ] #N: title`).
- Epic zamknij dopiero gdy wszystkie sub-taski merged.

### Zamykanie issues

- **Foundation / Slice issue:** zamyka się gdy odpowiadający change-id ma w `context/changes/<change-id>/` zarchiwizowany change folder i `/10x-archive` wpisał pozycję w `## Done` w `roadmap.md`. Zamknięcie zsynchronizowane = obie strony.
- **PRD-Question issue:** zamyka się komentarzem zawierającym verbatim decyzję usera + zaktualizowaniem `## Open Questions` w `prd.md` (jeśli decyzja zmienia kontrakt) lub `## Open Roadmap Questions` w `roadmap.md`. Komentarz z decyzją jest audit-trail.

### Edycja statusu

Trzy status-labels są wzajemnie wykluczające. Zmiana:

```
gh issue edit <N> --remove-label "status:blocked" --add-label "status:ready"
```

Jeżeli zmienia się status w GitHub → zaktualizuj też `Status:` w odpowiedniej sekcji `roadmap.md` (sekcja `## Foundations` lub `## Slices`).

### Komentarze decyzyjne

Kiedy user zamyka PRD-question (np. wybiera dostawcę AI = OpenAI gpt-4.1-mini):

1. Komentarz na #2 z verbatim decyzją + datą.
2. Zamknij #2.
3. Edytuj #6 i #8: usuń wzmiankę "Blocked on Q4 (dostawca AI)" z body + zmień `status:blocked` na `status:ready` jeśli to była ostatnia blokada (#8 ma 3 — Q4, Q6, Q7 — więc po Q4 zostaje blocked).
4. Zaktualizuj `roadmap.md` sekcję `## Open Roadmap Questions` + `### F-03` + `### S-01`.
5. Skrypt do tego nie istnieje (12 issues to za mało, żeby się opłaciło) — robisz ręcznie.

## Drift detection (synchronizacja roadmap ↔ issues)

Co spowoduje rozjazd:

- Dodanie nowego slice'u w `roadmap.md` bez utworzenia issue.
- Zmiana `Status:` w `roadmap.md` bez przepięcia labela na issue.
- Zmiana labela na GitHub (np. `prio:must-have` → `prio:nice-to-have`) bez aktualizacji `Status:`/wzmianki w `roadmap.md`.
- Closing issue zanim `/10x-archive` przepisze pozycję do `## Done` w `roadmap.md`.

Mechaniczne wykrycie (manualne, raz na sesję planującą):

```
# Liczba pozycji F-/S- w roadmap vs liczba issues z type:foundation OR type:slice
grep -E "^### [FS]-[0-9]" context/foundation/roadmap.md | wc -l
gh issue list --repo klimek77/DIB --label "type:foundation" --label "type:slice" --state all --json number | jq length
```

Niezgodność = jest drift. Reconcile ręcznie.

## Komendy szybkiego dostępu

```powershell
# Wszystkie ready do startu
gh issue list --repo klimek77/DIB --label "status:ready"

# Wszystkie blocked + powód (w body)
gh issue list --repo klimek77/DIB --label "status:blocked"

# Open PRD-decyzje czekające na usera
gh issue list --repo klimek77/DIB --label "type:question" --state open

# Stream A (core wedge) całość
gh issue list --repo klimek77/DIB --label "stream:A" --state all

# Konkretny issue z body i komentarzami
gh issue view 4 --repo klimek77/DIB --comments
```

## Linki

- **Roadmap (source of truth):** [`context/foundation/roadmap.md`](./roadmap.md)
- **PRD:** [`context/foundation/prd.md`](./prd.md)
- **Tech stack:** [`context/foundation/tech-stack.md`](./tech-stack.md)
- **Infrastructure:** [`context/foundation/infrastructure.md`](./infrastructure.md)
- **GitHub issues:** https://github.com/klimek77/DIB/issues
- **GitHub labels:** https://github.com/klimek77/DIB/labels
