import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DIGEST_CRON, routeScheduledCron, SWEEP_CRON } from "./route-cron";

// Guard the lockstep between wrangler.jsonc `triggers.crons` and the router's known
// crons (route-cron.ts). JSONC config can't import the TS constants, so a drift would
// otherwise surface only at runtime as an "unknown" no-op — silently disabling the
// recovery sweep (the "no silent submission loss" backstop, test-plan risk #4). This
// turns that drift into a test-time failure instead of a log line nobody reads.

const wranglerSource = readFileSync(fileURLToPath(new URL("../../../wrangler.jsonc", import.meta.url)), "utf8");

/** Extract `triggers.crons` string entries without a full JSONC parse (entries are plain quoted strings, no `]`). */
function wranglerCrons(): string[] {
  const arrayBody = /"crons"\s*:\s*\[([^\]]*)\]/.exec(wranglerSource)?.[1] ?? "";
  return [...arrayBody.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("wrangler.jsonc crons ↔ routeScheduledCron lockstep", () => {
  it("registers both known crons in wrangler.jsonc", () => {
    const crons = wranglerCrons();
    expect(crons).toContain(SWEEP_CRON);
    expect(crons).toContain(DIGEST_CRON);
  });

  it("maps every registered cron to a known job (no silent no-op)", () => {
    const crons = wranglerCrons();
    expect(crons.length).toBeGreaterThan(0);
    for (const cron of crons) {
      expect(routeScheduledCron(cron), `cron "${cron}" must route to a known job`).not.toBe("unknown");
    }
  });
});
