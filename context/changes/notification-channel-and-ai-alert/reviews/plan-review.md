<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Notification Channel + FR-018 AI-Failure Alert (S-03)

- **Plan**: context/changes/notification-channel-and-ai-alert/plan.md
- **Mode**: Deep
- **Date**: 2026-06-13
- **Verdict**: REVISE (→ SOUND after fixes)
- **Findings**: 0 critical · 2 warnings · 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | WARNING (→ PASS after F3 fix) |
| Blind Spots | WARNING (→ PASS after F1 fix) |
| Plan Completeness | WARNING (→ PASS after F2 fix) |

## Grounding

8/8 paths ✓ (`src/lib/notifications/` correctly absent), symbols ✓ (`markFailed` /
`captureError` / `ConsumerContext` / `emitFailureSignal` / allowlist parser located),
Progress↔Phase mechanical contract ✓ (3 phases, 18/18 criteria mapped, no stray checkboxes in
phase bodies), brief↔plan ✓. Deep-verify ✓: coalescing scope (`worker.ts:40-54` — one
`consumerCtx` built per batch, single-queue loop, flush-after-loop is sound), `markFailed` store
impl (`consumer.ts:311-324` — `.select("id")` → `data.length` is viable; UPDATE currently
returns no rows), `openai.ts:42-66` `fetchImpl ?? fetch` pattern confirmed (email.ts mirror is
sound), existing throw-based gate confirmed (`consumer.ts:141-154,197-217`). 1 gap → F1.

## Findings

### F1 — Recipient resolver reads env.ALLOWED_ADMIN_EMAILS, which isn't on the Worker Env

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 1 §2 (recipients.ts) + §4 (secrets)
- **Detail**: `worker-env.d.ts:16-29` declares `Env` with no `ALLOWED_ADMIN_EMAILS` (only QUEUE /
  ASSETS / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY / SENTRY_DSN?). That var is
  declared as an Astro `envField` secret (`astro.config.mjs:71`) consumed only via
  `astro:env/server` (`allowlist.ts:1`). Consequences: (a) Phase 1's typecheck gate (1.3,
  `astro check`) fails — `'ALLOWED_ADMIN_EMAILS'` not on `Env`; Phase 1 §4 adds only
  `RESEND_API_KEY?`/`ALERT_FROM?`. (b) The resolver introduces a second read path (raw Worker
  binding) vs allowlist's `astro:env/server`; reading via `astro:env/server` in the queue handler
  likely returns undefined (no Astro request ALS context) — so the raw binding is the right
  choice — but if the binding is unpopulated the resolver silently returns `[]` and FR-018 (a
  must-have) delivers nothing.
- **Fix**: Add `ALLOWED_ADMIN_EMAILS?: string` to `Env` in Phase 1 §4 + a runtime-binding check
  (routed through existing Phase-3 step 3.7) + a rationale note on raw-binding vs `astro:env`.
- **Decision**: FIXED (Fix in plan) — Phase 1 §4 now adds `ALLOWED_ADMIN_EMAILS?` to `Env` and
  explains the typecheck/runtime rationale; the "One recipient parser" detail documents why the
  resolver reads the raw binding; runtime confirm folded into step 3.7.

### F2 — markFailed contract change breaks existing success-path tests, not only the throws-cases

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 §3 (consumer.test.ts)
- **Detail**: The shared `makeStore` mock (`consumer.test.ts:31`) sets
  `markFailed: vi.fn(() => Promise.resolve())` → `undefined`. Once gated on `rowsAffected > 0`,
  `undefined > 0` is false. Existing success-path tests — `:144` (permanent ⇒ `captureError`
  fires), `:237` (retry-exhausted ⇒ `captureError` fires), plus the `emitFailureSignal` log-line
  asserts — go RED unless the default mock returns ≥1. Phase 2 §3 only flagged the
  markFailed-throws cases.
- **Fix**: In Phase 2 §3, set `makeStore`'s default `markFailed` to `Promise.resolve(1)` and state
  the existing `:144`/`:237` + signal log-line asserts must stay green under the new return type.
- **Decision**: FIXED (Fix in plan) — Phase 2 §3 now opens with the default-mock update and names
  the success-path assertions that must stay green.

### F3 — Home of the shared parseEmailList helper is unspecified (dependency-direction risk)

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 1 §2
- **Detail**: The plan extracts `parseEmailList` "into a shared pure helper (e.g. ...) used by both
  `allowlist.ts` and `recipients.ts`" but left its location as "e.g.". If it lands in
  `src/lib/notifications/recipients.ts`, then `src/lib/auth/allowlist.ts` imports from
  `notifications/` — auth depending on a notifications module, an odd direction for a load-bearing
  auth file imported by middleware/signin/callback.
- **Fix**: Place the shared parser in a neutral module
  (`src/lib/email/parse-email-list.ts`), not inside `notifications/`.
- **Decision**: FIXED (Fix in plan) — Phase 1 §2 File list adds `src/lib/email/parse-email-list.ts`
  (neutral shared parser) and the Contract pins the location + states the auth→notifications
  direction is wrong.
