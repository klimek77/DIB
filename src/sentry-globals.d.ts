// Build-time Sentry constants injected by `vite.define` in astro.config.mjs (sentry-observability,
// Phase 3). Each is replaced with a string literal at build — the public client DSN, the commit-SHA
// release, and the environment. Absent locally → "" (the read sites coerce that to undefined so the
// SDK no-ops). Ambient/global so both the root client config and the worker options builder see them.
declare const __SENTRY_DSN__: string;
declare const __SENTRY_RELEASE__: string;
declare const __SENTRY_ENVIRONMENT__: string;
