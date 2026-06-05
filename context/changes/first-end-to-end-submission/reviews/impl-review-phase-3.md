<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-01 first-end-to-end-submission

- **Plan**: context/changes/first-end-to-end-submission/plan.md
- **Scope**: Phase 3 of 5
- **Date**: 2026-06-05
- **Verdict**: REJECTED at review → all 4 findings FIXED in triage (2026-06-05)
- **Findings**: 1 critical, 1 warning, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Findings

### F1 — Google Fonts @import leaks every anonymous visitor's IP to Google

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (Privacy / Data-safety)
- **Location**: src/styles/global.css:3
- **Detail**: `@import url("https://fonts.googleapis.com/css2?family=DM+Sans...")` loads via global.css (imported unconditionally by Layout.astro:2), so it runs on the public anonymous surfaces `/`, `/submit`, `/submit-success`. Each visitor's browser then requests fonts.googleapis.com + fonts.gstatic.com, sending IP + User-Agent to Google — contradicting the Welcome trust-footer's "🚫 Bez śledzenia" / "🔒 Szyfrowane połączenie" (Welcome.astro:33,35) and the "nie zapisujemy … adresu IP" hero copy (Welcome.astro:19). Anonymity is the product's core guarantee.
- **Fix A ⭐ Recommended**: Self-host DM Sans (@fontsource-variable/dm-sans); remove remote @import, import local font in global.css.
  - Strength: Keeps exact design-§4.1 font AND removes the third-party request; honours "Bez śledzenia".
  - Tradeoff: Adds one npm dependency + bundles a woff2; small build step (global.css + package.json).
  - Confidence: HIGH — @fontsource is the standard Astro self-host path; --font-dm-sans token already wired.
  - Blind spot: Haven't confirmed the Cloudflare adapter bundles the woff2 cleanly — verify after.
- **Fix B**: Drop the webfont; map --font-dm-sans to a system sans stack ("DM Sans", ui-sans-serif, system-ui, sans-serif).
  - Strength: Zero third-party request, zero new dependency; design lineage already tolerated a font fallback.
  - Tradeoff: Public form world renders in a system font unless DM Sans is locally installed — drift from §4.1.
  - Confidence: HIGH — pure CSS edit, no build risk.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix A — installed @fontsource-variable/dm-sans, replaced remote @import with `@import "@fontsource-variable/dm-sans"`, token → "DM Sans Variable". Build verified: zero googleapis refs in dist/, woff2 (latin + latin-ext) bundled locally.

### F2 — Topbar.astro is now orphaned dead code

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/Topbar.astro (whole file)
- **Detail**: The old Welcome.astro imported Topbar; the rewrite dropped it and a grep for "Topbar" across src/ returns zero matches. It still renders sign-in/Dashboard/Sign-out admin nav with no mount point. Project rule "Feature usunięty → code usunięty (zero osieroconych plików)" applies.
- **Fix**: Delete src/components/Topbar.astro (zero importers confirmed). If Phase 5's admin surface will reuse the nav, instead park it with a one-line "unused — reserved for admin topbar" note.
- **Decision**: FIXED — deleted src/components/Topbar.astro (git rm; grep reconfirmed zero importers).

### F3 — Footer trust-emoji lack aria-hidden (inconsistent with same diff)

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency (A11y)
- **Location**: src/components/Welcome.astro:33-35
- **Detail**: The 🔒/👤/🚫 emoji sit inline as content with no aria-hidden, so screen readers announce "locked, …". Not info-losing (Polish text carries meaning) but inconsistent: the `→` (Welcome:28) and `✓` (submit-success:14) in the same diff are correctly aria-hidden.
- **Fix**: Wrap each leading footer emoji in <span aria-hidden="true"> to match the →/✓ treatment.
- **Decision**: FIXED — wrapped 🔒/👤/🚫 in <span aria-hidden="true"> (Welcome.astro:33-35).

### F4 — Form-world gradient repeated verbatim instead of a @utility

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: Welcome.astro:7, submit.astro:10, submit-success.astro:8
- **Detail**: `bg-gradient-to-br from-[#0f1923] via-[#1a2a3a] to-[#0d2137]` is copied across 3 pages and will repeat in Phase 4/5. The repo already has the `bg-cosmic` @utility as the precedent for exactly this; literal hex strings spread across files can drift.
- **Fix**: Promote it to a `@utility bg-form-world` in global.css (mirrors bg-cosmic); the form-world pages share one source of truth.
- **Decision**: FIXED — added `@utility bg-form-world` to global.css; replaced the literal gradient in Welcome.astro / submit.astro / submit-success.astro. Build verified the utility compiles into Layout CSS.
