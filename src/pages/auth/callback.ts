import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { isAllowedAdmin } from "@/lib/auth/allowlist";

export const GET: APIRoute = async (context) => {
  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent("Supabase is not configured")}`);
  }

  const url = new URL(context.request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");

  // Magic-link delivery shape is config-dependent: PKCE (@supabase/ssr default) sends
  // ?code=; some email templates / non-PKCE flow send token_hash + type. Handle both.
  const result = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      : null;

  // Session-time gate: reject anything that failed, carried no recognizable param, or
  // resolved to a non-allow-listed email. Clear the session before bouncing (neutral).
  if (!result || result.error || !isAllowedAdmin(result.data.user?.email)) {
    await supabase.auth.signOut();
    return context.redirect("/auth/signin");
  }

  return context.redirect("/dashboard");
};
