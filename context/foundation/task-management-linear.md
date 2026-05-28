---
project: "digital idea box"
mirrors: context/foundation/roadmap.md
roadmap_version: 1
system: linear
workspace: digital-idea-box
team: Digital-idea-box
team_id: ba5343ff-f6dc-432e-b469-0ebe7435c805
identifier_prefix: DIG
linear_project_name: digital-idea-box
linear_project_id: 890bebd7-a8af-4cc0-8086-2f0126acecaa
linear_project_url: https://linear.app/digital-idea-box/project/digital-idea-box-598e0b997c1d
linear_project_lead: Tom
linear_project_state: In Progress
linear_project_priority: Urgent
start_date: 2026-05-28
target_date: 2026-06-18
created: 2026-05-28
updated: 2026-05-28
---

# Task Management — Linear mirror of roadmap.md

> Drugi derywat `context/foundation/roadmap.md` (v1) zmigrowany do Linear (workspace `digital-idea-box`, team `Digital-idea-box`, project `digital-idea-box`) 2026-05-28.
> Mirror równoległy do [`tasks-github.md`](./tasks-github.md). Oba lustrza tej samej roadmapy — roadmap.md jest źródłem prawdy.
> Jeśli wykorzystujesz Linear jako podstawowy task manager — to jest twoje miejsce. GitHub mirror jest wtedy fallbackiem / czytelnym dla osób bez Linear konta.

## Linear project

