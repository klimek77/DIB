---
project: digital-idea-box
researched_at: 2026-05-25
recommended_platform: cloudflare-workers-static-assets
runner_up: fly-io
context_type: mvp
tech_stack:
  language: TypeScript
  framework: Astro 6 (SSR) + React 19
  runtime: Cloudflare Workers (workerd) via @astrojs/cloudflare
  database: Supabase (external — Postgres + Auth + Storage)
---

## Recommendation

**Deploy on Cloudflare Workers with Static Assets.**

The 10x-astro-starter is already configured for the Workers-with-Static-Assets path (`wrangler.jsonc` with `assets.binding = "ASSETS"`, `main = "@astrojs/cloudflare/entrypoints/server"`, `compatibility_date: 2026-05-08`, `nodejs_compat` on) — `wrangler deploy` ships it as-is. Cloudflare scores 5/5 on the agent-friendly criteria, but the deciding factor is **FR-015**: corporate-LAN/VPN-only access is solved natively by **Cloudflare Access (Zero Trust, free up to 50 users)** with CIDR-include policies — every other candidate either lacks native gating below Enterprise or requires fronting with an extra service. Workers Paid ($5/month) + Queues (now on Free, GA 2026-02-04) + Cron Triggers + Access give a complete operational picture for ~$5/month total at MVP scale.

## Platform Comparison

The five agent-friendly criteria scored Pass / Partial / Fail per `references/agent-friendly-criteria.md`. **Hard filter applied**: persistent-connection requirement does not apply (the digital idea box is request/response + cron + queue-driven; PRD shows no WebSocket needs). **Soft weights applied**: cost-sensitive penalizes expensive base tiers; single-region neutralizes edge bonus; no familiarity removes tiebreak; external providers OK removes co-location bonus.

| Platform | CLI-first | Managed | Agent docs | Scriptable deploy | MCP/Integration | Score | FR-015 gating |
|---|---|---|---|---|---|---|---|
| **Cloudflare Workers** | Pass | Pass | Pass | Pass | Pass | **5/5** | Native, free ≤50 users |
| **Vercel** | Pass | Pass | Pass | Pass | Partial (MCP beta, read-only) | 4.5/5 | Enterprise-only Trusted IPs |
| **Netlify** | Pass | Pass | Pass | Pass | Pass | **5/5** | Pro tier capped at 2 rules × 3 IPs |
| **Fly.io** | Pass | Partial (own Dockerfile/cron) | Partial (no `llms.txt`) | Pass | Partial (MCP experimental) | 3.5/5 | Native (Flycast + WireGuard) |
| **Railway** | Pass | Pass | Pass | Pass | Pass | **5/5** | None native; Tailscale workaround |
| **Render** | Pass | Pass | Pass | Pass | Pass | **5/5** | Scale plan only (cost-prohibitive) |

### Shortlisted Platforms

#### 1. Cloudflare Workers with Static Assets (Recommended)

Already aligned with the project — `@astrojs/cloudflare` 13.5.0 produces a Worker bundle plus static assets in one `wrangler deploy`. Cloudflare Access (Zero Trust, GA, free ≤50 users) supports CIDR include rules (`in {10.0.0.0/8}` selector) and WARP client integration, so the corporate-LAN-only constraint of FR-015 is solved by the platform without a separate auth gate or external proxy. Queues went GA on the Free plan (2026-02-04, 10k ops/day) — workable for the async AI enrichment of FR-005/FR-006/FR-007 once it outgrows in-Worker fire-and-forget. Cron Triggers cover FR-017's weekly Monday-08:00 digest natively. The official MCP catalog (Workers, Bindings, Observability, API) gives the agent typed access to platform state for the post-MVP operational loop. Cost at MVP scale (~80 active employees, low qps): **$5/month** Workers Paid + Access free tier.

#### 2. Fly.io

Solves FR-015 cleanly without any external service: release public IPs, allocate `--private` IPv6 (Flycast), and corporate users connect via `fly wireguard create` peers — the app resolves only inside Fly's 6PN private network. Persistent processes mean an in-process background worker for AI enrichment is straightforward (no Queue-binding glue), and Cron Manager (`fly-apps/cron-manager`) gives proper cron syntax for the weekly digest. Tradeoffs that move it to runner-up: the user owns the Dockerfile (more agent surface to misconfigure), `fly mcp` is experimental, no `llms.txt` published, and a known regression where `fly launch` doesn't emit a Dockerfile for Astro 5+ projects. Cost: ~$2-3/month for a single shared-cpu-1x always-on machine + auto-stop.

#### 3. Netlify

