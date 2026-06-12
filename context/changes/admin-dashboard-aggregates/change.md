---
change_id: admin-dashboard-aggregates
title: Admin dashboard z agregatami — licznik, pie tematyk, oddziały, lista
status: implemented
created: 2026-06-12
updated: 2026-06-12
archived_at: null
---

## Notes

Roadmap S-02 (`context/foundation/roadmap.md`) — kolejny krok Stream A po domkniętym S-01.

- Outcome: admin w jednym widoku — (a) licznik zgłoszeń z filtrem czasu (24h / tydzień / miesiąc / rok / custom), (b) pie chart tematyk, (c) podział wg oddziału, (d) lista zgłoszeń z AI-summary, klikalna do detail view z S-01.
- PRD refs: FR-010, FR-011, FR-012, FR-013.
- Prereq: S-01 (done). Parallel with: S-03 (notification-channel-and-ai-alert).
- Decyzje odłożone do `/10x-plan` (per roadmap Risk): wybór biblioteki wykresów (bundle size), minimalny datepicker dla custom range, lista bez paginacji przy skali MVP.

(Utworzone w odpowiedzi na "co mamy następne do robienia?" — wybór wg kolejności Stream A; równoległa alternatywa: S-03.)