**Project:** [`digital-idea-box`](https://linear.app/digital-idea-box/project/digital-idea-box-598e0b997c1d) (id `890bebd7-a8af-4cc0-8086-2f0126acecaa`, prefix DIG)

| Atrybut       | Wartość                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| Lead          | Tom                                                                     |
| State         | In Progress (`started`)                                                 |
| Priority      | Urgent (1)                                                              |
| Icon / color  | :bulb: / `#5e6ad2` (Linear blue)                                        |
| Start date    | 2026-05-28                                                              |
| Target date   | 2026-06-18 (3-tygodniowy MVP budget per PRD `timeline_budget`)          |
| Teams         | Digital-idea-box                                                        |
| Issues        | 12 (DIG-5..DIG-16) — wszystkie 12 przypięte do projektu                 |
| Milestones    | — (na razie brak; dodać gdy backlog wymusi rozbicie)                    |

Body projektu (Linear Description) trzyma streszczenie wedge'a, north star, scope per stream, PRD-question gates, tygodniowy harmonogram orientacyjny, hard guardrails z PRD, out-of-scope, oraz linki do foundation docs. To jest "single-pager" projektu — full detail żyje w roadmap.md i per-issue body.

Po pierwszym `/10x-plan submissions-data-model`: jeśli pojawią się sub-issues, ustaw je z `parentId: DIG-8` żeby Linear pokazał subtree. Project pozostaje ten sam (sub-issues dziedziczą projekt).

## Wybrany system zadań

**Linear** workspace `digital-idea-box`, team `Digital-idea-box` (identifier prefix `DIG`).

Powód utrzymania **obu** mirrorów (GitHub + Linear):

- **GitHub Issues** — w repo, zero kosztu, dobre dla `#N`-linkowania w commitach, agent-friendly via `gh` CLI.
- **Linear** — szybsze keyboard-first UI, lepszy view manager, natywne `blockedBy/blocks` jako relacje (a nie prose), priority + status type system, Linear Agent / MCP dla automatyzacji, lepsze cykle/projekty/initiatives gdy backlog urośnie.
- Wybór nie jest binarny na MVP. Operuj na tym, w którym faktycznie pracujesz; po pierwszej iteracji `/10x-plan` ten z dwóch, który okazał się przeszkadzać, zostaje wycofany.

Linear MCP daje agentowi (Claude Code, Linear's own agent) bezpośrednio strukturalny dostęp do issues, labels, statusów, relacji blocked-by. Komentarze i status-flipy można wykonać przez konwersację, bez ręcznego klikania.

## Format issue (zatwierdzony, parallel do GitHub)

Każde issue ma:

- **Tytuł:** `[ID] <suggested issue title z roadmap.md>` — np. `[F-01] Foundation: tabela submissions + types + RLS`.
- **Body (pełny, Markdown):** Outcome, Change ID, PRD refs, Prerequisites (z natywnymi `<issue id="…">DIG-N</issue>` link-rendererami które Linear sam wstawia), Parallel with, Unknowns, Risk, Status, Mirror (link do GitHub odpowiednika).
- **Labels:** 4 (po jednej z każdej grupy: `type:*`, `prio:*`, `status:*`, `stream:*`). Wyjątek: `type:question` ma tylko 1 label.
- **Linear-native status:** `Todo` dla `status:ready` (workflow type=unstarted, gotowe do startu), `Backlog` dla `status:blocked`/`status:proposed` (workflow type=backlog).
- **Linear-native priority:** `Urgent (1)` dla north-star, `High (2)` dla must-have + PRD-Q4 + foundations, `Medium (3)` dla pozostałych PRD-questions, `Low (4)` dla nice-to-have.
- **Linear-native blockedBy relations:** używane zamiast tekstowych `Prerequisites:` (Linear sam renderuje graph zależności + alertuje gdy blocker się zamyka).

## Schemat 13 etykiet (parallel do GitHub mirror)

Linear domyślne labele `Feature`, `Improvement`, `Bug` zostały zachowane (workspace-level). Dodaliśmy 13 team-level labels grupowanych logicznie:

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

## Issue mapping (12 issues — Linear + GitHub identyfikatory)

| Roadmap | Linear                                                                                                                                | GitHub                                                | Linear status | Priority    | BlockedBy (Linear)            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------- | ----------- | ----------------------------- |
| PRD-Q3  | [DIG-5](https://linear.app/digital-idea-box/issue/DIG-5) `[PRD-Q3] N startowe zgłoszenia pilota`                                       | [#1](https://github.com/klimek77/DIB/issues/1)        | Todo          | High (2)    | —                             |
| PRD-Q4  | [DIG-6](https://linear.app/digital-idea-box/issue/DIG-6) `[PRD-Q4] Wybór dostawcy AI / modelu`                                         | [#2](https://github.com/klimek77/DIB/issues/2)        | Todo          | Urgent (1)  | —                             |
| PRD-Q5  | [DIG-7](https://linear.app/digital-idea-box/issue/DIG-7) `[PRD-Q5] Format powiadomień admina`                                          | [#3](https://github.com/klimek77/DIB/issues/3)        | Todo          | Medium (3)  | —                             |
| F-01    | [DIG-8](https://linear.app/digital-idea-box/issue/DIG-8) `[F-01] Foundation: tabela submissions + types + RLS`                         | [#4](https://github.com/klimek77/DIB/issues/4)        | Todo          | High (2)    | —                             |
| F-02    | [DIG-9](https://linear.app/digital-idea-box/issue/DIG-9) `[F-02] Foundation: refit auth na magic-link + admin allow-list`              | [#5](https://github.com/klimek77/DIB/issues/5)        | Todo          | High (2)    | —                             |
| F-03    | [DIG-10](https://linear.app/digital-idea-box/issue/DIG-10) `[F-03] Foundation: queue + consumer Worker dla AI enrichment`              | [#6](https://github.com/klimek77/DIB/issues/6)        | Backlog       | High (2)    | DIG-8, DIG-6                  |
| F-04    | [DIG-11](https://linear.app/digital-idea-box/issue/DIG-11) `[F-04] Foundation: Cloudflare Access CIDR-bypass policy`                   | [#7](https://github.com/klimek77/DIB/issues/7)        | Backlog       | High (2)    | — (external: CIDR od user/IT) |
| S-01    | [DIG-12](https://linear.app/digital-idea-box/issue/DIG-12) `[S-01] North star: pierwsza anonimowa submisja → AI → admin detail view`   | [#8](https://github.com/klimek77/DIB/issues/8)        | Backlog       | Urgent (1)  | DIG-8, DIG-9, DIG-10, DIG-6   |
| S-02    | [DIG-13](https://linear.app/digital-idea-box/issue/DIG-13) `[S-02] Admin dashboard z agregatami`                                       | [#9](https://github.com/klimek77/DIB/issues/9)        | Backlog       | High (2)    | DIG-12                        |
| S-03    | [DIG-14](https://linear.app/digital-idea-box/issue/DIG-14) `[S-03] Notification channel + FR-018 alert na fail AI enrichment`          | [#10](https://github.com/klimek77/DIB/issues/10)      | Backlog       | High (2)    | DIG-12                        |
| S-04    | [DIG-15](https://linear.app/digital-idea-box/issue/DIG-15) `[S-04] Natychmiastowa notyfikacja admina o nowym zgłoszeniu`               | [#11](https://github.com/klimek77/DIB/issues/11)      | Backlog       | Low (4)     | DIG-14                        |
| S-05    | [DIG-16](https://linear.app/digital-idea-box/issue/DIG-16) `[S-05] Cotygodniowy mail-digest w poniedziałek 8:00`                       | [#12](https://github.com/klimek77/DIB/issues/12)      | Backlog       | Low (4)     | DIG-13, DIG-14                |

## Graf zależności (Linear-native — renderowany przez Linear)

```
DIG-5  PRD-Q3 ─────────────────────► (metryka pilota, nie ma blockera strukturalnie)
DIG-6  PRD-Q4 ──────► DIG-10 (F-03) ──────► DIG-12 (S-01) ──────► DIG-13 (S-02), DIG-14 (S-03)
                                                                  │
                                                                  └─► DIG-15 (S-04, przez DIG-14)
                                                                      DIG-16 (S-05, przez DIG-13+DIG-14)
DIG-7  PRD-Q5 ─────► DIG-14 (soft — email default działa)
DIG-8  F-01 ───────► DIG-10, DIG-12
DIG-9  F-02 ───────► DIG-12
DIG-10 F-03 ───────► DIG-12
DIG-11 F-04 ───────► (równolegle, blok dla pilot launch, nie dev — brak Linear-internal blockera)
DIG-12 S-01 ───────► DIG-13, DIG-14
DIG-13 S-02 ───────► DIG-16
DIG-14 S-03 ───────► DIG-15, DIG-16
```

Najwyższy fan-out odblokowywania (jedna decyzja → N issues unblocked):

1. **DIG-6 (PRD-Q4)** — odblokowuje DIG-10 (F-03), DIG-12 (S-01) i transitively cały Stream A poniżej. **To pierwsza decyzja do podjęcia.**
2. **DIG-8 (F-01)** — odblokowuje DIG-10 + DIG-12 (już ready do startu, bez zewnętrznych decyzji).
3. **DIG-9 (F-02)** — odblokowuje DIG-12 (już ready do startu, równoległe ze Stream A).

## Mapowanie status: roadmap → Linear

Linear ma native status workflow oraz label-based status. Trzymamy **oba** dla różnych celów:

| roadmap.md `Status:` | Linear status (workflow) | Linear label       | Po co dwóch?                                          |
| -------------------- | ------------------------ | ------------------ | ----------------------------------------------------- |
| `ready`              | Todo                     | `status:ready`     | Workflow = co aktualnie robić. Label = fidelity do roadmap. |
| `blocked`            | Backlog                  | `status:blocked`   | Workflow = nie startuj. Label = filtrowalność: "wszystko blocked" osobno od proposed. |
| `proposed`           | Backlog                  | `status:proposed`  | Workflow = nie startuj. Label = osobny bucket od blocked (czeka na upstream slice, nie na decyzję). |
| `done`               | Done                     | (label usunięty)   | Workflow = zarchiwizowane / merged. Label `status:*` usuwamy po zamknięciu (nie ma sensu trzymać `status:ready` na closed issue). |

Po stronie operacyjnej: filtrowanie "co robię teraz" idzie po **statusie Linear** (Todo). Filtrowanie "co czeka na zewnętrzną decyzję" idzie po **labelu** (`status:blocked` zawsze == zewnętrzny blocker; `status:proposed` == upstream slice).

## Konwencje pracy

### Tworzenie sub-tasków z `/10x-plan`

Gdy `/10x-plan <change-id>` produkuje plan implementacyjny (np. `/10x-plan submissions-data-model` → plan dla DIG-8):

- Nie zamykaj F-/S-issue. Zostaje otwarty jako "epic" (Linear nie ma osobnego typu Epic w darmowej wersji — po prostu issue z sub-tasks).
- Twórz **sub-issues** w Linear (issue z `parentId: DIG-8`) per krok planu. Linear renderuje subtree natywnie.
- Sub-issues dziedziczą project/cycle epica, ale nie etykiet — labels nakładaj per sub-issue.
- Epic zamknij dopiero gdy wszystkie sub-issues są w Done.

### Zamykanie issues

- **Foundation / Slice issue:** zamyka się gdy:
  1. `/10x-archive` przepisał change-id do `## Done` w `roadmap.md`.
  2. Wszystkie sub-issues w Done.
  3. Manualne kliknięcie / `mcp__linear-server__save_issue` `state="Done"`.

- **PRD-Question issue:** zamyka się komentarzem zawierającym verbatim decyzję usera + zaktualizowaniem `## Open Questions` w `prd.md` (jeśli decyzja zmienia kontrakt) lub `## Open Roadmap Questions` w `roadmap.md`. Komentarz z decyzją jest audit-trail.

### Edycja statusu (label-side i workflow-side)

Linear MCP via Claude:

```
mcp__linear-server__save_issue
  id: DIG-N
  state: "Todo" | "Backlog" | "Done"
  labels: ["type:foundation", "prio:must-have", "status:ready", "stream:A"]
```

Trzy `status:*` labels są wzajemnie wykluczające w schemacie — przepinając jednego musisz drugi usunąć. Linear MCP `save_issue` z `labels` parametrem **zastępuje** listę etykiet w całości, więc podaj zawsze pełny zestaw 4.

Gdy zmieni się status w Linear → zaktualizuj `Status:` w odpowiedniej sekcji `roadmap.md` (sekcja `## Foundations` lub `## Slices`) **i** w GitHub mirror (przez `gh issue edit`).

### Komentarze decyzyjne

Kiedy user zamyka PRD-question (np. wybiera dostawcę AI = OpenAI gpt-4.1-mini):

1. Komentarz na DIG-6 (PRD-Q4) z verbatim decyzją + datą.
2. Zamknij DIG-6 (state=Done).
3. Edytuj DIG-10 (F-03) i DIG-12 (S-01):
   - Usuń wzmiankę "Block: yes" / "PRD Q4 dostawca" w body.
   - Zmień `status:blocked` na `status:ready` jeśli to była ostatnia blokada (DIG-12 ma jeszcze Q6, Q7 — więc po Q4 zostaje blocked).
   - `removeBlockedBy: ["DIG-6"]` żeby zerwać relację.
4. Linear sam wyśle notyfikację, że DIG-6 zostało zamknięte i flagnie sub-tree do uwagi.
5. Zaktualizuj `roadmap.md` sekcję `## Open Roadmap Questions` + `### F-03` + `### S-01`.
6. Zsynchronizuj GitHub mirror analogicznie (`gh issue close 2`, `gh issue edit 6,8`).

## Drift detection (trzy źródła — roadmap ↔ Linear ↔ GitHub)

Co spowoduje rozjazd:

- Dodanie nowego slice'u w `roadmap.md` bez utworzenia issue w Linear i/lub GitHub.
- Zmiana `Status:` w `roadmap.md` bez przepięcia labela + workflow status w Linear.
- Zamknięcie issue w jednym mirrorze (Linear lub GitHub) bez zamknięcia drugiego.
- Brak komentarza decyzyjnego na PRD-question issue gdy `## Open Questions` w `prd.md` zostało zmienione.

Mechaniczne wykrycie (manualne, raz na sesję planującą):

```
# Linear MCP: liczba F-/S-issues w team Digital-idea-box
mcp__linear-server__list_issues team="Digital-idea-box" label="type:foundation"
mcp__linear-server__list_issues team="Digital-idea-box" label="type:slice"

# vs roadmap
grep -E "^### [FS]-[0-9]" context/foundation/roadmap.md | wc -l

# vs GitHub
gh issue list --repo klimek77/DIB --label "type:foundation" --label "type:slice" --state all --json number | jq length
```

Niezgodność trzech licznikow → drift; reconcile ręcznie zaczynając od `roadmap.md` (source of truth).

## Komendy szybkiego dostępu (Linear MCP)

```
# Wszystkie ready do startu (Todo + label status:ready)
mcp__linear-server__list_issues team="Digital-idea-box" state="Todo" label="status:ready"

# Wszystkie blocked z powodu zewnętrznej decyzji (label status:blocked)
mcp__linear-server__list_issues team="Digital-idea-box" label="status:blocked"

# Otwarte PRD-decyzje czekające na usera
mcp__linear-server__list_issues team="Digital-idea-box" label="type:question" state="Todo"

# Stream A (core wedge) całość
mcp__linear-server__list_issues team="Digital-idea-box" label="stream:A"

# Konkretny issue z body + relacjami + komentarzami
mcp__linear-server__get_issue id="DIG-8"
mcp__linear-server__list_comments issue="DIG-8"
```

Te komendy są instrukcją dla agenta (Claude w sesji Claude Code z Linear MCP) — nie wpisuje się ich w terminalu.

## Linki

- **Roadmap (source of truth):** [`context/foundation/roadmap.md`](./roadmap.md)
- **GitHub mirror:** [`task-management-github mirror of roadmap.md`](./task-management-github%20mirror%20of%20roadmap.md)
- **PRD:** [`context/foundation/prd.md`](./prd.md)
- **Tech stack:** [`context/foundation/tech-stack.md`](./tech-stack.md)
- **Infrastructure:** [`context/foundation/infrastructure.md`](./infrastructure.md)
- **Linear workspace:** https://linear.app/digital-idea-box
- **Linear team Digital-idea-box backlog:** https://linear.app/digital-idea-box/team/DIG
