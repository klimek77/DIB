// @ts-check
import { defineConfig, envField } from "astro/config";

import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  output: "server",
  integrations: [react(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
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
