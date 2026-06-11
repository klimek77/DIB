import { defineConfig, devices } from "@playwright/test";

// E2E runner config for the /10x-e2e flow. The skill discovers this file, the single-spec
// command (`npx playwright test <file>`), and the webServer block; it does not create them.
//
// App-under-test: Astro SSR dev server on :4321. `npm run dev` is the fast path; for
// Workers-runtime fidelity swap the webServer command to `npm run preview` (wrangler
// emulation). Either way the dev/preview server needs `.dev.vars` and a running local
// Supabase (`npm run db:reset`) — see CLAUDE.md "Dev & test commands".
//
// Auth: admin is magic-link (passwordless), so storageState auth is deferred. First E2E
// risks target the anonymous submission flow (no auth). When admin coverage is needed, add a
// `setup` project that mints a Supabase session via the service-role key and writes
// storageState, then point an authed project at it via `use.storageState`.
const PORT = 4321;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // Specs live under tests/e2e (outside src/), so Vitest's `src/**/*.{test,spec}.ts` globs
  // never pick them up and these never run under Vitest.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
