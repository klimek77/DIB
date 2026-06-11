# Sentry Error Monitoring (Astro + Cloudflare Workers) — Plan Brief

> Full plan: `context/changes/sentry-observability/plan.md`

## What & Why

Wire Sentry **error monitoring** (errors-only — no tracing) across the app's three runtimes — browser client, SSR `fetch`, and the `queue`+`scheduled` worker — so unhandled errors surface in one place with symbolicated stacks. The hard constraint is **anonymity**: this is anonymous employee feedback, so submission content, signatures, and OpenAI error bodies must never reach Sentry. The integration is built deny-by-default to protect that guarantee.

## Starting Point

The app deploys as **Cloudflare Workers with Static Assets** (custom `src/worker.ts` with `fetch`/`queue`/`scheduled`; not Pages), shipped via **Cloudflare Workers Builds** Git integration (CI has no deploy step). `nodejs_compat` is already on (a `@sentry/cloudflare` prerequisite). There is no existing Sentry wiring, but the codebase already has a strong PII discipline to extend (`log.ts`, `consumer.ts` `redactError()`, the id-less submission endpoint).

## Desired End State

An error in any runtime appears in one Sentry project — tagged by environment (production/preview) and runtime, with a symbolicated stack and the correct release — and contains **zero PII**. Replay and tracing are off. Locally the SDK is inert (no DSN → no-op). All existing suites stay green.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Runtimes instrumented | client + `fetch` + `queue` + `scheduled` | One `withSentry` wrap covers the whole worker; no blind spots on the silent async paths | Plan |
| Monitoring depth | Errors-only (`tracesSampleRate: 0`) | Matches the task; smallest PII surface and cost for MVP | Plan |
| Session Replay | Off | Replay would record the feedback textarea — direct anonymity breach | Plan |
| Deploy / source-map upload | Cloudflare Workers Builds build step | That's how prod is built today; `SENTRY_AUTH_TOKEN` lives in CF build-env | Plan |
| Sentry projects | One project, one DSN | Simplest; environment + runtime tags split the views | Plan |
| Client DSN delivery | `PUBLIC_SENTRY_DSN` at build | Client DSN is inherently public (write-only ingest key); server DSN stays a Workers Secret | Plan |
| Env gating + release | prod + preview, `release` = commit SHA, local inert | Catches PR errors pre-merge; SHA spans maps↔client↔worker for symbolication | Plan |
| PII scrubbing posture | Deny-by-default | A single leak breaks anonymity; everything sensitive is stripped unless proven safe | Plan |
| Breadcrumbs | Limit (drop fetch/xhr bodies; keep console) | Console logs are already id-less/body-less; only the fetch/xhr vector needs blocking | Plan |
| Verification | Temp trigger per runtime + dashboard + green suites | Proves all 3 runtimes + source maps + no-leak end-to-end | Plan |

## Scope

**In scope:** `@sentry/astro` (client + source-map upload), `@sentry/cloudflare` `withSentry` on `worker.ts`, deny-by-default PII scrubbing, explicit redacted captures at terminal enrichment failures, secret/env wiring, release pinning, e2e verification.

**Out of scope:** performance tracing, Session Replay, Sentry Logs, alerting integrations, a GitHub Actions deploy job, a second Sentry project, a client DSN tunnel, rewriting existing structured logging.

## Architecture / Approach

`@sentry/astro` handles the **client** (auto-injected `sentry.client.config.ts`) and **build-time source-map upload**, configured client-only so it never collides with the worker wrap. `@sentry/cloudflare`'s `withSentry((env) => options, handler)` wraps the `worker.ts` default export **once**, instrumenting `fetch`+`queue`+`scheduled` from a single shared options-builder. PII safety is two-layer: a global `beforeSend`/`beforeBreadcrumb` strips request data and breadcrumb bodies, and the consumer's two terminal-failure points capture a **synthetic redacted** error (never the raw `EnrichmentError`, whose message can echo submission content). `release` = `WORKERS_CI_COMMIT_SHA`, injected once at build and read by all three producers.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Deps, env & secrets | Packages + `SENTRY_DSN`/`PUBLIC_SENTRY_DSN` in all config surfaces + setup runbook | Build-env vars not set on Cloudflare → silent no-upload later |
| 2. Server/Worker + PII | `withSentry` on worker.ts + scrubbing + redacted terminal captures | `withSentry` changes default-export shape → workers-pool tests; raw `EnrichmentError` leaking via capture |
| 3. Client + source maps | `sentry()` integration (client-only) + client config + release pinning | `@sentry/astro` double-wrapping the server; release mismatch breaking symbolication |
| 4. Verify + audit + cleanup | 4-runtime preview trigger pass, PII audit, triggers reverted | A captured event carrying PII; forgetting to revert a trigger |

**Prerequisites:** A Sentry account/project; Cloudflare Workers Builds connected; `wrangler` secret + build-env access. `nodejs_compat` already satisfied.
**Estimated effort:** ~3–4 short sessions (one per phase); Phase 4 needs a live preview deploy.

## Open Risks & Assumptions

- **Custom-entry double-init:** `@sentry/astro`'s Cloudflare auto-wrap may also instrument the adapter `handle`; must disable its server-side instrumentation and verify exactly one `init` per runtime.
- **Astro 6 ↔ `@sentry/astro` compat:** Astro 6 is new; the integration's exact option names (disable-server knob, `sourceMapsUploadOptions`) must be confirmed against the installed version.
- **Release on a shallow CI clone:** Workers Builds may shallow-clone; rely on `WORKERS_CI_COMMIT_SHA` rather than git auto-detection for the release.
- **Source-map upload depends on CF build-env:** if `SENTRY_AUTH_TOKEN` isn't set in Workers Builds, the build still succeeds but maps silently don't upload — Phase 4 symbolication gate catches this.

## Success Criteria (Summary)

- An unhandled error in each of the four runtime paths reaches Sentry with a symbolicated stack and correct release.
- Every captured event is verified PII-free (no request data, no submission content/id, no OpenAI body, no user/IP); Replay off; local dev inert.
- All existing automated suites (node + workers + typecheck + lint + build) remain green and temporary triggers are reverted.
