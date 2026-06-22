# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Verify every /simplify finding against the code before turning it into a plan

**Context:** Planning phase, when a `/simplify` (or any code-smell sweep) report feeds `/10x-plan`. First seen: `submissions-data-model-hardening`.
**Problem:** A 15-finding `/simplify` report grew into a 535-line, 6-phase plan that passed `plan-review` with a SOUND verdict — while carrying 3 factually wrong findings: a drop-index call built on a false Postgres "prefix" theory (#9), a "consolidate 6 INSERTs" fix for a seed that was already a single multi-row INSERT (#10), and a CLI bump to fix a harmless no-op `Omit<>` that typecheck/build already accepted (#15). A snapshot smell-sweep has no ground truth — it manufactures confident false positives, and turning its raw output into plan scope launders them past review.
**Rule:** Treat `/simplify` output as triage candidates, not plan scope. Before a finding enters a plan, confirm it against the actual file (read the line, run typecheck/build) and reject INVALID ones. The number of findings never sets the number of phases.
**Applies to:** `plan`, `plan-review`

## A deferred permissive gate is live exposure until the tightening change lands

**Context:** RLS/authz review when a permissive predicate (`USING (true)`, open SELECT) is deliberately deferred to a later change. First seen: `submissions-data-model` F1 (admin SELECT open to any authenticated user until F-02).
**Problem:** `submissions_authenticated_select USING (true)` is correct per the F-01 plan, but becomes live data exposure the moment a read surface (S-02 dashboard) ships before F-02 tightens the gate. A code-smell sweep sees a valid policy; a plan-adherence review sees "matches plan" — the risk only surfaces when you reason about change ORDERING.
**Rule:** When a change deliberately defers an authz tightening, record the ordering dependency: the consuming read/write surface must not ship before the tightening change. In review, after confirming "code = plan", ask whether the deliberate deferral creates a leak if the next change lands out of order.
**Applies to:** `plan`, `plan-review`, `impl-review`

## Don't harden a consumer that doesn't exist yet

**Context:** Planning/review of foundation changes (schema, shared modules) whose consumers (UI, workers, dashboard queries) aren't built yet. First seen: `submissions-data-model-hardening` (S-01/S-02/F-03 unbuilt).
**Problem:** Half the hardening plan optimized code that doesn't exist: 5 type guards with zero importers (#12), index decisions with no query written (#9/#14), and an auth shared-client refit for a bug that doesn't manifest in any current flow (#6) — the largest blast radius in the plan for zero realized benefit.
**Rule:** A finding that fixes a not-yet-written consumer is premature. Defer it until the consumer exists and its shape is known; write the guard/index/refit together with its first real caller so the shape stays honest.
**Applies to:** `plan`, `plan-review`, `implement`

## A composite index doesn't serve ORDER BY on its non-leading column

**Context:** Postgres schema/query work; judging whether an index is redundant. First seen: `submissions-data-model-hardening` #9. (Candidate for removal after the S-02/F-03 session if it proves a one-off.)
**Problem:** A finding claimed `idx ON (created_at DESC)` was redundant against the composite `idx ON (enrichment_status, created_at DESC)` because it "covers it as a prefix." False: the composite is ordered by `enrichment_status` first, so it cannot serve a bare `ORDER BY created_at DESC` without a full scan + sort. The single-column index was the only one serving the unfiltered time-range query.
**Rule:** A composite index provides ordering on column N only if every column before N is equality-constrained in the query. Never call a single-column index redundant against a composite unless the composite's leading column(s) are fixed by the query's WHERE.
**Applies to:** `plan`, `plan-review`, `implement`, `impl-review`

## A partial index is only used when the query WHERE matches its predicate syntactically

**Context:** Postgres schema/query work with partial indexes (`... WHERE col = 'x'`); writing Supabase queries against them. First seen: `submissions-data-model` `submissions_topic_done_idx` / `submissions_branch_done_idx` (#14).
**Problem:** Partial indexes `... WHERE enrichment_status = 'done'` are only used when the query's WHERE implies the index predicate. The planner does NOT normalize `IN ('done')` (single element) to `= 'done'` for partial-index predicate proof, so a Supabase `.in('enrichment_status', ['done'])` misses the index while `.eq('enrichment_status', 'done')` matches it.
**Rule:** When a query targets a partial index, make its WHERE syntactically match the index predicate. Use `.eq()` for a single-value match against a partial index, never `.in([...])`.
**Applies to:** `plan`, `plan-review`, `implement`, `impl-review`

## Don't re-assert Supabase baseline grants in a migration

**Context:** Writing Supabase migrations that touch role grants on `public` tables. First seen: `submissions-data-model` migration line 141 (#8).
**Problem:** The migration re-asserted `GRANT USAGE ON SCHEMA public TO anon, authenticated`, which Supabase already grants in every project's baseline — a no-op that adds cognitive load (a future reader must reason whether it's load-bearing, unlike the REVOKE on the same table, which genuinely is).
**Rule:** Don't repeat baseline grants in a migration. If you need to constrain a baseline privilege, REVOKE it explicitly and document why; otherwise omit it.
**Applies to:** `plan`, `plan-review`, `implement`, `impl-review`

## Reset a claimed row to its re-claimable state before re-enqueueing a retry

**Context:** Any plan or consumer that claims a row/job into an intermediate state (e.g. `pending → processing`) via a compare-and-swap before doing work, then relies on platform redelivery/retry (at-least-once queues, job runners). First seen: `ai-enrichment-queue` F-03 plan-review F1.
**Problem:** A transient failure that calls `message.retry()` while leaving the row in the claimed (`processing`) state means redelivery re-runs the CAS claim, which only matches `pending` (or stale-`processing`). If the row isn't stale yet, the claim matches zero rows and the handler acks-and-skips — silently dropping the retry and wedging the row in `processing` forever (never `done`, never `failed`, no error). The idempotency claim swallows the very retry it was meant to coordinate.
**Rule:** When a retry/redelivery path leaves a row in an intermediate claimed state, reset it to the re-claimable state (e.g. `processing → pending`, attempt-guarded) BEFORE re-enqueueing, so the next delivery re-claims cleanly. Keep stale-state reclaim as a crash-only backstop, never the normal retry mechanism — don't make the idempotency claim depend on a timing window between the retry backoff and the stale threshold.
**Applies to:** `plan`, `plan-review`, `implement`, `impl-review`

## Test a Cloudflare Queue consumer by enqueueing from inside the Worker, not a separate process

**Context:** Manually testing a Cloudflare Queues consumer locally under `wrangler dev` (Astro + `@astrojs/cloudflare` custom Worker entry with a `queue` handler). First seen: `ai-enrichment-queue` F-03, Phase 3 manual gates 3.6–3.10.
**Problem:** Local Queues are NOT shared across separate Miniflare instances. A harness that sends via its own `getPlatformProxy()` process (e.g. `scripts/enqueue-test.mjs`) writes to its own ephemeral queue and never reaches the consumer running in `wrangler dev` — the row stays `pending`, the consumer never fires, and you chase a phantom bug. (KV/D1/R2 DO share via `.wrangler/state`; queues do not.) Compounding trap: `wrangler dev` serves the built bundle and does not hot-reload a custom `worker.ts`, so source edits silently have no effect.
**Rule:** To exercise a local queue consumer, enqueue from INSIDE the same Worker instance (a temporary dev-only HTTP hook in `fetch`, e.g. `GET /__dev/enqueue?id=…`, reverted before commit) so producer and consumer share one Miniflare instance. After any change to `worker.ts` or consumer modules, run `npm run build` before `wrangler dev` — never trust hot-reload for the custom entry.
**Applies to:** `implement`, `impl-review`

## Gate a durable failure signal on the guarded write actually applying

**Context:** Queue/job consumers that (a) guard a terminal `failed` write on a per-claim / optimistic-concurrency token and (b) ALSO emit a separate durable failure signal (log event, outbox row) for a downstream alerter to consume. First seen: `ai-enrichment-queue` F-03 Phase 3 DLQ branch (`processDeadLetterMessage`).
**Problem:** The DLQ branch guards `markFailed` on the observed `enrichment_attempted_at` token, so a row re-claimed between `readStatus` and `markFailed` is correctly NOT clobbered — but `emitFailureSignal()` + `ack()` fire unconditionally afterward. A durable `enrichment_failed` event is emitted for a row another invocation may still be enriching successfully. Harmless while forensic-only; the moment S-03 (email) consumes it, it sends a false alert. The DB clobber is closed; the *signal* clobber is not.
**Rule:** When a terminal failure write is conditionally guarded, gate the durable failure signal on the same condition — emit it only when the write actually affected a row (return rows-affected and branch on it), or dedup the signal against the row's final state. Never emit an alert-grade signal on a path that may have written zero rows.
**Applies to:** `plan`, `implement`, `impl-review`

## A terminal queue + total-dependency outage drops messages silently — decouple the alert from the write

**Context:** At-least-once queue consumer whose dead-letter queue has no further DLQ and whose only durable failure record is a write to the same backing store the work depends on. First seen: `ai-enrichment-queue` F-03 (`dib-enrichment-dlq`, `max_retries:3`, no DLQ-of-its-own; both the `failed` write and the FR-018 signal need Supabase).
**Problem:** If the store is unreachable for the whole retry window, the main queue exhausts to the DLQ, the DLQ's `readStatus`/`markFailed` also throw, the DLQ message exhausts its own `max_retries` and is dropped (terminal). The row never reaches `failed`, no signal fires, and it's silently abandoned in an intermediate state — invisible exactly when an alert is most needed. No data loss, but no record either.
**Rule:** For a terminal queue whose failure record depends on the failing store, decouple the alert from the store write: emit the failure signal on a different transport even when the DB write fails. At minimum, document the "stuck in intermediate state under total outage → re-enqueue" recovery path.
**Applies to:** `plan`, `implement`, `impl-review`

## REVOKE ... FROM PUBLIC is a no-op against Supabase's default role grants — revoke the roles explicitly

**Context:** Supabase migrations that lock down a privilege (EXECUTE on a function, or table DML) on a `public` object, intending to restrict it to a subset of roles. First seen: `first-end-to-end-submission` S-01 Phase 1 (`is_allowed_admin()` SECURITY DEFINER function), surfaced by impl-review F1.
**Problem:** Supabase's baseline `ALTER DEFAULT PRIVILEGES` grants EXECUTE on new functions (and table privileges) DIRECTLY to `anon`, `authenticated`, and `service_role` — not via `PUBLIC`. So `REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC` removes a grant that isn't the one in effect: the direct role grants survive and `anon` can still call the function. The migration reads as locked-down but isn't — a live `SET LOCAL ROLE anon; SELECT fn()` returns a value instead of `permission denied`. (Same auto-grant the F-01 `create_submissions` header documents for tables, which is exactly why F-01 revokes the *table* `FROM anon, authenticated` explicitly.)
**Rule:** To restrict a privilege on a `public` object in a Supabase migration, REVOKE from the roles explicitly (`FROM PUBLIC, anon, authenticated`), then GRANT back only the role(s) that need it. Never rely on `REVOKE ... FROM PUBLIC` alone. Confirm with a `SET LOCAL ROLE <role>` probe — or inspect `proacl`/`relacl` — that the unwanted role actually lost access; don't trust the REVOKE statement's presence.
**Applies to:** `plan`, `implement`, `impl-review`

## Exercise a Workers `scheduled` handler locally through an in-worker fetch hook, not wrangler's test endpoint

**Context:** Local/manual verification of a `scheduled` (cron) handler under `wrangler dev` in a Worker that serves static assets (`assets` binding — this repo's shape). First seen: `sentry-observability` Phase 4.
**Problem:** With assets configured, the test endpoint `/cdn-cgi/handler/scheduled` dispatches to the assets ROUTER worker, which has no `scheduled` handler — the invocation rejects (`outcome: "exception"`) before ANY user code runs, with zero log output; legacy `/__scheduled` falls through to the app's 404 page. Both look exactly like "my handler/SDK is broken" (cost ~40 min of false diagnosis against the Sentry wrapper before a bisect proved even a bare un-wrapped handler never gets entered).
**Rule:** To exercise `scheduled` locally on an assets-enabled Worker, add a temporary dev-only route in `fetch` that calls the exported (wrapped) `scheduled` handler with a synthetic controller, and revert it before commit. Treat wrangler's scheduled test endpoint as unusable for this Worker shape. Sibling rule to "Test a Cloudflare Queue consumer by enqueueing from inside the Worker".
**Applies to:** `implement`, `impl-review`

## Preview deployments only exercise HTTP — queue consumers and crons run solely on the active deployment

**Context:** Writing verification/testing steps for Cloudflare Workers features driven by non-HTTP triggers (queue consumers, cron triggers) when deployment is via Workers Builds branch previews. First seen: `sentry-observability` Phase 4 plan.
**Problem:** The plan assumed all four runtime triggers (client, SSR, queue, scheduled) could be verified "on a preview deploy". Preview versions serve only HTTP: queues and crons dispatch exclusively to the active (production) deployment — and a message enqueued from a preview URL is consumed by the PRODUCTION worker running code without the preview's changes. The verification step was physically impossible as written and surfaced only mid-implementation.
**Rule:** When a plan says "verify on preview", scope that to HTTP paths only; verify queue/cron behavior under local `wrangler dev` (with in-worker hooks) or on the active deployment, and write that split into the plan up front.
**Applies to:** `plan`, `plan-review`

## Confirm the build completed and the bundle contains your edit before trusting a verification run

**Context:** Any local verify/debug loop where a rebuilt artifact feeds the next observation (`npm run build` → `wrangler dev` → trigger → conclude), especially on Windows where a lingering workerd process can hold `dist/` open. First seen: `sentry-observability` Phase 4 diagnosis.
**Problem:** `astro build` died on EPERM (a zombie workerd held `dist/`), the failure was invisible because build output was piped through a narrow grep, and `wrangler dev` silently served the STALE bundle — two diagnostic rounds produced confident conclusions about code that was never running.
**Rule:** After every rebuild in a verification loop, assert the build actually completed (exit code / the `Complete!` line) AND that the artifact contains the change (grep a marker string in the built bundle) before drawing any conclusion from the run.
**Applies to:** `implement`

## Audit PII on the event stored by the telemetry backend, not on the SDK config

**Context:** Any change wiring telemetry/error reporting (Sentry or similar) in a project with an anonymity / no-PII guarantee. First seen: `sentry-observability` Phase 4 PII audit.
**Problem:** `sendDefaultPii: false` plus a `beforeSend` deleting `event.user` looked airtight in code review, yet stored server events still carried a connection IP — the ingest layer infers and attaches it AFTER the SDK runs. SDK-side scrubbing cannot remove what the backend adds at ingest.
**Rule:** Verify the PII posture by inspecting events as STORED in the backend (request section, user/IP, geo, breadcrumb bodies), never by reading SDK options alone; for Sentry, pair SDK scrubbing with the project-level "Prevent Storing of IP Addresses" switch.
**Applies to:** `plan`, `impl-review`

## Stage phase commits selectively — a phase commit carries only its phase's files

**Context:** Phase commits of a tracked change (`/10x-implement` Progress SHAs feed `/10x-impl-review`'s git-scope detection). First seen: `sentry-observability` — b61896d (p2) carried unrelated `.claude/.10x-cli-manifest.json`; `@sentry/*` deps landed in d13beda ("chore: add Stryker...") while Progress gate 1.1 points at e6c1435.
**Problem:** impl-review derives its diff from the phase-commit range. A file committed outside the phase commits (deps swept into an earlier unrelated chore) vanishes from the review diff — package.json was absent from `e6c1435^..HEAD` and initially looked like a MISSING implementation; unrelated tool-state files swept in inflate the diff and read as scope creep. Content correct, audit trail misleading.
**Rule:** Stage selectively per change (`git add <paths>`, never `-A` with unrelated dirty state). In Progress, record the SHA of the commit that actually carries the change; if an artifact landed in an earlier/unrelated commit, name that SHA explicitly.
**Applies to:** `implement`, `impl-review`

## Scrub ingest-derived geo with a dataset-scoped panel rule — the IP switch alone doesn't remove it

**Context:** Telemetry/error-reporting wiring in a project with an anonymity / no-PII guarantee (Sentry here); especially client/browser events, where the connection IP at ingest belongs to the anonymous submitter. First seen: sentry-observability follow-up (2026-06-12).
**Problem:** Sentry ingest derives `user.geo` (country/city/region) from the connection IP BEFORE the "Prevent Storing of IP Addresses" switch discards the IP — geo persisted on client error events despite `sendDefaultPii: false`, a `beforeSend` deleting `event.user`, and the switch confirmed ON. The Phase-4 audit even recorded it ("only coarse ingest geo (city)") yet rated the event PASS. City-level geo of an anonymous submitter is a deanonymization vector.
**Rule:** Ingest-derived attributes need ingest-side scrubbing: pair SDK scrubbing and the IP switch with a panel Advanced Data Scrubbing rule [Remove] [Anything] from [$user.geo.**], scoped to the dataset that actually carries your events (Errors — a rule scoped to Logs scrubs nothing in an errors-only setup). The rule applies only forward; historical events keep their geo until retention expires. Sibling rule to "Audit PII on the event stored by the telemetry backend".
**Applies to:** `plan`, `impl-review`

## Smoke-test a cfContext.waitUntil route through the BUILT worker under wrangler dev, not astro dev

**Context:** Local/manual smoke of an Astro SSR route (this repo's `@astrojs/cloudflare` custom Worker) that defers work via `Astro.locals.cfContext.waitUntil(...)`. First seen: `new-submission-instant-notify` Phase 2 (instant-notify dispatch on the insert route).
**Problem:** `cfContext` is populated only on the adapter's workerd `handle()` path; `astro dev` (Vite dev server) doesn't run it — and `npm run dev` IS `astro dev` here — so the deferred-dispatch line is untested or throws there. `wrangler dev` serves the BUILT `dist/` bundle, not source, so a stale build silently smokes old code. Compounding trap: with the built config at `dist/server/wrangler.json`, wrangler resolves `.dev.vars` beside that config, so root-level secrets (`SUPABASE_*`, `RESEND_*`) don't load and the insert 500s — looking like a code bug.
**Rule:** To smoke a `cfContext.waitUntil` route, run `npm run build`, then `npx wrangler dev -c dist/server/wrangler.json` (NOT `astro dev`), and stage `.dev.vars` beside the built config (`cp .dev.vars dist/server/.dev.vars`; `dist/` is gitignored — remove after). Confirm the built bundle contains your edit (grep a marker string in `dist/`) before trusting the run. Sibling to the queue-consumer and `scheduled`-handler in-worker-hook lessons and "Confirm the build completed and the bundle contains your edit".
**Applies to:** `implement`, `impl-review`

## Push Supabase migrations to prod as part of deploy — a green app deploy doesn't mean the DB schema is current

**Context:** Hosted (online) Supabase whose schema lives in `supabase/migrations/`, deployed alongside an Astro/Cloudflare Worker app. First seen: `new-submission-instant-notify` go-live smoke (2026-06-18).
**Problem:** Prod Supabase sat two migrations behind the repo — `supabase_migrations.schema_migrations` had only `20260528`/`20260529`, while `20260605` (admin_allowlist + RLS gate) and `20260612` (dashboard aggregates RPC) were never pushed. The app deployed fine and inserts worked, so nothing looked broken, but the dashboard threw "nie udało się pobrać danych" (missing RPC/table) and — worse — the access-control RLS gate (risk #1) was dormant: `submissions` still ran the permissive `USING(true)` SELECT from migration #1. The gap was invisible until a real admin login hit the missing table.
**Rule:** Make `supabase db push` an explicit deploy step (CI after merge, or a documented manual gate). Verify `SELECT version FROM supabase_migrations.schema_migrations` equals the files in `supabase/migrations/` before trusting prod. A successful app/worker deploy never implies the DB schema — or its RLS policies — is current.
**Applies to:** `implement`, `impl-review`

## Verify a new Cloudflare cron on-demand via an HTTP hook, not a temporary short-interval cron

**Context:** Verifying a cron-triggered Worker path on the ACTIVE Cloudflare deployment on-demand (not waiting for the real schedule), in an Astro + `@astrojs/cloudflare` worker with multiple `triggers.crons`. First seen: `weekly-digest` (S-05) Phase 3, 2026-06-19.
**Problem:** To force the digest to fire "now", its cron was temporarily set to `* * * * *` (`DIGEST_CRON` + wrangler.jsonc in lockstep), built and deployed. Over a 12-minute window the new every-minute expression never fired — Observability logs showed only the pre-existing `*/15` sweep continuing on the same temp version. Cloudflare cron-trigger changes take minutes to propagate, so a newly-added/edited expression isn't live immediately even though `wrangler deploy` prints it under "schedule:"; the unchanged cron keeps firing and masks the gap. Cost: 2 extra prod deploys + an inconclusive verification.
**Rule:** To exercise a cron-triggered path on prod on-demand, add a temporary guarded HTTP route in `fetch` that invokes the exported `scheduled` handler with a synthetic controller (HTTP takes effect immediately on deploy), trigger it once, then revert. Never rely on temporarily shortening a cron interval to force a fire — a newly-added/edited expression needs propagation time and may not run in a short verification window. Sibling to the in-worker-hook lessons for queue consumers and the `scheduled` handler.
**Applies to:** `implement`, `impl-review`

## Cron/route triggers register ONLY on `wrangler deploy` — version-upload, dashboard promotion and secret-change never apply them

**Context:** Cloudflare Workers Builds (or any wrangler flow) where prod is reached via `wrangler versions upload` (non-prod branches) + dashboard version-promotion, or via secret changes — not exclusively a `wrangler deploy`. Astro `@astrojs/cloudflare` worker with `triggers.crons`. First seen: `weekly-digest` (S-05), 2026-06-22 — first real Monday digest firing silently didn't happen.
**Problem:** The `0 7 * * 1` digest cron was in source, in the built `dist/server/wrangler.json`, AND shown in the dashboard "Triggers" tab, and the digest CODE was live on the active version — yet it NEVER fired. Observability at the 07:00 tick showed only the `*/15` sweep invocation; zero `0 7 * * 1` invocations ever (also during the Phase-3 `* * * * *` test). Cron/route triggers are SCRIPT-level settings applied ONLY by `wrangler deploy`. `wrangler versions upload`, promoting a version in the dashboard, and secret-change redeploys all create/activate a version WITHOUT touching the schedule registry — so a newly-added cron silently never registers, while an older cron (`*/15`, from an earlier full `wrangler deploy`) persists. The dashboard "Triggers" view reflects the deployed CONFIG, not the scheduler registry, so it misleadingly shows both. This SUPERSEDES the earlier "cron propagation delay" read (lesson above): the digest cron wasn't slow to propagate — it was never registered. Compounded by `sendWeeklyDigest`'s catch-all (no re-throw): "no mail + no Sentry error" was a non-signal, since that path can't reach Sentry at all.
**Rule:** Verify a cron/route is LIVE by a runtime logged invocation (the job's own log line in Observability), NEVER by the dashboard Triggers display or the built config — they show declared config, not the scheduler registry. Triggers apply only via `wrangler deploy`; after any `versions upload` / dashboard promotion / secret change, run `wrangler triggers deploy -c dist/server/wrangler.json` (or land the change through a clean main-branch `wrangler deploy`). Once applied they persist at script level across later version-uploads/secret-changes. The cron↔router lockstep unit test guards SOURCE drift only; it cannot catch a deploy-time registration gap — that is an ops check.
**Applies to:** `plan`, `implement`, `impl-review`
