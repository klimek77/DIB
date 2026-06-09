import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the two module boundaries the endpoint touches — never the Astro runtime itself.
// createClient is controlled per-test: a stub exposing auth.signInWithOtp, or null (unconfigured).
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn<() => SupabaseStub>() }));
vi.mock("@/lib/supabase", () => ({ createClient }));

// isAllowedAdmin is a controllable boolean — the allow-list *logic* (fail-closed, normalization)
// is covered by src/lib/auth/allowlist.test.ts; this suite tests the endpoint's USE of the gate.
const { isAllowedAdmin } = vi.hoisted(() => ({ isAllowedAdmin: vi.fn<(email?: string | null) => boolean>() }));
vi.mock("@/lib/auth/allowlist", () => ({ isAllowedAdmin }));

import { POST } from "./signin";

interface OtpArgs {
  email: string;
  options: { shouldCreateUser: boolean; emailRedirectTo: string };
}
type SupabaseStub = { auth: { signInWithOtp: (args: OtpArgs) => Promise<unknown> } } | null;

function stubClient() {
  const signInWithOtp = vi.fn<(args: OtpArgs) => Promise<unknown>>(() => Promise.resolve({ data: {}, error: null }));
  return { client: { auth: { signInWithOtp } }, signInWithOtp };
}

const ORIGIN = "https://app.test";

// Fabricated APIContext: a real form-encoded Request (URLSearchParams body sets the
// content-type) + a redirect vi.fn returning a 302 Response. cookies is inert — the
// handler only forwards it to createClient, which is mocked.
function makeContext(email: string | null) {
  const body = new URLSearchParams();
  if (email !== null) body.set("email", email);
  const request = new Request(`${ORIGIN}/api/auth/signin`, { method: "POST", body });
  const redirect = vi.fn((path: string) => new Response(null, { status: 302, headers: { Location: path } }));
  const context = { request, cookies: {} as Record<string, never>, redirect };
  return { context, redirect };
}

function invoke(ctx: ReturnType<typeof makeContext>) {
  return POST(ctx.context as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  createClient.mockReset();
  isAllowedAdmin.mockReset();
});

describe("POST /api/auth/signin — allow-list gates the OTP send (fail-closed before send)", () => {
  it("sends the OTP exactly once for an allow-listed email, with the origin-derived callback", async () => {
    const { client, signInWithOtp } = stubClient();
    createClient.mockReturnValue(client);
    isAllowedAdmin.mockReturnValue(true);

    const res = await invoke(makeContext("admin@firma.pl"));

    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "admin@firma.pl",
      options: { shouldCreateUser: true, emailRedirectTo: `${ORIGIN}/auth/callback` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/check-email");
  });

  it("never calls signInWithOtp for a not-allow-listed email — the gate runs BEFORE the send", async () => {
    const { client, signInWithOtp } = stubClient();
    createClient.mockReturnValue(client);
    isAllowedAdmin.mockReturnValue(false);

    const res = await invoke(makeContext("intruz@firma.pl"));

    // The gate was consulted with the submitted email (not short-circuited some other way) …
    expect(isAllowedAdmin).toHaveBeenCalledWith("intruz@firma.pl");
    // … and no email was dispatched: the spam vector is gated, not throttled.
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/check-email");
  });

  it("treats a malformed or missing email like any non-admin (no server-side format check, no send)", async () => {
    const { client, signInWithOtp } = stubClient();
    createClient.mockReturnValue(client);
    isAllowedAdmin.mockReturnValue(false);

    const malformed = await invoke(makeContext("not-an-email"));
    const missing = await invoke(makeContext(null));

    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(malformed.status).toBe(302);
    expect(malformed.headers.get("Location")).toBe("/auth/check-email");
    expect(missing.status).toBe(302);
    expect(missing.headers.get("Location")).toBe("/auth/check-email");
  });

  it("swallows a signInWithOtp transport throw — an allowed-but-erroring email still lands neutral, never a 500", async () => {
    const { client, signInWithOtp } = stubClient();
    signInWithOtp.mockRejectedValue(new Error("smtp down"));
    createClient.mockReturnValue(client);
    isAllowedAdmin.mockReturnValue(true);

    const res = await invoke(makeContext("admin@firma.pl"));

    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/check-email");
  });
});

describe("POST /api/auth/signin — non-enumeration (identical response across branches)", () => {
  it("returns one identical { status, Location } shape for allowed / denied / malformed / erroring", async () => {
    const shapes: { status: number; location: string | null }[] = [];
    const collect = (res: Response) => shapes.push({ status: res.status, location: res.headers.get("Location") });

    // Branch 1: allow-listed, send succeeds.
    const ok = stubClient();
    createClient.mockReturnValue(ok.client);
    isAllowedAdmin.mockReturnValue(true);
    collect(await invoke(makeContext("admin@firma.pl")));

    // Branch 2: not-allow-listed.
    const denied = stubClient();
    createClient.mockReturnValue(denied.client);
    isAllowedAdmin.mockReturnValue(false);
    collect(await invoke(makeContext("intruz@firma.pl")));

    // Branch 3: malformed email (server does no format validation).
    const malformed = stubClient();
    createClient.mockReturnValue(malformed.client);
    isAllowedAdmin.mockReturnValue(false);
    collect(await invoke(makeContext("not-an-email")));

    // Branch 4: allow-listed but the send throws (swallowed).
    const erroring = stubClient();
    erroring.signInWithOtp.mockRejectedValue(new Error("smtp down"));
    createClient.mockReturnValue(erroring.client);
    isAllowedAdmin.mockReturnValue(true);
    collect(await invoke(makeContext("admin@firma.pl")));

    // Every branch lands on the same neutral page with no error-bearing query param …
    for (const shape of shapes) {
      expect(shape).toEqual({ status: 302, location: "/auth/check-email" });
      expect(shape.location).not.toContain("?error=");
    }
    // … and the shapes are literally indistinguishable across branches: a probe observing
    // status + Location cannot enumerate the admin roster. (Any branch diverging from the
    // others collapses this Set to size > 1 even if the target page is later renamed.)
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
  });

  it("unconfigured client: redirects to the signin error page identically for ANY email (email-independent)", async () => {
    // createClient → null returns before the allow-list gate; the page differs from the
    // neutral branch (config error, not auth outcome) but must not vary by email.
    createClient.mockReturnValue(null);

    isAllowedAdmin.mockReturnValue(true);
    const allowed = await invoke(makeContext("admin@firma.pl"));
    isAllowedAdmin.mockReturnValue(false);
    const denied = await invoke(makeContext("intruz@firma.pl"));

    expect(allowed.status).toBe(302);
    expect(allowed.headers.get("Location")).toMatch(/^\/auth\/signin\?error=/);
    expect(denied.status).toBe(allowed.status);
    expect(denied.headers.get("Location")).toBe(allowed.headers.get("Location"));
  });
});
