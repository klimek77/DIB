# Submission Durability & Taxonomy Integrity (Test Rollout Phase 2) — Plan Brief

> Full plan: `context/changes/testing-submission-durability-taxonomy/plan.md`
> Research: `context/changes/testing-submission-durability-taxonomy/research.md`

## What & Why

Phase 2 of the test rollout (`test-plan.md §3`): write the tests that protect **Risk #4** (a submission shows "thank you" but is silently lost — DB rejects a drifted taxonomy value, or the enqueue fails) and **Risk #7** (a duplicate queue delivery re-calls AI / clobbers the result, or a row wedges in `processing` forever). Research proved the enrichment logic is sound but untested at its riskiest seams, and that the submission durability claim rests on a recovery sweep that does not exist.

## Starting Point

The enrichment consumer already implements CAS, token-guarded writes, a 12-min stale backstop, and reset-before-retry correctly — but the stale-reclaim arm, the CAS rows-affected branch, the `markDone`/`resetToPending` guards, and the duplicate-delivery interleave are untested. `taxonomies.ts ≡ migration CHECK` is a character-match today but guarded by nothing. The submission endpoint returns 201 on enqueue-fail and leaves the row recoverable as `pending` — but no sweep ever re-enqueues it, and two code comments claim one exists.

## Desired End State

`npm test` fails loudly on any future `taxonomies.ts ↔ CHECK` drift; proves a duplicate delivery enriches once and never clobbers, and that stale rows are reclaimed; and locks the submission durability contract truthfully (enqueue-fail → recoverable `pending` row + logged event + 201). The missing recovery sweep is opened as its own follow-up change. No production behavior changes; pure-unit fidelity, no new infra.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| #4a durability gap | Test-only + defer the sweep | Building a cron sweep is a production feature outside a test phase; honors "don't harden a non-existent consumer" | Plan |
| Test fidelity | Pure-unit / fake-client | Matches the node-env stack; the drift guard makes "app-valid ⇒ CHECK-valid" true by construction, so no live DB needed | Plan |
| #7 coverage depth | Full (interleave + stale-arm + real-store guards + reset-fail recovery) | Closes exactly the gaps research found — the stuck-forever and clobber paths | Plan |
| Observability / comments | Assert as-is + correct the two misleading comments | Code should tell the truth about the deferred sweep; trivial comment-only diff, no anonymity impact | Plan |
| Phase sequencing | Cheapest-signal-first (drift → #7 → #4a) | Front-loads the cheapest, highest-certainty win; each phase commits independently | Plan |

## Scope

**In scope:** taxonomy drift-guard unit test; enrichment idempotency tests (interleave, stale-reclaim, token guards, reset-fail recovery); submission durability route tests; correcting two misleading comments; opening the deferred sweep change.

**Out of scope:** building the recovery sweep; any production behavior change; real/emulated Postgres or Workers runtime pool (Phase 3); AI content correctness; total-outage signal decoupling; re-testing the OpenAI-schema↔TS seam.

## Architecture / Approach

Three independent phases, each touching 1-2 test files and committing on its own. Phase 1 is a new self-contained unit test that reads migration SQL via `node:fs`. Phases 2-3 extend existing test files (`consumer.test.ts`, `submissions.test.ts`) following their edge-only mocking patterns. Production code is touched only in Phase 3, comments only.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Taxonomy drift guard | Unit test: `taxonomies.ts ≡ CHECK` (5 cols, both directions, diacritic-sensitive) | SQL parser must track final-effective CHECK across migrations in date order |
| 2. Enrichment idempotency | Interleave, stale-arm, real-store token guards, reset-fail recovery | The in-memory fake store's CAS rule must match `consumer.ts` or the test is vacuous |
| 3. Submission durability | Route tests (enqueue-fail/insert-fail) + corrected comments + deferred-sweep follow-up | Success criterion must admit "no silent loss" isn't fully met until the sweep lands |

**Prerequisites:** none beyond the existing test suite and migrations on disk.
**Estimated effort:** ~3 sessions, one per phase (each 1-2 files).

## Open Risks & Assumptions

- The durability "no silent loss" goal is only **partially** met by Phase 2 — full closure depends on the deferred sweep change. The Phase-3 success criterion is worded to say so.
- Pure-unit fidelity proves the code *builds* the right query, not that Postgres *executes* it that way; the drift guard + simple predicates are the mitigation. Live-DB verification stays Phase 3.
- The #7 fake store re-encodes the production CAS rule — a manual parity review (step 2.4) guards against the fake drifting from `consumer.ts`.

## Success Criteria (Summary)

- A future drift between `taxonomies.ts` and the migration CHECK fails CI instead of a user's submission.
- A duplicate enrichment delivery enriches once and never overwrites; stale rows are reclaimed, fresh ones are not.
- The submission endpoint's durability contract is locked truthfully, the misleading comments are gone, and the recovery sweep is captured as a tracked follow-up.
