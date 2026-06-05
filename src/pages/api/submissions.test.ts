import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/database.types";
import { createAdminClient } from "@/lib/enrichment/supabase-admin";
import { BRANCHES, TOPICS } from "@/lib/submissions/taxonomies";

import { POST } from "./submissions";

// `queueSend` stands in for the real QUEUE binding. enqueueEnrichment is NOT mocked — the real
// helper runs and calls this through the mocked env, so the test exercises the actual
// insert→id→enqueue wiring. vi.hoisted lets the mock factory (hoisted above imports) reference it.
const { queueSend } = vi.hoisted(() => ({ queueSend: vi.fn<(msg: { submissionId: string }) => Promise<void>>() }));

// Astro v6 removed locals.runtime.env; the route reads bindings via @/lib/runtime-env, which wraps
// `cloudflare:workers` (unloadable in vitest). Mocking the wrapper keeps the virtual module out of
// the test entirely while still injecting a controllable QUEUE.
vi.mock("@/lib/runtime-env", () => ({
  env: {
    QUEUE: { send: queueSend },
    SUPABASE_URL: "https://stub.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  },
}));

// The route builds its own admin client via createAdminClient(env); mock that module so each test
// controls the insert result.
vi.mock("@/lib/enrichment/supabase-admin", () => ({
  createAdminClient: vi.fn(),
}));

// A chainable admin-client stub for `.from(t).insert(v).select(c).single()`. Records every insert
// payload so the whitelist (client ai_*/id/enrichment_status stripped) is asserted directly.
function makeAdmin(result: { data: unknown; error: unknown }) {
  const inserts: Record<string, unknown>[] = [];
  const client = {
    from(_table: string) {
      const builder = {
        insert(values: Record<string, unknown>) {
          inserts.push(values);
          return builder;
        },
        select(_cols: unknown) {
          return builder;
        },
        single() {
          return Promise.resolve(result);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, inserts };
}

// Capture console output (the route's only log transport) without leaking to stdout.
function captureConsole() {
  const lines: string[] = [];
  const sink = (...args: unknown[]) => {
    for (const a of args) if (typeof a === "string") lines.push(a);
  };
  const errSpy = vi.spyOn(console, "error").mockImplementation(sink);
  const logSpy = vi.spyOn(console, "log").mockImplementation(sink);
  return {
    lines,
    restore: () => {
      errSpy.mockRestore();
      logSpy.mockRestore();
    },
  };
}

// Sentinel client identifiers planted in the request headers/cookies. The anonymity NFR requires
// the route to never read or log them — the test asserts none appear in any logged line.
const IP_SENTINEL = "203.0.113.77";
const COOKIE_SENTINEL = "LEAK_ME_COOKIE_VALUE";

function makeContext(payload: unknown, opts: { rawBody?: string } = {}): Parameters<typeof POST>[0] {
  const request = new Request("https://example.test/api/submissions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": IP_SENTINEL,
      Cookie: `sb-session=${COOKIE_SENTINEL}`,
    },
    body: opts.rawBody ?? JSON.stringify(payload),
  });
  return { request } as unknown as Parameters<typeof POST>[0];
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    branch: BRANCHES[0],
    topic: TOPICS[0],
    content: "Proponuję powiększyć firmowy parking.",
    ...overrides,
  };
}

function mockInsert(result: { data: unknown; error: unknown }) {
  const { client, inserts } = makeAdmin(result);
  vi.mocked(createAdminClient).mockReturnValue(client);
  return inserts;
}

beforeEach(() => {
  queueSend.mockReset();
  queueSend.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.mocked(createAdminClient).mockReset();
});

describe("POST /api/submissions — whitelist on insert", () => {
  it("strips client ai_*/id/enrichment_status and inserts defaults only (pending set by caller)", async () => {
    const inserts = mockInsert({ data: { id: "row-1" }, error: null });
    const log = captureConsole();

    const res = await POST(
      makeContext(
        validPayload({
          id: "client-supplied-id",
          enrichment_status: "done",
          enrichment_attempts: 99,
          ai_title: "pwned",
          ai_tone: "Pozytywny",
          ai_classification: "skarga",
          ai_summary: "leaked",
        }),
      ),
    );

    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
    const inserted = inserts[0];
    // The caller sets pending; client-supplied enrichment_status is ignored.
    expect(inserted.enrichment_status).toBe("pending");
    // Only the user-writable fields + enrichment_status may be present.
    expect(Object.keys(inserted).sort()).toEqual(["branch", "content", "enrichment_status", "topic"]);
    expect(inserted).not.toHaveProperty("id");
    expect(inserted).not.toHaveProperty("ai_title");
    expect(inserted).not.toHaveProperty("ai_summary");
    expect(inserted).not.toHaveProperty("enrichment_attempts");
    log.restore();
  });
});

describe("POST /api/submissions — success path", () => {
  it("returns { ok: true } and enqueues exactly once with the inserted id (AI never awaited)", async () => {
    mockInsert({ data: { id: "row-42" }, error: null });
    const log = captureConsole();

    const res = await POST(makeContext(validPayload()));

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend).toHaveBeenCalledWith({ submissionId: "row-42" });
    log.restore();
  });

  it("carries an optional department + signature through to the insert", async () => {
    const inserts = mockInsert({ data: { id: "row-7" }, error: null });
    const log = captureConsole();

    await POST(makeContext(validPayload({ department: "IT", signature: "Jan K." })));

    expect(inserts[0]).toMatchObject({ department: "IT", signature: "Jan K.", enrichment_status: "pending" });
    log.restore();
  });
});

