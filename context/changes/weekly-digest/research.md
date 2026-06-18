---
date: 2026-06-18T12:45:22+02:00
researcher: Tom (klimek77)
git_commit: f0c7d1431c428a554ed3f36a1c12b0638fbc2211
branch: main
repository: klimek77/DIB
topic: "S-05 weekly-digest — reuse map: cron handler + dashboard aggregates RPC + Resend email channel"
tags: [research, codebase, weekly-digest, cron, scheduled, dashboard-aggregates, resend, notifications, dst]
status: complete
last_updated: 2026-06-18
last_updated_by: Tom (klimek77)
---

# Research: S-05 weekly-digest — reuse map for cron + aggregates + email

**Date**: 2026-06-18T12:45:22+02:00
**Researcher**: Tom (klimek77)
**Git Commit**: f0c7d1431c428a554ed3f36a1c12b0638fbc2211 (pushed to origin/main)
**Branch**: main
**Repository**: klimek77/DIB

## Research Question

S-05 `weekly-digest` (roadmap, PRD FR-017): w każdy poniedziałek 08:00 Europe/Warsaw
admin dostaje mail z podsumowaniem zgłoszeń poprzedniego tygodnia (liczba, breakdown
wg tematyki, wg oddziału, opcjonalnie top-3 wg klasyfikacji AI). Slice ma **reużyć**
trzy istniejące powierzchnie: agregaty z S-02, kanał email z S-03/S-04 oraz cron w
`src/worker.ts`. Gdzie dokładnie te rzeczy żyją, jaki mają kontrakt, i co jest
*net-new* do zaplanowania?

## Summary

**Prawie wszystko jest już zbudowane.** S-05 to integracja, nie budowa od zera:

- Działający `scheduled` (cron) handler istnieje w `src/worker.ts:97-124` (cron
  `*/15 * * * *`, recovery sweep z change `2026-06-08-submission-enqueue-recovery-sweep`).
- Agregaty: RPC `public.dashboard_aggregates(p_from, p_to, p_branch)` + klient TS
  `fetchDashboardAggregates(supabase, range)` — **wywoływalne wprost** z dowolnym oknem
  czasowym.
- Email: `sendEmail({to,subject,text,env})` (Resend przez `fetch`, env-gated no-op) +
  `resolveAlertRecipients(env)` (z `ALLOWED_ADMIN_EMAILS`, fail-closed) — **reużywalne 1:1**.
- DST: `warsawDayStartUtc(dateStr)` w `src/lib/dashboard/range.ts` liczy UTC-instant
  północy w Warszawie — to rozwiązuje wprost ryzyko „cron na UTC vs 08:00 Warszawa".

**Net-new decyzje dla `/10x-plan` (5 sztuk):**
1. **Multi-cron dispatch** — po dodaniu poniedziałkowego crona handler odpala się na
   *dwóch* harmonogramach; musi rozgałęziać po `controller.cron` (dziś go ignoruje:
   `_controller`). Żaden dokument w archiwum nie pokrywa multi-cron — to jedyny realnie
   nowy kawałek logiki w `worker.ts`.
2. **Idempotencja *wysyłki*** — projekt NIE ma żadnego trwałego dedup-store (S-03 świadomie
   go odrzucił). Sweep jest naturalnie idempotentny; *email* nie. Decyzja: zaakceptować
   rzadki double-send (nice-to-have) vs. wprowadzić pierwszy primitive dedup (tabela/KV
   keyed by ISO-week).
3. **Okno tygodniowe liczone w handlerze** (DST-safe) i przekazane jako `p_from/p_to` do
   RPC — **NIE** czytać `by_week` (patrz niżej).
4. **Top-3 wg klasyfikacji AI** (opcjonalne w roadmapie) wymaga *nowego* agregatu —
   `ai_classification` było świadomie wyłączone z S-02.
5. **Dopisać ryzyka S-05 do test-planu** (§7 test-plan: S-04/S-05 wejdą do mapy ryzyk
   przy rollout).

## Detailed Findings

### Area 1 — Cron / scheduled handler (`src/worker.ts`)

- **Handler:** `src/worker.ts:97-124` —
  `async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext)`.
  Obecnie **NIE** rozgałęzia po cronie (parametr to `_controller`) — cała logika to
  recovery sweep (jedyne scheduled-zachowanie dziś).
