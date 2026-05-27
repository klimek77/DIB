---
project: Digital Idea Box (DIB)
deployed_at: 2026-05-27
deployed_by: tomasz.klimas
host: Cloudflare Workers (Static Assets)
deploy_url: https://digital-idea-box.klimek77.workers.dev
worker_name: digital-idea-box
current_version: 9c09f0bc-0219-4769-8fa7-ea48a687cd01
cloudflare_account: media@sewera.pl
cloudflare_account_id: 34af41dd0b57d15710decfbc3474a652
workers_dev_subdomain: klimek77
source_plan: context/changes/deployment/deployment-plan.md
status: deployed (MVP / course exercise, FR-015 network gate intentionally deferred)
---

# Deploy plan — executed run

Audit trail of the first production deploy of the Digital Idea Box skeleton to Cloudflare Workers. Source plan: `context/changes/deployment/deployment-plan.md`. Scope decisions and deviations recorded inline.

## Scope as executed

- **Goal:** publish current Astro scaffold (signin/signup/confirm-email/dashboard + middleware) to a public Cloudflare Worker for the course MVP exercise.
- **Out of scope this run:** Cloudflare Access network gate (FR-015), CI auto-deploy (Phase 6), custom domain, AI handlers, queues, cron triggers, notification channels. Course context: production deploy to corporate SSH host done separately by user later.

## Pre-flight — verified

| Item | Status | Value |
|---|---|---|
| Cloudflare account | OK | `media@sewera.pl`, acct `34af41dd0b57d15710decfbc3474a652` |
| Wrangler auth | OK | OAuth session, scopes cover workers/workers_kv/workers_scripts/workers_tail/account |
| Wrangler version | OK | 4.90.0 (devDependency, invoked via npx) |
| Supabase CLI | OK | 2.101.0 (not used for first deploy — auth/migrations deferred) |
| GitHub CLI | OK | 2.92.0, authenticated as `klimek77`, scopes `repo`+`workflow` |
| Git remote | OK | `https://github.com/klimek77/DIB.git` |
| Node version | DEVIATION | v24.14.0 installed (`.nvmrc` pins 22.14.0; nvm-windows not present; see deviations) |
| `wrangler.jsonc` shape | OK | `compatibility_date: 2026-05-08`, `nodejs_compat`, assets binding present |
| `.env` with Supabase creds | OK | `SUPABASE_URL`, `SUPABASE_KEY` (Publishable), `SUPABASE_PROJECTID` |
| Supabase project | OK | `ovwgoqhqbbgfodivwmwk` (cloud, EU region) |
| Corporate VPN/LAN CIDR | N/A | Phase 5 skipped — see deviations |
| Admin email list (FR-009) | N/A | Deferred — Supabase Auth allow-list will be configured during real prod deploy by user |
| Domain decision | OK | workers.dev subdomain `klimek77` registered manually in dashboard |

## Phase 1 — Workstation CLIs

- npm install → 774 packages, 0 changes (lockfile coherent); 10 known vulns (9 moderate, 1 high) baseline from bootstrap.
- npm run build → `dist/` produced (server adapter `@astrojs/cloudflare`), 16.93 s. Sitemap warning (missing `site` config) — non-blocking.

## Phase 2 — Cloudflare login

- `npx wrangler whoami` confirms session under `media@sewera.pl`; account ID matches expected.
- No API token env var set (OAuth session sufficient for this workstation).

## Phase 3 — Supabase

- Cloud project `ovwgoqhqbbgfodivwmwk` used (course context: cloud over local-via-`supabase start` because Cloudflare Worker cannot reach localhost).
- Magic-link allow-list, custom SMTP, URL configuration — NOT touched in this run; deferred to real-production handover (user owns the SSH-internal deploy).

## Phase 4 — First production deploy