Best agent surface of the candidates — official MCP server (`netlify/netlify-mcp`, GA, vendor-maintained), Background Functions (GA, 15-minute timeout, fits async AI enrichment), Scheduled Functions (GA, cron, fits weekly digest), `netlify deploy` defaults to draft-by-default (safe for agents — `--prod` required for production). The single load-bearing weakness is FR-015: Firewall Traffic Rules on the Pro tier ($19/mo) cap at 2 rules × 3 IPs × 3 geos. This is workable only if the corporate VPN egresses through ≤3 IPs; otherwise the Enterprise tier is required. Astro skew protection is a nice DX touch the others lack.

## Anti-Bias Cross-Check: Cloudflare Workers with Static Assets

### Devil's Advocate — Weaknesses

1. **Pages→Workers transition is mid-flight in 2026, but the starter resolved it at scaffold.** The project is already on the Workers-with-Static-Assets path (`wrangler.jsonc` shows `assets.binding`, `main: "@astrojs/cloudflare/entrypoints/server"`). The risk applies to stale tutorials and blog posts the agent may read — many still reference `wrangler pages deploy`. Anchor the agent on `@astrojs/cloudflare` 13.5.0's own docs.
2. **Workers CPU-time limits (10ms free, 30s paid) constrain in-Worker AI enrichment.** Calling Claude/OpenAI synchronously from an HTTP Worker hits the limit on slow model responses. The pattern that scales is producer-into-Queue then a separate consumer Worker — two `wrangler` deploys, two configs, more binding glue. The "$5/mo covers production" framing hides that Queues + AI Gateway is a multi-binding setup.
3. **Supabase auth cookies on Workers have a history of Set-Cookie quirks.** Magic-link callback (`/auth/callback`) sets cookies the dashboard then reads; if cookies don't round-trip cleanly through Workers' streaming response model, admin auth breaks on production but not in dev. Surface 2-day issue, not day-1.
4. **Cloudflare Access free tier is ≤50 users — but what counts as a user?** If the policy is bypass-for-corporate-IP-range (no per-user identity), the count may be zero. If WARP-client-required is the chosen mechanism, every connecting employee counts. The 50-user free ceiling shifts depending on policy shape, and the pricing model isn't loud about it.
5. **Cron Triggers run on UTC and have no "at-least-once" guarantees on Workers Free.** The Monday-08:00 weekly digest must specify `0 7 * * 1` (Europe/Warsaw UTC+1 in winter, UTC+2 in summer — DST is the gotcha) and the consumer must be idempotent. Workers Paid is implicit here.

### Pre-Mortem — How This Could Fail

Six months in, the team realized Cloudflare wasn't the right call. Three things compounded. First, the Workers CPU-time ceiling forced the AI enrichment off the in-Worker path and onto Queues + a separate consumer Worker — that transition required scoped API tokens, two deploy steps in CI, and binding configuration the agent kept getting wrong because it had ingested Pages-shaped tutorial content rather than the project's actual Workers-with-Static-Assets shape. The team lost a week on a Set-Cookie bug that only manifested when Cloudflare Access was active in front of Workers (cookies were being stripped from a streaming response in one specific code path). Second, the corporate IT decided to deprecate the traditional VPN in favor of a Zero-Trust SaaS that was NOT WARP-compatible, so Cloudflare Access lost its free per-user pricing — the team now had to either pay $7/user/month above 50, or front the whole stack with the new corporate Zero-Trust solution, defeating the point of choosing Cloudflare Access in the first place. Third, the magic-link emails from Supabase were being soft-blocked by the corporate spam filter for the first three weeks because the LAN-only gating meant external email testing was impossible — every admin login required physical-office or VPN access just to validate the auth flow worked. The MVP shipped, but operational debug-time was 3x what the budget assumed.

### Unknown Unknowns

- **Astro 6 + adapter 13 dev-server fidelity assumes the workerd Vite plugin path.** `astro dev` mirrors production for *most* Workers features, but Cron Triggers, Durable Objects, and Queues consumers still need `wrangler dev --test-scheduled` or `wrangler dev --remote` for local verification. The "no separate wrangler dev needed" framing is mostly true for HTTP, materially false for cron/queue work.
- **Workers Paid is metered per minute of CPU-time above the included pool.** A misconfigured AI enrichment loop that retries on transient OpenAI errors can quietly burn 30M included CPU-ms in a day, then start metering at $0.02 per million additional CPU-ms — no automatic spending cap on the lowest paid tier.
- **Cloudflare Access policies historically gated Pages projects with a one-click UI flow. Workers-with-Static-Assets is newer terrain.** For this project the Access policy must be configured against the Workers HTTP application (not the Pages project type) — the dashboard surfaces and onboarding flow as of 2026-05-25 are catching up. Expect "the docs say one thing, the panel asks for another" friction for the first policy creation.
- **The corporate-LAN-only constraint of FR-015 is testable only from inside the LAN.** Magic-link email deliverability, Access policy enforcement edge cases, and even basic "is the app actually reachable" smoke tests all require the developer or agent to be on the corporate VPN at test time. CI runners on GitHub Actions are NOT on the corporate network — deploy verification must use a private health-check that Workers can expose to itself (e.g., a scheduled cron that hits its own routes), or the verification must happen manually post-deploy.
- **The `compatibility_date` in `wrangler.jsonc` is 2026-05-08, locking Worker behavior to platform changes as of that date.** Cloudflare bumps the date semantics periodically; a future bump that enables a new default may break the app silently if pinned dependencies haven't been reviewed since. The agent should not bump `compatibility_date` without a planned regression pass.