- **Cron config:** `wrangler.jsonc:20-22` → `"triggers": { "crons": ["*/15 * * * *"] }`.
  Wszystkie crony Cloudflare odpalają się w **UTC**. Blok `triggers` kopiuje się
  *verbatim* do zbudowanego `dist/server/wrangler.json` (`@astrojs/cloudflare` go nie
  usuwa) — ale cron rejestruje się **tylko z pliku zbudowanego**, więc po edycji trzeba
  `npm run build` + redeploy (config-not-code: cicha porażka).
- **Budowa zależności w handlerze:** `const store = createSupabaseStore(createAdminClient(env))`
  — ten sam wzorzec co queue handler. **Service-role client** (omija RLS) — kluczowe dla
  S-05 (cron nie ma usera, RPC jest RLS-gated, patrz Area 2).
- **Bindings w kontekście workera** (`src/worker-env.d.ts:16-42`): `QUEUE`, `ASSETS`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `SENTRY_DSN?`,
  `RESEND_API_KEY?`, `ALERT_FROM?`, `ALLOWED_ADMIN_EMAILS?`.
- **Dostęp do sekretów:** w handlerze (queue/cron/fetch) czyta się `env.SECRET` *wprost*
  z drugiego parametru — **NIE** przez `astro:env/server` (to wirtualizacja request-scoped
  Astro; poza requestem zwraca `undefined`). Trasy Astro używają `@/lib/runtime-env.ts`.
- **Async:** scheduled po prostu `await`-uje całość — bez `ctx.waitUntil` (nie ma klienta
  czekającego na odpowiedź). `waitUntil` jest wzorcem *tras* (`src/pages/api/submissions.ts:82`).
- **Slot-in:** nowy cron `"0 8 * * MON"` (lub `"0 7 * * 1"` — patrz DST niżej) obok
  `*/15 * * * *`; w handlerze `if (controller.cron === ...) { sweep } else if (...) { digest }`.

### Area 2 — Aggregation reuse (S-02)

- **RPC:** `public.dashboard_aggregates(p_from timestamptz, p_to timestamptz, p_branch text DEFAULT NULL) RETURNS jsonb`,
  `LANGUAGE sql STABLE SECURITY INVOKER` —
  `supabase/migrations/20260612000000_s02_dashboard_aggregates_rpc.sql:40-115`.
  - `p_from` inkluzywne (`created_at >= p_from`), `p_to` ekskluzywne (`created_at < p_to`),
    `p_branch` opcjonalne (NULL = brak filtra).
  - Zwraca jsonb: `total_range`, `total_all`, `by_topic`, `by_branch`, `by_tone`
    (`jsonb_object_agg`, `by_tone` pomija NULL), `by_week` (dokładnie 8 buckets).
  - Wszystkie predykaty `enrichment_status = 'done'` (równość → trafia w partial/composite
    index; `.in([...])` by chybił — patrz lessons.md).
- **⚠️ `by_week` jest przykuty do „bieżący tydzień ISO Warszawa + 7 poprzednich",
  NIEZALEŻNIE od `p_from/p_to`** (migracja, linie 57-66; header 31-36). Dla digestu (sumy
  pojedynczego *poprzedniego* tygodnia) **przekaż `p_from/p_to` = poprzedni tydzień
  warszawski i czytaj `total_range`/`by_topic`/`by_branch`/`by_tone` — NIE tnij `by_week`.**
- **Klient TS:** `fetchDashboardAggregates(supabase, range: ResolvedRange): Promise<DashboardAggregates>`
  — `src/lib/dashboard/aggregates.ts:81-108`. Woła `.rpc("dashboard_aggregates", {p_from, p_to, p_branch})`
  (`:85-90`), zero-fill, waliduje `byWeek.length===8`, liczy `negPct`.
- **Lista:** `fetchSubmissionsList(supabase, range, limit = 100): Promise<SubmissionListItem[]>`
  — `src/lib/dashboard/aggregates.ts:110-131`; `.eq("enrichment_status","done")` (`:120`).
- **`ResolvedRange`** (`src/lib/dashboard/range.ts:10-19`): `{ preset, fromIso, toIso, branch, label }`.
  Funkcje czytają tylko `fromIso/toIso/branch` — `preset`/`label` kosmetyczne. **Brak modyfikacji
  potrzebnej** dla S-05: zbuduj `ResolvedRange` z oknem tygodnia i wywołaj wprost.
