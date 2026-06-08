---
change_id: testing-submission-durability-taxonomy
title: Submission durability & taxonomy integrity (test rollout Phase 2)
status: impl_reviewed
created: 2026-06-08
updated: 2026-06-08
archived_at: null
---

## Notes

Open a change folder for rollout Phase 2 of context/foundation/test-plan.md: "Trwałość submisji & integralność taksonomii" (Submission durability & taxonomy integrity).
Risks covered: #4 (ciche zgubienie zgłoszenia — "sukces w UI" <1s mimo że DB CHECK odrzuca / drift taksonomii, albo insert OK a enqueue pada po cichu), #7 (kolejka AI — duplikat dostarczenia bez compare-and-swap nadpisuje/dubluje wzbogacenie i pali tokeny; albo wiersz wisi w processing na zawsze).
Test types planned: unit (taxonomy drift guard — taxonomies.ts ≡ enumy CHECK w migracji), integration (insert/enqueue sequence + enqueue-fail nie gubi danych po cichu; queue consumer idempotency/CAS, transient vs permanent, stale-reclaim).
Risk response intent:
- #4: prove "sukces w UI" ⇒ trwały wiersz w DB albo czysty błąd; taksonomie ≡ enumy CHECK; enqueue-fail nie gubi danych po cichu. Challenge "status 200 == zapisane i zakolejkowane" oraz "taksonomie zawsze zgodne z DB".
- #7: prove drugie dostarczenie tego samego joba nie woła AI ponownie ani nie nadpisuje wyniku; stale processing jest odzyskiwany. Challenge "retry zawsze bezpieczny"; nie konflacuj transient z permanent.
