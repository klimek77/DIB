---
change_id: testing-auth-abuse-boundary
title: Auth & abuse-boundary tests (rollout Phase 3) — magic-link spam/enumeration + Workers cookie round-trip
status: implementing
created: 2026-06-09
updated: 2026-06-09
archived_at: null
---

## Notes

Rollout Phase 3 of `context/foundation/test-plan.md` — "Auth & granica nadużyć".

Risks covered:
- **#5** (Medium×Medium) — spam / enumeracja magic-linków: powtarzane żądania OTP zalewają skrzynkę, wpadają w SMTP rate-limit, albo ujawniają, który email jest na allow-liście.
- **#6** (High×Medium) — magic-link cookie/PKCE nie round-trip na runtime Workers (prod ≠ dev): admin nie zaloguje się na produkcji mimo że lokalnie działa.

Risk response intent (z §2 Risk Response Guidance — weryfikować w researchu, nie przyjmować na wiarę):
- **#5**: udowodnij, że powtarzane żądania OTP są dławione (built-in Supabase throttle) i bramowane allow-listą fail-closed, a odpowiedź nie ujawnia, który email istnieje na allow-liście (non-enumeration). Najpierw zweryfikuj built-in throttle — nie testuj rate-limitera, którego nie ma.
- **#6**: udowodnij, że callback ustawia trwałe cookie sesji na runtime Workers i admin pozostaje zalogowany po round-tripie na prod — nie tylko lokalnie. Unikaj unit-testu mockującego cookie bez runtime Workers (fałszywy zielony).
