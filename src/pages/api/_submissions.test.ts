import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";

import type { Database } from "@/lib/database.types";
import { createAdminClient } from "@/lib/enrichment/supabase-admin";
import { BRANCHES, TOPICS } from "@/lib/submissions/taxonomies";

import { POST } from "./submissions";

// `queueSend` stands in for the real QUEUE binding. enqueueEnrichment is NOT mocked — the real
// helper runs and calls this through the mocked env, so the test exercises the actual
// insert→id→enqueue wiring. vi.hoisted lets the mock factory (hoisted above imports) reference it.
const { queueSend, mockEnv } = vi.hoisted(() => {
  const queueSend = vi.fn<(msg: { submissionId: string }) => Promise<void>>();
  // Mutable so the instant-notify edge tests can flip on the Resend secrets + allow-list, then
  // strip them in afterEach. Default (no secrets) keeps notify a fail-closed no-op for every other test.
  const mockEnv: Record<string, unknown> = {
    QUEUE: { send: queueSend },
    SUPABASE_URL: "https://stub.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  };
  return { queueSend, mockEnv };
});

// Astro v6 removed locals.runtime.env; the route reads bindings via @/lib/runtime-env, which wraps
// `cloudflare:workers` (unloadable in vitest). Mocking the wrapper keeps the virtual module out of
// the test entirely while still injecting a controllable QUEUE + the notify-channel secrets.
vi.mock("@/lib/runtime-env", () => ({ env: mockEnv }));

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
          // The route reads back `id` + `created_at` (select widened for the instant-notify
          // timestamp). Default created_at so success-path tests that set only `{ id }` still
          // satisfy the read; a test may override it. Error cases (data: null) pass through.
          if (result.data !== null && typeof result.data === "object") {
            return Promise.resolve({
              data: { created_at: "2026-06-15T10:00:00.000Z", ...(result.data as Record<string, unknown>) },
              error: result.error,
            });
          }
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
  // Synthetic cfContext.waitUntil — the route dispatches the instant-notify through it
  // unconditionally on success (no `?.`); without this every success-path test would throw.
  return { request, locals: { cfContext: { waitUntil: vi.fn() } } } as unknown as Parameters<typeof POST>[0];
}

