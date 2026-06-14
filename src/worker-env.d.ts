// Runtime bindings + secrets for the Worker (fetch + queue handlers).
//
// `@astrojs/cloudflare/handler` and `ExportedHandler<Env>` reference a GLOBAL
// `Env`, so this interface is declared globally (not exported). It is distinct
// from `App.Locals` in `src/env.d.ts`, which is request-scoped Astro state.
//
// The QUEUE message type is hand-typed as `Queue<EnrichmentMessage>` instead of
// generating it via `wrangler types` (which would emit an untyped `Queue` and
// collide with this declaration). Global Workers types (`Queue`, `Fetcher`,
// `ExportedHandler`, `MessageBatch`, `ExecutionContext`) come from
// `@cloudflare/workers-types` via tsconfig `compilerOptions.types`.

import type { EnrichmentMessage } from "./lib/enrichment/types";

declare global {
  interface Env {
    /** Producer binding for the enrichment queue (wrangler.jsonc queues.producers). */
    QUEUE: Queue<EnrichmentMessage>;
    /** Static-asset fetcher injected by the Cloudflare adapter. */
    ASSETS: Fetcher;
    /** Supabase project URL (shared with the SSR path). */
    SUPABASE_URL: string;
    /** Service-role key — bypasses RLS/column grants for the enrichment write path. */
    SUPABASE_SERVICE_ROLE_KEY: string;
    /** OpenAI API key for the enrichment provider. */
    OPENAI_API_KEY: string;
    /** Sentry server DSN (Workers Secret). Optional: absent → SDK no-ops (local dev). */
    SENTRY_DSN?: string;
    /** Resend API key for the notification email channel. Optional: absent → sendEmail no-ops. */
    RESEND_API_KEY?: string;
    /** Verified sender address for notification emails. Optional: absent → sendEmail no-ops. */
    ALERT_FROM?: string;
    /**
     * Comma-separated admin allow-list (alert recipients). Declared as an Astro
     * `envField` secret (astro.config.mjs) consumed via `astro:env/server` on the
     * request path; surfaced here so the queue-path recipient resolver can read the
     * same Cloudflare secret off the raw Worker binding (where `astro:env` access is
     * unavailable outside an Astro request context).
     */
    ALLOWED_ADMIN_EMAILS?: string;
  }
}

export {};
