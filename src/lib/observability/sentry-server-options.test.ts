// Regression pin for the PII scrub — the sole enforcement point of the anonymity NFR on the
// Sentry path (impl-review F3). `buildServerSentryOptions` is a pure function, so the deny-by-
// default rules (`beforeSend` strips request/user; EnrichmentError values are redacted;
// fetch/xhr breadcrumb bodies dropped) are asserted directly in the node pool. Without this
// file, deleting `delete event.request` would be invisible to every automated gate.

import type { Breadcrumb, ErrorEvent } from "@sentry/cloudflare";
import { describe, expect, it } from "vitest";

import { EnrichmentError } from "../enrichment/errors";

import { buildServerSentryOptions, captureServerError } from "./sentry-server-options";

// Only SENTRY_DSN is read by the builder; the cast erases the unrelated Worker bindings.
const ENV = { SENTRY_DSN: "https://publickey@example.ingest.sentry.io/1" } as unknown as Env;

// The OpenAI 4xx body echoes a slice of the user-authored submission — the string that must
// never survive into a captured event (same fixture shape as consumer.test.ts).
const LEAKY = 'OpenAI returned 400: {"input":"PARKING PROPOSAL FROM JAN KOWALSKI"}';

// Narrowing assert (lint forbids non-null assertions): fails the test if the value is absent.
function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("expected value to be defined");
  return value;
}

function runBeforeSend(event: ErrorEvent, originalException?: unknown): ErrorEvent | null {
  const options = buildServerSentryOptions(ENV);
  // beforeSend is synchronous in this module; the SDK type also allows a promise, hence the cast.
  return must(options.beforeSend)(event, { originalException }) as ErrorEvent | null;
}

describe("buildServerSentryOptions — errors-only, deny-by-default posture", () => {
  it("pins dsn passthrough, tracesSampleRate 0 and sendDefaultPii false", () => {
    const options = buildServerSentryOptions(ENV);

    expect(options).toMatchObject({
      dsn: ENV.SENTRY_DSN,
      tracesSampleRate: 0,
      sendDefaultPii: false,
    });
  });

  it("beforeSend strips event.request and event.user unconditionally", () => {
    const event = {
      type: undefined,
      request: {
        url: "https://app.example/api/submissions?x=1",
        headers: { cookie: "sb-session=secret" },
        data: '{"content":"treść","signature":"Jan"}',
      },
      user: { ip_address: "10.0.0.1" },
    } as ErrorEvent;

    const result = must(runBeforeSend(event));

    expect(result.request).toBeUndefined();
    expect(result.user).toBeUndefined();
  });

  it("beforeSend overwrites every exception value of an EnrichmentError with the body-free descriptor", () => {
    const err = new EnrichmentError("permanent", LEAKY, 400);
    const event = {
      type: undefined,
      exception: { values: [{ type: "EnrichmentError", value: LEAKY }, { value: LEAKY }] },
    } as ErrorEvent;

    const result = must(runBeforeSend(event, err));

    expect(must(must(result.exception).values).map((v) => v.value)).toEqual([
      "Enrichment permanent error (HTTP 400)",
      "Enrichment permanent error (HTTP 400)",
    ]);
    expect(JSON.stringify(result)).not.toContain("PARKING PROPOSAL");
  });

  it("beforeSend redacts a status-less EnrichmentError too", () => {
    const err = new EnrichmentError("transient", LEAKY);
    const event = { type: undefined, exception: { values: [{ value: LEAKY }] } } as ErrorEvent;

    const result = must(runBeforeSend(event, err));

    expect(must(must(result.exception).values)[0].value).toBe("Enrichment transient error");
  });

  it("beforeSend leaves non-EnrichmentError exception values untouched", () => {
    const event = { type: undefined, exception: { values: [{ value: "plain failure" }] } } as ErrorEvent;

    const result = must(runBeforeSend(event, new Error("plain failure")));

    expect(must(must(result.exception).values)[0].value).toBe("plain failure");
  });

  it("beforeBreadcrumb drops fetch/xhr bodies but keeps the non-body fields", () => {
    const options = buildServerSentryOptions(ENV);
    const breadcrumb: Breadcrumb = {
      category: "fetch",
      data: {
        method: "POST",
        url: "https://app.example/api/submissions",
        status_code: 500,
        request_body: '{"content":"treść","signature":"Jan"}',
        response_body: '{"error":"boom"}',
        body: "raw",
      },
    };

    const result = must(must(options.beforeBreadcrumb)(breadcrumb));
    const data = must(result.data);

    expect(data.request_body).toBeUndefined();
    expect(data.response_body).toBeUndefined();
    expect(data.body).toBeUndefined();
    expect(data.method).toBe("POST");
    expect(data.status_code).toBe(500);
  });
});

describe("captureServerError — guarded seam", () => {
  it("is a no-throw no-op without an active Sentry client (node pool / local dev)", () => {
    expect(() => {
      captureServerError("Enrichment permanent error (HTTP 400)", {
        errorType: "permanent",
        submissionId: "id-1",
      });
    }).not.toThrow();
  });
});
