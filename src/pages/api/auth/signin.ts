import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { isAllowedAdmin } from "@/lib/auth/allowlist";

export const POST: APIRoute = async (context) => {
  const form = await context.request.formData();
  const email = ((form.get("email") as string | null) ?? "").trim();

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent("Supabase is not configured")}`);
  }

  // Request-time gate: only send a magic link to allow-listed admins. Whatever the
  // outcome, land on the neutral confirmation page so a probe cannot enumerate the
  // admin roster (request-time is one of two gates; the callback + middleware enforce
  // the allow-list again at session time).
  if (isAllowedAdmin(email)) {
    const origin = new URL(context.request.url).origin;
    await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${origin}/auth/callback`,
      },
    });
  }

  return context.redirect("/auth/check-email");
};
