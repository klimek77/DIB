/**
 * Parse a comma-separated email list (e.g. `ALLOWED_ADMIN_EMAILS`) into a
 * normalized array: comma-split → trim → lowercase → drop empties.
 *
 * Neutral, dependency-free helper so both the auth allow-list and the
 * notification recipient resolver share one parsing rule. Lives outside
 * `notifications/` on purpose — `auth/allowlist.ts` is load-bearing
 * (middleware/signin/callback) and must not import from `notifications/`.
 *
 * Fail-closed: an unset/empty input yields an empty array.
 */
export function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}
