import { describe, expect, it } from "vitest";

import { DIGEST_CRON, routeScheduledCron, SWEEP_CRON } from "./route-cron";

describe("routeScheduledCron — cron → job mapping", () => {
  it("maps the */15 sweep cron to the recovery sweep", () => {
    expect(routeScheduledCron(SWEEP_CRON)).toBe("sweep");
    expect(routeScheduledCron("*/15 * * * *")).toBe("sweep");
  });

  it("maps the Monday 07:00 UTC cron to the weekly digest", () => {
    expect(routeScheduledCron(DIGEST_CRON)).toBe("digest");
    expect(routeScheduledCron("0 7 * * 1")).toBe("digest");
  });

  it("returns unknown for any unrecognized expression (config drift, no default job)", () => {
    expect(routeScheduledCron("0 0 * * *")).toBe("unknown");
    expect(routeScheduledCron("")).toBe("unknown");
    // A near-miss of a known cron must NOT silently fall through to that job.
    expect(routeScheduledCron("0 7 * * 0")).toBe("unknown");
  });
});
