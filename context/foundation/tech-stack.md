---
starter_id: 10x-astro-starter
package_manager: npm
project_name: digital-idea-box
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: first-class
  path_taken: standard
  quality_override: false
  self_check_answers: null
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: true
  has_background_jobs: true
---

## Why this stack

Solo developer shipping an anonymous employee-feedback MVP in ~3 working weeks, with admin magic-link auth, AI-powered enrichment of every submission, and asynchronous background work (per-submission enrichment, weekly digest, AI-failure alerts). The recommended default for `(web, js)` — 10x-astro-starter — clears all four agent-friendly quality gates and bundles Astro + React + TypeScript + Tailwind for the two surfaces (employee form + admin dashboard), Supabase for auth + Postgres + storage covering both the magic-link admin flow and the submission store, and Cloudflare Pages/Workers for deploy. Hard scale ceiling (~270 employees, ~80 active) means no horizontal scaling pressure — Supabase's smallest tier and Cloudflare's free/lowest paid tier are sized with room to spare. Bootstrapper confidence is first-class (not yet end-to-end verified), so expect mostly-smooth scaffolding with occasional manual steps. Cloudflare Pages chosen for deployment as the starter default for THIS MVP only — the long-term target in the host organization is an on-premise environment reachable via SSH (self-host), with that migration explicitly deferred until after the MVP ships and is validated. FR-015 network gating is a follow-up configuration via Cloudflare Access (Zero Trust) on the MVP, and trivially achievable on the on-prem environment. CI on GitHub Actions with auto-deploy-on-merge — what the starter ships with.