- First `wrangler deploy` attempt FAILED at publish step: account had no `workers.dev` subdomain registered. Assets uploaded (8 files, 1910.50 KiB) and a KV namespace was created (`10x-astro-starter-session`, id `5f7d1765f22b4817981bde573a4b6e6e`) before failure.
- User manually registered `klimek77` as workers.dev subdomain via dashboard (`/workers/onboarding`); also created orphan worker entry visible in dashboard from the first failed upload.
- `wrangler.jsonc` `name` changed `10x-astro-starter` → `digital-idea-box` (course-appropriate). Rebuild required because `dist/server/wrangler.json` was generated at build time with the old name.
- Second `wrangler deploy` succeeded:
  - Worker name: `digital-idea-box`
  - URL: `https://digital-idea-box.klimek77.workers.dev`
  - Initial version: `56dcc54d-8bb7-4812-8110-d946d6d40020` (created 2026-05-27T09:16:35Z)
  - Bindings: `env.SESSION` → KV namespace `5f7d1765f22b4817981bde573a4b6e6e` (inherited from first deploy — name `10x-astro-starter-session` is legacy but functional), `env.IMAGES`, `env.ASSETS`
  - Warnings: `workers_dev` and `preview_urls` enabled by default (not in `wrangler.jsonc`)
- Secrets uploaded via `npx wrangler secret bulk .env`:
  - `SUPABASE_URL` (secret_text)
  - `SUPABASE_KEY` (secret_text) — Supabase Publishable key, prefix `sb_publishable_`
  - `SUPABASE_PROJECTID` (secret_text) — bonus, present in `.env` though not declared in `astro.config.mjs` envField
  - Secret upload triggered automatic redeploy → current version `9c09f0bc-0219-4769-8fa7-ea48a687cd01` (created 2026-05-27T09:18:02Z)
