import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the three module boundaries the middleware touches — never the Astro runtime itself.
// defineMiddleware becomes an identity passthrough so the imported `onRequest` is the bare
// (context, next) function we can call directly.
vi.mock("astro:middleware", () => ({ defineMiddleware: (handler: unknown) => handler }));

// createClient is controlled per-test: a stub exposing auth.getUser, or null (no SSR client).
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn<() => SupabaseStub>() }));
vi.mock("@/lib/supabase", () => ({ createClient }));

// isAllowedAdmin is a controllable boolean — this keeps the guard test independent of the
// allow-list internals (those are unit-tested separately in src/lib/auth/allowlist.test.ts).
const { isAllowedAdmin } = vi.hoisted(() => ({ isAllowedAdmin: vi.fn<(email?: string | null) => boolean>() }));
vi.mock("@/lib/auth/allowlist", () => ({ isAllowedAdmin }));

import { onRequest } from "./middleware";

type FakeUser = { email?: string; id?: string } | null;
type SupabaseStub = { auth: { getUser: () => Promise<{ data: { user: FakeUser } }> } } | null;

function stubClientWithUser(user: FakeUser): SupabaseStub {
  return { auth: { getUser: () => Promise.resolve({ data: { user } }) } };
}

interface FakeContext {
  url: URL;
  request: { headers: Headers };
  cookies: Record<string, never>;
  locals: { user?: FakeUser };
  redirect: (path: string) => Response;
}

function makeContext(pathname: string) {
  const redirect = vi.fn((path: string) => new Response(null, { status: 302, headers: { Location: path } }));
  const next = vi.fn(() => Promise.resolve(new Response("next")));
  const context: FakeContext = {
    url: new URL(`https://app.test${pathname}`),
    request: { headers: new Headers() },
    cookies: {},
    locals: {},
    redirect,
  };
  return { context, redirect, next };
}

function invoke(ctx: ReturnType<typeof makeContext>) {
  return onRequest(ctx.context as unknown as Parameters<typeof onRequest>[0], ctx.next);
}

beforeEach(() => {
  createClient.mockReset();
  isAllowedAdmin.mockReset();
});

describe("onRequest — protected-route admin guard", () => {
  it("redirects a non-admin away from the /dashboard/submissions/[id] sub-route (prefix coverage)", async () => {
    createClient.mockReturnValue(stubClientWithUser({ email: "user@firma.pl" }));
    isAllowedAdmin.mockReturnValue(false);
    const ctx = makeContext("/dashboard/submissions/abc-123");

    await invoke(ctx);

    // The /dashboard prefix must cover the detail sub-route, not just /dashboard root.
    expect(ctx.redirect).toHaveBeenCalledWith("/auth/signin");
    expect(ctx.next).not.toHaveBeenCalled();
  });

  it("lets an admin through to the /dashboard/submissions/[id] sub-route", async () => {
    createClient.mockReturnValue(stubClientWithUser({ email: "admin@firma.pl" }));
    isAllowedAdmin.mockReturnValue(true);
    const ctx = makeContext("/dashboard/submissions/abc-123");

    await invoke(ctx);

    expect(ctx.next).toHaveBeenCalledTimes(1);
    expect(ctx.redirect).not.toHaveBeenCalled();
  });

  it("still guards the /dashboard root for a non-admin", async () => {
    createClient.mockReturnValue(stubClientWithUser({ email: "user@firma.pl" }));
    isAllowedAdmin.mockReturnValue(false);
    const ctx = makeContext("/dashboard");

    await invoke(ctx);

    expect(ctx.redirect).toHaveBeenCalledWith("/auth/signin");
    expect(ctx.next).not.toHaveBeenCalled();
  });

  it("redirects an unauthenticated request on a protected path", async () => {
    // No session → getUser yields a null user; the guard treats a missing user as unauthorized.
    createClient.mockReturnValue(stubClientWithUser(null));
    isAllowedAdmin.mockReturnValue(false);
    const ctx = makeContext("/dashboard/submissions/abc-123");

    await invoke(ctx);

    expect(ctx.redirect).toHaveBeenCalledWith("/auth/signin");
    expect(ctx.next).not.toHaveBeenCalled();
  });
});

describe("onRequest — non-protected routes", () => {
  it("does not guard a public route even for a non-admin", async () => {
    createClient.mockReturnValue(stubClientWithUser({ email: "user@firma.pl" }));
    isAllowedAdmin.mockReturnValue(false);
    const ctx = makeContext("/submit");

    await invoke(ctx);

    expect(ctx.next).toHaveBeenCalledTimes(1);
    expect(ctx.redirect).not.toHaveBeenCalled();
  });
});

describe("onRequest — locals.user population", () => {
  it("sets context.locals.user from getUser()", async () => {
    const user = { email: "admin@firma.pl", id: "u-1" };
    createClient.mockReturnValue(stubClientWithUser(user));
    isAllowedAdmin.mockReturnValue(true);
    const ctx = makeContext("/dashboard");

    await invoke(ctx);

    expect(ctx.context.locals.user).toEqual(user);
  });

  it("sets context.locals.user to null and still guards when there is no Supabase client", async () => {
    createClient.mockReturnValue(null);
    isAllowedAdmin.mockReturnValue(false);
    const ctx = makeContext("/dashboard");

    await invoke(ctx);

    expect(ctx.context.locals.user).toBeNull();
    expect(ctx.redirect).toHaveBeenCalledWith("/auth/signin");
  });
});