## Operational Story

How Cloudflare Workers + Access operates day to day for the digital idea box:

- **Preview deploys**: every PR creates a Worker preview at `<pr-shortname>-<worker-name>.<account>.workers.dev` automatically when CI runs `wrangler deploy --env preview` (or via the GitHub-Cloudflare integration). Preview URLs are reachable from outside the LAN by default, so Access must include preview Worker subdomains in the same policy. Fork PRs from external contributors cannot deploy to the account's Cloudflare tenancy — they get a build-only check.
- **Secrets**: Supabase URL/Key, OpenAI/Claude API key, magic-link signing secret live in **Cloudflare Workers Secrets**, set via `wrangler secret put SUPABASE_KEY` (one secret per command, never committed to repo). The `.env.example` in repo lists the names; `.env` for local `astro dev` is gitignored. Rotation flow: `wrangler secret put` overwrites; the next deploy picks up the new value. No secret read access from any non-deploy path.
- **Rollback**: `wrangler deployments list --name 10x-astro-starter` shows the deployment history; `wrangler rollback <deployment-id>` reverts to a prior version in seconds. Typical time-to-revert ≤ 30 seconds. **DB migrations on Supabase do NOT roll back automatically** — a migration applied during a bad deploy stays applied; rollback requires either a forward-fix migration or manual `supabase db reset` against a backup.
- **Approval**: Cron Trigger changes, Access policy edits, custom domain changes, and `compatibility_date` bumps are **human-only** (panel-by-hand for the first three, code-review-required for the fourth). Routine `wrangler deploy` against main and `wrangler secret put` for established names may be agent-driven. Deleting the Worker, deleting Access policies, rotating the master Cloudflare API token are panel-only.
- **Logs**: `wrangler tail` streams live logs; **Workers Observability** (now GA, enabled in `wrangler.jsonc` already) exposes per-invocation traces. The agent reads via the Cloudflare MCP Observability server (typed access to logs/metrics) or the CLI `wrangler tail --format json | <filter>`. Magic-link callback failures, AI enrichment errors, and FR-018 alert pings all surface in `wrangler tail` with structured log calls from the Worker.

## Risk Register

