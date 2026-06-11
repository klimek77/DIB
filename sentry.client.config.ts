// Browser SDK init (sentry-observability, Phase 3). @sentry/astro auto-detects this default path and
// injects its import at the top of every page, so this runs once per page load. Errors-only — no
// Session Replay, no performance tracing — with the SAME deny-by-default PII scrubbing as the server
// (src/lib/observability/sentry-server-options.ts). Anonymity is the dominant constraint (anonymous
// employee feedback): the /api/submissions POST body carries submission content + signature and must
// never ride along on a client event.
import * as Sentry from "@sentry/astro";

// DSN / release / environment are burned in as string literals by `vite.define` in astro.config.mjs
// (declared in src/sentry-globals.d.ts) — the SAME constants the worker SDK reads, so client and
// server events share one release. Empty locally ("") → coerced to undefined below.

Sentry.init({
  // Falsy DSN (local dev / no PUBLIC_SENTRY_DSN) → the SDK no-ops; dev noise never reaches Sentry.
  dsn: __SENTRY_DSN__ || undefined,
  environment: __SENTRY_ENVIRONMENT__ || undefined,
  release: __SENTRY_RELEASE__ || undefined,
  // Errors-only MVP: no performance tracing/spans.
  tracesSampleRate: 0,
  // No Session Replay (anonymity) and nothing else added — Replay is opt-in in v10, so omitting
  // replayIntegration() keeps it out of the bundle entirely (verified by gate 3.7: no Replay bundle).
  integrations: [],
  // Never attach IP / headers by default.
  sendDefaultPii: false,
  beforeSend: (event) => {
    // Deny-by-default: never ship request data (URL/query/body/headers/cookies) or user/IP.
    delete event.request;
    delete event.user;
    return event;
  },
  beforeBreadcrumb: (breadcrumb) => {
    // Drop console breadcrumbs entirely — they carry full console.* arguments, the one
    // allow-by-default channel left; a future console.log(content) in a React component must
    // not ride along on the next client error (impl-review F4).
    if (breadcrumb.category === "console") return null;
    // Drop request/response bodies from fetch/xhr breadcrumbs — protects the /api/submissions POST
    // body (submission content + signature) from being attached to a later client error.
    if ((breadcrumb.category === "fetch" || breadcrumb.category === "xhr") && breadcrumb.data) {
      delete breadcrumb.data.request_body;
      delete breadcrumb.data.response_body;
      delete breadcrumb.data.body;
    }
    return breadcrumb;
  },
});
