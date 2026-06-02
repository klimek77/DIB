---
change_id: ai-enrichment-queue
title: Async AI enrichment plumbing — Cloudflare Queue + consumer Worker
status: new
created: 2026-06-02
updated: 2026-06-02
archived_at: null
---

## Notes

from @context/foundation/roadmap.md (F-03, Stream A).

### Decisions locked (2026-06-02, pre-/10x-plan)

- **AI provider/model:** OpenAI `gpt-4o-mini` via Structured Outputs (strict JSON schema) — tone label + classification (5 fixed categories: pomysł / zgłoszenie / propozycja / błąd / skarga) + 1–2 sentence summary. Async (queue) → latency irrelevant; cost negligible at expected volume. Anthropic `claude-haiku` = pre-vetted fallback (both API tokens on hand; no local LLMs). Resolves roadmap Open Q2 / PRD Q4.
- **FR-018 fail-alert sink:** email only (MVP) — consumer emits a structured event on final enrichment failure; that event lands on email (downstream S-03). Slack/Teams → v2.

### F-03 output schema is largely fixed by the shipped F-01 table

The `submissions` table (migration `supabase/migrations/20260528000000_create_submissions.sql`) already defines the enrichment-output columns the consumer writes:

- `ai_tone` — CHECK enum **`Pozytywny | Negatywny | Neutralny`** → **resolves PRD Q7** (tone vocabulary is fixed; no open decision).
- `ai_classification` — `text`, **no DB CHECK** → classification scheme still open; `/10x-plan` decides it (roadmap narrative floats a 5-category set pomysł/zgłoszenie/propozycja/błąd/skarga — confirm or revise; not enforced by the DB).
- `ai_title`, `ai_summary` — free `text` (summary = 1–2 sentences per FR-007).
- Lifecycle the consumer owns: `enrichment_status` (`pending | processing | done | failed`), `enrichment_attempts`, `enrichment_last_error`, `enrichment_attempted_at`.

Mirror the enum values from `src/lib/submissions/taxonomies.ts` (single source of truth; diacritic drift silently breaks INSERTs). Note: user-selected `topic` (`Pomysł | Problem | Usprawnienie | Inne`) is **distinct** from AI `ai_classification` — don't conflate.
