# Deploy Plan — Digital Idea Box, first production deploy

## Context

The digital-idea-box MVP scaffold is 70% deploy-ready and the platform decision is recorded in `context/foundation/infrastructure.md`: **Cloudflare Workers with Static Assets** as host, **Supabase** (external) for Postgres + Auth + Storage, **Cloudflare Access (Zero Trust, free tier ≤50 users)** as the FR-015 corporate-LAN/VPN gate. The starter is already on the Workers path (`wrangler.jsonc` declares `assets.binding`, `main: "@astrojs/cloudflare/entrypoints/server"`, `compatibility_date: 2026-05-08`, `nodejs_compat`). No code changes are needed to publish the current skeleton — the gaps are external account setup, secrets, the network gate, and one CI step.

This plan operationalizes `infrastructure.md`'s "Getting Started" into a manual-first-deploy → wire-CI sequence, with explicit manual gates where the user must supply information IT controls (corporate egress CIDRs, admin email list, custom domain decision). On approval, execution writes the audit trail to `context/deployment/deploy-plan.md` (per CLAUDE-m1l5.md).

**Scope**: first deploy of the current scaffold (signin/signup/confirm-email/dashboard skeleton + middleware) to production behind Cloudflare Access. **Out of scope**: AI enrichment handlers, queue setup, cron triggers, custom domain, notification channel selection — those are feature-implementation concerns and PRD open questions, deferred to `/10x-implement`.

---

## Pre-flight — manual gates that block deploy

These are user-driven actions that the agent CANNOT do automatically. Each is a hard prerequisite for the next phase.

- [ ] **Cloudflare account exists** (free tier OK) at `dash.cloudflare.com`. Note the **Account ID** visible on the right sidebar of any zone or the Workers & Pages overview.
- [ ] **Cloudflare API token created** at `dash.cloudflare.com/profile/api-tokens` with scopes:
  - `Account → Workers Scripts → Edit`
  - `Account → Workers KV Storage → Edit`
  - `Account → Workers Tail → Read`
  - `Account → Account Settings → Read` (lets `wrangler whoami` work)
  - `Zone → Zone → Read` only if a custom domain is added later — skip for `workers.dev` first deploy
  - Constraint: token bound to a single account ID. Save the value once — Cloudflare does not show it again.
- [ ] **Supabase project decided**: either create a fresh project at `supabase.com/dashboard` (EU region recommended for Poland latency + GDPR posture) or reuse an existing one. Note the **Project Reference ID** (`abcdefghijkl`) and the **anon API key** (NOT the service-role key — that one stays on the server only if needed for admin scripts).
- [ ] **GitHub repository connected** to the project's git remote, with admin access for setting repository Actions secrets via `gh secret set` (or the GitHub web UI).
- [ ] **Corporate VPN/LAN egress CIDR list obtained from IT** — the public IP range(s) corporate users appear from when accessing internet-facing services. This is the load-bearing input for FR-015. Without it, Cloudflare Access cannot be configured and the deploy is paused after Step 4. Expected shape: one or more CIDR blocks like `198.51.100.0/24`, `203.0.113.42/32`. Ask IT specifically: "what is our office/VPN egress IP range as seen by external services".
- [ ] **Admin email list confirmed** (FR-009): the small set of corporate email addresses authorized to view the dashboard. Magic-link recipients are limited to this list inside Supabase Auth allow-list settings.
- [ ] **Decision: custom domain or `workers.dev` for first deploy?** Default plan goes with `workers.dev` (e.g., `10x-astro-starter.<account>.workers.dev`); custom domain is documented as a follow-up. The link in the corporate intranet/komunikator from FR-001 can be the `workers.dev` URL for the pilot and later switch with a redirect.

---

## Phase 1 — Install CLIs on workstation

Run from `C:\tklimas\10xDevs\DIB`. Workstation is Windows 10 / PowerShell or Git Bash.

