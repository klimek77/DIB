import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

// Test harness config for the everyday node-env suite: pure-logic tests with mocked queue
// messages and Supabase/OpenAI clients. Workers-runtime contract tests live in a separate
// project (vitest.workers.config.ts, `npm run test:workers`) so this suite stays fast —
// `*.workers.test.ts` is excluded here and only the pool-workers project picks it up.
//
// Strategic testing/quality-gate policy remains a Module-3 concern; this is harness-only.
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    exclude: [...configDefaults.exclude, "**/*.workers.test.ts"],
  },
  // The Sentry build constants are injected by astro.config.mjs's `vite.define` only during the app
  // build. This node suite transforms source directly (no app build), so it must define them too or
  // sentry-server-options.ts throws ReferenceError on import. Empty → the read sites coerce to
  // undefined → the SDK no-ops, which is exactly the posture these pure-logic tests assert against.
  define: {
    __SENTRY_DSN__: '""',
    __SENTRY_RELEASE__: '""',
    __SENTRY_ENVIRONMENT__: '""',
  },
  // Mirror tsconfig's `@/* -> ./src/*` path alias so tests can load app modules (e.g. API routes)
  // that use the `@/` import convention. Vite does not read tsconfig `paths` without a plugin.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
