---
change_id: testing-access-control-anonymity
title: "Test Phase 1: access-control & anonymity core (risks #1-#3)"
status: archived
created: 2026-06-08
updated: 2026-06-08
archived_at: 2026-06-08T11:13:18Z
---

## Notes

Open a change folder for rollout Phase 1 of context/foundation/test-plan.md: "Access-control & anonimowość core".
Risks covered: #1 (niepowołany odczyt zgłoszeń przez detail view / RLS), #2 (deanonimizacja — zapis IP/identyfikatora nadawcy lub PII w logach), #3 (spoofing pól AI przez payload anonimowego nadawcy).
Test types planned: integration (route + RLS), unit (payload/whitelist/no-PII).
Risk response intent (z §2 Risk Response Guidance — zweryfikuj, nie przyjmuj na ślepo):
- #1: udowodnij, że nie-admin / usunięty admin dostaje 403 lub redirect zarówno na liście, jak i na /dashboard/submissions/[id], a RLS sam blokuje SELECT (defense in depth). Zakwestionuj "middleware na /dashboard root wystarczy". Unikaj happy-path-only.
- #2: udowodnij, że insert nie zawiera IP/identyfikatora nadawcy, logi i ciała błędów nie zawierają treści ani podpisu, a payload do AI jest bez podpisu. Zakwestionuj "endpoint anon => nic nie logujemy". Unikaj asercji skopiowanej z implementacji.
- #3: udowodnij, że pola wzbogacenia / id / status z payloadu klienta są odrzucane lub ignorowane, a column-grants w DB blokują zapis nawet przy luce w whitelist. Zakwestionuj "whitelist po stronie app wystarczy". Unikaj luki w czarnej liście.
