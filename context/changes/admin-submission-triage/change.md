---
change_id: admin-submission-triage
title: Admin submission triage — update status and delete on the dashboard
status: impl_reviewed
created: 2026-06-19
updated: 2026-06-23
archived_at: null
---

## Notes

Domknięcie CRUD: dodać adminowi dwie akcje na dashboardzie (obie przez sesję
admina → RLS, więc dodatkowo wzmacniają wymaganie #4 i nie naruszają anonimowości):

- **Update**: status zgłoszenia, np. `nowe → w trakcie → rozpatrzone/odrzucone`
  (naturalny triage skrzynki pomysłów; status to metadana admina, nie tożsamość
  nadawcy).
- **Delete**: admin usuwa spam / zgłoszenia off-topic z panelu (naturalna
  moderacja).

Szacowany kształt zmiany: 1 migracja (kolumna `review_status` + grant/RLS) +
1 endpoint API + przyciski w widoku — mała, spójna z produktem zmiana.

Otwarte decyzje do rozstrzygnięcia w planie: dokładny enum statusów, hard vs
soft delete, kształt endpointu (jeden vs dwa), gdzie egzekwowana jest autoryzacja
(middleware + RLS column-grant backstop, por. test-plan #1/#3).
