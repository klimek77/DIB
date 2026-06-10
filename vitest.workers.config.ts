import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Workers-runtime contract tests (`*.workers.test.ts`) — a SEPARATE vitest project so the
// everyday node suite (vitest.config.ts) never pays the `workerd` boot cost. Run via
// `npm run test:workers`; the build is a prerequisite because the pool drives the BUILT
// worker (dist/server/entry.mjs via the build-generated wrangler.json) — invoking route
// handlers directly cannot produce real Set-Cookie headers (the adapter App pipeline
// appends them after render), so the built-worker path is the whole point of this project.
//
// `cloudflareTest` is the vitest-4 API of @cloudflare/vitest-pool-workers (0.16.x dropped
// the older `defineWorkersConfig` from "/config").
export default defineConfig({
  plugins: [
    cloudflareTest({
      // The build-generated config: `main` points at the compiled worker entry and the
      // queue/assets/compatibility settings mirror wrangler.jsonc exactly.
      wrangler: { configPath: "./dist/server/wrangler.json" },
      miniflare: {
        // astro:env/server secrets the worker reads at runtime. Values are test-local:
        // the Supabase origin is fake (outbound calls are intercepted by stubbing
        // global fetch) and only its hostname matters — it derives the `sb-<ref>-…`
        // cookie names. The pool ALSO loads dist/server/.dev.vars (copied by the
        // build), so every secret declared there gets a dummy override here — real
        // keys must never sit in the test isolate, even with egress stubbed.
        bindings: {
          SUPABASE_URL: "https://testref.supabase.co",
          SUPABASE_KEY: "test-anon-key",
          ALLOWED_ADMIN_EMAILS: "admin@firma.pl",
          SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
          OPENAI_API_KEY: "test-openai-key",
          ANTHROPIC_API_KEY: "test-anthropic-key",
          SUPABASE_PROJECTID: "testref",
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.workers.test.ts"],
  },
});
