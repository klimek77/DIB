import { describe, expect, it, vi } from "vitest";

import { sendEmail } from "./email";

function makeEnv(overrides: Partial<Env>): Env {
  return { ...overrides } as unknown as Env;
}

function fakeResponse(init: { ok: boolean; status: number }): Response {
  return init as unknown as Response;
}

const CONFIGURED = { RESEND_API_KEY: "re_test_key", ALERT_FROM: "alerts@firma.pl" };

describe("sendEmail — env gate (no-op when unconfigured)", () => {
  it("no-ops without a network call when RESEND_API_KEY is absent", async () => {
    const fetchImpl = vi.fn();
    const result = await sendEmail({
      to: ["admin@firma.pl"],
      subject: "s",
      text: "t",
      env: makeEnv({ ALERT_FROM: "alerts@firma.pl" }),
      fetchImpl: fetchImpl,
    });
    expect(result).toEqual({ sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no-ops without a network call when ALERT_FROM is absent", async () => {
    const fetchImpl = vi.fn();
    const result = await sendEmail({
      to: ["admin@firma.pl"],
      subject: "s",
      text: "t",
      env: makeEnv({ RESEND_API_KEY: "re_test_key" }),
      fetchImpl: fetchImpl,
    });
    expect(result).toEqual({ sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no-ops with empty recipients even when fully configured", async () => {
    const fetchImpl = vi.fn();
    const result = await sendEmail({
      to: [],
      subject: "s",
      text: "t",
      env: makeEnv(CONFIGURED),
      fetchImpl: fetchImpl,
    });
    expect(result).toEqual({ sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("sendEmail — Resend request when configured", () => {
  it("POSTs the correct Resend request shape and reports sent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
    const result = await sendEmail({
      to: ["admin@firma.pl", "boss@firma.pl"],
      subject: "Subj",
      text: "Body",
      env: makeEnv(CONFIGURED),
      fetchImpl: fetchImpl,
    });

    expect(result).toEqual({ sent: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      from: "alerts@firma.pl",
      to: ["admin@firma.pl", "boss@firma.pl"],
      subject: "Subj",
      text: "Body",
    });
  });

  it("throws on a non-2xx Resend response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ ok: false, status: 422 }));
    await expect(
      sendEmail({
        to: ["admin@firma.pl"],
        subject: "s",
        text: "t",
        env: makeEnv(CONFIGURED),
        fetchImpl: fetchImpl,
      }),
    ).rejects.toThrow(/422/);
  });
});
