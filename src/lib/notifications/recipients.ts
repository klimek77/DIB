import { parseEmailList } from "@/lib/email/parse-email-list";

/**
 * Resolve alert recipients from `ALLOWED_ADMIN_EMAILS` — the same single source
 * of truth as the auth allow-list (`src/lib/auth/allowlist.ts`). Reads the raw
 * Worker `env` binding rather than `astro:env/server` because the queue handler
 * runs outside any Astro request context (where `astro:env` secret access can
 * return `undefined`); both paths resolve the same Cloudflare secret.
 *
 * Deliberately NOT sourced from the `admin_allowlist` DB table: that table is
 * the RLS gate and is additive-only, so it lags on admin removal and could mail
 * a removed admin.
 *
 * Fail-closed: an unset/empty list resolves to no recipients (`[]`).
 */
export function resolveAlertRecipients(env: Env): string[] {
  return parseEmailList(env.ALLOWED_ADMIN_EMAILS);
}
