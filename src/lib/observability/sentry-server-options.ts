// Shared @sentry/cloudflare options for every Worker runtime (fetch + queue + scheduled), built
// once from `env` so all handlers share identical DSN/environment/release/scrubbing config.
//
// SDK-import boundary (see plan "Capture seam, not a direct SDK import"): this module — and ONLY
// this module plus src/worker.ts — imports @sentry/cloudflare. The pure-logic enrichment/submission
// modules stay SDK-free and receive the capture seam (`captureServerError`) by injection, so they
// remain unit-testable in the node pool without loading a workerd SDK.
//
// PII safety is deny-by-default (anonymity NFR — anonymous employee feedback):
//   * `beforeSend` strips request data (URL/query/body/headers/cookies) and user/IP unconditionally,
//     and as defense-in-depth redacts any EnrichmentError-shaped exception value (its `.message` can
//     echo an OpenAI 4xx body = a slice of the user-authored submission content);
//   * `beforeBreadcrumb` drops fetch/xhr request/response bodies;
//   * the capture seam ALWAYS sends a caller-built body-free descriptor string, never a raw error.

import * as Sentry from "@sentry/cloudflare";
import type { CloudflareOptions } from "@sentry/cloudflare";

import { EnrichmentError, type ErrorKind } from "../enrichment/errors";

// Release + environment are injected at build by `vite.define` in astro.config.mjs (from the commit
// SHA / branch) — the same literals the client SDK and the source-map upload use, so events and maps
// agree. Declared in src/sentry-globals.d.ts. Empty locally ("") → coerced to undefined → the SDK
// simply omits the tag (and the DSN is absent anyway, so it no-ops entirely).
const SENTRY_RELEASE = __SENTRY_RELEASE__ || undefined;
const SENTRY_ENVIRONMENT = __SENTRY_ENVIRONMENT__ || undefined;

// Body-free descriptor for an EnrichmentError — mirrors consumer.ts's `redactError` for the
// EnrichmentError case. Kept local (3 lines) so the observability layer doesn't reach into the
// consumer's internals; both exist to ensure `.message` (OpenAI body) never leaves the process.
function redactEnrichmentError(err: EnrichmentError): string {
  return err.status !== undefined
    ? `Enrichment ${err.kind} error (HTTP ${err.status})`
    : `Enrichment ${err.kind} error`;
}

export function buildServerSentryOptions(env: Env): CloudflareOptions {
  return {
    // Falsy DSN (local dev / no secret) → the SDK no-ops; dev noise never reaches Sentry.
    dsn: env.SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
    release: SENTRY_RELEASE,
    // Errors-only MVP: no performance tracing/spans, no profiling.
    tracesSampleRate: 0,
    // Never attach IP / headers / cookies by default — anonymity is the dominant constraint.
    sendDefaultPii: false,
    beforeSend: (event, hint) => {
      // Deny-by-default: never ship request data (URL/query/body/headers/cookies) or user/IP,
      // for ANY captured event including unhandled throws auto-captured by withSentry.
      delete event.request;
      delete event.user;
      // Defense-in-depth: an EnrichmentError that somehow reaches auto-capture carries the OpenAI
      // 4xx body (= submission content) in `.message`. Overwrite every exception value with a
      // body-free descriptor. (The consumer never passes a raw EnrichmentError to a capture — this
      // only guards an uncaught escape.)
      const original = hint.originalException;
      if (original instanceof EnrichmentError && event.exception?.values) {
        const descriptor = redactEnrichmentError(original);
        for (const value of event.exception.values) {
          value.value = descriptor;
        }
      }
      return event;
    },
    beforeBreadcrumb: (breadcrumb) => {
      // Drop request/response bodies from fetch/xhr breadcrumbs — they can carry the submission
      // POST body or an OpenAI error body. (Sentry omits bodies by default; this is belt-and-braces.)
      if ((breadcrumb.category === "fetch" || breadcrumb.category === "xhr") && breadcrumb.data) {
        delete breadcrumb.data.request_body;
        delete breadcrumb.data.response_body;
        delete breadcrumb.data.body;
      }
      return breadcrumb;
    },
  };
}

// Tags carried on a server-side capture. `errorType` is the discriminator; the rest are the same
// PII-safe fields already logged on each path. `submissionId` is optional precisely so the
// submission endpoint can omit it (it keeps a stricter id-less anonymity-forensic posture).
export interface ServerCaptureTags {
  errorType: string;
  submissionId?: string;
  errorKind?: ErrorKind;
  errorStatus?: number;
  reason?: string;
}

// The injected capture seam. `descriptor` is ALWAYS a caller-built, body-free string (redactError(),
// a static DLQ message, or a static route message) — NEVER a raw error whose message could leak PII.
// Guarded: with no active Sentry client (no DSN / local dev / node tests) this is an explicit no-op,
// so the SDK-free callers can invoke it unconditionally.
export function captureServerError(descriptor: string, tags: ServerCaptureTags): void {
  try {
    if (!Sentry.getClient()) return;
    // Cast: ServerCaptureTags' values are all string | number | undefined (Sentry `Primitive`s);
    // the named-key interface just lacks the index signature `tags` is typed against.
    Sentry.captureException(new Error(descriptor), {
      tags: tags as unknown as Record<string, string | number | undefined>,
    });
  } catch {
    // Capture must never break the caller's flow (queue ack / HTTP response) — a failed
    // capture is strictly less important than the path it observes.
  }
}
