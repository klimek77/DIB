// @ts-check
/* global process, console */ // this config is executed by Node at build time (Sentry env bridging)
import { defineConfig, envField } from "astro/config";

import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";
import sentry from "@sentry/astro";

// --- Sentry release + environment pinning (sentry-observability, Phase 3) -----------------------
// A single DSN/release/environment, resolved once at build and burned into BOTH bundles as literals,
// so the client SDK (sentry.client.config.ts), the worker SDK
// (src/lib/observability/sentry-server-options.ts), and the source-map upload all agree and stack
// frames symbolicate. Cloudflare Workers Builds injects the commit SHA as WORKERS_CI_COMMIT_SHA and the
// branch as WORKERS_CI_BRANCH (see setup.md §4); the public client DSN arrives as the build-env var
// PUBLIC_SENTRY_DSN. We expose them as `__SENTRY_*__` globals via `vite.define` (literal text
// replacement in both the client and worker bundles) rather than relying on Astro's `import.meta.env`
// PUBLIC_ inlining — that mechanism does NOT pick up values resolved inside this config, and a define
// on `import.meta.env.X` can't reach the worker options builder because it aliases `import.meta.env`
// to a variable first. Absent locally → "" → both SDKs no-op via the falsy DSN, so dev never reports.
const sentryRelease = process.env.WORKERS_CI_COMMIT_SHA ?? "";
const sentryEnvironment =
  process.env.PUBLIC_SENTRY_ENVIRONMENT ??
  (process.env.WORKERS_CI_BRANCH === "main" ? "production" : process.env.WORKERS_CI_BRANCH ? "preview" : "");
const sentryClientDsn = process.env.PUBLIC_SENTRY_DSN ?? "";
// Loud at build: a wrong/empty release surfaces here, not silently at the Phase 4 symbolication gate.
// eslint-disable-next-line no-console -- intentional build-time diagnostic for the release linchpin
console.log(`[sentry] release="${sentryRelease || "(none)"}" environment="${sentryEnvironment || "(none)"}"`);

// https://astro.build/config
export default defineConfig({
  output: "server",
  integrations: [
    react(),
    sitemap(),
    sentry({
      // Server SDK OFF (the load-bearing knob): the Worker is wrapped explicitly by
      // @sentry/cloudflare's withSentry in src/worker.ts (Phase 2). With the server SDK left enabled,
      // @sentry/astro would ALSO wrap the Worker entry (its internal sentryCloudflareVitePlugin calls
      // withSentry too) → two Sentry.init per request (double-init). `autoInstrumentation` does NOT
      // stop that wrap; only disabling the server SDK does. Client stays on; source-map upload is
      // gated on (client || server), so maps still upload with the client enabled.
      enabled: { client: true, server: false },
      // Source-map upload (build-time). The plugin falls back to SENTRY_ORG/PROJECT/AUTH_TOKEN env
      // vars; passing them explicitly is just self-documenting. No auth token (local) → maps are still
      // emitted but the upload step is skipped with a warning; the real upload runs on CF builds.
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      // Pin the upload's release to the same SHA the SDKs use so artifacts line up with events.
      // Guarded: omitted locally (empty SHA) so the plugin never tries to create a release named "".
      ...(sentryRelease ? { unstable_sentryVitePluginOptions: { release: { name: sentryRelease } } } : {}),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    // Burn the resolved Sentry constants into both bundles as string literals (see the block above).
    // `|| undefined` lives at the read sites so an empty literal cleanly disables a tag / the SDK.
    define: {
      __SENTRY_DSN__: JSON.stringify(sentryClientDsn),
      __SENTRY_RELEASE__: JSON.stringify(sentryRelease),
      __SENTRY_ENVIRONMENT__: JSON.stringify(sentryEnvironment),
    },
  },
  adapter: cloudflare(),
  env: {
    schema: {
      SUPABASE_URL: envField.string({ context: "server", access: "secret", optional: true }),
      SUPABASE_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      ALLOWED_ADMIN_EMAILS: envField.string({ context: "server", access: "secret", optional: true }),
      // F-03 consumer secrets — values set via `wrangler secret put`, never committed.
      OPENAI_API_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      SUPABASE_SERVICE_ROLE_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      // Sentry server DSN — Workers Secret; absent locally → SDK no-ops (sentry-observability).
      // The public client DSN ships as PUBLIC_SENTRY_DSN via the PUBLIC_ convention, not here.
      SENTRY_DSN: envField.string({ context: "server", access: "secret", optional: true }),
    },
  },
});
