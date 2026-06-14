import { ALLOWED_ADMIN_EMAILS } from "astro:env/server";

import { parseEmailList } from "@/lib/email/parse-email-list";

/**
 * Admin allow-list, sourced from the ALLOWED_ADMIN_EMAILS env var
 * (comma-separated work emails, configured manually per shape-notes).
 *
 * Fail-closed: an empty or unset list authorizes no one. This is the single
 * source of truth for "is this email an admin?" — used by the magic-link
 * request endpoint, the auth callback, and the middleware route guard so the
 * three enforcement points cannot drift.
 */
const allowed = new Set(parseEmailList(ALLOWED_ADMIN_EMAILS));

/** True only when at least one admin email is configured. */
export function isAllowlistConfigured(): boolean {
  return allowed.size > 0;
}

/** Case-insensitive, whitespace-trimmed membership test. Empty input → false. */
export function isAllowedAdmin(email?: string | null): boolean {
  return !!email && allowed.has(email.trim().toLowerCase());
}