- [ ] **Node 22.14.0** — already pinned in `.nvmrc`. Verify: `node --version` reports `v22.x`. If older, install via `nvm-windows` (`nvm install 22.14.0; nvm use 22.14.0`) or fnm.
- [ ] **Wrangler 4.90.0** — already a devDependency in `package.json` (no global install needed). Use it via `npx wrangler ...`. Verify: `npx wrangler --version` reports `4.90.0` after `npm install`.
- [ ] **Supabase CLI** — install via **Scoop** (Windows canonical; `npm install -g supabase` is deprecated and `npm install supabase --save-dev` is a fallback only). Commands:
  ```powershell
  # one-time Scoop install if not present
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
  irm get.scoop.sh | iex

  # add the Supabase bucket and install
  scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
  scoop install supabase
  ```
  Verify: `supabase --version`. Docker Desktop is NOT required for this plan — `supabase` CLI is used only to login + link the remote project; no local Postgres is started. If the user already has Supabase CLI installed via Brew/Scoop/binary, skip this step.
- [ ] **GitHub CLI (`gh`)** — install via **winget** (Windows canonical):
  ```powershell
  winget install --id GitHub.cli
  ```
  Verify: `gh --version`. Authenticate: `gh auth login` (browser flow). Confirms via `gh auth status`.

---

## Phase 2 — Cloudflare login + verification

- [ ] **Authenticate Wrangler** via interactive OAuth (one-time workstation setup):
  ```powershell
  npx wrangler login
  ```
  This opens a browser to `dash.cloudflare.com` and authorizes the CLI. Verify: `npx wrangler whoami` reports the account email and account ID.
- [ ] **Alternative (if browser login fails inside corporate proxy)**: set the API token from pre-flight as an env var and skip `wrangler login`:
  ```powershell
  $env:CLOUDFLARE_API_TOKEN = "<token-from-preflight>"
  $env:CLOUDFLARE_ACCOUNT_ID = "<account-id-from-preflight>"
  npx wrangler whoami
  ```
- [ ] **Confirm account binding** — `wrangler whoami` must show the same Account ID used in the token. If multiple accounts are shown, set `account_id` in `wrangler.jsonc` explicitly to avoid the "which account?" prompt during deploy.

---

## Phase 3 — Supabase project setup (external integration)

- [ ] **If creating new project**: at `supabase.com/dashboard`, create project. Region: `eu-central-1` (Frankfurt) or `eu-west-2` (London) for Poland-proximity. Database password: generated, stored in a password manager (never committed).
- [ ] **Login Supabase CLI** + link to remote project (for future migration use, not first-deploy):
  ```powershell
  supabase login
  supabase link --project-ref <project-ref-id>
  ```
- [ ] **Note credentials** for the secrets step:
  - `SUPABASE_URL` = `https://<project-ref>.supabase.co`
  - `SUPABASE_KEY` = the **anon public** key from `Settings → API → Project API keys`
- [ ] **Configure magic-link allow-list** in Supabase Auth → URL Configuration:
  - Site URL: the eventual Worker URL from Phase 4 (e.g., `https://10x-astro-starter.<account>.workers.dev`)
  - Redirect URLs: same + `/auth/callback*`
  - Auth Providers → Email → enable Magic Link, disable signups if invite-only (admins are pre-provisioned per FR-009)
- [ ] **Magic-link email deliverability (RISK from infrastructure.md)** — Supabase's default SMTP works in dev but corporate mail servers often soft-block. Coordinate with corporate IT BEFORE pilot:
  - Option A (cheapest, works for small pilot): keep Supabase default SMTP, ask IT to allowlist the Supabase sending domain in the corporate spam filter.
  - Option B (recommended for any serious use): configure custom SMTP in Supabase Auth → SMTP Settings, using a corporate-approved sending domain with valid SPF/DKIM records.
  - **Verify** by sending one magic-link to a real admin email on the corporate network before declaring auth done.

---

## Phase 4 — First production deploy (to `workers.dev`)

- [ ] **Install dependencies**:
  ```powershell
  npm install
  ```
- [ ] **Build**:
  ```powershell
  npm run build
  ```
  Confirms `dist/` is produced. If `astro sync` warnings appear about env vars, that's normal — Supabase env vars are flagged `optional: true` in `astro.config.mjs`, so build succeeds without them.
- [ ] **Deploy**:
  ```powershell
  npx wrangler deploy
  ```
  Output: a `https://10x-astro-starter.<account>.workers.dev` URL. Save it.
- [ ] **Set runtime secrets on the deployed Worker** (these are Workers Secrets, distinct from GitHub Actions secrets):
  ```powershell
  npx wrangler secret put SUPABASE_URL
  # paste https://<project-ref>.supabase.co when prompted

  npx wrangler secret put SUPABASE_KEY
  # paste the anon key when prompted
  ```
  Each command opens an interactive paste prompt. Secrets are encrypted at rest and only readable by the Worker's runtime — never committed to git, never visible in dashboard logs.
