import { defineConfig } from "vitest/config";

// Test harness for this change's own automated gates (drift-guard, enrich() mock,
// consumer idempotency/branching). All planned tests are pure-logic with mocked
// queue messages and Supabase/OpenAI clients, so they run in the default node
// environment — no `@cloudflare/vitest-pool-workers` needed. Add the workers pool
// later only if a test genuinely requires the live Workers runtime.
//
// Strategic testing/quality-gate policy remains a Module-3 concern; this is harness-only.
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
  },
});
