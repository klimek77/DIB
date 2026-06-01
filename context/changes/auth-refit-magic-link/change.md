---
change_id: auth-refit-magic-link
title: Auth refit — magic-link + admin allow-list (retire password/self-registration)
status: implemented
created: 2026-06-01
updated: 2026-06-01
archived_at: null
---

## Notes

from @context/foundation/roadmap.md (F-02, Stream B).

### Decisions locked during /10x-plan (2026-06-01)

- **Allow-list source:** env-var `ALLOWED_ADMIN_EMAILS` (comma-separated), in Cloudflare Workers Secrets. Matches shape-notes "konfigurowana ręcznie" + roadmap default. No DB table, no admin UI (lessons.md: don't build a consumer that doesn't exist yet).
- **Enforcement:** both layers — request-time (don't email non-allowed) AND session-time (middleware + callback reject non-allowed). The session-time check is what closes the F-01 exposure.
- **Provisioning:** `shouldCreateUser: true` — first magic-link login for an allowed email auto-creates the Supabase user; allow-list is the single source of truth.
- **Empty/unset allow-list:** fail-closed (nobody logs in) + config-status banner warning.
- **Denied UX:** neutral "if authorized, a link is on its way" (no enumeration).
- **Post-login redirect:** `/dashboard`.
- **Removal scope:** full delete of password + self-registration artifacts (PRD "bez haseł").

### F-01 forward-note (F4) resolution

The F-01 review left a note that F-02 might tighten `submissions_authenticated_select USING (true)` with an `auth.uid()`-based RLS allow-list (needing a `SET LOCAL request.jwt.claims` test recipe). **N/A for this design:** the allow-list lives in an env-var, not the DB, so there is no `auth.uid()` set to gate against. The RLS policy stays as-is; it is safe because the only principals that can obtain a Supabase session are allow-listed admins (employee path is anonymous `anon`), so `authenticated ≡ admin`. Assumption + invalidation trigger recorded in `plan.md` → Open Risks & Assumptions.
