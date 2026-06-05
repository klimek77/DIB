# markFailed clobber fix — session report (2026-06-05)

- **Source**: pre-push review finding (you spotted it on the diff vs `origin/main`).
- **Status**: ✅ FIXED + verified. **Not committed, not pushed** (awaiting your OK).
- **Scope chosen**: *Full fix* — close BOTH clobber paths (permanent-error branch + DLQ branch).
- **Files**: `src/lib/enrichment/consumer.ts`, `src/lib/enrichment/consumer.test.ts`.

## The finding

`createSupabaseStore.markFailed` guarded only on `.neq("enrichment_status", "done")` while its
siblings `markDone` / `resetToPending` guard on the per-claim token `enrichment_attempted_at`. This
contradicted the file's own stated invariant ("Each transition write is guarded on
`enrichment_attempted_at` … never clobbered") and let a stale/zombie invocation flip a freshly
re-claimed row to `failed`.

### Two clobber paths (both now closed)

1. **Permanent-error branch + stale-reclaim race**
   - A claims a row, hangs >12 min (`STALE_PROCESSING_THRESHOLD_MS`) without crashing.
   - B stale-reclaims it (new `attempted_at`), starts enriching.
   - A's `enrich()` returns a **permanent** (4xx) error → A's `markFailed` (old: `.neq(done)` only)
     flips the row to `failed`, clobbering B's live claim.
   - B succeeds → `markDone` (guarded on B's token) no-ops → **B's successful enrichment silently lost**.

2. **DLQ branch + re-enqueue race**
   - `processDeadLetterMessage` reads status, then `markFailed`. If a re-enqueued fresh claim
     re-stamps the row between `readStatus` and `markFailed`, the old `.neq(done)`-only write
     clobbered that fresh, in-flight claim.

### What was already safe (unchanged)

- `.neq("enrichment_status", "done")` already prevented clobbering an **already-`done`** row — the
  worst case (overwriting completed AI output) was never reachable. Exposure was a `processing`
  (different claim) or `pending` row.
- Trigger probability is **low** (needs a non-crashing >12-min hang ending in a *permanent* error, or
  a DLQ-vs-re-enqueue race). The failure mode when it does trigger is **silent data loss**, and the
  fix is small — hence fixing pre-push rather than deferring.

## The fix (3 parts)

1. `SubmissionStore.markFailed` signature gains an optional `claimedAt?: string | null`. The SQL impl
   keeps the `.neq(done)` floor and, **when a token is supplied**, also `.eq("enrichment_attempted_at", claimedAt)`.
2. **Permanent-error branch** (`processEnrichmentMessage`) now passes its own `claimedAt` → a write
   from an invocation that lost the claim affects zero rows.
3. **DLQ branch** (`processDeadLetterMessage`) now passes the token it **observed** via `readStatus`
   (optimistic concurrency). `readStatus` was widened to return `attemptedAt: string | null`; the
   local `current` annotation widened to match.

The `claimedAt != null` check means the rare **never-claimed DLQ row** (`attempted_at` still null)
falls back to the `.neq(done)`-only floor — i.e. it still gets failed, exactly as before.

## Tests (TDD: red → green)

- New `describe("createSupabaseStore — per-claim write guards")` exercises the **real** store against a
  chainable supabase-js mock — the SQL guards were previously **untested** (existing tests mock the
  whole store seam, so they only cover *when* a transition is requested, never the guard itself).
  - `markFailed` WITH token → asserts both `.neq(done)` and `.eq(attempted_at, token)`.
  - `markFailed` WITHOUT token → asserts `.neq(done)` only, no `attempted_at` filter.
  - `readStatus` → returns `attemptedAt`.
- Updated the permanent-error test to assert `markFailed` is called with the 4th arg (claim token).
- Updated the DLQ test to assert `markFailed` receives the observed `attemptedAt` as the guard token.
- Red proof: before the impl, the 4 token-related assertions failed (current code passed no token /
  `readStatus` omitted `attemptedAt`); after, all green.

## Verification

- `npx vitest run` → **19/19 passed** (consumer suite 11/11).
- `npm run typecheck` (astro check) → **0 errors**.
- `npm run lint` (eslint) → **clean** (ran `lint:fix` for prettier formatting).

## Residual / accepted (NOT changed — left intentionally minimal)

- **Spurious `retry_exhausted` signal**: when the DLQ `markFailed` no-ops (row re-claimed), the DLQ
  still calls `emitFailureSignal` + `ack`. The DB clobber is closed, but a forensic failure signal may
  fire for a row another claim is actively processing. Suppressing it would require `markFailed` to
  return rows-affected (return-type change + all callers + tests) — out of scope for "close the
  clobber". Candidate follow-up if S-03 alert noise becomes a concern.

## Next steps for you

- Review the diff, then commit + push when ready (push gate runs test/lint/typecheck — all green here).
- Suggested commit subject: `fix(ai-enrichment-queue): guard markFailed on per-claim token (no clobber)`.