- **⚠️ RLS gotcha:** RPC jest `SECURITY INVOKER` + RLS-gated przez `is_allowed_admin()` →
  zwraca wiersze tylko dla JWT admina. **Cron nie ma usera → S-05 MUSI wołać RPC
  service-role clientem** (`createAdminClient(env)`, omija RLS). Grant `service_role EXECUTE`
  został zostawiony *celowo pod S-05* (`2026-06-12-.../impl-review.md:38`).
- **Taksonomie:** `src/lib/submissions/taxonomies.ts:18-61` (`DEPARTMENTS`, `BRANCHES`,
  `TOPICS`, `TONES`, `ENRICHMENT_STATUSES`, `CLASSIFICATIONS`). Wartości lustrzane wobec
  CHECK z migracji `20260528` — drift diakrytyków cicho psuje INSERT-y.
- **„Top-3 AI" nie istnieje:** `by_topic` to taksonomia (Pomysł/Problem…), NIE klasyfikacja
  AI; `ai_classification` świadomie wyłączone z S-02. Opcjonalny top-3 = nowy agregat.

### Area 3 — Email channel (S-03 + S-04)

- **Transport:** `sendEmail(opts: SendEmailOptions): Promise<{ sent: boolean }>` —
  `src/lib/notifications/email.ts:27-52`. Resend przez **raw `fetch`** (POST
  `https://api.resend.com/emails`, `Bearer ${RESEND_API_KEY}`), **plain-text only**.
  - `SendEmailOptions = { to: string[]; subject: string; text: string; env: Env; fetchImpl?: typeof fetch }`.
  - **Env-gated no-op:** zwraca `{sent:false}` bez sieci gdy brak `RESEND_API_KEY` lub
    `ALERT_FROM`, albo `to` puste. **Rzuca** na non-2xx (caller łapie).
- **Recipient:** `resolveAlertRecipients(env): string[]` — `src/lib/notifications/recipients.ts:16-18`,
  parsuje `ALLOWED_ADMIN_EMAILS` przez `parseEmailList` (`src/lib/email/parse-email-list.ts:12-17`),
  **fail-closed → `[]`**. Świadomie z env-var, **NIE** z tabeli `admin_allowlist` (additive-only,
  driftuje przy usunięciu admina).
- **Wzorzec builder + orchestrator (do skopiowania dla digestu):**
  - `buildNewSubmissionNotification(notice, baseUrl): { subject, text }` —
    `src/lib/notifications/new-submission-alert.ts:31-43` (linie `\n`-joined).
  - `notifyNewSubmission(env, notice, baseUrl)` — `…:53-64`: `resolveAlertRecipients` →
    guard `to.length===0` → build → `sendEmail` w `try/catch` (log `*_notify_failed`).
  - S-03 alert builder: `buildEnrichmentFailureAlert(items)` — `src/lib/notifications/fr018-alert.ts:43-55`.
- **Dispatch S-04:** `src/pages/api/submissions.ts:82` — `context.locals.cfContext.waitUntil(notifyNewSubmission(env, notice, baseUrl))`.
  Wyciąga tylko *bezpieczne* pola (NIGDY content/signature/IP) — wzorzec anonimowości do
  zachowania w digeście.
- **Dispatch S-03:** bufor `failureBuffer` zbierany w `src/worker.ts:45-50`, flush jednym
  mailem w `src/worker.ts:73-88` (coalesce per batch).
- **Idempotencja:** S-04 brak dedup (jedno zdarzenie na insert). S-03 coalesce per batch,
  ale redelivery batcha może wysłać alert dwa razy. **Brak trwałego dedup-store w projekcie.**

### Area 4 — DST-safe weekly window (rozwiązuje flagowane ryzyko)

- **Cron na UTC.** `0 7 * * 1` = pon 08:00 Warszawa **tylko zimą**; latem (CEST, UTC+2)
  odpali 09:00 local. „policz okno wewnątrz handlera, DST-niezależnie"
  (`infrastructure.md:124-130`, `roadmap.md:190`).
