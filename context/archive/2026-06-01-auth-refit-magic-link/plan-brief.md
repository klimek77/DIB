# Auth Refit — Magic-Link + Admin Allow-List — Plan Brief

> Full plan: `context/changes/auth-refit-magic-link/plan.md`

## What & Why

Replace the scaffold's email+password auth (with open self-registration) with passwordless **magic-link** login gated by a manually-configured **admin allow-list**. Implements roadmap F-02 → PRD FR-009 + Access Control. Beyond the login UX, this is the change that **closes the F-01 exposure**: `submissions_authenticated_select USING (true)` is open to any authenticated user, which is only safe once the only way to authenticate is to be an allow-listed admin.

## Starting Point

The `10x-astro-starter` scaffold ships Supabase-SSR password auth: `signInWithPassword` sign-in, **open `signUp` self-registration** (anyone can make an account), a `/dashboard` route guarded by middleware that checks only "is there a session" — never "is this email an admin". The Supabase SSR client (`src/lib/supabase.ts`) is already correctly wired for cookies and is reused unchanged.

## Desired End State

Entering an allow-listed work email on `/auth/signin` sends a magic link; opening it (same browser) lands the admin on `/dashboard`. Non-allowed emails get no email and the same neutral message (no enumeration). `/auth/signup` is gone (404), no password field exists, and an empty allow-list locks everyone out with a visible config warning.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Allow-list source | Env-var `ALLOWED_ADMIN_EMAILS` (CSV) | Matches "konfigurowana ręcznie"; no premature DB table/UI | Plan |
| Enforcement | Both request-time + session-time | Session check closes the F-01 read exposure even on forwarded links | Plan |
| Provisioning | `shouldCreateUser: true` | Allow-list is the single gate; zero manual Supabase setup | Plan |
| Empty allow-list | Fail-closed (nobody) + banner | A misconfig locks out rather than exposing data | Plan |
| Denied-email UX | Neutral message | No admin-roster enumeration | Plan |
| Post-login redirect | `/dashboard` | The admin's only destination | Plan |
| Removal scope | Full delete of password + signup | PRD "bez haseł"; kills the dual-login-path risk | Plan |
| F-01 RLS policy | Leave `USING (true)` unchanged | Allow-list is in env-var, not DB; `authenticated ≡ admin` makes it safe | Plan |

## Scope

**In scope:** magic-link request endpoint, PKCE callback, middleware allow-list gate, env-var + helper + config banner, deletion of password/self-registration endpoints, pages, and components.

**Out of scope:** F-01 RLS change, Cloudflare Access network gate (F-04), custom SMTP in code, admin-management UI/DB table, role hierarchy, password reset, rate-limiting.

## Architecture / Approach

`signin.ts` (request-time gate) → `signInWithOtp({ shouldCreateUser, emailRedirectTo: /auth/callback })` → Supabase emails a PKCE `?code=` link → `callback.ts` runs `exchangeCodeForSession` (session-time gate, sign-out if not allowed) → `/dashboard`. `middleware.ts` re-checks the allow-list on every protected request (defense in depth). A single `isAllowedAdmin()` helper backs all three points so they can't drift.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Allow-list config + helper | Env var, fail-closed `isAllowedAdmin()`, config banner | Fail-open by mistake (mitigated: explicit fail-closed + manual check) |
| 2. Swap auth path | Magic-link request, callback, middleware gate; delete `signup.ts`/`confirm-email` | Workers Set-Cookie round-trip breaks in prod (test on preview) |
| 3. Retire password UI | Email-only form; delete signup page + orphaned components; fix copy/nav | Dangling imports (caught by build) |

**Prerequisites:** none (F-02 prereqs are `—`). For full manual verification: local Supabase + Mailpit/Inbucket; `/auth/callback` added to Supabase Redirect URLs; a Cloudflare preview deploy for the cookie check.
**Estimated effort:** ~1–2 sessions across 3 phases (mostly small, focused edits + manual auth-flow verification).

## Open Risks & Assumptions

- **Only admins ever authenticate** — what makes the unchanged F-01 RLS safe; revisit RLS if employees ever get accounts.
- Magic-link emails may be **spam-filtered** → custom Supabase SMTP + IT coordination before pilot.
- **Workers Set-Cookie** quirk → verify callback on a preview deploy, not just dev.
- **PKCE same-browser** requirement; **Supabase Redirect URLs** must list `/auth/callback`.

## Success Criteria (Summary)

- Only allow-listed admins can reach `/dashboard`; non-allowed emails learn nothing (no email, neutral message).
- No password field, no self-registration, `/auth/signup` → 404.
- Empty/unset allow-list → nobody logs in + visible warning.
