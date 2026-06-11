# Sentry — External Setup Runbook

> Manual, panel-side steps the implementer cannot script. Do these once per
> environment. Pure operations doc; no values are ever committed.
>
> Scope rule (load-bearing): **every secret and build-env var below must be set
> on BOTH the production build/deploy AND the preview (non-production branch)
> build/deploy.** Phase 4 verifies events at the `preview` environment, so a
> production-only setup silently fails the preview symbolication gate.

## 1. Sentry project

- [ ] Create one Sentry project (platform: **JavaScript → Astro**). One project, one DSN; environment + runtime tags split the views.
- [ ] Copy the **client DSN** (inherently public, write-only ingest key) → used as `PUBLIC_SENTRY_DSN`.
- [ ] The **server DSN** is the same DSN string; it is delivered as a Workers Secret (`SENTRY_DSN`) rather than baked into the bundle.
- [ ] Create a Sentry **Auth Token** with `project:releases` + source-map upload scope → used as `SENTRY_AUTH_TOKEN` (build secret only; never shipped to the client).
- [ ] Note the **org slug** and **project slug** → `SENTRY_ORG`, `SENTRY_PROJECT`.

## 2. Runtime secret (Cloudflare Worker)

The server SDK reads its DSN from the Worker runtime, not the build.

