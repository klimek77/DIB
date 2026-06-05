// Access the per-Worker bindings + secrets (the global `Env` from src/worker-env.d.ts)
// from non-Worker-entry code such as Astro API routes.
//
// Astro v6 + @astrojs/cloudflare v13 REMOVED `Astro.locals.runtime.env` (it now throws —
// see node_modules/@astrojs/cloudflare/dist/utils/handler.js). `cloudflare:workers` is the
// supported replacement. We wrap it here so the route imports a plain `@/`-resolvable module
// that vitest can mock (vitest has no workerd runtime and cannot load `cloudflare:workers`).
//
// `cloudflare:workers` types `env` as the empty `Cloudflare.Env`; this project declares its
// bindings on the global `Env` interface instead, so we assert across to the project's shape.

import { env as cloudflareEnv } from "cloudflare:workers";

export const env = cloudflareEnv as unknown as Env;
