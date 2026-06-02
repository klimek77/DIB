# Async AI Enrichment Plumbing (F-03) — Plan Brief

> Full plan: `context/changes/ai-enrichment-queue/plan.md`

## What & Why

Build the asynchronous AI-enrichment path: a Cloudflare Queue + a consumer Worker that enriches each submission (tone, classification, title, summary) via OpenAI `gpt-4o-mini` and writes it back to the row. The PRD requires a sub-1s submission confirmation regardless of AI state (NFR) and graceful degradation when AI is down (FR-008) — both demand the enrichment run *off* the request path. This is the foundation S-01 (employee form) and S-03 (failure alert) build on.

## Starting Point

F-01 already shipped the `submissions` table with every output + lifecycle column F-03 needs (`enrichment_status pending|processing|done|failed`, `enrichment_attempts`, `ai_tone` CHECK-enforced, `ai_classification` free text, `ai_title`, `ai_summary`). The app runs on `@astrojs/cloudflare` 13.5.0, whose default Worker entry exports only `fetch`; `wrangler.jsonc` has no queue config. There is no form endpoint and no notification channel yet.

## Desired End State

Given a submission id on the queue, the Worker enriches the row exactly once and marks it `done` with valid AI fields; transient AI failures retry with backoff via the platform; exhausted retries mark the row `failed` and emit a structured FR-018 signal; redelivery never double-calls the AI or clobbers a good result.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| AI provider/model | OpenAI `gpt-4o-mini`, Structured Outputs | Cheap, reliable constrained output; async so latency is irrelevant. | Frame (change.md) |
| Worker topology | Single Worker, `fetch` + `queue` handlers | Simplest for MVP; AI call is I/O-wait not CPU, so one Worker fits limits. | Plan |
| Queue message | `{ submissionId }` only | DB is single source of truth; no stale payload, content never copied into the queue. | Plan |
| Retry model | Native Queues retry + DLQ | Platform owns backoff/redelivery; no in-handler sleep / cost-burn risk. | Plan |
| Idempotency | Compare-and-swap `enrichment_status` claim | At-least-once delivery would otherwise double-spend/clobber; lifecycle columns exist for this. | Plan |
| Anthropic fallback | OpenAI now, clean seam only | Async retry absorbs OpenAI outages; wiring failover now is premature scope. | Plan |
| FR-018 signal | `failed` row state + structured log | Builds the contract without building S-03's sender (lessons compliance). | Plan |
| Classification set | Fixed 5-category enum in `taxonomies.ts` | Constrained output is chartable for FR-011; single source of truth. | Frame + Plan |
| Producer side | Enqueue helper + dev harness, no form endpoint | Form is S-01; lessons: don't build a not-yet-written consumer. | Plan |

## Scope

**In scope:** queue + DLQ creation/bindings; custom dual-handler Worker entry; `enqueueEnrichment()` helper; service-role DB client; `CLASSIFICATIONS` taxonomy; provider-seam `enrich()` (OpenAI Structured Outputs); consumer state machine (claim → enrich → write-back → retry → fail + signal); structured logging; dev verification harness.

**Out of scope:** employee form / submission endpoint (S-01); email/notification delivery (S-03); Anthropic failover wiring; any DB migration; cron / weekly digest (S-05); dashboard reads (S-02); retention/delete.

## Architecture / Approach

One Worker exports `fetch` (delegating to the adapter's `handle`) and `queue`. The form (S-01, later) calls `enqueueEnrichment(env, id)`. The consumer re-reads the row via a service-role client, compare-and-swap-claims it (`pending → processing`), calls `enrich(content)`, and writes `done` with the AI fields. Transient errors call `message.retry({delaySeconds})`; permanent errors or exhausted attempts write `failed` + emit the FR-018 log signal; a dead-letter queue is the backstop.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Infra + dual-handler skeleton | Queues + bindings, custom `src/worker.ts` (no-op consumer), enqueue helper, env wiring | Adapter entry swap (`main` → custom file, `handle` import) must not break HTTP routing |
| 2. Enrich module + taxonomy + admin client | `CLASSIFICATIONS`, service-role client, provider-seam `enrich()` (OpenAI Structured Outputs) | Schema enum must mirror taxonomy SSOT or valid responses fail the row write |
| 3. Consumer state machine | Claim/enrich/write-back, retry/DLQ, `failed` + FR-018 signal, structured logs | At-least-once idempotency + stale-`processing` reclaim correctness |

**Prerequisites:** Cloudflare account access for `wrangler queues create` (×2) and `wrangler secret put` (`OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`); an OpenAI API key; the Supabase service-role key. No DB migration needed.
**Estimated effort:** ~2–3 sessions across 3 phases.

## Open Risks & Assumptions

- Single-Worker assumption holds because the AI call is fetch-wait, not CPU; if a future surface adds heavy CPU work, revisit the two-Worker split.
- No automatic provider failover — a *sustained* OpenAI outage leaves jobs retrying until the cap, then `failed` (acceptable for async MVP).
- Local queue testing requires `wrangler dev` (not `astro dev`); the dev harness is the only standalone way to exercise the consumer before S-01.
- An uncapped retry loop on transient errors could burn cost; bounded by `max_retries` + backoff + a manual account Spend Limit.

## Success Criteria (Summary)

- A `pending` submission, once enqueued, reaches `enrichment_status='done'` with `ai_tone` ∈ TONES and `ai_classification` ∈ CLASSIFICATIONS.
- A persistent AI failure ends the row `failed` with `enrichment_last_error` set and a structured `enrichment_failed` event in the logs.
- A duplicate delivery causes exactly one AI call and never clobbers a good result.
