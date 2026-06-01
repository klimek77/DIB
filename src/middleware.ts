import { defineMiddleware } from "astro:middleware";
import { createClient } from "@/lib/supabase";
import { isAllowedAdmin } from "@/lib/auth/allowlist";

const PROTECTED_ROUTES = ["/dashboard"];

export const onRequest = defineMiddleware(async (context, next) => {
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

  return next();
});