| Risk | Source | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Stale Pages tutorials misguide agent away from the project's Workers shape | Devil's advocate | M | M | Pin agent prompts to `@astrojs/cloudflare` 13.5.0 docs and the project's `wrangler.jsonc`; flag any `wrangler pages deploy` suggestion as wrong. |
| Workers CPU-time limit forces AI enrichment onto Queues + consumer Worker | Devil's advocate, Pre-mortem | M | M | Design the enrichment path with Queues from day one; do not start with in-Worker synchronous AI calls. Budget for the binding glue in MVP scope. |
| Supabase Set-Cookie quirks on Workers (auth callback) | Devil's advocate, Pre-mortem | L-M | H | Use `@supabase/ssr` 0.10.3+ (already in package.json); test the magic-link callback end-to-end behind Access before declaring auth done; record cookie attributes (`SameSite`, `Secure`, `Path`) explicitly. |
| Access free-tier user count behavior depends on policy shape (CIDR vs WARP) | Devil's advocate | M | L-M | Choose CIDR-include policy for FR-015 (no per-user identity needed for the employee form path); reserve identity-based Access only for admin magic-link route; monitor user count monthly. |
| Corporate IT swaps VPN for non-WARP Zero-Trust SaaS, breaking free Access tier | Pre-mortem | L | M | Document the assumption in `context/deployment/deploy-plan.md`; quarterly check with IT roadmap; have Fly.io+Flycast as the documented runner-up if the assumption breaks. |
| Magic-link emails soft-blocked by corporate spam filter | Pre-mortem | M | H | Configure Supabase Auth SMTP with a custom From-domain that the corporate mail server's SPF/DKIM allowlist explicitly trusts; coordinate with IT before pilot. |
| LAN-only gating prevents external smoke testing post-deploy | Unknown unknowns | H | M | Expose a Worker-internal scheduled health-check that pings its own routes from inside Workers; surface results via the FR-018 admin notification channel; document manual on-VPN verification step in `deploy-plan.md`. |
| Workers Paid bill spike from retry loop on transient AI failures | Unknown unknowns | L | M | Implement exponential backoff with a max-attempts cap in the consumer Worker; set a Cloudflare Account-level Spend Limit (panel, manual) as a circuit breaker. |
| `compatibility_date` bump silently changes Worker behavior | Unknown unknowns | L | H | Never bump `compatibility_date` outside a planned dependency-review PR; tie the bump to a regression pass on the staging Worker before main. |
| Cron Trigger DST gotcha (UTC vs Europe/Warsaw shifting) | Devil's advocate | L | L | Pin cron as `0 7 * * 1` (winter) / `0 6 * * 1` (summer DST) or compute weekly digest range inside the consumer rather than relying on the trigger time being exact. |
| Astro 6 + Workers cron/queue local-dev fidelity gap (workerd Vite plugin doesn't cover all triggers) | Unknown unknowns | M | L | Use `wrangler dev --test-scheduled` and `wrangler dev --remote` for cron + queue verification before deploy; do not rely on `astro dev` alone for non-HTTP paths. |

## Getting Started

The 10x-astro-starter is already configured. Validated against the current `package.json` and `wrangler.jsonc`:

1. **Install Cloudflare account + API token**. Create a token at `dash.cloudflare.com/profile/api-tokens` scoped to: `Account → Workers Scripts → Edit`, `Account → Cloudflare Pages → Edit` (legacy carry, harmless), `Account → Workers KV Storage → Edit` (for session/cache), `Account → Workers Tail → Read`. Export as `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in your shell or `.env` for wrangler.

2. **First deploy** (no code changes needed):
   ```powershell
   npm install
   npm run build
   npx wrangler deploy
   ```
   `wrangler.jsonc` already declares the Worker entry, static assets binding, compatibility date, and `nodejs_compat` flag. The first `wrangler deploy` will prompt for login if `CLOUDFLARE_API_TOKEN` isn't set, then publish to `<worker-name>.<account>.workers.dev`.

3. **Set Supabase secrets** on the deployed Worker (these are runtime secrets, not build-time):
   ```powershell
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_KEY
   ```
   Paste the values when prompted. Do NOT commit them. The `.env` file is for local `astro dev`; production Workers read from secrets.

4. **Configure Cloudflare Access (Zero Trust)** for FR-015:
   - `dash.cloudflare.com → Zero Trust → Access → Applications → Add an application → Self-hosted`
   - Application domain: the Worker's `workers.dev` URL or your custom domain
   - Create a policy with action `Bypass` and selector `IP ranges include {your corporate CIDR}`
   - Add a second policy for the magic-link callback route (`/auth/callback*`) if needed — typically the same Bypass is fine for MVP
   - Apply and test from on-LAN and off-LAN to confirm the gate behaves as expected
   - **MVP user note**: with a CIDR-bypass policy and no per-user authentication step, Access free tier covers this — the policy is identity-less.

5. **Add Cron Trigger for weekly digest (FR-017)** to `wrangler.jsonc` once the handler exists in code:
   ```jsonc
   "triggers": {
     "crons": ["0 7 * * 1"]
   }
   ```
   (`0 7 * * 1` UTC = Monday 08:00 Europe/Warsaw in winter; flip to `0 6 * * 1` for summer DST, or compute the weekly window inside the handler to be DST-independent.) Add the scheduled handler in the Astro project per `@astrojs/cloudflare` docs for Workers — the adapter exports a `scheduled` hook alongside the `fetch` hook.

6. **Local development** — `npm run dev` (`astro dev`) is the canonical loop. The `@astrojs/cloudflare` 13.5.0 Vite plugin runs against `workerd`, so the dev-server mirrors production runtime for HTTP routes without a separate `wrangler dev` step. For cron and queue verification, use `npx wrangler dev --test-scheduled` separately — the Vite plugin doesn't cover non-HTTP triggers.

## Out of Scope

The following were **not** evaluated in this research and are explicit non-goals for the MVP:

- Docker image configuration (the chosen platform doesn't need one)
- CI/CD pipeline setup (GitHub Actions auto-deploy is the stack's default — separate concern)
- Production-scale architecture: multi-region failover, HA, disaster recovery, SLA commitments
- Long-term self-host migration to corporate on-prem (deferred per `tech-stack.md` until after MVP ships)
- Cost projections beyond a 6-month horizon at MVP scale (~80 active employees, ~270 ceiling)
