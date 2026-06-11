import { defineMiddleware } from "astro:middleware";
import { createClient } from "@/lib/supabase";
import { isAllowedAdmin } from "@/lib/auth/allowlist";
import { captureServerError } from "@/lib/observability/sentry-server-options";

const PROTECTED_ROUTES = ["/dashboard"];

export const onRequest = defineMiddleware(async (context, next) => {
  try {
    const supabase = createClient(context.request.headers, context.cookies);

    if (supabase) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      context.locals.user = user ?? null;
    } else {
      context.locals.user = null;
    }

    // Session-time allow-list gate: a missing user OR an authenticated-but-not-allowed
    // email (e.g. a forwarded link, or an admin since removed from the list) is treated
    // as unauthorized. This is what closes the F-01 "any authenticated user can read" gap.
    if (PROTECTED_ROUTES.some((route) => context.url.pathname.startsWith(route))) {
      if (!isAllowedAdmin(context.locals.user?.email)) {
        return context.redirect("/auth/signin");
      }
    }

    return await next();
  } catch (err) {
    // Render/SSR errors are converted to error responses by the adapter's `handle` BEFORE they
    // reach withSentry (impl-review F7) — capture here, the innermost spot that still sees the
    // throw, then re-throw so the adapter's error handling stays untouched. Body-free: the error
    // NAME only (a render error message can interpolate user-authored props); the pathname
    // carries no query string and no PII on this app's route map.
    captureServerError(`Astro render error: ${err instanceof Error ? err.name : "unknown"}`, {
      errorType: "render_error",
      reason: context.url.pathname,
    });
    throw err;
  }
});
