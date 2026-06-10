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
  // Narrow the attacker-controlled `type` to the OTP types a magic-link callback can
  // carry, so an unexpected value fails fast (→ null branch) instead of reaching
  // verifyOtp as an unsound `(string & {})` value.
  const typeParam = url.searchParams.get("type");
  const type = (["magiclink", "email", "recovery", "signup"] as const).find((t) => t === typeParam);

  // Magic-link delivery shape is config-dependent: PKCE (@supabase/ssr default) sends
  // ?code=; some email templates / non-PKCE flow send token_hash + type. Handle both.
  // A transport-level throw is treated as a failed exchange (→ neutral redirect below).
  const result = await (async () => {
    try {
      if (code) return await supabase.auth.exchangeCodeForSession(code);
      if (tokenHash && type) return await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      return null;
    } catch {
      return null;
    }
  })();

  // Session-time gate: reject anything that failed, carried no recognizable param, or
  // resolved to a non-allow-listed email. Clear the session before bouncing (neutral).
  if (!result || result.error || !isAllowedAdmin(result.data.user?.email)) {
    try {
      await supabase.auth.signOut();
    } catch {
      // Ignore: we redirect to signin regardless of whether the cleanup call throws.
    }
    // signOut's cookie flush only deletes chunks visible on the REQUEST (@supabase/ssr
    // applyServerStorage enumerates getAll), so a session cookie buffered by the exchange
    // above would still ship durable on this response — a denied user would carry a
    // (server-revoked) session blob for ~400 days. Replace every buffered sb-* session
    // cookie with an explicit deletion; snapshot first because delete() mutates the map.
    for (const header of [...context.cookies.headers()]) {
      const name = header.slice(0, header.indexOf("="));
      if (/^sb-.+-auth-token(\.\d+)?$/.test(name)) {
        context.cookies.delete(name, { path: "/" });
      }
    }
    return context.redirect("/auth/signin");
  }

  return context.redirect("/dashboard");
};