- **Reużywalny primitive:** `warsawDayStartUtc(dateStr: string): Date` —
  `src/lib/dashboard/range.ts:43-80`. Czyta offset Warszawy przez `Intl.DateTimeFormat`
  (`longOffset`), odejmuje od północy UTC → UTC-instant lokalnej północy. Zero zależności
  date-lib; testowany zima +01:00 / lato +02:00 / dni przejścia DST. SQL-side analogicznie
  `date_trunc('week', … AT TIME ZONE 'Europe/Warsaw')`.
- **Okno digestu:** `from = warsawDayStartUtc(poprzedni poniedziałek)`,
  `to = warsawDayStartUtc(ten poniedziałek)` → `[from, to)` pokrywa cały kalendarzowy
  tydzień warszawski. Podaj jako `p_from/p_to` do RPC.

## Code References

- `src/worker.ts:97-124` — `scheduled` handler (recovery sweep; punkt rozszerzenia o digest)
- `src/worker.ts:45-50,73-88` — S-03 FR-018 failure buffer + flush (wzorzec coalesce email)
- `wrangler.jsonc:20-22` — `triggers.crons` (`*/15 * * * *`, UTC; kopiowane do zbudowanego configu)
- `supabase/migrations/20260612000000_s02_dashboard_aggregates_rpc.sql:40-115` — RPC `dashboard_aggregates`
- `src/lib/dashboard/aggregates.ts:81-131` — `fetchDashboardAggregates` (`:85-90` wywołanie RPC) + `fetchSubmissionsList`
- `src/lib/dashboard/range.ts:10-19` — `ResolvedRange`; `:43-80` — `warsawDayStartUtc` (DST-safe)
- `src/lib/notifications/email.ts:27-52` — `sendEmail` (Resend, env-gated)
- `src/lib/notifications/recipients.ts:16-18` — `resolveAlertRecipients` (fail-closed)
- `src/lib/email/parse-email-list.ts:12-17` — `parseEmailList`
- `src/lib/notifications/new-submission-alert.ts:31-64` — builder + orchestrator (wzorzec do digestu)
- `src/lib/notifications/fr018-alert.ts:43-55` — `buildEnrichmentFailureAlert` (templating)
- `src/lib/submissions/taxonomies.ts:18-61` — taksonomie (TOPICS/BRANCHES/TONES/CLASSIFICATIONS)
- `src/lib/enrichment/supabase-admin.ts` — `createAdminClient(env)` (service-role, omija RLS)
- `src/pages/api/submissions.ts:82` — wzorzec `cfContext.waitUntil` (kontekst, nie dla crona)
- `src/worker-env.d.ts:16-42` — `Env` (bindings/sekrety w workerze)

(HEAD `f0c7d14` jest na `origin/main` — w razie potrzeby permalinki:
`https://github.com/klimek77/DIB/blob/f0c7d1431c428a554ed3f36a1c12b0638fbc2211/<file>#L<line>`.)

## Architecture Insights

- **Jeden worker, wiele triggerów.** `src/worker.ts` to jeden entry point: SSR + queue
  consumer (+DLQ) + cron. S-05 dokleja *drugie* scheduled-zachowanie do tego samego
  handlera — stąd konieczność dispatchu po `controller.cron`.
- **Off-request kod czyta `env` wprost; on-request przez Astro env.** Granica
  worker-handler vs trasa Astro jest twarda — sekrety w cronie tylko z `env.*`.
- **RLS-gated RPC + service-role bypass jako świadomy dual-path.** Dashboard (user JWT)
  wchodzi przez RLS; backendowy konsument (cron) przez service-role. Grant pod S-05
  zostawiony intencjonalnie.
- **Anonimowość = whitelist pól w notyfikacji.** Każdy mailowy builder wyciąga tylko
  bezpieczne pola, nigdy nie spreaduje walidowanej wartości (content/podpis). Digest musi
  trzymać ten sam kontrakt (agregaty są bezpieczne; lista — tylko `ai_summary`/metadane,
  bez surowej treści/podpisu).
- **Brak dedup-store to świadoma cecha, nie luka.** S-03 odrzucił KV/tabelę. Wprowadzenie
  go w S-05 to architektoniczna decyzja (pierwszy taki primitive), nie „dorobienie".

## Historical Context (from prior changes)

- `context/archive/2026-06-08-submission-enqueue-recovery-sweep/plan.md` — **zbudował obecny
  `scheduled` handler** + cron `*/15`; omawiał wariant tygodniowego crona `0 7 * * 1` z
  caveatem UTC/DST (nie wdrożony). Najważniejszy precedens wykonawczy dla S-05.
