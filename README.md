# Digital Idea Box (DIB)

![Digital Idea Box](./public/template.png)

An **anonymous idea-submission** web app with AI enrichment and an admin dashboard.
Rank-and-file employees submit ideas and problems without identifying themselves;
OpenAI enriches each submission (tone, classification, a short summary); and
management reads an aggregated dashboard by department, branch, and topic. The point
is to turn an anonymous stream into a mappable operational trend — replacing the
"email-the-boss / wall suggestion box" status quo.

## Hard anonymity (first-class guardrail)

Anonymity is a product guarantee enforced by construction, not a setting:

- The `submissions` table has **no IP, user-agent, session, or fingerprint columns** by design.
- The only identity field is an **optional, free-text `signature`** the author consciously types.
- The signature is **never sent to the AI** — the model gets identical input for signed and anonymous submissions.
- The submission endpoint never reads or logs request headers/cookies/IP; log lines and error captures carry only a static event tag — never a submission id, body, or identifier.

## How it works

1. An anonymous visitor opens **`/submit`** and posts an idea to **`POST /api/submissions`**.
2. The endpoint validates a strict field whitelist, inserts a `pending` row via a service-role client (so the row id can be read back under the no-SELECT anon role), then **fire-and-forget enqueues AI enrichment** and **notifies admins**.
3. The **`dib-enrichment` queue consumer** (in `src/worker.ts`) runs a claim → enrich → write-back state machine, filling `ai_title / ai_tone / ai_classification / ai_summary` and advancing `enrichment_status` (`pending → processing → done/failed`). Exhausted messages land in a dead-letter queue.
4. A **15-minute cron sweep** re-enqueues any row stranded in `pending` (whose initial enqueue silently failed), so submissions are never lost.
5. **Allow-listed admins** sign in by magic link and read **`/dashboard`** (aggregates + list) and **`/dashboard/submissions/[id]`** (detail + AI analysis).

## Tech stack