- Smoke test (post-secrets, public internet, off-corporate network from Claude Code's environment):
  - `GET /` → 200 OK
  - `GET /dashboard` → 302 → `Location: /auth/signin` (middleware enforcement working)
  - `GET /auth/signin` → 200 OK; HTML 9104 bytes; `<title>Sign in</title>`; `<form>` with `name="email"` input present
  - Note: initial TLS handshake failed for ~30 s after subdomain registration (`ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE`) — Cloudflare cert propagation lag, self-resolved.

## Phase 5 — Cloudflare Access (FR-015 network gate)

**SKIPPED INTENTIONALLY.** This run is the course MVP exercise. Production deploy on corporate SSH-internal host is owned by user and is the surface that will satisfy FR-015. The public `workers.dev` URL is reachable from the open internet; this is acceptable for the course context but would violate the PRD if treated as the corporate-facing production.

Implications:
- No CIDR allow-list configured on Cloudflare.
- No `Bypass` policy created.
- Off-corporate-network access is intentionally open.
- If this URL is ever repurposed beyond the course, Phase 5 of the source plan must be executed first.

## Phase 6 — CI auto-deploy on merge to main

**DEFERRED.** No GitHub Actions secrets set, no deploy job added to `.github/workflows/ci.yml`. Local `wrangler deploy` from workstation is the active deploy mechanism for this run. CI auto-deploy can be enabled later by following Phase 6 of the source plan.

## Phase 7 — Audit trail

This file.

## Resources on Cloudflare account (verified via CLI 2026-05-27 post-cleanup)

| Resource | Name | ID | Notes |
|---|---|---|---|
| Worker (active) | `digital-idea-box` | current version `9c09f0bc-0219-4769-8fa7-ea48a687cd01` | The deployed app — sole worker on account |
| KV namespace | display title `10x-astro-starter-session` | `5f7d1765f22b4817981bde573a4b6e6e` | Bound to active worker as `SESSION`; legacy display title only (functional). Renameable in dashboard if desired |
| workers.dev subdomain | `klimek77` | (account-level) | Registered once for `media@sewera.pl` account |

CLI verification commands and outputs:

- `npx wrangler deployments list --name 10x-astro-starter` → `code: 10007 This Worker does not exist on your account.` (user cleaned it up manually via dashboard before this check)
- `npx wrangler deployments list --name digital-idea-box` → returns deployments, current version `9c09f0bc-0219-4769-8fa7-ea48a687cd01`
- `npx wrangler kv namespace list` → 1 namespace, id `5f7d1765f22b4817981bde573a4b6e6e`, title `10x-astro-starter-session`

## Deviations from source plan

1. **Node v24.14.0 instead of v22.14.0 from `.nvmrc`.** Root cause: `nvm-windows` not installed on workstation, only single Node install at `C:\Program Files\nodejs`. Astro 6 and `@astrojs/cloudflare` 13.5 both support v24; `package.json` has no `engines` constraint. Build and runtime verified to work. Risk: subtle differences if a future contributor uses the pinned v22.14.0. Mitigation: documented; if drift becomes a problem, install nvm-windows and switch.
2. **Phase 5 (Cloudflare Access / FR-015) skipped.** Scope decision: course MVP, real prod is corporate SSH-internal, owned by user. URL is publicly reachable.
3. **Phase 6 (CI auto-deploy) deferred.** Manual `wrangler deploy` from workstation is the active mechanism. No Actions secrets set.
4. **Worker name changed from default scaffold name.** `10x-astro-starter` → `digital-idea-box`. Rebuild required between the rename and the next deploy because `@astrojs/cloudflare` bakes name into `dist/server/wrangler.json` at build time.
5. **Orphan worker `10x-astro-starter` from the failed first deploy was cleaned up by user via Cloudflare dashboard before CLI verification.** CLI confirms it no longer exists on the account (API code 10007). KV namespace with legacy display title `10x-astro-starter-session` remains, in active use as the `SESSION` binding on `digital-idea-box` — purely cosmetic legacy on the display title.
6. **`SUPABASE_PROJECTID` pushed as a Workers secret** despite not being declared in `astro.config.mjs` envField. Harmless — Astro just won't surface it via `astro:env/server`. Can be removed later via `npx wrangler secret delete SUPABASE_PROJECTID --name digital-idea-box` if desired.

## Verification status

End-to-end signup flow verified by user from a browser on 2026-05-27:

- Opened deployed URL, submitted signup form
- Confirmation email from Supabase arrived in inbox
- After confirmation, user record visible in Supabase Auth → Users on cloud project `ovwgoqhqbbgfodivwmwk`

This confirms the full chain works in production: browser → Cloudflare Worker (`digital-idea-box`) → middleware → Astro server route → `@supabase/ssr` → Supabase cloud auth → Supabase email provider → inbox → callback → Supabase user persistence.

Original-plan items NOT exercised:

- Magic-link sign-in flow with a pre-provisioned admin email and the Auth allow-list locked down (deferred to real-prod deploy; current setup permits any signup).
- Off-corporate-network deny check (N/A — Cloudflare Access gate intentionally skipped, see Deviations §2).

## Operational pointers

- **Tail live logs:** `npx wrangler tail --name digital-idea-box`
- **List versions:** `npx wrangler deployments list --name digital-idea-box`
- **Rollback:** `npx wrangler rollback <version-id> --name digital-idea-box`
- **Read secrets list:** `npx wrangler secret list --name digital-idea-box`
- **Update secrets from `.env`:** `npx wrangler secret bulk .env`
- **Local dev with bound resources:** `npx wrangler dev` (uses local Node, no Cloudflare runtime emulation by default in this stack)

## Next steps owned by user (post-course handover)

- Execute Phase 5 of the source plan (Cloudflare Access bypass policy on corporate CIDR) IF this URL is intended to be the corporate-facing surface.
- OR re-deploy on corporate SSH-internal host (the actual planned production target) — at which point this Cloudflare worker becomes the staging/demo environment and Phase 5 may remain skipped.
- Configure Supabase Auth allow-list, magic-link SMTP/custom-domain, redirect URLs to match production URL.
- Optionally delete orphan Cloudflare worker `10x-astro-starter` from dashboard and the legacy-named KV namespace once a new namespace with a clean name is created.
- Enable Phase 6 (CI auto-deploy) once the deploy pipeline is the source of truth for production.
