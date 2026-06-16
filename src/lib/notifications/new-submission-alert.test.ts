import { afterEach, describe, expect, it, vi } from "vitest";

import { buildNewSubmissionNotification, notifyNewSubmission, type NewSubmissionNotice } from "./new-submission-alert";

const BASE_URL = "https://dib.example";

const notice: NewSubmissionNotice = {
  submissionId: "11111111-1111-1111-1111-111111111111",
  branch: "Gliwice",
  topic: "Pomysł",
  createdAt: "2026-06-15T10:00:00.000Z",
};

describe("buildNewSubmissionNotification — subject + body", () => {
  it("puts the topic in the subject", () => {
    const { subject } = buildNewSubmissionNotification(notice, BASE_URL);
    expect(subject).toBe("Nowe zgłoszenie — Pomysł");
  });

  it("lists czas / oddział / tematyka and a gated detail link", () => {
    const { text } = buildNewSubmissionNotification(notice, BASE_URL);
    expect(text).toContain("Czas: 2026-06-15T10:00:00.000Z");
    expect(text).toContain("Oddział: Gliwice");
    expect(text).toContain("Tematyka: Pomysł");
    expect(text).toContain(`Szczegóły: ${BASE_URL}/dashboard/submissions/${notice.submissionId}`);
  });
});

describe("buildNewSubmissionNotification — department line", () => {
  it("includes the dział line when a department is provided", () => {
    const { text } = buildNewSubmissionNotification({ ...notice, department: "IT" }, BASE_URL);
    expect(text).toContain("Dział: IT");
  });

  it("omits the dział line entirely when no department is provided", () => {
    const { text } = buildNewSubmissionNotification(notice, BASE_URL);
    expect(text).not.toContain("Dział:");
  });
});

describe("buildNewSubmissionNotification — anonymity shape-seal", () => {
  it("never renders content / signature even if present on the notice object", () => {
    const SECRET_CONTENT = "TOP_SECRET_SUBMISSION_BODY";
    const SECRET_SIGNATURE = "Jan Kowalski";

    // Pollute the notice with forbidden fields the typed contract does not declare.
    // The builder reads only the named safe fields, so neither may surface.
    const polluted = {
      ...notice,
      content: SECRET_CONTENT,
      signature: SECRET_SIGNATURE,
    } as unknown as NewSubmissionNotice;

    const { subject, text } = buildNewSubmissionNotification(polluted, BASE_URL);
    for (const leak of [SECRET_CONTENT, SECRET_SIGNATURE]) {
      expect(subject).not.toContain(leak);
      expect(text).not.toContain(leak);
    }
  });
});

// Edge mocking only (env + Resend `fetch`); the internal builder/recipient resolver run for real.
function makeEnv(overrides: Partial<Env>): Env {
  return { ...overrides } as unknown as Env;
}

function fakeResponse(init: { ok: boolean; status: number }): Response {
  return init as unknown as Response;
}

const CONFIGURED = {
  RESEND_API_KEY: "re_test_key",
  ALERT_FROM: "alerts@firma.pl",
  ALLOWED_ADMIN_EMAILS: "admin@firma.pl,boss@firma.pl",
};

describe("notifyNewSubmission — orchestration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-ops without sending when there are no recipients", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Channel configured but the allow-list is unset → fail-closed to no recipients.
    await notifyNewSubmission(
      makeEnv({ RESEND_API_KEY: "re_test_key", ALERT_FROM: "alerts@firma.pl" }),
      notice,
      BASE_URL,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the built payload to the resolved recipients when configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(fakeResponse({ ok: true, status: 200 }));

    await notifyNewSubmission(makeEnv(CONFIGURED), { ...notice, department: "IT" }, BASE_URL);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { to: string[]; subject: string; text: string };
    expect(body.to).toEqual(["admin@firma.pl", "boss@firma.pl"]);
    const expected = buildNewSubmissionNotification({ ...notice, department: "IT" }, BASE_URL);
    expect(body.subject).toBe(expected.subject);
    expect(body.text).toBe(expected.text);
  });

  it("swallows a send failure and logs an id-less marker (never throws)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fakeResponse({ ok: false, status: 500 }));
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      for (const a of args) if (typeof a === "string") logged.push(a);
    });

    await expect(notifyNewSubmission(makeEnv(CONFIGURED), notice, BASE_URL)).resolves.toBeUndefined();

    const marker = logged.find((l) => l.includes('"event":"new_submission_notify_failed"'));
    expect(marker).toBeDefined();
    // The marker must be id-less — no submission id rides the failure log (anonymity).
    expect(marker).not.toContain(notice.submissionId);
  });
});
