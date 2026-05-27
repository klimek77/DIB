---
bootstrapped_at: 2026-05-22T11:25:59Z
starter_id: 10x-astro-starter
starter_name: "10x Astro Starter (Astro + Supabase + Cloudflare)"
project_name: digital-idea-box
language_family: js
package_manager: npm
cwd_strategy: git-clone
bootstrapper_confidence: first-class
phase_3_status: ok
audit_command: "npm audit --json"
---

## Hand-off

Verbatim from `context/foundation/tech-stack.md`:

```yaml
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
```

### Why this stack (verbatim from hand-off body)

Solo developer shipping an anonymous employee-feedback MVP in ~3 working weeks, with admin magic-link auth, AI-powered enrichment of every submission, and asynchronous background work (per-submission enrichment, weekly digest, AI-failure alerts). The recommended default for `(web, js)` — 10x-astro-starter — clears all four agent-friendly quality gates and bundles Astro + React + TypeScript + Tailwind for the two surfaces (employee form + admin dashboard), Supabase for auth + Postgres + storage covering both the magic-link admin flow and the submission store, and Cloudflare Pages/Workers for deploy. Hard scale ceiling (~270 employees, ~80 active) means no horizontal scaling pressure — Supabase's smallest tier and Cloudflare's free/lowest paid tier are sized with room to spare. Bootstrapper confidence is first-class (not yet end-to-end verified), so expect mostly-smooth scaffolding with occasional manual steps. Cloudflare Pages chosen for deployment as the starter default for THIS MVP only — the long-term target in the host organization is an on-premise environment reachable via SSH (self-host), with that migration explicitly deferred until after the MVP ships and is validated. FR-015 network gating is a follow-up configuration via Cloudflare Access (Zero Trust) on the MVP, and trivially achievable on the on-prem environment. CI on GitHub Actions with auto-deploy-on-merge — what the starter ships with.

## Pre-scaffold verification

| Signal             | Value                                            | Severity     | Notes                                                                                          |
| ------------------ | ------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------- |
| npm package        | not run                                          | n/a          | cmd_template starts with `git clone`; no npm CLI to query                                      |
| GitHub repo        | not run                                          | unavailable  | api.github.com unreachable from this network (curl timed out — likely corporate proxy blocking api.* subdomain); `git ls-remote` to github.com itself succeeded, so the scaffold step could proceed |

## Scaffold log

