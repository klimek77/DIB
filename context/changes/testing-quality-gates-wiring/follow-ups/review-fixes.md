# Review follow-ups — testing-quality-gates-wiring

> Queued from impl-review phase 2 (2026-06-10). Execute during Phase 3 (notka §6.6 w test-planie).

- [ ] **F1 (phase-2 review)** — do notki husky w §6.6 dopisać escape dla prod-install: `"prepare": "husky"` wywala `npm ci --omit=dev` (binarka husky nieobecna → exit 127 → install pada); świadomy escape to `npm ci --ignore-scripts`. Decyzja: zostawić prepare as-is (fail-fast jako sygnał), tylko udokumentować.
- [ ] **F5 (phase-2 review)** — do tej samej notki §6.6 dopisać jedną linię o świadomych bypassach gate'a: `HUSKY=0` (env, wyłącza shimy i instalację) oraz `git push --no-verify` — udokumentowane escape'y zamiast wiedzy plemiennej.
