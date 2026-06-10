/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// SELF is deprecated in favour of `exports` from "cloudflare:workers", but typing
// exports.default needs a generated Cloudflare.Exports augmentation (`wrangler types`)
// this repo doesn't carry. SELF stays functional and fully typed; revisit with the
// Phase 4 CI wiring.
// eslint-disable-next-line @typescript-eslint/no-deprecated
const worker = SELF;

// Contract tests for the ?code= callback path on the REAL workerd runtime. The suite
// drives the BUILT worker via SELF.fetch (vitest.workers.config.ts points the pool at
// dist/server/wrangler.json) — invoking the route handler directly with fabricated
// cookies cannot observe real Set-Cookie headers (the adapter App pipeline appends them
// after render) and would be the exact "false green" this test exists to prevent.
//
// Outbound Supabase calls are intercepted by stubbing globalThis.fetch: tests run in the
// SAME isolate as the main worker (cloudflare:test docs), so the stub covers the worker's
// supabase-js subrequests while SELF/ASSETS stay real (bindings don't go through global
// fetch). vitest-pool-workers 0.16.x removed the older `fetchMock` API; per its migration
// guide, stubbing global fetch is the supported replacement. The real @supabase/ssr
// cookie adapter and the real App pipeline stay in the path while CI stays hermetic.

// Mirror of the miniflare bindings in vitest.workers.config.ts. Hardcoded on purpose:
// if the binding override ever stops winning (e.g. .dev.vars leaking into the pool),
// the sb-testref-… cookie-name assertions fail loudly instead of silently adapting.
const SUPABASE_ORIGIN = "https://testref.supabase.co";
const STORAGE_KEY = "sb-testref-auth-token";
const VERIFIER_COOKIE = `${STORAGE_KEY}-code-verifier`;
const SESSION_COOKIE_NAME = /^sb-testref-auth-token(\.\d+)?$/;

const FAKE_CODE = "11111111-2222-3333-4444-555555555555";
const FAKE_VERIFIER = "test-code-verifier-0123456789012345678901234567890123456789";

