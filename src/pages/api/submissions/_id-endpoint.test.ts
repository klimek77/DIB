import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock ONLY the edges (test-plan §6.2): the SSR cookie-client factory and the allow-list gate.
// Internal modules (the validator) run for real — the test exercises the actual whitelist wiring.
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createClient }));

const { isAllowedAdmin } = vi.hoisted(() => ({ isAllowedAdmin: vi.fn<(email?: string | null) => boolean>() }));
vi.mock("@/lib/auth/allowlist", () => ({ isAllowedAdmin }));

import { DELETE, PATCH } from "./[id]";

const APP_ORIGIN = "https://app.test";

// A chainable SSR-client stub for `.from(t).update(v).eq(c,v).select(c).maybeSingle()` and
// `.from(t).delete().eq(c,v).select(c).maybeSingle()`. Records the update payload (to prove the
// SET carries ONLY review_status) and the verb/eq calls (to prove DELETE targets the id).
function makeSupabase(result: { data: unknown; error: unknown }) {
  const updates: Record<string, unknown>[] = [];
  const calls = { update: 0, delete: 0, eqColumn: "", eqValue: "" };
  const builder = {
    update(values: Record<string, unknown>) {
      calls.update++;
      updates.push(values);
      return builder;
    },
    delete() {
      calls.delete++;
      return builder;
    },
    eq(column: string, value: string) {
      calls.eqColumn = column;
      calls.eqValue = value;
      return builder;
    },
    select(_columns: unknown) {
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(result);
    },
  };
  const client = { from: (_table: string) => builder };
  return { client, updates, calls };
}

function mockClient(result: { data: unknown; error: unknown }) {
  const { client, updates, calls } = makeSupabase(result);
  vi.mocked(createClient).mockReturnValue(client);
  return { updates, calls };
}

interface ContextOpts {
  method: "PATCH" | "DELETE";
  id?: string;
  // Origin header: omit the field → same-origin (default); `null` → header absent; a string → that origin.
  origin?: string | null;
  user?: { email?: string } | null;
  body?: unknown;
  rawBody?: string;
}

function makeContext(opts: ContextOpts): APIContext {
  const id = opts.id ?? "row-1";
  const url = `${APP_ORIGIN}/api/submissions/${id}`;
  const headers = new Headers({ "Content-Type": "application/json" });
  const originValue = "origin" in opts ? opts.origin : APP_ORIGIN;
  if (originValue !== null && originValue !== undefined) {
    headers.set("Origin", originValue);
  }
  const init: RequestInit = { method: opts.method, headers };
  if (opts.method === "PATCH") {
    init.body = opts.rawBody ?? JSON.stringify(opts.body ?? {});
  }
  const request = new Request(url, init);
  return {
    request,
    params: { id },
    locals: { user: opts.user ?? null },
    cookies: {},
  } as unknown as APIContext;
}

