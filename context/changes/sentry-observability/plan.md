# Sentry Error Monitoring (Astro + Cloudflare Workers) Implementation Plan

## Overview

Wire Sentry **error monitoring** (errors-only, no performance tracing) across the three runtimes of the Digital Idea Box app:

1. **Browser client** — React islands + Astro pages, via `@sentry/astro` (client SDK injection + build-time source-map upload).
2. **SSR server (HTTP `fetch`)** — runs in workerd, via `@sentry/cloudflare`.
3. **Queue consumer + `scheduled` cron** — the custom `src/worker.ts` `ExportedHandler`, via the same `@sentry/cloudflare` `withSentry()` wrapper.

The dominant constraint is **anonymity**: this is anonymous employee feedback. Submission `content`, `signature`, and any OpenAI error body (which on a 4xx echoes a slice of submission content) must **never** reach Sentry. Scrubbing is **deny-by-default**. The server DSN lives as a Cloudflare Workers Secret; the (inherently public) client DSN is injected at build as `PUBLIC_SENTRY_DSN`. Source maps are uploaded by the Cloudflare Workers Builds build step, with `release` pinned to the commit SHA so client, worker, and uploaded maps all agree.

## Current State Analysis

- **Deploy model:** Cloudflare **Workers with Static Assets** (`wrangler.jsonc` → `main: "src/worker.ts"`, `assets` binding, `queues.consumers`, `triggers.crons`). *Not* Pages, despite the tech-stack hint. Deployment is via **Cloudflare Workers Builds (Git integration)** — `.github/workflows/ci.yml` has **no deploy step** (lint/test/typecheck/build only).
- **Custom worker entry** (`src/worker.ts:31`): a single `ExportedHandler` exporting `fetch` (delegates to `@astrojs/cloudflare/handler`'s `handle`), `queue` (routes main vs DLQ), and `scheduled` (recovery sweep). This is the wrap target for `@sentry/cloudflare`.
- **`nodejs_compat` already enabled** (`wrangler.jsonc:6`) — a hard prerequisite for `@sentry/cloudflare` (AsyncLocalStorage). ✓ No compatibility-flag change needed.
- **Env schema** is declared in two places: `astro.config.mjs` `env.schema` (for `astro:env` server secrets) and the global `Env` interface in `src/worker-env.d.ts` (for the Worker runtime). Both must learn `SENTRY_DSN`.
- **Existing PII discipline (the precedent to extend):**
  - `src/lib/enrichment/log.ts` — explicit guard: never pass `err.message`/`content`/`signature` to logs; log only `errorKind` + `errorStatus` (+ ids).
  - `src/lib/enrichment/consumer.ts:226` `redactError()` — converts an `EnrichmentError` into a body-free descriptor (`Enrichment <kind> error (HTTP <status>)`) precisely because `EnrichmentError.message` can carry ~500 chars of OpenAI body.
  - `src/pages/api/submissions.ts:19` — the public endpoint logs id-less, body-less, header-less events (stricter than the enrichment path, which does log `submissionId`).
- **No existing Sentry wiring** anywhere in source.
- **Tests:** `vitest run` (node pool) + `vitest run --config vitest.workers.config.ts` (workers pool). `withSentry()` changes the *shape* of `worker.ts`'s default export — the workers-pool tests and any importer of the default export must still pass.

### Key Discoveries:

- Sentry ships a dedicated **"Astro + Cloudflare"** guide: install **both** `@sentry/astro` and `@sentry/cloudflare`. The Astro integration auto-detects the Cloudflare adapter and *can* auto-wrap the server — but that targets the adapter's *default* entry. We have a custom `worker.ts`, so we wrap **explicitly** with `Sentry.withSentry((env) => options, handler)` and must ensure the Astro integration does **not** also wrap the server (double-init risk — see Critical Implementation Details).
- On Cloudflare Workers, **server config comes from environment variables, not `sentry.server.config.ts`** (that file is Node-only and ignored on workerd) — per Sentry docs. So server options are built in `worker.ts` from `env`.
- `withSentry()` wraps the **whole `ExportedHandler`** — `fetch`, `queue`, and `scheduled` are all instrumented for unhandled-exception capture by a single wrap.
- `release` must match across the build-time source-map upload, the client SDK, and the worker SDK, or stack frames won't symbolicate. Cloudflare Workers Builds exposes the commit SHA as `WORKERS_CI_COMMIT_SHA` at build time.

## Desired End State

- An unhandled error in any of the three runtimes appears in one Sentry project, tagged by environment (`production` / `preview`) and runtime, with a **symbolicated** stack trace (source maps resolved) and the correct `release`.
- **Zero PII** in any captured event: no request body, headers, cookies, query string; no submission `content`/`signature`; no OpenAI error body. Verified by inspecting real captured events.
- Session Replay is **off**. Performance tracing is **off** (`tracesSampleRate: 0`).
- Locally (`astro dev` / `wrangler dev`) the SDK is inert (no DSN → no-op), so dev noise never reaches Sentry.
- All existing automated suites (vitest node + workers, typecheck, lint, build) remain green.

**Verification of end state:** temporary dev-only error triggers in each runtime, deployed to a preview Worker, produce four distinct, PII-free, symbolicated events in Sentry at the preview release; triggers reverted before merge.

## What We're NOT Doing

- **No performance tracing / spans / profiling** (`tracesSampleRate: 0`). Errors-only MVP.
- **No Session Replay** (anonymity).
- **No `enableLogs` / Sentry Logs product** — the existing `console`→Workers Observability log transport stays the structured-log channel.
- **No alerting/notification wiring** (Slack/email/PagerDuty) — out of scope; Sentry's own default issue alerts are enough for MVP.
- **No tunnel/proxy for the client DSN** — the DSN ships publicly in the bundle by design (write-only ingest key).
- **No GitHub Actions deploy job** — deployment stays on Cloudflare Workers Builds.
- **No second Sentry project** — one project, one DSN, split by environment + runtime tags.
- **No rewrite of the existing structured logging** — Sentry sits alongside it.
- **No AI-Gateway / OpenAI request instrumentation.**

## Implementation Approach

`@sentry/astro` owns the **client** (auto-injected `sentry.client.config.ts`) and the **build-time source-map upload**; it is configured **client-only** (server auto-instrumentation disabled) so it never collides with the explicit Worker wrap. `@sentry/cloudflare`'s `withSentry()` owns **all server runtimes** by wrapping the `worker.ts` default export once. A single shared options-builder feeds the worker wrap so `fetch`/`queue`/`scheduled` share identical DSN/environment/release/scrubbing config. PII safety has two layers: (1) a global `beforeSend`/`beforeBreadcrumb` that strips request data and breadcrumb bodies by default, and (2) explicit, redacted capture at the two terminal enrichment-failure points — never passing a raw `EnrichmentError` to Sentry.

## Critical Implementation Details

- **PII chokepoint (load-bearing).** `Sentry.captureException(err)` sends `err.message`. `EnrichmentError.message` can carry OpenAI 4xx body content (= submission text). Therefore: (a) at explicit capture points, **never** pass the raw `EnrichmentError` — capture a synthetic error built from `redactError(err)` (reuse the existing helper) plus `errorKind`/`errorStatus`/`submissionId` tags; (b) the global `beforeSend` strips `event.request` (URL query, body, headers, cookies) and `event.user` unconditionally, as defense-in-depth for any unhandled throw. The submission endpoint's stricter discipline (no id) is preserved: its capture points attach **no** `submissionId`.
- **Capture seam, not a direct SDK import (architectural).** `consumer.ts` and `submissions.ts` are pure-logic modules unit-tested in the **node** pool (no workerd). They must NOT import `@sentry/cloudflare` directly (breaks the `ConsumerContext` DI seam and risks node-pool test failure). The SDK import lives only in `worker.ts` + `sentry-server-options.ts`; the capture function is **injected** (via `ConsumerContext.captureError` / a guarded helper) and no-ops in tests.
- **`release` consistency across three producers.** The source-map upload (in `astro build`), the client `Sentry.init`, and the worker `withSentry` options must use the **same** `release` string = the commit SHA. Inject it once at build (e.g. a Vite `define`/`astro:env` value sourced from `WORKERS_CI_COMMIT_SHA`) and reference that single constant in all three. A mismatch silently breaks symbolication even though events still arrive. **Verify the exact Cloudflare Workers Builds variable name against current CF docs in Phase 1** (it is the linchpin of symbolication), and **log the resolved release at build time** so a wrong/empty value is loud at build instead of silently surfacing only at gate 4.8.
- **Double-init risk.** If `@sentry/astro`'s Cloudflare auto-wrap instruments the adapter's `handle` *in addition* to our explicit `withSentry`, two `Sentry.init`s run per request. Configure the Astro integration to **not** instrument the server (client + source-maps only), and verify exactly one init per runtime (Phase 4 gate).
- **`scheduled` already re-throws** (`worker.ts:77`) — so `withSentry` auto-captures recovery-sweep failures with no code change there. The `queue` consumer, by contrast, **catches** its errors (`consumer.ts`), so those need the explicit redacted captures from Phase 2 to surface.

---

## Phase 1: Dependencies, env schema & secret wiring

### Overview

Add the two SDK packages and teach every config surface about the new env names — without activating any Sentry behavior yet. Produce the external-setup runbook (Sentry project, secrets, Cloudflare build env).

### Changes Required:

#### 1. SDK dependencies

**File**: `package.json`

**Intent**: Add `@sentry/astro` and `@sentry/cloudflare` as dependencies (matching versions, latest stable compatible with Astro 6).

**Contract**: Two new entries under `dependencies`. Verify they resolve and `npm ci` is reproducible (lockfile updated).

#### 2. Server env schema (`astro:env`)

**File**: `astro.config.mjs`

**Intent**: Declare `SENTRY_DSN` as a server secret in `env.schema` alongside the existing Supabase/OpenAI secrets, so server code can read it through the typed `astro:env` surface and the runtime knows it's optional (absent locally → SDK inert).

**Contract**: New `envField.string({ context: "server", access: "secret", optional: true })` entry for `SENTRY_DSN`. (Client `PUBLIC_SENTRY_DSN` is consumed via `import.meta.env`/`PUBLIC_` convention, not a server secret field.)

#### 3. Worker runtime `Env` interface

**File**: `src/worker-env.d.ts`

**Intent**: Add `SENTRY_DSN` (and the release/environment values if delivered via env rather than build-time define — see Phase 3) to the global `Env` interface so `withSentry((env) => …)` is typed.

**Contract**: New `SENTRY_DSN: string` member on `interface Env`. Keep the hand-typed-bindings convention noted in the file header.

#### 4. Secret-name registry

**File**: `.env.example`

**Intent**: Append the new secret names so the repo documents them (names only, never values).

**Contract**: Add `SENTRY_DSN=###` and `PUBLIC_SENTRY_DSN=###` lines.

#### 5. External-setup runbook

**File**: `context/changes/sentry-observability/setup.md` (new)

**Intent**: Document the manual, panel-side steps the implementer cannot script: create the Sentry project; `wrangler secret put SENTRY_DSN`; set Cloudflare Workers Builds **build-environment** variables (`SENTRY_AUTH_TOKEN` as a build secret, `SENTRY_ORG`, `SENTRY_PROJECT`, `PUBLIC_SENTRY_DSN`); note that `WORKERS_CI_COMMIT_SHA` is provided automatically. **Explicitly scope all of these to BOTH production and preview (non-production branch) builds/deploys** — the gating decision is "prod + preview", so Phase 4's preview verification depends on the runtime secret and all four build-env vars being present on preview builds, not production-only. Note that the runtime `SENTRY_DSN` secret must reach whatever Worker the preview branch deploys to.

**Contract**: Markdown checklist; pure documentation, no code.

### Success Criteria:

#### Automated Verification:

- Dependencies install cleanly: `npm ci`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- Sentry project created; `SENTRY_DSN` set as a Workers Secret (`wrangler secret list` shows it).
- Cloudflare Workers Builds build-env vars set (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `PUBLIC_SENTRY_DSN`).

**Implementation Note**: After automated verification passes, pause for manual confirmation that the Sentry project + secrets + build-env are configured before proceeding.

---

## Phase 2: Server/Worker instrumentation + PII scrubbing

### Overview

Wrap the `worker.ts` default export with `@sentry/cloudflare`'s `withSentry`, covering `fetch` + `queue` + `scheduled`. Build the shared, deny-by-default options (including PII scrubbing) once, and add explicit redacted captures at the two terminal enrichment-failure points the consumer currently swallows.

### Changes Required:

#### 1. Shared server Sentry options

**File**: `src/lib/observability/sentry-server-options.ts` (new)

**Intent**: A single builder returning the `@sentry/cloudflare` options from `env` — so all worker handlers share identical config and the PII rules live in one place. This module (and only this module + `worker.ts`) imports `@sentry/cloudflare`; the pure-logic enrichment/submission modules stay SDK-free (see change #3/#4 + the capture-seam decision in Critical Implementation Details).

**Contract**: Exports a function `(env: Env) => CloudflareOptions` producing: `dsn: env.SENTRY_DSN`, `environment` (from build-injected value), `release` (the shared SHA constant), `tracesSampleRate: 0`, `sendDefaultPii: false`, `beforeSend` (delete `event.request`, `event.user`; redact any `EnrichmentError`-shaped exception value as defense-in-depth), `beforeBreadcrumb` (drop `fetch`/`xhr` breadcrumb request/response bodies). When `dsn` is falsy the SDK no-ops (local dev). Also exports a small factory that returns the Sentry-backed **capture-seam** function injected into the consumer/submission paths (a body-free `captureException(new Error(descriptor), { tags })`). No snippet — follows the documented `withSentry` options shape.

#### 2. Wrap the worker handler

**File**: `src/worker.ts`

**Intent**: Wrap the existing `export default { fetch, queue, scheduled }` in `Sentry.withSentry(buildOptions, handler)` so unhandled errors in every handler are captured. Preserve the existing handler bodies verbatim. Additionally, wire the Sentry-backed **capture seam** (from change #1) into the `consumerCtx` built in the `queue` handler (`worker.ts:35`) so the consumer's swallowed terminal failures reach Sentry without `consumer.ts` importing the SDK.

**Contract**: `export default Sentry.withSentry((env) => buildServerSentryOptions(env), { fetch, queue, scheduled } satisfies ExportedHandler<Env, EnrichmentMessage>)`. The wrapped value must still satisfy `ExportedHandler<Env, EnrichmentMessage>` and not break the existing workers-pool tests / default-export importers (note: `_callback.workers.test.ts` drives the BUILT, wrapped default export via `SELF.fetch`, so gate 2.1 genuinely exercises the wrap — confirm Set-Cookie/redirect contract still passes). `consumerCtx` gains the injected `captureError` field.

#### 3. Explicit redacted captures at terminal enrichment failures

**File**: `src/lib/enrichment/consumer.ts`

**Intent**: The consumer catches its errors, so `withSentry` won't auto-capture them. Surface the **two terminal failure points** — the permanent-error branch (`consumer.ts:134`, alongside `emitFailureSignal`) and the DLQ retry-exhausted branch (`consumer.ts:192`) — through an **injected capture seam**, NOT a direct `@sentry/cloudflare` import. This keeps `consumer.ts` runtime-agnostic and node-pool-testable (matching the existing `store`/`enrichFn` injection on `ConsumerContext`, consumer.ts:70-77) and avoids breaking `consumer.test.ts`.

**Contract**: Add an optional `captureError?: (descriptor: string, tags: { errorKind?; errorStatus?; submissionId; errorType }) => void` to `ConsumerContext`. The two terminal branches call `ctx.captureError?.(redactError(err)|<DLQ descriptor>, { … })` with the same PII-safe fields already logged — **never** the raw `err`/`EnrichmentError`. `worker.ts` injects the Sentry-backed impl (change #2); tests omit it → no-op, asserting nothing new. Gate the call on the same condition as the durable signal (lessons.md: "gate a durable failure signal on the guarded write actually applying"). Transient retry paths are **not** captured (expected, self-heal).

#### 4. Submission-endpoint hard-failure capture

**File**: `src/pages/api/submissions.ts`

**Intent**: Capture the hard insert failure (`submission_insert_failed`, the 500 path at `submissions.ts:54`) so a broken write surface is visible. Match this file's stricter discipline AND keep it SDK-free for the node pool (`_submissions.test.ts`) — capture through the same injected/guarded seam, not a direct `@sentry/cloudflare` import.

**Contract**: Route a static, body-free event with a `reason` tag only — **no** `submissionId`, no body, no headers (preserving the endpoint's id-less anonymity-forensic posture) — through the injected capture helper (the route already imports `env` via `@/lib/runtime-env`; resolve the seam there or via a thin guarded wrapper that no-ops without a Sentry client). The fire-and-forget enqueue failure stays log-only (already recoverable by the sweep) unless trivially included as a low-severity event.

### Success Criteria:

#### Automated Verification:

- Workers-pool tests pass (default-export shape intact): `npm run test:workers:run`
- Node tests pass: `npm test`
- Type checking passes: `npm run typecheck`
- Build passes: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- `wrangler dev` boots with no `SENTRY_DSN` and the SDK is inert (no init errors, normal request/queue behavior).
- Code review confirms no raw `EnrichmentError` reaches any `captureException`; `beforeSend` strips `request`/`user`.

**Implementation Note**: After automated verification passes, pause for manual confirmation before proceeding to the client + source-map phase.

---

## Phase 3: Client instrumentation + Astro integration + source maps

### Overview

Register `@sentry/astro` (client-only + source-map upload), add the client config with scrubbing and no Replay, and pin `release` to the commit SHA consistently across client, worker, and the source-map upload.

### Changes Required:

#### 1. Astro Sentry integration (client + source maps, no server wrap)

**File**: `astro.config.mjs`

**Intent**: Add `sentry()` to `integrations` configured for client SDK injection and build-time source-map upload, with server auto-instrumentation **disabled** (the Worker is wrapped explicitly in Phase 2).

**Contract**: `sentry({ org, project, authToken: <build env>, sourceMapsUploadOptions: { enabled, release: { name: <SHA> } }, … })` with the option that disables server-side instrumentation set. `org`/`project`/`authToken` read from `process.env` (Cloudflare build env). Confirm against the installed `@sentry/astro` version's exact option names (the "disable server" knob and `sourceMapsUploadOptions` shape) — this is the integration's current-API touchpoint.

#### 2. Client SDK config

**File**: `sentry.client.config.ts` (new, project root — the path `@sentry/astro` expects)

**Intent**: Initialize the browser SDK: DSN from `PUBLIC_SENTRY_DSN`, environment + release, errors-only, no Replay, with the same deny-by-default scrubbing as the server.

**Contract**: `Sentry.init({ dsn: import.meta.env.PUBLIC_SENTRY_DSN, environment, release, tracesSampleRate: 0, integrations: [] (no Replay), beforeSend (strip request-shaped data), beforeBreadcrumb (drop fetch/xhr bodies — protects the `/api/submissions` POST body) })`. Falsy DSN → no-op (local).

#### 3. Release / environment injection

**File**: `astro.config.mjs` (Vite `define` or `astro:env`), consumed by `worker.ts` options + `sentry.client.config.ts`

**Intent**: Source the commit SHA (`WORKERS_CI_COMMIT_SHA`) and environment (`production`/`preview`) once at build and expose a single constant all three producers read, guaranteeing `release` agreement.

**Contract**: A build-time define (e.g. `import.meta.env.PUBLIC_SENTRY_RELEASE` / `import.meta.env.PUBLIC_SENTRY_ENVIRONMENT`) replaced with literals at build. Phase 2's options builder and Phase 3's client config both read it. Document the fallback when the var is absent (local → `undefined` → SDK still no-ops via missing DSN).

#### 4. Ignore local source maps / build artifacts if needed

**File**: `.gitignore` (only if the build now emits committed-by-accident artifacts)

**Intent**: Ensure generated `.map` files aren't committed.

**Contract**: Append patterns only if a gap exists; otherwise omit this change.

### Success Criteria:

#### Automated Verification:

- Build emits source maps and the build log shows the Sentry upload step (with a token present): `npm run build`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Both test suites pass: `npm test` and `npm run test:workers:run`

#### Manual Verification:

- A production/preview build on Cloudflare Workers Builds uploads source maps to Sentry (release artifacts visible in the Sentry release).
- View source shows the client SDK loaded with `PUBLIC_SENTRY_DSN`; no Replay bundle present.

**Implementation Note**: After automated verification passes, pause for manual confirmation that source maps uploaded for a real build before the verification phase.

---

## Phase 4: End-to-end verification, PII audit & cleanup

### Overview

Prove the wiring works in all three runtimes against a live preview, audit captured events for PII and symbolication, confirm suites are green, and revert the temporary triggers.

### Changes Required:

#### 1. Temporary per-runtime error triggers (dev-only, reverted before merge)

**File**: temporary edits — a client trigger (e.g. a hidden dev-only control or query-gated throw), an SSR/`fetch` trigger (a dev-only route or query param), a `queue` trigger, a `scheduled` trigger.

**Intent**: Force one controlled, **non-PII** error in each runtime so we can confirm capture, release, symbolication, and scrubbing end-to-end.

**Contract**: Each trigger throws a static `new Error("sentry-verify-<runtime>")` gated behind a dev/preview-only condition. All four are reverted before merge (tracked as an explicit checklist item).

#### 2. PII-audit checklist

**File**: `context/changes/sentry-observability/setup.md` (append) or a short verification note

**Intent**: Record what was inspected (event payloads for `request`, `user`, breadcrumb bodies, exception values) and the result.

**Contract**: A short pass/fail audit table; documentation only.

### Success Criteria:

#### Automated Verification:

- Full node suite passes: `npm test`
- Full workers suite passes: `npm run test:workers:run`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Build passes: `npm run build`
- Temporary triggers fully reverted: `git grep -n "sentry-verify"` returns nothing.

#### Manual Verification:

- Four events (client, SSR `fetch`, `queue`, `scheduled`) appear in Sentry at the **preview** environment with the correct `release`. (Depends on Phase 1's preview-scoped secret + build-env — if events/maps are absent on preview, check that scoping first.)
- Stack traces are **symbolicated** (original TS frames, not minified) — proves source-map upload + release match.
- **Zero PII** in every event: no request body/headers/cookies/query, no `submissionId` on the submission-endpoint event, no OpenAI body in any enrichment event, no `user`/IP.
- Session Replay confirmed **absent**; exactly one `Sentry.init` per runtime (no double-init).
- Local `astro dev` / `wrangler dev` produce **no** Sentry events (SDK inert without DSN).

**Implementation Note**: This is the final phase; after all gates pass and triggers are reverted, the change is ready for `/10x-impl-review` and merge.

---

## Testing Strategy

### Unit / existing suites:

- The node pool (`npm test`) and workers pool (`npm run test:workers:run`) must stay green at every phase. The highest-risk regression is Phase 2's change to `worker.ts`'s default-export shape — run the workers suite immediately after wrapping.
- No new unit tests are required for SDK wiring (it's configuration); the consumer-capture change should not alter existing consumer test assertions (captures are side-effects on a swallowed path). If a consumer test asserts on emitted signals, confirm the added capture doesn't change those assertions.

### Integration / manual:

- Phase 4's four-runtime trigger pass is the integration test (against a live preview Worker).

### Manual Testing Steps:

1. Deploy a preview build (push a PR branch → Cloudflare Workers Builds preview).
2. Trigger the client error → confirm a symbolicated, PII-free event at `preview` release in Sentry.
3. Trigger the SSR `fetch` error → confirm event.
4. Enqueue a message that forces the consumer's permanent-failure path (dev-only trigger) → confirm a **redacted** event (no OpenAI body).
5. Trigger the `scheduled` sweep failure → confirm event.
6. Inspect each event's payload for PII; record in the audit table.
7. Revert all triggers; confirm `git grep "sentry-verify"` is clean; re-run full suites.

## Performance Considerations

Errors-only (`tracesSampleRate: 0`) means negligible runtime overhead — the SDK only does work on the error path. `withSentry` adds a thin wrapper around each handler invocation; no per-request span allocation. No impact on the sub-second submission NFR (no awaited Sentry calls on the hot path; capture is fire-and-forget within the SDK).

## Migration Notes

No data migration. Rollout is additive and reversible: a bad Sentry config can be neutralized by clearing `SENTRY_DSN` (SDK no-ops) without a redeploy of logic, and `wrangler rollback` reverts the deploy in seconds (per `infrastructure.md`).

## References

- Change identity: `context/changes/sentry-observability/change.md`
- Tech stack & deploy model: `context/foundation/tech-stack.md`, `context/foundation/infrastructure.md`
- PII precedent: `src/lib/enrichment/log.ts`, `src/lib/enrichment/consumer.ts:226` (`redactError`), `src/pages/api/submissions.ts:19`
- Relevant lessons: `context/foundation/lessons.md` — "Gate a durable failure signal on the guarded write actually applying"
- Sentry docs: "Astro + Cloudflare" guide; `@sentry/cloudflare` `withSentry`; Astro source-map upload + release.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Dependencies, env schema & secret wiring

#### Automated

- [x] 1.1 Dependencies install cleanly: `npm ci` — e6c1435
- [x] 1.2 Type checking passes: `npm run typecheck` — e6c1435
- [x] 1.3 Linting passes: `npm run lint` — e6c1435
- [x] 1.4 Build passes: `npm run build` — e6c1435

#### Manual

- [x] 1.5 Sentry project created; `SENTRY_DSN` set as a Workers Secret — e6c1435
- [x] 1.6 Cloudflare Workers Builds build-env vars set (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `PUBLIC_SENTRY_DSN`) — e6c1435

### Phase 2: Server/Worker instrumentation + PII scrubbing

#### Automated

- [x] 2.1 Workers-pool tests pass (default-export shape intact): `npm run test:workers:run` — b61896d
- [x] 2.2 Node tests pass: `npm test` — b61896d
- [x] 2.3 Type checking passes: `npm run typecheck` — b61896d
- [x] 2.4 Build passes: `npm run build` — b61896d
- [x] 2.5 Linting passes: `npm run lint` — b61896d

#### Manual

- [x] 2.6 `wrangler dev` boots with no `SENTRY_DSN` and the SDK is inert — b61896d
- [x] 2.7 Review confirms no raw `EnrichmentError` reaches `captureException`; `beforeSend` strips `request`/`user` — b61896d

### Phase 3: Client instrumentation + Astro integration + source maps

#### Automated

- [x] 3.1 Build emits source maps and shows the Sentry upload step: `npm run build` — 2f85496
- [x] 3.2 Type checking passes: `npm run typecheck` — 2f85496
- [x] 3.3 Linting passes: `npm run lint` — 2f85496
- [x] 3.4 Node tests pass: `npm test` — 2f85496
- [x] 3.5 Workers tests pass: `npm run test:workers:run` — 2f85496

#### Manual

- [x] 3.6 A Cloudflare Workers Builds build uploads source maps (release artifacts visible in Sentry) — 2f85496
- [x] 3.7 View source shows client SDK with `PUBLIC_SENTRY_DSN`; no Replay bundle — 2f85496

### Phase 4: End-to-end verification, PII audit & cleanup

#### Automated

- [x] 4.1 Full node suite passes: `npm test`
- [x] 4.2 Full workers suite passes: `npm run test:workers:run`
- [x] 4.3 Type checking passes: `npm run typecheck`
- [x] 4.4 Linting passes: `npm run lint`
- [x] 4.5 Build passes: `npm run build`
- [x] 4.6 Temporary triggers fully reverted: `git grep -n "sentry-verify"` returns nothing

#### Manual

- [x] 4.7 Four events (client / SSR / queue / scheduled) in Sentry at `preview` with correct `release`
- [x] 4.8 Stack traces symbolicated (source maps + release match)
- [x] 4.9 Zero PII in every event (no request data, no `submissionId` on submission event, no OpenAI body, no user/IP)
- [x] 4.10 Session Replay absent; exactly one `Sentry.init` per runtime
- [x] 4.11 Local `astro dev` / `wrangler dev` produce no Sentry events