- `context/archive/2026-06-12-admin-dashboard-aggregates/{plan.md,reviews/impl-review.md}` —
  kontrakt RPC; `by_week` przykuty do now(); grant `service_role` zostawiony *pod S-05*
  (`impl-review.md:38`); `ai_classification` wyłączone z S-02 (`plan.md:78`).
- `context/archive/2026-06-13-notification-channel-and-ai-alert/plan.md` — kanał Resend
  zbudowany tak, by „S-04 i S-05 później go reużyły" (`:76-77`); odrzucony durable dedup
  (`:82-83`); `astro:env/server` zwraca `undefined` poza requestem (`:124-128`); recipients
  = `ALLOWED_ADMIN_EMAILS`, nie `admin_allowlist` (`:84-85`); delivery validated tylko z
  `onboarding@resend.dev` (course mode, `:443`).
- `context/archive/2026-06-15-new-submission-instant-notify/plan.md` — wzorzec
  builder+orchestrator+`waitUntil`; lekcja „push migracji do prod jako krok deploy".
- `context/archive/2026-06-02-ai-enrichment-queue/plan.md:38` — „no cron / weekly digest —
  that is S-05".
- `context/foundation/lessons.md:82-101,131-136` — (a) scheduled testuje się przez
  in-worker `fetch` hook, NIE wrangler test endpoint (assets-enabled worker);
  (b) `wrangler dev` serwuje zbudowany `dist/`, nie hot-reloaduje `worker.ts` → build first
  + grep markera; (c) push migracji do prod jako jawny krok deploy.

## Related Research

- `context/archive/2026-06-12-admin-dashboard-aggregates/` (research/plan) — agregaty
- `context/archive/2026-06-13-notification-channel-and-ai-alert/` (research/plan) — email
- `context/archive/2026-06-08-submission-enqueue-recovery-sweep/` (research/plan) — cron handler
- `context/foundation/{roadmap.md:181-191, infrastructure.md:124-130, test-plan.md §7}`

## Open Questions

1. **Idempotencja wysyłki** — zaakceptować rzadki double-send (nice-to-have, najprostsze)
   czy wprowadzić pierwszy dedup-store (tabela `digest_log` keyed by ISO-week, lub KV)?
   Tabela = nowa migracja → wymaga `supabase db push` na prod (lekcja deploy). **Decyzja do
   `/10x-plan`.** Rekomendacja wstępna: najprostsze MVP = idempotencja przez zapytanie
   („czy są zgłoszenia w oknie; jeśli zero — nie wysyłaj"), bo Free tier i tak rzadko
   duplikuje, a digest nie jest krytyczny; dedup-store tylko jeśli double-send uznany za
   nieakceptowalny.
2. **Top-3 wg klasyfikacji AI** — opcjonalne w roadmapie. Pominąć w MVP (count + by-topic +
   by-branch wystarcza per FR-017) czy dodać nowy agregat na `ai_classification`?
3. **Cron expression** — `0 7 * * 1` (zima-celne) vs `0 8 * * MON`? Bez znaczenia dla
   poprawności DANYCH (okno liczone w handlerze), wpływa tylko na *godzinę dostarczenia*
   maila (zima vs lato ±1h). Wybrać jeden i udokumentować, że godzina pływa o ±1h z DST.
4. **Pusty tydzień** — czy wysyłać digest „0 zgłoszeń w tym tygodniu", czy pomijać wysyłkę?
   (Łączy się z #1 — „skip gdy zero" daje darmową quasi-idempotencję, ale gubi sygnał
   „system żyje".)
5. **Treść w liście vs tylko agregaty** — digest per FR-017 to *podsumowanie liczbowe*;
   nie powinien zawierać surowej treści zgłoszeń (anonimowość). Potwierdzić, że digest =
   agregaty + ewentualnie linki do detail view, bez `content`/podpisu.

> Następny krok: `/10x-plan weekly-digest` — plan rozstrzyga 5 open questions powyżej i
> spina 1 net-new kawałek logiki (multi-cron dispatch) z 4 reużywanymi modułami.
> Dodać ryzyka S-05 do `context/foundation/test-plan.md` §2/§7.
