---
change_id: weekly-digest
title: Cotygodniowy mail-digest w poniedziałek 8:00 Europe/Warsaw
status: implementing
created: 2026-06-18
updated: 2026-06-19
archived_at: null
---

## Notes

Roadmap **S-05** (Stream A), PRD **FR-017** — nice-to-have. Ostatnia pozycja MVP; po niej roadmapa domknięta (dalej tylko §Parked → v2).

**Outcome:** w każdy poniedziałek o 8:00 Europe/Warsaw admin dostaje mail z podsumowaniem zgłoszeń poprzedniego tygodnia: liczba zgłoszeń, breakdown wg tematyki, breakdown wg oddziału, opcjonalnie top-3 tematów wg klasyfikacji AI.

**Prerequisites (oba done):** S-02 `admin-dashboard-aggregates` (digest re-używa agregacji z dashboardu) + S-03 `notification-channel-and-ai-alert` (re-używa skonfigurowanego kanału email).

**Ryzyko przeniesione z roadmapy — do zaadresowania w `/10x-plan`:**
- Cron Triggers na Workers działają w UTC; DST gotcha (Europe/Warsaw = UTC+1 zimą / UTC+2 latem). Nie trzymaj godziny triggera literalnie — policz okno tygodniowe wewnątrz handlera (od poniedziałku-7d 00:00 do poniedziałku 00:00 lokalnie) zamiast polegać na tym, że trigger odpali dokładnie 08:00 Warszawa. (Devil's Advocate #5, `infrastructure.md`.)
- Handler musi być idempotentny — Workers nie gwarantuje at-least-once na Free tier.
- Cron żyje w `src/worker.ts` (już jest tam 15-min sweep + queue consumer) — digest dokleja kolejny scheduled handler, nie nowy worker.