// JWT-shaped access token: nothing verifies the signature client-side, but the shape
// keeps any decode-for-claims path in supabase-js from throwing on a bare string.
function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fakeSession(email: string) {
  const accessToken = [
    b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    b64url(
      JSON.stringify({ sub: "00000000-0000-4000-8000-000000000001", email, role: "authenticated", exp: 9999999999 }),
    ),
    "fake-signature",
  ].join(".");
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    // Far future so no code path tries a token refresh (a second, unmocked call).
    expires_at: 9999999999,
    refresh_token: "fake-refresh-token",
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      aud: "authenticated",
      role: "authenticated",
      email,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      identities: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

// Outbound-fetch interceptor state, reset per test. `sessionEmail` configures the fake
// PKCE exchange; recorded token calls let tests pin the verifier ROUND-TRIP (the value
// must be the one carried in by the inbound Cookie header — read by the real
// @supabase/ssr adapter — not anything synthesized inside the worker).
let sessionEmail: string | null = null;
let tokenCalls: { auth_code?: string; code_verifier?: string }[] = [];
let logoutCalls = 0;

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const target = `${url.origin}${url.pathname}`;
    if (target === `${SUPABASE_ORIGIN}/auth/v1/token` && request.method === "POST" && sessionEmail) {
      tokenCalls.push(await request.json());
      return new Response(JSON.stringify(fakeSession(sessionEmail)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (target === `${SUPABASE_ORIGIN}/auth/v1/logout` && request.method === "POST") {
      logoutCalls += 1;
      return new Response(null, { status: 204 });
    }
    // Fail closed: any other outbound request throws instead of hitting the network —
    // the suite stays hermetic (edge-only mocking policy, test-plan §6.2).
    throw new Error(`Unmocked outbound fetch: ${request.method} ${request.url}`);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sessionEmail = null;
  tokenCalls = [];
  logoutCalls = 0;
});

function fetchCallback() {
  return worker.fetch(`https://example.com/auth/callback?code=${FAKE_CODE}`, {
    headers: { Cookie: `${VERIFIER_COOKIE}=${FAKE_VERIFIER}` },
    redirect: "manual",
  });
}

interface ParsedCookie {
  name: string;
  value: string;
  attrs: Map<string, string>;
  raw: string;
}
function parseSetCookies(res: Response): ParsedCookie[] {
  return res.headers.getSetCookie().map((raw) => {
    const [nameValue = "", ...attrPairs] = raw.split(";").map((part) => part.trim());
    const eq = nameValue.indexOf("=");
    const attrs = new Map(
      attrPairs.map((pair): [string, string] => {
        const i = pair.indexOf("=");
        return i === -1 ? [pair.toLowerCase(), ""] : [pair.slice(0, i).toLowerCase(), pair.slice(i + 1)];
      }),
    );
    return { name: nameValue.slice(0, eq), value: nameValue.slice(eq + 1), attrs, raw };
  });
}
// Deletion shapes seen here: @supabase/ssr flushes `value="" + Max-Age=0`; AstroCookies
// .delete() serializes `value="deleted" + Expires=<epoch>`. Treat both as deletions.
const isDeletion = (c: ParsedCookie) =>
  c.value === "" ||
  c.value === "deleted" ||
  c.attrs.get("max-age") === "0" ||
  new Date(c.attrs.get("expires") ?? "").getTime() === 0;

describe("built worker under workerd", () => {
  // Step-zero spike (plan: Critical Implementation Details): the Cloudflare adapter must
  // resolve astro:env/server secrets from miniflare-provided bindings. If it did not,
  // createClient would return null and the callback would bounce to
  // /auth/signin?error=Supabase%20is%20not%20configured — a Location WITH an error param.
  it("reads astro:env/server secrets from miniflare bindings (config spike)", async () => {
    const res = await worker.fetch("https://example.com/auth/callback", { redirect: "manual" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/signin");
  });
});

describe("GET /auth/callback?code= — session Set-Cookie contract on a real workerd Response", () => {
  it("allow-listed exchange emits durable session cookie(s) with the @supabase/ssr default attributes", async () => {
    sessionEmail = "admin@firma.pl";

    const res = await fetchCallback();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");

    // The exchange consumed the verifier from the inbound Cookie header — the PKCE
    // handoff round-tripped through the real adapter, not a synthesized value.
    expect(tokenCalls).toEqual([{ auth_code: FAKE_CODE, code_verifier: FAKE_VERIFIER }]);

    // The session token lands as sb-<ref>-auth-token, chunked .0/.1 if it outgrows one
    // cookie. Presence + attributes are the contract; value bytes are not.
    const cookies = parseSetCookies(res);
    const sessionCookies = cookies.filter((c) => SESSION_COOKIE_NAME.test(c.name));
    expect(sessionCookies.length).toBeGreaterThanOrEqual(1);
    for (const cookie of sessionCookies) {
      expect(cookie.value).not.toBe("");
      expect(cookie.attrs.get("path")).toBe("/");
      expect(cookie.attrs.get("samesite")?.toLowerCase()).toBe("lax");
      // DEFAULT_COOKIE_OPTIONS: ~400 days. Pin durability (≈34560000s), not the exact byte.
      const maxAge = Number(cookie.attrs.get("max-age"));
      expect(maxAge).toBeGreaterThan(34_000_000);
      expect(maxAge).toBeLessThan(35_000_000);
      // No Secure (never set anywhere — would break http://localhost) and no HttpOnly
      // (@supabase/ssr default: the browser client may read the session).
      expect(cookie.attrs.has("secure")).toBe(false);
      expect(cookie.attrs.has("httponly")).toBe(false);
    }

    // The one-shot PKCE verifier is consumed by the exchange: cleared, never durable.
    const verifierCookies = cookies.filter((c) => c.name === VERIFIER_COOKIE);
    expect(verifierCookies).toHaveLength(1);
    expect(verifierCookies.every(isDeletion)).toBe(true);
  });

  it("not-allow-listed exchange signs out and redirects to signin with NO durable session cookie", async () => {
    sessionEmail = "intruz@firma.pl";

    const res = await fetchCallback();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/signin");
    // The session-time gate (callback.ts) actually cleared the session server-side.
    expect(logoutCalls).toBe(1);

    // The exchange buffered a session cookie before the gate fired; the callback's
    // explicit cleanup must have replaced it with a deletion (signOut's own flush cannot
    // see it — @supabase/ssr only deletes chunks present on the REQUEST). At least one
    // deletion must be present (proves the clearing ran), and nothing durable may ship.
    const sessionCookies = parseSetCookies(res).filter((c) => SESSION_COOKIE_NAME.test(c.name));
    expect(sessionCookies.length).toBeGreaterThanOrEqual(1);
    for (const cookie of sessionCookies) {
      expect(isDeletion(cookie)).toBe(true);
    }
  });
});