- [ ] **Smoke test (UNAUTHENTICATED — before Access is applied)**: open the `workers.dev` URL in a browser. Expect:
  - `/` redirects or renders some landing
  - `/dashboard` redirects to `/auth/signin` (middleware in `src/middleware.ts` enforces this — already in the scaffold)
  - `/auth/signin` renders the sign-in form
  - No Cloudflare Access challenge yet (Access is configured in Phase 5)
- [ ] **Tail logs** during smoke test to confirm no runtime errors:
  ```powershell
  npx wrangler tail
  ```

---

## Phase 5 — Cloudflare Access policy (FR-015 network gate)

**Critical**: this is the only step that satisfies FR-015. Until it's applied, the `workers.dev` URL is reachable from the public internet — which violates the PRD.

- [ ] **Enable Zero Trust** at `dash.cloudflare.com → Zero Trust`. First-time setup walks through choosing a team domain (e.g., `<companyname>.cloudflareaccess.com`) — pick once, hard to change. Free plan covers ≤50 users.
- [ ] **Create Self-hosted Access Application**:
  - Navigate: `Zero Trust → Access → Applications → Add an application → Self-hosted`
  - Application name: `Digital Idea Box`
  - Session duration: 24 hours (matches admin workday; Bypass policies don't actually issue sessions but the field is required)
  - Application domain: the `workers.dev` URL from Phase 4 (e.g., `10x-astro-starter.<account>.workers.dev`). Include subdomain wildcards if needed: leave wildcard off for first MVP.
- [ ] **Create a Bypass policy** (the load-bearing FR-015 mechanism):
  - Policy name: `Corporate LAN/VPN bypass`
  - Action: **Bypass**
  - Selector: `IP ranges` → include → `<corp-cidrs-from-preflight>` (one or many CIDR blocks, comma-separated)
  - **Note**: Bypass policies CANNOT use identity selectors (emails, groups). That's fine here — the form is anonymous (PRD: zero identity for employees) and admin auth is handled by Supabase magic link AFTER the Access bypass, not by Cloudflare identity.
- [ ] **No second policy needed** for MVP. With only the Bypass policy:
  - On-LAN/VPN traffic → matches Bypass → reaches the Worker → middleware enforces signin for `/dashboard`
  - Off-LAN traffic → no matching policy → Access blocks with the default deny page (FR-015 satisfied: "Próba dostępu spoza firmowej sieci ... nie nawiązuje połączenia")
- [ ] **Validate the gate** with TWO smoke tests:
  - **On-LAN test**: from a workstation on the corporate network (or via corporate VPN), load the `workers.dev` URL. Expect the app to render directly (no Access challenge). Hit `/dashboard` → redirected to `/auth/signin`. Sign in with a magic-link email. Magic-link callback round-trip works.
  - **Off-LAN test**: from a phone on cellular, or any non-corporate connection, load the same URL. Expect the Cloudflare Access "you don't have access" page, NOT the app. If the app renders off-LAN, the Bypass policy is misconfigured (most common cause: the CIDR list is wrong or the app domain doesn't match exactly).

---

## Phase 6 — Wire CI auto-deploy on merge to main

The tech-stack hand-off specifies `ci_default_flow: auto-deploy-on-merge`. After the manual first deploy proves the pipeline works, automate subsequent deploys.

- [ ] **Set GitHub Actions secrets** (use `gh` CLI, non-interactive):
  ```powershell
  gh secret set CLOUDFLARE_API_TOKEN     # paste API token from pre-flight
  gh secret set CLOUDFLARE_ACCOUNT_ID    # paste account ID from pre-flight
  # SUPABASE_URL and SUPABASE_KEY are already used by the existing build step in ci.yml
  gh secret set SUPABASE_URL             # paste the same value used in Phase 4
  gh secret set SUPABASE_KEY             # paste the same value used in Phase 4
  ```
- [ ] **Edit `.github/workflows/ci.yml`** to add a deploy job that runs after the build job, gated on push to `main`/`master`. Use the official `cloudflare/wrangler-action@v3` action. Outline (NOT executed yet — written into `context/deployment/deploy-plan.md` as the canonical version):
  ```yaml
  deploy:
    needs: build
    if: github.event_name == 'push' && (github.ref == 'refs/heads/master' || github.ref == 'refs/heads/main')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: 'npm'
      - run: npm ci
      - run: npm run build
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
  ```
- [ ] **Smoke test the CI path**: make a trivial change (e.g., update a comment), commit, push to `master`. Watch `gh run watch` to confirm the deploy step runs end-to-end. Reload the `workers.dev` URL on-LAN to confirm the change is live.
- [ ] **Note**: CI runners are NOT on the corporate network, so the CI runner CANNOT smoke-test the deployed app behind Access. Verification post-CI-deploy is manual from on-LAN. This is an acknowledged risk in `infrastructure.md`.

---

## Phase 7 — Audit trail

- [ ] **Write `context/deployment/deploy-plan.md`** with the final, executed plan: every checkbox above with timestamps, the resolved `workers.dev` URL, the Cloudflare Access Application ID, the GitHub Actions secret names set, and the validation results from on-LAN and off-LAN smoke tests. This file is what downstream skills (`/10x-implement`, milestone planning) read as ground truth for "what's already deployed and which secrets are wired".

---

## External integrations matrix

Every external dependency the deploy plan touches, with explicit status:

| Integration | Status at first deploy | Owner / decision source |
|---|---|---|
| Cloudflare account + Workers + Static Assets | **Needed** — Phase 2/4 | infrastructure.md |
| Cloudflare Access (Zero Trust, free tier) | **Needed** — Phase 5 (FR-015) | infrastructure.md |
| Supabase Postgres + Auth | **Needed** — Phase 3 | tech-stack.md |
| Supabase Storage | Available (not used yet — no file uploads in MVP) | tech-stack.md |
| Supabase custom SMTP | **Recommended** — Phase 3, magic-link deliverability | risk register R6 |
| GitHub repo + Actions | **Needed** — Phase 6 | tech-stack.md |
| Corporate VPN/LAN egress CIDR | **Needed** — Phase 5 input | user + corporate IT |
| AI provider (OpenAI / Anthropic / other) | **Deferred** — PRD Open Question 4, no form-submission code yet | `/10x-implement` |
| Notification channel (email / Slack / Teams) | **Deferred** — PRD Open Question 5, FR-016/FR-018 | `/10x-implement` |
| Custom domain (e.g., `dib.firma.pl`) | **Deferred** — workers.dev OK for pilot | post-MVP decision |
| Long-term self-host on-prem | **Deferred** — explicitly post-MVP per tech-stack.md | future migration |

---

## Edge cases / extra support steps

Patterns that surface during real deploys; each has a specific fallback.

### CLI install / auth

- [ ] **Scoop install blocked by corporate execution policy**: if `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` fails with "access denied", install Supabase CLI as a project devDependency instead: `npm install supabase --save-dev`, then invoke via `npx supabase ...`.
- [ ] **`wrangler login` fails inside corporate HTTP proxy / no browser available**: skip the OAuth flow entirely; set `CLOUDFLARE_API_TOKEN` env var (Phase 2 alternative) and `wrangler` becomes non-interactive. If a corporate proxy intercepts HTTPS, set `HTTPS_PROXY` env var or configure `wrangler` to trust a custom CA bundle.
- [ ] **`gh auth login` fails in PowerShell with no browser**: use `gh auth login --with-token < token.txt` (paste a Personal Access Token created at `github.com/settings/tokens` with `repo` + `workflow` scopes).

### Cloudflare deploy

- [ ] **`wrangler deploy` says "did not deploy" with no error**: check `wrangler.jsonc` JSONC syntax — trailing commas are allowed inside objects but a stray comma elsewhere silently fails. Run `wrangler deploy --dry-run --outdir=tmp/` to surface the parsed config.
- [ ] **`Could not parse compatibility_flags`**: confirm `compatibility_date: "2026-05-08"` is set; `nodejs_compat` requires a compatibility_date ≥ 2024-09-23. Both are already true in the project.
- [ ] **First deploy succeeds but `/` returns 500**: check `wrangler tail` for the actual error. Most common: missing `SUPABASE_URL`/`SUPABASE_KEY` — re-run `wrangler secret put` for both. The `astro:env/server` envField checks at runtime, not build time.
- [ ] **Multiple Cloudflare accounts on `wrangler whoami`**: explicitly set `account_id` in `wrangler.jsonc` (after `"name"`) to lock the deploy target.

### Supabase

- [ ] **Magic-link email never arrives at corporate inbox** (most likely cause of failure):
  - First check Supabase dashboard → Auth → Logs to confirm the email was sent.
  - If sent but not received, it's a corporate spam filter — switch to custom SMTP (Phase 3, Option B).
  - If not sent, confirm the admin email is in Supabase Auth's allow-list and that Magic Link provider is enabled.
- [ ] **Magic-link callback returns 404**: the redirect URL in Supabase Auth → URL Configuration must match the `workers.dev` URL exactly. Check protocol (`https://`), trailing slash, and that `/auth/callback*` is whitelisted.
- [ ] **`supabase link` fails with "permission denied"**: rerun `supabase login` and confirm the user has access to the project in the Supabase dashboard organization.

### Cloudflare Access

- [ ] **Off-LAN smoke test still loads the app (gate not enforcing)**: most common cause — the application domain in Access doesn't match the Worker domain exactly. Check for typos in the subdomain. Trailing slash matters in the field. Wait 30-60 seconds after policy save for propagation.
- [ ] **On-LAN smoke test gets blocked by Access ("you don't have access")**: the CIDR in the Bypass policy doesn't match the actual egress IP. Verify with `curl ifconfig.me` from on-LAN — that's the IP corporate users present as. Update the CIDR. If multiple offices / branch sites have different egresses, add each to the include list.
- [ ] **Cloudflare Access user-count surprise on bill** (risk R4 in infrastructure.md): Bypass policies with CIDR selectors do NOT count toward the free-tier 50-user ceiling because they don't issue Access sessions. If a future policy uses identity selectors (`emails include {admin@corp.com}`), each authenticating user counts. For this MVP with only a Bypass+CIDR policy, the user count remains zero.
- [ ] **Corporate IT swaps VPN for non-WARP Zero-Trust SaaS** (risk R5): pivot path documented — switch the Access bypass selector from `IP ranges` to `Country/Region` (least preferred, broad), OR migrate to runner-up (Fly.io + Flycast + WireGuard, fully documented in `infrastructure.md`).

### Custom domain (deferred but documented)

- [ ] When the corporation picks a subdomain (e.g., `dib.firma.pl`): in Cloudflare, add the zone if not already managed, create a `Worker Route` or use the Workers Custom Domain feature to map the subdomain to the Worker. Update the Access Application's domain field to the new subdomain. Update Supabase Auth → Site URL and Redirect URLs. Re-run on-LAN + off-LAN smoke tests.

### Rollback

- [ ] If a deployed version misbehaves, list deployments and revert in seconds:
  ```powershell
  npx wrangler deployments list --name 10x-astro-starter
  npx wrangler rollback <deployment-id>
  ```
- [ ] **Caveat**: DB migrations on Supabase do NOT rollback automatically with a Worker rollback. If a deploy applied a migration, rolling back the Worker still leaves the DB in the post-migration shape. Forward-fix or restore from Supabase backup. For first deploy this is moot (no migrations yet).

---

## Verification (end-to-end, post-execution)

After all phases complete, the following must be true from on-LAN:

- [ ] `https://10x-astro-starter.<account>.workers.dev/` loads and renders some Astro page (no error).
- [ ] `https://10x-astro-starter.<account>.workers.dev/dashboard` redirects to `/auth/signin` (middleware enforcement).
- [ ] `https://10x-astro-starter.<account>.workers.dev/auth/signin` renders the sign-in form.
- [ ] An admin email (on the Supabase allow-list) submits the sign-in form, receives the magic-link email within 60s, clicks it, lands on `/dashboard` authenticated.
- [ ] `wrangler tail` shows the auth round-trip log lines with no errors.

From off-LAN:

- [ ] Same URL loads the Cloudflare Access "you don't have access" page — the Worker is unreachable to public internet.

CI smoke (post-Phase 6):

- [ ] A trivial push to `master` triggers `gh run watch` showing build + deploy success; the deployed change is visible on-LAN.

Once all checkboxes above are green, `context/deployment/deploy-plan.md` is written with the resolved values (URL, Access app ID, secret names, dates) and the deploy is declared shipped.