| Layer               | Choice                                                                                      | Version                               |
| ------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------- |
| Web framework (SSR) | [Astro](https://astro.build/)                                                               | `^6.4.4`                              |
| Interactive islands | [React](https://react.dev/)                                                                 | `^19.2.6`                             |
| Language            | [TypeScript](https://www.typescriptlang.org/)                                               | `^5.9.3`                              |
| Styling             | [Tailwind CSS](https://tailwindcss.com/)                                                    | `^4.2.4`                              |
| Backend / auth / DB | [Supabase](https://supabase.com/) (`@supabase/ssr`, magic-link auth, Postgres + RLS)        | `ssr ^0.10.3`, `js ^2.99.1`           |
| Runtime / deploy    | [Cloudflare Workers](https://workers.cloudflare.com/) (`@astrojs/cloudflare`, Queues, Cron) | adapter `^13.6.1`, `wrangler ^4.90.0` |
| AI enrichment       | OpenAI (called over `fetch` — no SDK dependency)                                            | —                                     |
| Error monitoring    | [Sentry](https://sentry.io/) (`@sentry/astro`, `@sentry/cloudflare`)                        | `^10.57.0`                            |
| Tests               | Vitest (`^4.1.8`) + `@cloudflare/vitest-pool-workers` (`^0.16.14`), Playwright (`^1.60.0`)  | —                                     |

## Architecture

- **`src/worker.ts` is the single Cloudflare Worker entry point.** It serves three runtimes behind one `Sentry.withSentry` wrapper: Astro **SSR** (`fetch`), the **`dib-enrichment` queue consumer + DLQ backstop** (`queue`), and the **15-minute cron sweep** (`scheduled`). Async/queue/cron behavior lives here, not only in routes.
- **Data model** (Postgres, 4 migrations under `supabase/migrations/`):
  - `submissions` — anonymized by construction; taxonomies enforced as DB `CHECK` constraints (department, branch, topic, content 1–800 chars, `enrichment_status`, `ai_tone`).
  - `admin_allowlist` — email allow-list read through a `SECURITY DEFINER` function `is_allowed_admin()`.
  - `dashboard_aggregates(p_from, p_to, p_branch)` — a `SECURITY INVOKER` RPC returning totals + by-topic / by-branch / by-tone / by-week counts (done-only rows). Being invoker-rights, the submissions `SELECT` RLS policy (`USING is_allowed_admin()`) gates every row.
  - **RLS is defense-in-depth**: the app-layer allow-list (middleware) is the first gate, DB RLS the last.

## Routes

| Route                         | Method | Access             | Purpose                                                                                                      |
| ----------------------------- | ------ | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `/`                           | GET    | public             | Landing page → links to `/submit`                                                                            |
| `/submit`                     | GET    | public             | Anonymous submission form (React island)                                                                     |
| `/api/submissions`            | POST   | public / anon      | Create a submission, enqueue enrichment, notify admins                                                       |
| `/submit-success`             | GET    | public             | Thank-you page (confirms nothing identifying was stored)                                                     |
| `/auth/signin`                | GET    | public             | Magic-link request form (work email; no password)                                                            |
| `/api/auth/signin`            | POST   | public             | Send a magic link **only** to allow-listed emails; always redirects to `/auth/check-email` (non-enumeration) |
| `/auth/check-email`           | GET    | public             | Neutral "check your inbox" confirmation                                                                      |
| `/auth/callback`              | GET    | magic link         | Consume the link (PKCE or token-hash), gate on the allow-list, establish session → `/dashboard`              |
| `/api/auth/signout`           | POST   | session            | Sign out → `/`                                                                                               |
| `/dashboard`                  | GET    | admin (allow-list) | KPIs, charts, and the submissions list (SSR, zero client JS)                                                 |
| `/dashboard/submissions/[id]` | GET    | admin (allow-list) | Read-only submission detail + AI analysis card                                                               |

Admin access is **passwordless (magic-link OTP)** gated by the `ALLOWED_ADMIN_EMAILS`
allow-list — there is no password and no signup. The allow-list is fail-closed (an
empty list authorizes no one) and enforced at three points: the magic-link request,
the auth callback, and the `/dashboard` route guard in `src/middleware.ts`.

## Prerequisites

- **Node.js `22.14.0`** (pinned in `.nvmrc`)
- **[Docker](https://www.docker.com/)** + ~7 GB RAM, for the local Supabase stack
- The **Supabase CLI** is bundled as a dev dependency (run via `npx supabase …`)

## Getting started (local)

```bash
git clone https://github.com/klimek77/DIB.git
cd DIB
npm install            # also installs git hooks via the "prepare" script
```

1. **Boot the local Supabase stack** (downloads Docker images on first run) and apply the schema:

   ```bash
   npx supabase start     # prints API URL + anon/service-role keys
   npm run db:reset       # applies the 4 migrations + seed.sql
   ```

2. **Create env files** from the example and fill in the values printed by `supabase start`:

   ```bash
   cp .env.example .env        # used by astro dev + the supabase CLI / seed scripts
   cp .env.example .dev.vars   # used by the built worker under `wrangler dev`
   ```

   At minimum set `SUPABASE_URL`, `SUPABASE_KEY` (anon key), and `SUPABASE_SERVICE_ROLE_KEY`.
   Set `ALLOWED_ADMIN_EMAILS` to the address(es) you'll log in with.

3. **Seed the admin allow-list** so a magic-link login resolves to an admin:

   ```bash
   npm run db:seed-admins      # reads ALLOWED_ADMIN_EMAILS (additive-only)
   ```

4. **Run the dev server:**

   ```bash
   npm run dev
   ```

Local Supabase Studio is at `http://localhost:54323`. Stop the stack with `npx supabase stop`.

## Environment variables

Declared via Astro's `astro:env` schema (server-only secrets) and read off the raw
Worker binding on the queue/cron path. All are technically optional at build time so
the build never hard-fails, but several are required at runtime.

| Variable                    | Required          | Purpose                                                                                                              |
| --------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | ✅                | Supabase project URL (shared by SSR and the Worker)                                                                  |
| `SUPABASE_KEY`              | ✅                | Supabase **anon/publishable** key (SSR server client)                                                                |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅                | Service-role key — bypasses RLS for the enrichment write-back, the submission insert read-back, and `db:seed-admins` |
| `ALLOWED_ADMIN_EMAILS`      | ✅                | Comma-separated admin allow-list **and** notification-email recipients (fail-closed)                                 |
| `OPENAI_API_KEY`            | ✅ for enrichment | OpenAI key for the enrichment consumer (set as a Worker secret; not in `.env.example`)                               |
| `RESEND_API_KEY`            | optional          | Resend key for notification email; `sendEmail` no-ops unless this **and** `ALERT_FROM` are set                       |
| `ALERT_FROM`                | optional          | Verified sender address for notification email                                                                       |
| `APP_BASE_URL`              | optional          | Absolute app URL (no trailing slash) for the weekly-digest dashboard link; omitted gracefully if unset               |
| `SENTRY_DSN`                | optional          | Server Sentry DSN (Worker secret); SDK no-ops when absent                                                            |
| `PUBLIC_SENTRY_DSN`         | optional          | Client Sentry DSN (shipped via the `PUBLIC_` convention); no-ops when empty                                          |

`QUEUE` (the `dib-enrichment` producer) and `ASSETS` (static-asset fetcher) are
Cloudflare **runtime bindings** configured in `wrangler.jsonc`, not secrets.

## Scripts

| Script                             | What it does                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run dev`                      | Astro dev server                                                                                 |
| `npm run build`                    | Production build (`astro build`; emits `dist/server/wrangler.json`)                              |
| `npm run preview`                  | Serve the production build locally                                                               |
| `npm test`                         | Node-env Vitest suite (**excludes** `*.workers.test.ts`)                                         |
| `npm run test:workers`             | Cloudflare Workers-runtime contract tests — **builds first**, then runs against the built worker |
| `npm run test:e2e` / `test:e2e:ui` | Playwright E2E suite (`tests/e2e/`) / with the UI runner                                         |
| `npm run typecheck`                | Type/diagnostic check (`astro check`, **not** `tsc`)                                             |
| `npm run lint` / `lint:fix`        | ESLint (type-checked rules) / with autofix                                                       |
| `npm run format`                   | Prettier                                                                                         |
| `npm run db:reset`                 | Rebuild the local DB from migrations + seed                                                      |
| `npm run db:gen-types`             | Regenerate `src/lib/database.types.ts` from the local schema (never hand-edit it)                |
| `npm run db:seed-admins`           | Seed the admin allow-list from `ALLOWED_ADMIN_EMAILS` (additive-only)                            |

Mutation testing (Stryker) is available ad hoc via `npx stryker run` as a selective,
manually-invoked gate — it is intentionally not wired into hooks or CI.

## Testing

- `npm test` is the fast node-env suite; it **excludes** `*.workers.test.ts`.
- `npm run test:workers` builds first and runs against `dist/server/wrangler.json` — a stale build means a stale result.
- E2E (`tests/e2e/`) boots `npm run dev`, so it needs `.dev.vars` + a running local Supabase.
- Git hooks: `pre-commit` runs lint-staged + `typecheck`; `pre-push` runs `npm test` (a red suite blocks the push).

## Deployment

Deploys to Cloudflare Workers (the entry point is `src/worker.ts`).

```bash
npm run build
npx wrangler deploy
```

- Push secrets to prod with `npx wrangler secret put <NAME>` (`OPENAI_API_KEY`, `SENTRY_DSN`, `RESEND_API_KEY`, `ALERT_FROM`, the Supabase keys, …). Never commit them.
- The `dib-enrichment` queue and its DLQ are created manually (`npx wrangler queues create …`) — they are not auto-provisioned on deploy.
- ⚠️ **Prod Supabase migrations are NOT auto-applied on deploy.** After any deploy that adds a `supabase/migrations/*.sql`, run `supabase db push` against the linked prod project and confirm `SELECT version FROM supabase_migrations.schema_migrations` matches the files in `supabase/migrations/`. A green app/worker deploy does **not** imply the DB schema (or its RLS policies) is current — prod once sat 2 migrations behind, silently leaving the access-control RLS gate dormant.

## Project structure

```
src/
  pages/          # routes: Astro pages + /api endpoints (test files prefixed _ or .workers.test.ts)
  components/     # Astro components + React islands (SubmissionForm, SignInForm, dashboard charts)
  layouts/        # Layout.astro
  lib/            # domain logic: submissions, auth (allowlist), enrichment, notifications, dashboard
  middleware.ts   # allow-list route guard for /dashboard
  worker.ts       # single Worker entry: SSR + queue consumer (+DLQ) + cron sweep
supabase/
  migrations/     # 4 SQL migrations (schema, constraints, allow-list RLS, aggregates RPC)
  config.toml     # local stack config
  seed.sql        # local seed data
tests/e2e/        # Playwright specs
wrangler.jsonc    # Workers config: assets binding, queues, cron triggers
context/          # project knowledge (foundation docs + active/archived changes)
```

Deeper, non-obvious conventions for contributors (and AI agents) live in `CLAUDE.md`.

## License

Private / internal project — not licensed for public redistribution.
