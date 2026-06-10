---
change_id: testing-quality-gates-wiring
title: Quality-gates wiring — vitest unit+integration as a required CI gate
status: impl_reviewed
created: 2026-06-10
updated: 2026-06-10
archived_at: null
---

## Notes

Open a change folder for rollout Phase 4 of context/foundation/test-plan.md: "Quality-gates wiring". Risks covered: cross-cutting (zatrzaśnięcie podłogi jakości dla regresji z ryzyk #1–#7). Test types planned: wpięcie gate'ów — vitest unit+integration (`npm test`) w CI. Risk response intent: cross-cutting — CI dziś robi tylko lint+build (per roadmap baseline); ta faza wpina `npm test` (vitest run) jako wymaganą bramę, tak by regresje logiki, dostępu, anonimowości i taksonomii blokowały merge (§5 test-planu). Do rozstrzygnięcia w researchu: czy `npm run test:workers` (pool-workers, kontrakt Set-Cookie #6) też wchodzi do CI — §4 i §6.3 test-planu wskazują CI w Phase 4.
