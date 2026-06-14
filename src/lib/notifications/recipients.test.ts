import { describe, expect, it } from "vitest";

import { resolveAlertRecipients } from "./recipients";

function makeEnv(value: string | undefined): Env {
  return { ALLOWED_ADMIN_EMAILS: value } as unknown as Env;
}

describe("resolveAlertRecipients", () => {
  it("parses a comma-separated list", () => {
    expect(resolveAlertRecipients(makeEnv("admin@firma.pl,boss@firma.pl"))).toEqual([
      "admin@firma.pl",
      "boss@firma.pl",
    ]);
  });

  it("trims whitespace and lowercases entries", () => {
    expect(resolveAlertRecipients(makeEnv("  Admin@Firma.PL , BOSS@firma.pl "))).toEqual([
      "admin@firma.pl",
      "boss@firma.pl",
    ]);
  });

  it("drops empty / whitespace-only entries", () => {
    expect(resolveAlertRecipients(makeEnv("  , ,admin@firma.pl, "))).toEqual(["admin@firma.pl"]);
  });

  it("returns [] (fail-closed) for an empty string", () => {
    expect(resolveAlertRecipients(makeEnv(""))).toEqual([]);
  });

  it("returns [] (fail-closed) for an unset value", () => {
    expect(resolveAlertRecipients(makeEnv(undefined))).toEqual([]);
  });
});