beforeEach(() => {
  createClient.mockReset();
  isAllowedAdmin.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PATCH /api/submissions/[id] — guard", () => {
  it("returns 403 and never touches the DB for an unauthenticated request", async () => {
    isAllowedAdmin.mockReturnValue(false);
    const res = await PATCH(makeContext({ method: "PATCH", user: null, body: { review_status: "reviewed" } }));

    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 403 for an authenticated non-admin", async () => {
    isAllowedAdmin.mockReturnValue(false);
    const res = await PATCH(
      makeContext({ method: "PATCH", user: { email: "user@firma.pl" }, body: { review_status: "reviewed" } }),
    );

    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 403 for a cross-origin request even from an admin (origin checked first)", async () => {
    isAllowedAdmin.mockReturnValue(true);
    const res = await PATCH(
      makeContext({
        method: "PATCH",
        origin: "https://evil.test",
        user: { email: "admin@firma.pl" },
        body: { review_status: "reviewed" },
      }),
    );

    expect(res.status).toBe(403);
    // Origin is the first gate: a forged request never reaches the admin check or the DB.
    expect(isAllowedAdmin).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 403 when the Origin header is absent", async () => {
    isAllowedAdmin.mockReturnValue(true);
    const res = await PATCH(
      makeContext({
        method: "PATCH",
        origin: null,
        user: { email: "admin@firma.pl" },
        body: { review_status: "reviewed" },
      }),
    );

    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/submissions/[id] — validation", () => {
  it("returns 400 and never touches the DB for a status outside the taxonomy", async () => {
    isAllowedAdmin.mockReturnValue(true);
    const res = await PATCH(
      makeContext({ method: "PATCH", user: { email: "admin@firma.pl" }, body: { review_status: "archived" } }),
    );

    expect(res.status).toBe(400);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 400 for an unparseable JSON body", async () => {
    isAllowedAdmin.mockReturnValue(true);
    const res = await PATCH(makeContext({ method: "PATCH", user: { email: "admin@firma.pl" }, rawBody: "}{not json" }));

    expect(res.status).toBe(400);
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/submissions/[id] — success path", () => {
  it("returns 200 { ok: true } and the UPDATE SET carries EXACTLY { review_status }", async () => {
    isAllowedAdmin.mockReturnValue(true);
    const { updates, calls } = mockClient({ data: { id: "row-1" }, error: null });

    const res = await PATCH(
      makeContext({
        method: "PATCH",
        id: "row-1",
        user: { email: "admin@firma.pl" },
        body: { review_status: "reviewed" },
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(calls.update).toBe(1);
    expect(updates).toHaveLength(1);
    // The column-scoped grant backstop (test-plan #3) depends on this being review_status alone.
    expect(Object.keys(updates[0]).sort()).toEqual(["review_status"]);
    expect(updates[0]).toEqual({ review_status: "reviewed" });
    expect(calls.eqColumn).toBe("id");
    expect(calls.eqValue).toBe("row-1");
  });

  it("strips injected columns — extra body keys never reach the UPDATE SET", async () => {
    isAllowedAdmin.mockReturnValue(true);
    const { updates } = mockClient({ data: { id: "row-1" }, error: null });

    await PATCH(
      makeContext({
        method: "PATCH",
        user: { email: "admin@firma.pl" },
        body: {
          review_status: "in_progress",
          content: "hacked",
          ai_title: "pwned",
          id: "client-id",
          enrichment_status: "done",
        },
      }),
    );

    expect(Object.keys(updates[0]).sort()).toEqual(["review_status"]);
    expect(updates[0]).toEqual({ review_status: "in_progress" });
  });

  it("returns 404 when the update matches no row (id absent or RLS-denied)", async () => {
    isAllowedAdmin.mockReturnValue(true);
    mockClient({ data: null, error: null });

    const res = await PATCH(
      makeContext({ method: "PATCH", user: { email: "admin@firma.pl" }, body: { review_status: "reviewed" } }),
    );

    expect(res.status).toBe(404);
  });

  it("returns 500 on a DB error", async () => {
    isAllowedAdmin.mockReturnValue(true);
    mockClient({ data: null, error: { message: "db down" } });

    const res = await PATCH(
      makeContext({ method: "PATCH", user: { email: "admin@firma.pl" }, body: { review_status: "reviewed" } }),
    );

    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/submissions/[id]", () => {
  it("returns 403 and never touches the DB for a non-admin", async () => {
    isAllowedAdmin.mockReturnValue(false);
    const res = await DELETE(makeContext({ method: "DELETE", user: { email: "user@firma.pl" } }));

    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 403 for a cross-origin request", async () => {
    isAllowedAdmin.mockReturnValue(true);
    const res = await DELETE(
      makeContext({ method: "DELETE", origin: "https://evil.test", user: { email: "admin@firma.pl" } }),
    );

    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 200 { ok: true } and calls .delete().eq('id', id) for an admin", async () => {
    isAllowedAdmin.mockReturnValue(true);
    const { calls } = mockClient({ data: { id: "row-9" }, error: null });

    const res = await DELETE(makeContext({ method: "DELETE", id: "row-9", user: { email: "admin@firma.pl" } }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(calls.delete).toBe(1);
    expect(calls.update).toBe(0);
    expect(calls.eqColumn).toBe("id");
    expect(calls.eqValue).toBe("row-9");
  });

  it("returns 404 when the delete matches no row (id absent or RLS-denied)", async () => {
    isAllowedAdmin.mockReturnValue(true);
    mockClient({ data: null, error: null });

    const res = await DELETE(makeContext({ method: "DELETE", user: { email: "admin@firma.pl" } }));

    expect(res.status).toBe(404);
  });
});
