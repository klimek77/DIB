import { afterEach, describe, expect, it, vi } from "vitest";

// allowlist.ts builds its Set ONCE at module load from ALLOWED_ADMIN_EMAILS (astro:env/server).
// A single top-level mock would freeze one list for the whole file, so each scenario resets the
// module registry, re-mocks the virtual env module with its own value, and re-imports fresh.
// Mutating the env after import would NOT rebuild the already-frozen Set — hence the re-import.
async function loadAllowlist(emails: string | undefined) {
  vi.resetModules();
  vi.doMock("astro:env/server", () => ({ ALLOWED_ADMIN_EMAILS: emails }));
  return import("./allowlist");
}

afterEach(() => {
  vi.doUnmock("astro:env/server");
  vi.resetModules();
});

describe("isAllowedAdmin — membership", () => {
  it("returns true for a configured email", async () => {
    const { isAllowedAdmin } = await loadAllowlist("admin@firma.pl,boss@firma.pl");
    expect(isAllowedAdmin("admin@firma.pl")).toBe(true);
    expect(isAllowedAdmin("boss@firma.pl")).toBe(true);
  });

  it("matches case-insensitively and trims surrounding whitespace", async () => {
    const { isAllowedAdmin } = await loadAllowlist("Admin@Firma.PL");
    expect(isAllowedAdmin("ADMIN@firma.pl")).toBe(true);
    expect(isAllowedAdmin("  admin@firma.pl  ")).toBe(true);
  });

  it("returns false for an email that is not configured (authenticated != authorized)", async () => {
    const { isAllowedAdmin } = await loadAllowlist("admin@firma.pl");
    expect(isAllowedAdmin("intruder@firma.pl")).toBe(false);
  });

  it("returns false for undefined / null / empty input (fail-closed on bad input)", async () => {
    const { isAllowedAdmin } = await loadAllowlist("admin@firma.pl");
    expect(isAllowedAdmin(undefined)).toBe(false);
    expect(isAllowedAdmin(null)).toBe(false);
    expect(isAllowedAdmin("")).toBe(false);
  });
});

describe("isAllowlistConfigured / isAllowedAdmin — fail-closed on empty list", () => {
  it("authorizes no one and reports unconfigured when ALLOWED_ADMIN_EMAILS is empty", async () => {
    const { isAllowedAdmin, isAllowlistConfigured } = await loadAllowlist("");
    expect(isAllowlistConfigured()).toBe(false);
    expect(isAllowedAdmin("admin@firma.pl")).toBe(false);
    expect(isAllowedAdmin("anyone@firma.pl")).toBe(false);
  });

  it("treats an unset (undefined) ALLOWED_ADMIN_EMAILS the same as empty", async () => {
    const { isAllowedAdmin, isAllowlistConfigured } = await loadAllowlist(undefined);
    expect(isAllowlistConfigured()).toBe(false);
    expect(isAllowedAdmin("admin@firma.pl")).toBe(false);
  });

  it("ignores whitespace-only / empty entries when splitting the list", async () => {
    const { isAllowedAdmin, isAllowlistConfigured } = await loadAllowlist("  , ,admin@firma.pl, ");
    expect(isAllowlistConfigured()).toBe(true);
    expect(isAllowedAdmin("admin@firma.pl")).toBe(true);
  });

  it("reports configured when at least one email is present", async () => {
    const { isAllowlistConfigured } = await loadAllowlist("admin@firma.pl");
    expect(isAllowlistConfigured()).toBe(true);
  });
});

describe("isAllowedAdmin — removed admin", () => {
  it("rejects an email that was an admin in a prior config but is absent after reconfigure", async () => {
    // Was an admin under the first configuration...
    const before = await loadAllowlist("admin@firma.pl,leaver@firma.pl");
    expect(before.isAllowedAdmin("leaver@firma.pl")).toBe(true);

    // ...then removed from the list (a fresh import with the leaver dropped) → no longer authorized,
    // while a still-listed admin remains authorized. This refutes "once an admin, always an admin".
    const after = await loadAllowlist("admin@firma.pl");
    expect(after.isAllowedAdmin("leaver@firma.pl")).toBe(false);
    expect(after.isAllowedAdmin("admin@firma.pl")).toBe(true);
  });
});