- [ ] `npx wrangler secret put SENTRY_DSN` — paste the DSN. Confirm with `npx wrangler secret list`.
- [ ] **Preview scope:** the runtime `SENTRY_DSN` secret must also reach whatever Worker the preview branch deploys to. If preview deploys to a separate Worker/environment, set the secret there too (`wrangler secret put SENTRY_DSN --env <preview-env>` or via the preview Worker's dashboard).

## 3. Cloudflare Workers Builds — build-environment variables

Set under **Worker → Settings → Build → Build variables and secrets**. These are read at **build time** by `astro build` (client DSN injection + source-map upload). Set them on production **and** preview.


| Name                | Kind       | Purpose                                                                           |
| ------------------- | ---------- | --------------------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN` | **secret** | Authorizes the build-time source-map upload. Never expose to the client.          |
| `SENTRY_ORG`        | plaintext  | Sentry org slug (source-map upload target).                                       |
| `SENTRY_PROJECT`    | plaintext  | Sentry project slug (source-map upload target).                                   |
| `PUBLIC_SENTRY_DSN` | plaintext  | Public client DSN, injected into the browser bundle via the `PUBLIC_` convention. |


- [ ] `SENTRY_AUTH_TOKEN` set as a **build secret** (prod + preview).
- [ ] `SENTRY_ORG` set (prod + preview).
- [ ] `SENTRY_PROJECT` set (prod + preview).
- [ ] `PUBLIC_SENTRY_DSN` set (prod + preview).

## 4. Auto-injected build variable — `release` linchpin

- `WORKERS_CI_COMMIT_SHA` is injected automatically by Workers Builds — **no manual setup**. It carries the git commit SHA and is the single `release` string shared by client SDK, worker SDK, and the source-map upload. A mismatch silently breaks symbolication.
- `WORKERS_CI_BRANCH` is also auto-injected and is the cheapest signal for deriving `environment` (`production` vs `preview`) at build time. `astro.config.mjs` derives it as: branch `main` → `production`, any other branch → `preview` (and an explicit `PUBLIC_SENTRY_ENVIRONMENT` build var, if set, overrides the derivation).
- **Verified against current CF docs (2026-06-11):** Cloudflare's own changelog documents `WORKERS_CI_COMMIT_SHA` with the example use "Passing current commit ID to error reporting, for example, Sentry" — exactly this use case. Source: [https://developers.cloudflare.com/changelog/2025-06-10-default-env-vars/](https://developers.cloudflare.com/changelog/2025-06-10-default-env-vars/).

## 5. Verification (after Phases 2–3 land)

- [ ] `npx wrangler secret list` shows `SENTRY_DSN` (prod + preview Worker).
- [ ] Build log on a preview deploy shows the Sentry source-map **upload step** and the **resolved release** (Phase 3 logs it loud — a wrong/empty SHA must fail at build, not silently at the Phase 4 symbolication gate).
- [ ] Sentry **Releases** view shows artifacts for the preview commit SHA.

## Notes

- Local dev needs nothing here: absent `SENTRY_DSN` / `PUBLIC_SENTRY_DSN` → both SDKs no-op, so `astro dev` / `wrangler dev` never reach Sentry.
- Secret names (not values) are mirrored in `.env.example` and the env schema (`astro.config.mjs`, `src/worker-env.d.ts`).

## 6. Phase 4 — end-to-end verification & PII audit (2026-06-11)

**Method.** Throwaway branch `sentry-verify` (commit `95bae32`, never merged) pushed → Cloudflare
Workers Builds preview at the branch-alias URL. Client + SSR triggered against that preview.
Queue + scheduled verified under local `wrangler dev` (built with `WORKERS_CI_COMMIT_SHA=95bae32…`
+ `WORKERS_CI_BRANCH=sentry-verify` so events carry the same release/environment; `SENTRY_DSN`
temporarily in `.dev.vars`, removed after), because of two platform constraints discovered en route:

1. **Queue consumers and cron triggers never run on preview versions** — they dispatch only to the
   active (production) deployment, so the preview URL cannot exercise them.
2. **wrangler's scheduled test endpoint (`/cdn-cgi/handler/scheduled`) is broken for this Worker
   shape**: with static assets configured, the test invocation dispatches to the assets ROUTER
   worker, which has no `scheduled` handler — the invocation rejects (`outcome: "exception"`)
   before any user code runs. Verified by bisection (raw un-wrapped handler rejects identically;
   a `console.log` first statement never prints). Workaround used: a dev-only fetch hook invoking
   the withSentry-wrapped `scheduled` handler with a synthetic controller — exercises the full
   scheduled wrapper (init → capture `auto.faas.cloudflare.scheduled` → flush).

**Audit table** (event payloads inspected in the Sentry UI, project `digital-idea-box`):

| Runtime | Issue (events) | Mechanism / handled | release / environment | Request data | User / IP | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| client | `…-client` (3) | `auto.browser.browserapierrors.setTimeout` / no | `95bae3267ce6` / `preview` | url `--`, transaction `/` — **query string stripped** | Users = 0, **no IP stored**; only coarse ingest geo (city) | PASS |
| SSR `fetch` | `…-ssr` (1) | `auto.http.cloudflare` / no | `95bae3267ce6` / `preview` | url/transaction `--`; no headers/cookies/body | IP present = **Cloudflare egress** (infra, not a person) | PASS |
| queue — capture seam | `…-queue-seam` (10) | `generic` / yes; tags `errorType=sentry_verify`, `submissionId=<marker>` | `95bae3267ce6` / `preview` | `--` | IP = local dev machine (local-run artifact) | PASS |
| queue — unhandled | `…-queue` (10) | unhandled in `Object.queue` (withSentry queue wrap) | `95bae3267ce6` / `preview` | `--` | local-run artifact | PASS |
| scheduled | `…-scheduled` (1) | `auto.faas.cloudflare.scheduled` / no | `95bae3267ce6` / `preview` | `--` | local-run artifact | PASS |

**Symbolication (gate 4.8).** Client: bundled frame remapped to original source
(`sentryWrapped` → `../../../node_modules/@sentry/browser/...` with source context) — uploaded
maps + debug IDs working. Worker: chunk is un-minified; frames reference the built chunk with
full readable source context (no remap to `src/worker.ts`, trace fully debuggable). Local-run
events show local paths un-symbolicated — expected (local builds don't upload maps).

**Replay / double-init (gate 4.10).** No Replay on any event (UI shows Replay as not set up).
One event per invocation everywhere (client 3 events = 3 page loads) → single init per runtime.

**Findings & follow-ups:**

1. **Sentry ingest attaches the connection IP to server events** despite `sendDefaultPii: false`
   and `beforeSend` deleting `event.user` (inference happens server-side, past the SDK). On
   production this is the Worker's Cloudflare egress IP — infrastructure, not a person; client
   events store **no** IP. Recommended hardening: Sentry project Settings → Security & Privacy →
   **"Prevent Storing of IP Addresses"** ON.
2. **Local miniflare ignores `ack()`-before-throw**: the queue marker message was redelivered to
   exhaustion (main → DLQ → dropped) despite being acked before the trigger throw. Local-only
   observation (hence 10 events per queue issue); benign for this verification.
3. **Post-deploy check**: at verification time `main` (phases 1–3) had not been pushed/deployed.
   After the production deploy, glance once at the CF dashboard cron events for the wrapped
   `scheduled` handler — the local test endpoint cannot exercise the deployed path (see #2 above
   under Method), so production cron is the only true scheduled environment.
4. **Caveat (untested, by design)**: errors thrown *inside Astro page rendering* are converted to
   error responses by the adapter's `handle` and never propagate to `withSentry` — only
   worker-level throws are auto-captured. Revisit if route-render errors need capture.