describe("POST /api/submissions — validation", () => {
  it("returns 400 and inserts nothing for an invalid body (missing branch)", async () => {
    const inserts = mockInsert({ data: { id: "never" }, error: null });
    const log = captureConsole();

    const { branch: _omit, ...rest } = validPayload();
    void _omit;
    const res = await POST(makeContext(rest));

    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
    expect(queueSend).not.toHaveBeenCalled();
    log.restore();
  });

  it("returns 400 for a bad topic and for content over 800", async () => {
    mockInsert({ data: { id: "never" }, error: null });
    const log = captureConsole();

    const badTopic = await POST(makeContext(validPayload({ topic: "NotATopic" })));
    const tooLong = await POST(makeContext(validPayload({ content: "a".repeat(801) })));

    expect(badTopic.status).toBe(400);
    expect(tooLong.status).toBe(400);
    log.restore();
  });

  it("returns 400 for an unparseable JSON body", async () => {
    mockInsert({ data: { id: "never" }, error: null });
    const log = captureConsole();

    const res = await POST(makeContext(undefined, { rawBody: "}{not json" }));

    expect(res.status).toBe(400);
    log.restore();
  });
});

describe("POST /api/submissions — failure contract (F1)", () => {
  it("returns 500 on insert failure and never enqueues (nothing saved)", async () => {
    mockInsert({ data: null, error: { message: "db down" } });
    const log = captureConsole();

    const res = await POST(makeContext(validPayload()));

    expect(res.status).toBe(500);
    expect(queueSend).not.toHaveBeenCalled();
    log.restore();
  });

  it("still returns success when enqueue fails (row is durable as pending)", async () => {
    mockInsert({ data: { id: "row-9" }, error: null });
    queueSend.mockRejectedValueOnce(new Error("queue unreachable"));
    const log = captureConsole();

    const res = await POST(makeContext(validPayload()));

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(queueSend).toHaveBeenCalledTimes(1);
    log.restore();
  });
});

describe("POST /api/submissions — anonymity (no identifier logged)", () => {
  it("never logs the request IP/header/cookie on the success or insert-failure path", async () => {
    // Success path — force the enqueue-failure log branch to fire.
    mockInsert({ data: { id: "row-anon" }, error: null });
    queueSend.mockRejectedValueOnce(new Error("force enqueue log"));
    const okLog = captureConsole();
    await POST(makeContext(validPayload()));
    const okLines = [...okLog.lines];
    okLog.restore();

    vi.mocked(createAdminClient).mockReset();

    // Insert-failure path (exercises the other log branch).
    mockInsert({ data: null, error: { message: "db down" } });
    const failLog = captureConsole();
    await POST(makeContext(validPayload()));
    const failLines = [...failLog.lines];
    failLog.restore();

    const allLogged = [...okLines, ...failLines].join("\n");
    expect(allLogged).not.toContain(IP_SENTINEL);
    expect(allLogged).not.toContain(COOKIE_SENTINEL);
    expect(allLogged).not.toContain("x-forwarded-for");
    expect(allLogged).not.toContain("Cookie");
  });
});