// A context whose client-identity accessors EXPLODE when touched. Proves the handler never *reads*
// IP / cookies (anonymity is "not read", a stronger guarantee than "not logged"): if a future edit
// reaches for context.clientAddress or context.cookies, the getter throws and the POST rejects.
function makeParanoidContext(payload: unknown): Parameters<typeof POST>[0] {
  const request = new Request("https://example.test/api/submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const ctx: { request: Request; locals: { cfContext: { waitUntil: ReturnType<typeof vi.fn> } } } = {
    request,
    locals: { cfContext: { waitUntil: vi.fn() } },
  };
  Object.defineProperty(ctx, "clientAddress", {
    get() {
      throw new Error("anonymity violation: handler read context.clientAddress");
    },
  });
  Object.defineProperty(ctx, "cookies", {
    get() {
      throw new Error("anonymity violation: handler read context.cookies");
    },
  });
  return ctx as unknown as Parameters<typeof POST>[0];
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

// Fake Resend response — sendEmail reads only `.ok`/`.status` (mirrors email.test.ts).
function fakeResponse(init: { ok: boolean; status: number }): Response {
  return init as unknown as Response;
}

// Flip the instant-notify channel on (Resend secrets + a two-admin allow-list). Stripped in afterEach.
function configureNotifyChannel() {
  mockEnv.RESEND_API_KEY = "re_test_key";
  mockEnv.ALERT_FROM = "alerts@firma.pl";
  mockEnv.ALLOWED_ADMIN_EMAILS = "admin@firma.pl,boss@firma.pl";
}

// The synthetic waitUntil planted on the context by makeContext/makeParanoidContext. Cast to a
// property-typed Mock (not the lib's method signature) so reading it doesn't trip `unbound-method`.
type WaitUntilMock = Mock<(promise: Promise<unknown>) => void>;
function waitUntilOf(ctx: Parameters<typeof POST>[0]): WaitUntilMock {
  return (ctx.locals.cfContext as unknown as { waitUntil: WaitUntilMock }).waitUntil;
}

// Resend `fetch` edge — stubbed per notify test, restored in afterEach.
let fetchSpy: MockInstance<typeof fetch> | undefined;

beforeEach(() => {
  queueSend.mockReset();
  queueSend.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.mocked(createAdminClient).mockReset();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  delete mockEnv.RESEND_API_KEY;
  delete mockEnv.ALERT_FROM;
  delete mockEnv.ALLOWED_ADMIN_EMAILS;
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

  it("keeps valid optionals while stripping injected keys (exact 6-key whitelist at the service-role boundary)", async () => {
    const inserts = mockInsert({ data: { id: "row-combined" }, error: null });
    const log = captureConsole();

    await POST(
      makeContext(
        validPayload({
          department: "IT",
          signature: "Jan K.",
          id: "client-supplied-id",
          ai_title: "pwned",
          ai_classification: "skarga",
          enrichment_status: "done",
          enrichment_attempts: 99,
        }),
      ),
    );

    const inserted = inserts[0];
    // The service-role insert bypasses the column grant, so the inserted key set must be exactly
    // the whitelist even when valid optionals and hostile keys arrive together.
    expect(Object.keys(inserted).sort()).toEqual([
      "branch",
      "content",
      "department",
      "enrichment_status",
      "signature",
      "topic",
    ]);
    expect(inserted.enrichment_status).toBe("pending");
    expect(inserted.department).toBe("IT");
    expect(inserted.signature).toBe("Jan K.");
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

  it("returns the exact static 500 body and echoes no submitted field (#2 no-echo on error)", async () => {
    mockInsert({ data: null, error: { message: "db down" } });
    const log = captureConsole();

    // Distinctive PII-shaped values; a leak would surface them verbatim in the error body.
    const CONTENT_SENTINEL = "WRAŻLIWA-TREŚĆ-NIE-ECHO-12345";
    const SIGNATURE_SENTINEL = "Podpis-Sygnatariusza-XYZ";
    const res = await POST(makeContext(validPayload({ content: CONTENT_SENTINEL, signature: SIGNATURE_SENTINEL })));
    const text = await res.clone().text();

    expect(res.status).toBe(500);
    // Body is the exact static Polish string from submissions.ts — no payload interpolation.
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "Nie udało się zapisać zgłoszenia. Spróbuj ponownie.",
    });
    // content / signature are free-text and interpolation-prone — pinned by unique sentinels.
    expect(text).not.toContain(CONTENT_SENTINEL);
    expect(text).not.toContain(SIGNATURE_SENTINEL);
    // branch is enum-validated so it can't carry a sentinel; this guards against a future
    // change that templates the branch value into the (currently static) error body.
    expect(text).not.toContain(BRANCHES[0]);
    log.restore();
  });

  it("still returns success when enqueue fails — row durable as pending + a static failure event logged", async () => {
    const inserts = mockInsert({ data: { id: "row-9" }, error: null });
    queueSend.mockRejectedValueOnce(new Error("queue unreachable"));
    const log = captureConsole();

    const res = await POST(makeContext(validPayload()));

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(queueSend).toHaveBeenCalledTimes(1);
    // The row was persisted as `pending` BEFORE the (failed) enqueue — recoverable by a status-scan
    // (the deferred re-enqueue sweep), never silently lost from the DB. "200 == saved+queued" is false:
    // 201 means saved AND (queued OR enqueue silently failed).
    expect(inserts[0].enrichment_status).toBe("pending");
    // A static, id-less failure event is logged (forensic only; recovery is by status, not this line).
    expect(
      log.lines.some(
        (l) => l.includes('"event":"submission_enqueue_failed"') && l.includes('"reason":"queue_send_error"'),
      ),
    ).toBe(true);
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

  it("never reads context.clientAddress or context.cookies (a valid POST still succeeds)", async () => {
    mockInsert({ data: { id: "row-paranoid" }, error: null });
    const log = captureConsole();

    // If the handler touched either client-identity accessor, its getter would throw and POST
    // would reject — so reaching a 201 proves neither was read.
    const res = await POST(makeParanoidContext(validPayload()));

    expect(res.status).toBe(201);
    log.restore();
  });
});

describe("POST /api/submissions — instant-notify dispatch (S-04 / FR-016)", () => {
  it("dispatches the notification exactly once via cfContext.waitUntil on success", async () => {
    mockInsert({ data: { id: "row-n1" }, error: null });
    const log = captureConsole();

    const ctx = makeContext(validPayload());
    const res = await POST(ctx);

    expect(res.status).toBe(201);
    expect(waitUntilOf(ctx)).toHaveBeenCalledTimes(1);
    log.restore();
  });

  it("still dispatches notify when the enqueue fails — placement is independent of the enqueue block", async () => {
    // Notify is dispatched BEFORE the enqueue try/catch; an enqueue failure must never skip it
    // (regression fence against a future reorder — the plan's "enqueue ⊥ notify" guarantee).
    mockInsert({ data: { id: "row-n5" }, error: null });
    queueSend.mockRejectedValueOnce(new Error("queue unreachable"));
    const log = captureConsole();

    const ctx = makeContext(validPayload());
    const res = await POST(ctx);

    expect(res.status).toBe(201);
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(waitUntilOf(ctx)).toHaveBeenCalledTimes(1);
    log.restore();
  });

  it("the deferred send reaches the Resend edge with a safe body only (no content/signature)", async () => {
    configureNotifyChannel();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
    mockInsert({ data: { id: "row-n2", created_at: "2026-06-15T12:00:00.000Z" }, error: null });
    const log = captureConsole();

    // Free-text deanonymizers planted on the submission; the email must never carry them.
    const CONTENT_SENTINEL = "WRAŻLIWA-TREŚĆ-NIE-W-MAILU";
    const SIGNATURE_SENTINEL = "Podpis-Nadawcy-XYZ";
    const ctx = makeContext(
      validPayload({ department: "IT", content: CONTENT_SENTINEL, signature: SIGNATURE_SENTINEL }),
    );
    const res = await POST(ctx);
    expect(res.status).toBe(201);

    // Await the promise handed to waitUntil so the deferred send completes before asserting.
    await waitUntilOf(ctx).mock.calls[0][0];

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body as string) as { to: string[]; subject: string; text: string };
    // Recipients resolved from the allow-list; safe submission attributes present.
    expect(body.to).toEqual(["admin@firma.pl", "boss@firma.pl"]);
    expect(body.text).toContain(`Oddział: ${BRANCHES[0]}`);
    expect(body.text).toContain("Dział: IT");
    expect(body.text).toContain("/dashboard/submissions/row-n2");
    // Anonymity at the external store (the inbox): deanonymizers must be absent from the whole payload.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(CONTENT_SENTINEL);
    expect(serialized).not.toContain(SIGNATURE_SENTINEL);
    log.restore();
  });

  it("no-ops the send (no Resend call) with no recipients/secrets — the 201 still returns", async () => {
    // Default mockEnv carries no Resend secrets / allow-list → fail-closed no-op.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
    mockInsert({ data: { id: "row-n3" }, error: null });
    const log = captureConsole();

    const ctx = makeContext(validPayload());
    const res = await POST(ctx);

    expect(res.status).toBe(201);
    await waitUntilOf(ctx).mock.calls[0][0];
    expect(fetchSpy).not.toHaveBeenCalled();
    log.restore();
  });

  it("does not dispatch notify on a 400 validation error", async () => {
    mockInsert({ data: { id: "never" }, error: null });
    const log = captureConsole();

    const { branch: _omit, ...rest } = validPayload();
    void _omit;
    const ctx = makeContext(rest);
    const res = await POST(ctx);

    expect(res.status).toBe(400);
    expect(waitUntilOf(ctx)).not.toHaveBeenCalled();
    log.restore();
  });

  it("does not dispatch notify on a 500 insert error", async () => {
    mockInsert({ data: null, error: { message: "db down" } });
    const log = captureConsole();

    const ctx = makeContext(validPayload());
    const res = await POST(ctx);

    expect(res.status).toBe(500);
    expect(waitUntilOf(ctx)).not.toHaveBeenCalled();
    log.restore();
  });

  it("a failing send is swallowed (id-less marker) and never changes the 201", async () => {
    configureNotifyChannel();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(fakeResponse({ ok: false, status: 500 }));
    mockInsert({ data: { id: "row-n4" }, error: null });
    const log = captureConsole();

    const ctx = makeContext(validPayload());
    const res = await POST(ctx);

    expect(res.status).toBe(201);
    // The orchestrator swallows the Resend failure — the deferred promise still resolves.
    await expect(waitUntilOf(ctx).mock.calls[0][0]).resolves.toBeUndefined();
    expect(log.lines.some((l) => l.includes('"event":"new_submission_notify_failed"'))).toBe(true);
    // The failure marker is id-less (anonymity): no submission id rides the log line.
    expect(log.lines.join("\n")).not.toContain("row-n4");
    log.restore();
  });
});