**Resolved invocation**: `git clone https://github.com/przeprogramowani/10x-astro-starter .bootstrap-scaffold && cd .bootstrap-scaffold && npm install`
**Strategy**: git-clone
**Exit code**: 0
**Files moved**: 19 (10 files + 9 directories)
**Conflicts (.scaffold siblings)**: CLAUDE.md (cwd carried the project's CLAUDE.md from the 10xDevs workflow setup; the starter's CLAUDE.md landed as `CLAUDE.md.scaffold` per the conflict matrix)
**.gitignore handling**: moved silently (cwd had no pre-existing .gitignore, so the starter's .gitignore was placed without append-merge)
**.bootstrap-scaffold/.git/ removal**: deleted before move-up (starter's upstream git history not inherited)
**.bootstrap-scaffold cleanup**: deleted (directory was empty after move-up)

**Moved files / directories**:
- `.env.example` (file)
- `.github/` (directory — starter's CI workflows)
- `.gitignore` (file)
- `.husky/` (directory — git hook scaffolding)
- `.nvmrc` (file — node version pin)
- `.prettierrc.json` (file)
- `.vscode/` (directory)
- `README.md` (file)
- `astro.config.mjs` (file)
- `components.json` (file)
- `eslint.config.js` (file)
- `node_modules/` (directory — 773 packages, ~895 total deps including transitive)
- `package-lock.json` (file)
- `package.json` (file)
- `public/` (directory)
- `src/` (directory)
- `supabase/` (directory)
- `tsconfig.json` (file)
- `wrangler.jsonc` (file)

**npm install warnings (informational, install succeeded)**:
- `@babel/plugin-proposal-private-methods@7.18.6` deprecated → use `@babel/plugin-transform-private-methods`
- `node-domexception@1.0.0` deprecated → use platform's native DOMException

## Post-scaffold audit

**Tool**: `npm audit --json`
**Summary**: 0 CRITICAL, 1 HIGH, 9 MODERATE, 0 LOW (total: 10)
**Direct vs transitive**: 0 CRITICAL / 0 HIGH / 1 MODERATE / 0 LOW direct of total 0 / 1 / 9 / 0 — the single HIGH finding and 8 of 9 MODERATE are transitive; 1 MODERATE (`wrangler`) is a direct dependency

**Dependency totals** (from `metadata.dependencies`): prod 449, dev 316, optional 131, peer 0, total 895

#### CRITICAL findings

(none)

#### HIGH findings

- **`devalue`** (5.6.3 – 5.8.0) — transitive (via `@cloudflare/vite-plugin` → `miniflare`). Advisory: GHSA-77vg-94rm-hx3p, "Svelte devalue: DoS via sparse array deserialization". CVSS 7.5 (network attack vector, low complexity, no privileges, no user interaction, high availability impact). `fixAvailable: true`.

#### MODERATE findings

- **`@cloudflare/vite-plugin`** — transitive cause chain through `miniflare`, `wrangler`, `ws`. `fixAvailable: true`.
- **`wrangler`** — direct dependency. Pulled in `miniflare` (vulnerable range). `fixAvailable: true`.
- **`miniflare`** — transitive. Vulnerable via `ws`. `fixAvailable: true`.
- **`ws`** (8.0.0 – 8.20.0) — transitive, two install paths (`node_modules/ws` and `node_modules/@supabase/realtime-js/node_modules/ws`). Advisory: GHSA-58qx-3vcg-4xpx, "ws: Uninitialized memory disclosure". CVSS 4.4. `fixAvailable: true`.
- **`yaml`** (2.0.0 – 2.8.2) — transitive (via `yaml-language-server` → `volar-service-yaml` → `@astrojs/check`). Advisory: GHSA-48c2-rrv3-qjmp, "yaml vulnerable to Stack Overflow via deeply nested YAML collections". CVSS 4.3. Fix available via `@astrojs/check@0.9.2` (semver-major).
- **`yaml-language-server`** — transitive. Effect of `yaml`. Fix via `@astrojs/check@0.9.2` (semver-major).
- **`volar-service-yaml`** — transitive. Effect of `yaml-language-server`. Fix via `@astrojs/check@0.9.2` (semver-major).
- **`@astrojs/check`** — transitive effect of `volar-service-yaml`. Fix is the semver-major bump to 0.9.2.
- **`@astrojs/language-server`** — transitive effect of `@astrojs/check`. Fix via `@astrojs/check@0.9.2` (semver-major).

#### LOW / INFO findings

(none)

**Note on fixes**: every finding reports `fixAvailable: true` in `npm audit --json`. The `wrangler` and Cloudflare dependency chain can likely be patched via `npm audit fix`. The `@astrojs/check` chain requires a semver-major bump (`npm audit fix --force` or a manual upgrade in `package.json`), which may introduce breaking changes; review release notes before applying.

## Hints recorded but not acted on

| Hint                       | Value                              |
| -------------------------- | ---------------------------------- |
| bootstrapper_confidence    | first-class                        |
| quality_override           | false                              |
| path_taken                 | standard                           |
| self_check_answers         | null                               |
| team_size                  | solo                               |
| deployment_target          | cloudflare-pages                   |
| ci_provider                | github-actions                     |
| ci_default_flow            | auto-deploy-on-merge               |
| has_auth                   | true                               |
| has_payments               | false                              |
| has_realtime               | false                              |
| has_ai                     | true                               |
| has_background_jobs        | true                               |

These hints were read from the hand-off but not acted on in v1 of the bootstrapper. A future agent-context skill (M1L4 — Memory Architecture) will consume them to shape `AGENTS.md` / `CLAUDE.md` and CI workflow files.

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:
- `git init` (if you have not already) to start your own repo history. The starter's upstream `.git/` was deleted during scaffolding so nothing has to be untangled.
- Review `CLAUDE.md.scaffold` against your existing `CLAUDE.md` (the project's CLAUDE.md was preserved per the conflict matrix). `diff CLAUDE.md CLAUDE.md.scaffold` will show what the starter ships vs what you had — decide whether to merge any starter-specific guidance into your existing file, then delete the `.scaffold` sibling.
- Address audit findings per your project's risk tolerance:
  - The 1 HIGH (`devalue`) and most MODERATE findings concentrate in the Cloudflare tooling chain (`wrangler`, `miniflare`, `@cloudflare/vite-plugin`); `npm audit fix` should resolve a substantial portion non-destructively.
  - The `@astrojs/check` chain needs a semver-major bump — `npm audit fix --force` will apply it, but review the changelog first.
- Configure Supabase project credentials in `.env` (copy from `.env.example`) and the Cloudflare deployment binding in `wrangler.jsonc` before the first deploy.
