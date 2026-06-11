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

| Name | Kind | Purpose |
|------|------|---------|
| `SENTRY_AUTH_TOKEN` | **secret** | Authorizes the build-time source-map upload. Never expose to the client. |
| `SENTRY_ORG` | plaintext | Sentry org slug (source-map upload target). |
| `SENTRY_PROJECT` | plaintext | Sentry project slug (source-map upload target). |
| `PUBLIC_SENTRY_DSN` | plaintext | Public client DSN, injected into the browser bundle via the `PUBLIC_` convention. |

- [ ] `SENTRY_AUTH_TOKEN` set as a **build secret** (prod + preview).
- [ ] `SENTRY_ORG` set (prod + preview).
- [ ] `SENTRY_PROJECT` set (prod + preview).
- [ ] `PUBLIC_SENTRY_DSN` set (prod + preview).

## 4. Auto-injected build variable — `release` linchpin

- `WORKERS_CI_COMMIT_SHA` is injected automatically by Workers Builds — **no manual setup**. It carries the git commit SHA and is the single `release` string shared by client SDK, worker SDK, and the source-map upload. A mismatch silently breaks symbolication.
- `WORKERS_CI_BRANCH` is also auto-injected and is the cheapest signal for deriving `environment` (`production` vs `preview`) at build time.
- **Verified against current CF docs (2026-06-11):** Cloudflare's own changelog documents `WORKERS_CI_COMMIT_SHA` with the example use "Passing current commit ID to error reporting, for example, Sentry" — exactly this use case. Source: <https://developers.cloudflare.com/changelog/2025-06-10-default-env-vars/>.

## 5. Verification (after Phases 2–3 land)

- [ ] `npx wrangler secret list` shows `SENTRY_DSN` (prod + preview Worker).
- [ ] Build log on a preview deploy shows the Sentry source-map **upload step** and the **resolved release** (Phase 3 logs it loud — a wrong/empty SHA must fail at build, not silently at the Phase 4 symbolication gate).
- [ ] Sentry **Releases** view shows artifacts for the preview commit SHA.

## Notes

- Local dev needs nothing here: absent `SENTRY_DSN` / `PUBLIC_SENTRY_DSN` → both SDKs no-op, so `astro dev` / `wrangler dev` never reach Sentry.
- Secret names (not values) are mirrored in `.env.example` and the env schema (`astro.config.mjs`, `src/worker-env.d.ts`).
