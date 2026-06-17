---
change_id: new-submission-instant-notify
title: Natychmiastowa notyfikacja admina o każdym nowym zgłoszeniu
status: impl_reviewed
created: 2026-06-15
updated: 2026-06-17
archived_at: null
---

## Notes

Roadmap slice **S-04** (`context/foundation/roadmap.md`) — FR-016, nice-to-have.

Po przyjęciu zgłoszenia (przed enrichment lub po — do decyzji w planie) admin dostaje
powiadomienie na ten sam kanał co S-03, z minimalnym kontekstem (czas, dział, tematyka)
i linkiem do detail view (gated przez auth).

- Prereq: S-03 (kanał email już skonfigurowany — archived `2026-06-13-notification-channel-and-ai-alert`).
- Trigger: na wpisaniu wiersza do `submissions` (po insert w endpoint'cie lub DB webhook),
  NIE w consumer'ze F-03 (consumer odpala się po Q1-time, nie real-time).
- Nice-to-have: jeśli budżet się dusi, S-04 spada poniżej linii (FR-018 alert z S-03 jest must-have, to nie).
