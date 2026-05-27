---
project: "digital idea box"
context_type: greenfield
product_type: web-app
target_scale:
  users: medium
timeline_budget:
  mvp_weeks: 3
  hard_deadline: null
  after_hours_only: false
created: 2026-05-21
updated: 2026-05-22
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "pain category"
      decision: "coordination overhead + data trapped + workflow friction + missing capability — produkt adresuje wielowarstwowy ból, nie pojedyncze tarcie"
    - topic: "primary persona"
      decision: "pracownik zgłaszający (anonimowy submitter) — management jest secondary, konsumuje dashboard"
    - topic: "insight"
      decision: "agregacja zgłoszeń zamienia pojedyncze incydenty w widoczne wzorce; struktura (mapa procesów / działów) zamienia stos uwag w mapowane możliwości"
    - topic: "employee auth"
      decision: "wspólny link, bez konta, bez logowania — pełna anonimowość; system ma zero informacji o nadawcy poza tym, co sam wpisze (np. dział)"
    - topic: "admin auth"
      decision: "magic link na firmowy email; lista uprawnionych adminów konfigurowana ręcznie; bez SSO i bez haseł"
    - topic: "spam guard"
      decision: "dostęp ograniczony do firmowej sieci (biurowa LAN lub firmowy VPN); zdalni pracownicy mają preinstalowany VPN na służbowych mobilach, więc prywatne łącze nie wyklucza; to twarda granica sieciowa, nie warstwa aplikacyjna"
    - topic: "MVP scope"
      decision: "PRACOWNIK: welcome → formularz (dział req, podpis opcj., tematyka z 5 opcji, treść ≤800 zn) → wyślij → 'dziękujemy'. BACKEND: zapis + AI enrichment (ton + klasyfikacja + 1-2 zd. podsumowanie). ADMIN: magic-link login → dashboard (licznik z filtrem czasu, wykres kołowy typów, podział oddziałów, tabela z AI-summary) → detail view zgłoszenia. WYCIĘTE z MVP do v2: algorytm 'podobnych', auto-generowanie 'pomysłów' po progu, tab 'pomysły', hierarchia ról admin/team-lead."
    - topic: "MVP timeline"
      decision: "3 tygodnie afterhours — z AI-assist (Claude Code, Cursor) komfortowy budżet; akceptuje dalsze cięcia w trakcie pracy jeśli zajdzie potrzeba"
    - topic: "secondary nice-to-haves"
      decision: "(1) powiadomienie admina o nowym zgłoszeniu, (2) cotygodniowy mail w poniedziałki o 8:00 z podsumowaniem minionego tygodnia"
    - topic: "guardrails"
      decision: "twarda anonimowość (zero metadanych, AI prompt bez podpisu) + zero wycieku poza adminów + granica sieciowa zawsze działa + pęknięcie AI nie blokuje submisji (offline-resilient)"
    - topic: "product type"
      decision: "web-app — dwa surface'y w jednej aplikacji: formularz dla pracownika (responsywny, mobile + desktop) i dashboard dla admina (główny use case: desktop)"
    - topic: "target scale"
      decision: "medium kategorialnie — ale twardy ceiling: max ~270 pracowników w firmie (headcount jest stały, nie rośnie do 1000+ ani 10k). Oczekiwana participation ~30% = ~80 aktywnych submitterów. System nie musi skalować się poziomo, multi-region ani sharding — capacity planning ma jednoznaczny limit od dnia jeden."
    - topic: "timing"
      decision: "brak twardego deadline'u; praca w godzinach roboczych (nie afterhours) — kalendarzowo 3 tygodnie pracy mogą zająć krócej niż założenie afterhours-equivalent z Phase 3"
    - topic: "non-goals"
      decision: "single-tenant only (brak multi-tenancy / SaaS dla wielu firm); brak workflow statusów / komentarzy admina / kanału zwrotnego do pracownika; płaski admin model bez hierarchii ról; AI tylko per-zgłoszenie, brak algorytmu 'podobnych' / auto-meta-pomysłów"
  frs_drafted: 18
  quality_check_status: accepted
---

# Shape Notes: digital idea box

**Seed idea (verbatim from user):**

> aplikacja `digital idea box` dla pracowników firmy w celu stworzenia mapy procesów dla usprawnień/ulepszeń/zmiany/automatyzacji z dashboardem dla admina i formularzem zgloszenia dla pracownika anonimowo

## Vision & Problem Statement

Management w firmie nie ma kanału, przez który docierają do nich pomysły usprawnień i sygnały o problemach od warstwy wykonawczej — od ludzi, którzy najlepiej widzą, co można zmienić, ulepszyć lub zautomatyzować na własnym stanowisku i w swoim dziale. Najodważniejsi piszą maila do szefa; większość wstydzi się robić to osobiście, szczególnie gdy chodzi nie o pomysł, ale o problem. W rezultacie pomysły, które warstwa wykonawcza widzi codziennie, umierają w głowach pracowników, problemy się powtarzają, a usprawnienia się nie dzieją.

Insight: management widzi pojedyncze incydenty, nie wzorce. Mail do szefa to jeden punkt danych; cyfrowy, anonimowy, stale dostępny kanał, w którym zgłoszenia są przypisane do konkretnych procesów i działów, zamienia stos uwag w widoczny trend — powtarzający się problem w jednym dziale, kategoria usprawnień, która wraca, sygnał operacyjny zamiast incydentu. To, czego status quo (mail do szefa, fizyczna skrzynka na ścianie, ankieta raz w roku) nie dostarcza, to agregacja w czasie i mapowanie na strukturę firmy.

**Scale ceiling (insight z 100× probe):** firma ma twardo ograniczone headcount (~270 pracowników, nie rośnie do tysięcy). Przy oczekiwanej participation ~30% to ~80 aktywnych submitterów — kilkadziesiąt do kilkuset zgłoszeń miesięcznie. Skala jest "kategoryjnie medium" tylko z nazwy; w praktyce produkt nigdy nie obsłuży tysięcy użytkowników, więc zero pressure na horizontal scaling, sharding, multi-region. Domain rule (AI per-zgłoszenie + agregaty per oddział) działa identycznie dla 80 i dla 800 zgłoszeń miesięcznie — przy tym suficie nie zaczyna się nawet zaszumiać.

## User & Persona

**Pracownik wykonawczy** — szeregowy pracownik firmy, codziennie wykonujący operacyjną pracę na konkretnym stanowisku w konkretnym dziale. Widzi powtarzające się tarcia w swoim procesie, dostrzega możliwości automatyzacji lub usprawnienia tego, co robi. Sięga po aplikację w momencie, gdy ma pomysł lub natknął się na problem, ale bariera psychologiczna (wstyd, strach przed reakcją szefa, brak chęci eksponowania siebie) jest większa niż korzyść z zgłoszenia tego osobiście lub mailem.

### Secondary persona

**Management / administrator** — osoba decyzyjna w firmie konsumująca dashboard. Nie składa zgłoszeń; przegląda agregaty (po dziale, po procesie, po kategorii), identyfikuje wzorce i podejmuje decyzje o tym, które usprawnienia podjąć. Bez aktywności pierwszej persony dashboard jest pusty — MVP musi być przede wszystkim bezbolesny dla pracownika.

## Access Control

Dwie asymetryczne ścieżki dostępu — jedna baza danych, dwa zupełnie różne profile uprawnień.

**Ścieżka pracownika (zgłaszający, anonimowy):** wspólny, ogólnodostępny link do formularza. Bez konta, bez logowania, bez śladu tożsamości — system nie zapisuje IP, identyfikatora przeglądarki ani innych pól, które pozwoliłyby na deanonimizację. Wszystko, co system wie o nadawcy, to to, co nadawca sam wpisze w formularzu (np. dział, którego dotyczy zgłoszenie — wybierany z listy). Dostęp do linku jest ograniczony siecią: tylko z firmowej sieci biurowej LUB z firmowego VPN-a (zdalni pracownicy mają go preinstalowanego na służbowych mobilach, więc dostęp z prywatnego łącza jest możliwy przez VPN). Granica sieciowa jest tu jedynym mechanizmem ograniczającym spam — warstwa aplikacyjna anonimowości nie weryfikuje.

**Ścieżka admina (manager, czytelnik dashboardu):** logowanie przez magic link wysyłany na firmowy email. Bez haseł, bez SSO. Lista uprawnionych adresów email konfigurowana ręcznie (mała grupa). Po zalogowaniu admin ma pełny dostęp do agregatów i pojedynczych zgłoszeń — ale zgłoszenia są w bazie zapisane bez powiązania z tożsamością nadawcy, więc nawet admin nie może dotrzeć do tego, kto je wysłał. MVP zakłada jeden poziom adminów (płaski model); hierarchia ról (np. team lead widzący tylko swój dział) jest poza zakresem MVP.

## Success Criteria

### Primary

Pętla `pracownik → AI → admin` jest zamknięta i używana:
- Pracownicy zaczynają korzystać z anonimowego kanału — w pierwszym miesiącu pilota wpada co najmniej N zgłoszeń (N do ustalenia z firmą przy starcie pilotu; patrz Open Questions).
- 100% przyjętych zgłoszeń jest wzbogaconych przez AI o trzy pola: ton wypowiedzi, klasyfikację i 1–2 zdaniowe podsumowanie.
- Admin po zalogowaniu (magic link) widzi w dashboardzie agregaty (licznik z filtrem czasu, wykres kołowy typów, podział oddziałów) i może wejść w szczegóły pojedynczego zgłoszenia z jego wzbogaceniami AI.

### Secondary

- Powiadomienie admina o nowym zgłoszeniu (instant — email lub Slack).
- Cotygodniowy mail w poniedziałki o 8:00 z podsumowaniem zgłoszeń minionego tygodnia (typy, oddziały, liczba, ewentualnie top-3 tematów wg AI).

### Guardrails

- **Twarda anonimowość.** System nigdy nie zapisuje IP, User-Agent, fingerprintu przeglądarki ani innych metadanych identyfikujących pracownika. Opcjonalny podpis jest jedynym źródłem tożsamości — i tylko gdy pracownik świadomie go poda. Prompt do AI nie zawiera podpisu — AI dostaje to samo dla zgłoszenia podpisanego i anonimowego.
- **Zero wycieku poza adminów.** Zgłoszenia (często skargi i krytyka) nie mogą wyciec do innych pracowników ani na zewnątrz firmy. Tylko zalogowany admin widzi cokolwiek.
- **Granica sieciowa zawsze działa.** Aplikacja nigdy nie odpowiada zewnętrznemu ruchowi. Próba dostępu z domowego łącza bez firmowego VPN-a musi po prostu nie nawiązać połączenia (network-level deny, nie warstwa aplikacyjna).
- **Pęknięcie AI nie blokuje submisji.** Gdy AI / API jest niedostępne, formularz wciąż przyjmuje zgłoszenie. Zgłoszenie ląduje w kolejce na późniejsze wzbogacenie. Pracownik nigdy nie widzi błędu wynikającego z AI.

## User Stories

### US-01: Pracownik anonimowo zgłasza pomysł lub problem

- **Given** pracownik firmy znajduje się w firmowej sieci (biurowa LAN lub przez firmowy VPN) i ma w intranecie lub na Slacku link do formularza
- **When** otwiera link, czyta okno powitalne, klika "dalej", wypełnia formularz (dział z listy, opcjonalnie podpis, tematyka z 5 opcji, treść do 800 znaków) i naciska "wyślij"
- **Then** widzi potwierdzenie wysłania, a zgłoszenie ląduje w bazie systemu z opcjonalnym podpisem (jeśli został podany), bez zapisanego IP, User-Agentu ani innych metadanych identyfikujących

#### Acceptance Criteria

- Próba otwarcia linka z domowego łącza bez firmowego VPN-a nie nawiązuje połączenia (network-level deny).
- Dział jest wymagany; brak wybranego działu blokuje wysłanie formularza.
- Pole treści ma limit 800 znaków z widocznym licznikiem znaków.
- Po wysłaniu zgłoszenie jest wzbogacane przez AI o ton, klasyfikację i 1–2 zdaniowe podsumowanie — niezależnie od tego, czy podpis był podany; prompt do AI nie zawiera podpisu.
- Gdy AI jest niedostępne, zgłoszenie i tak ląduje w bazie z flagą `enrichment_pending`; wzbogacenie dochodzi później z kolejki.
- Pracownik nigdy nie widzi komunikatu o błędzie pochodzącego z AI lub kolejki wzbogaceń.

## Functional Requirements

### Submission (pracownik)

- FR-001: Pracownik może otworzyć formularz zgłoszenia z poziomu intranetu lub Slacka. Priority: must-have
- FR-002: Pracownik widzi okno powitalne wyjaśniające, czym jest narzędzie, po co istnieje i jak z niego korzystać, zanim przejdzie do właściwego formularza. Priority: must-have
- FR-003: Pracownik może wypełnić formularz z polami: dział/oddział (z listy, wymagany), podpis (tekst, opcjonalny), tematyka (jedno z: pomysł / zgłoszenie / propozycja / błąd / skarga), treść (max 800 znaków). Priority: must-have
  > Socrates: Counter-argument considered: "opcjonalny podpis jest pułapką dla naiwnych — pracownicy podpiszą się nie rozumiejąc konsekwencji". Resolution: pole pozostaje opcjonalne bez paternalistycznych ostrzeżeń; pracownicy są dorośli i jeśli ktoś się podpisuje, to jego świadoma decyzja.
- FR-004: Pracownik widzi potwierdzenie wysłania zgłoszenia ("dziękujemy"). Priority: must-have

### AI enrichment

- FR-005: System automatycznie wzbogaca każde zgłoszenie o ton wypowiedzi nadany przez AI. Priority: must-have
  > Socrates: Counter-argument considered: "etykiety AI typu 'agresywny' biasują decyzję admina — odrzuca merytorykę przez ton". Resolution: ton pozostaje jako field, ale UI musi prezentować go z wyraźnym disclaimerem 'AI-generated, może być stronnicze' i być schowany za rozwinięciem (nie jako pierwszorzędny element widoku). Wymóg UX odzwierciedlony w NFR / acceptance criteria.
- FR-006: System automatycznie wzbogaca każde zgłoszenie o klasyfikację nadaną przez AI. Priority: must-have
- FR-007: System automatycznie generuje 1–2 zdaniowe podsumowanie treści zgłoszenia przy użyciu AI. Priority: must-have
  > Socrates: Counter-argument considered: "AI halucynuje lub gubi kluczowy detal, admin podejmuje decyzję na podłożu błędnego summary". Resolution: stoi jak jest — admin jest dorosły, jeśli summary podejrzane, klika w detail i czyta surowy tekst (treść do 800 znaków jest krótka). Ryzyko halucynacji akceptowane.
- FR-008: Gdy AI jest niedostępne, system mimo to przyjmuje zgłoszenie i kolejkuje je do późniejszego wzbogacenia; zgłoszenia bez wzbogacenia NIE są widoczne w dashboardzie — pokazują się dopiero po wzbogaceniu z kolejki. Priority: must-have
  > Socrates: Counter-argument considered: "mieszanie wzbogaconych i 'pending' zgłoszeń w dashboardzie wprowadza chaos UX". Resolution: zmodyfikowano FR — surowe zgłoszenia czekają w kolejce, dashboard pokazuje tylko wzbogacone. Plus dodano FR-018 (alert admina o problemie z AI), żeby fundsy/API/etc. można było szybko zafixować.

### Admin auth & dashboard

- FR-009: Admin może zalogować się przez magic link wysłany na firmowy email; lista uprawnionych adresów konfigurowana ręcznie. Priority: must-have
- FR-010: Admin widzi licznik zgłoszeń z filtrem czasu: 24h / tydzień / miesiąc / rok / custom range. Priority: must-have
- FR-011: Admin widzi wykres kołowy podziału zgłoszeń wg tematyki (pomysł / zgłoszenie / propozycja / błąd / skarga). Priority: must-have
- FR-012: Admin widzi podział zgłoszeń wg oddziału. Priority: must-have
- FR-013: Admin widzi tabelę zgłoszeń z AI-podsumowaniem każdego. Priority: must-have
- FR-014: Admin może kliknąć w zgłoszenie i zobaczyć szczegóły: pełna treść, ton, klasyfikacja, podsumowanie AI, podpis (jeśli był — wyświetlany jako widoczny badge "autor: <imię>" nad treścią), data wysłania, dział. Priority: must-have
  > Socrates: Counter-argument considered: "skoro pracownik mógł się podpisać impulsywnie, admin widzący 'Anna z księgowości' łamie twardą anonimowość dla tej osoby — czy nie ukryć podpisu pod 'pokaż'?". Resolution: podpis pokazuje się oczywiście jako badge "autor: X" nad treścią. Nie utrudniamy admina — pracownik, który się podpisał, świadomie ujawnił tożsamość (decyzja z FR-003 Socrates).

### Network access

- FR-015: Aplikacja odpowiada wyłącznie na ruch z firmowej sieci LAN lub przez firmowy VPN; ruch zewnętrzny jest odrzucany na poziomie sieci, nie aplikacji. Priority: must-have
  > Socrates: Counter-argument considered: "kontraktorzy, audytorzy, goście, nowi pracownicy przed konfiguracją VPN są wykluczeni z możliwości zgłoszenia". Resolution: stoi jak jest — MVP jest dla pracowników etatowych z VPN-em, edge cases akceptowane jako strata. Inne ścieżki zgłaszania (mail) pozostają poza systemem.

### Notifications (Secondary)

- FR-016: Admin może otrzymać powiadomienie (email lub Slack) o nowym zgłoszeniu. Priority: nice-to-have
- FR-017: System wysyła do admina cotygodniowy mail w poniedziałki o 8:00 z podsumowaniem zgłoszeń poprzedniego tygodnia. Priority: nice-to-have

### Operations alerting

- FR-018: Gdy wzbogacenie AI zakończy się błędem (np. brak funduszy na API, niedostępność dostawcy, timeout), system natychmiast powiadamia admina (email lub Slack) o problemie operacyjnym, aby można było szybko zareagować. Priority: must-have
  > Socrates: Dodane w wyniku Socrates round na FR-008 — bez tego alertu kolejka enrichment rosnąca w ciszy oznaczałaby pusty dashboard bez przyczyny widocznej dla admina.

## Business Logic

Każde anonimowe zgłoszenie pracownika jest automatycznie wzbogacane przez AI o trzy interpretacyjne warstwy (ton wypowiedzi, klasyfikację, podsumowanie 1-2 zdaniowe), a admin otrzymuje agregaty (po typie, po oddziale, w czasie) i wzbogacone pojedyncze zgłoszenia — nie surowe teksty.

Wejściem reguły jest treść zgłoszenia podana przez pracownika (max 800 znaków) wraz z metadanymi które sam wprowadził (dział z listy, tematyka z 5 predefiniowanych kategorii, opcjonalnie podpis). Wyjściem są trzy nowe pola dołączone do zgłoszenia: ton (interpretacyjna etykieta wypowiedzi), klasyfikacja (kategoria nadana przez AI, niezależna od pracowniczej tematyki), oraz podsumowanie (1-2 zdania kondensujące treść). Te trzy pola plus oryginalne dane lądują w bazie i są źródłem zarówno widoku szczegółowego pojedynczego zgłoszenia, jak i agregatów dashboardu.

W produktowym flow pracownik nigdy nie widzi wzbogaceń (one są dla admina); admin nigdy nie widzi surowego procesu wzbogacania (ono dzieje się asynchronicznie po stronie systemu) — widzi tylko gotowy, wzbogacony rekord w dashboardzie lub w detail view. Wartość reguły leży w tym, że zamienia ona stos anonimowych tekstów (które same w sobie wymagałyby ręcznego czytania i kategoryzowania) w strukturyzowaną wiedzę gotową do agregacji i analizy.

## Non-Functional Requirements

- Pracownik widzi potwierdzenie wysłania zgłoszenia w czasie poniżej 1 sekundy od kliknięcia "wyślij", niezależnie od stanu AI-enrichment, który przebiega asynchronicznie po stronie systemu.
- Każda etykieta nadana przez AI (ton, klasyfikacja, podsumowanie) prezentowana jest w UI z widocznym oznaczeniem "AI-generated" i komunikatem informującym, że może być stronnicza — admin nigdy nie widzi etykiet AI prezentowanych jako fakty.
- Zgłoszenia podlegają polityce retencji: są automatycznie usuwane po N latach od daty wysłania (N do ustalenia z działem prawnym firmy; sugerowane 2 lata — patrz Open Questions).
- System nie zbiera ani nie zapisuje danych identyfikujących pracownika (IP, User-Agent, fingerprint przeglądarki, cookies trwałe) poza opcjonalnym podpisem podanym świadomie w formularzu.
- Aplikacja jest użyteczna na desktopie (przeglądarki Chrome / Firefox / Edge / Safari w dwóch ostatnich wersjach majora) oraz na urządzeniach mobilnych (responsywny layout) — wielu pracowników wypełni formularz z telefonu przez firmowy VPN preinstalowany na służbowym mobile.

## Non-Goals

Następujące rzeczy MVP **świadomie NIE robi** — są wycięte z zakresu, żeby nie wracały chyłkiem w trakcie pracy. Każdy wpis to wynik decyzji w trakcie Phase 6 (gray_areas_resolved: "non-goals") plus to, co wypadło ze scope wcześniej w Phase 3 (MVP scope).

- **Multi-tenancy / SaaS dla wielu firm.** Jedna firma = jedna instancja produktu. Brak panelu zarządzania klientami, brak billowania, brak izolacji per tenant. To dopinka do twardego scale ceiling: nie celujemy w klientów na rynku, tylko w jedną organizację z ~270 pracownikami.
- **Workflow statusów zgłoszeń / komentarze admina / kanał zwrotny do pracownika.** Admin tylko czyta i agreguje. Nie ma "zaznacz jako rozpatrzone", komentarzy pod zgłoszeniami, przypisania osoby odpowiedzialnej, statusów workflow. Brak zwrotnej komunikacji do pracownika — i tak nie da się jej dostarczyć przy twardej anonimowości.
- **Hierarchia ról adminów (team-lead per dział, read-only audytor).** Płaski model: każdy admin widzi wszystko. Nie ma admina, który widzi tylko swój oddział. Nie ma osobnej roli read-only. Jeden poziom uprawnień dla całej grupy adminów konfigurowanej ręcznie.
- **Algorytm "podobnych" zgłoszeń / auto-generowanie meta-pomysłów po progu N.** AI klasyfikuje pojedyncze zgłoszenie i nic więcej — nie grupuje, nie wykrywa duplikatów, nie generuje meta-pomysłów po wykryciu N zbliżonych zgłoszeń. Te funkcje są explicite wycięte do v2 (decyzja z Phase 3 MVP scope).
- **Edge cases dostępu: kontraktorzy / audytorzy / goście / nowi pracownicy przed konfiguracją VPN.** Świadomie zaakceptowana strata (decyzja z FR-015 Socrates) — MVP jest dla etatowych pracowników z firmowym VPN-em na służbowych urządzeniach. Inne osoby muszą używać kanałów poza systemem (mail).
- **Real-time / live updates dashboardu, native mobile apps, eksport raportów (PDF/CSV).** Domyślnie poza scope. Dashboard odświeża się przy załadowaniu strony / wymuszonym refresh. Pracownik wypełnia formularz w przeglądarce (responsywny layout, nie native app). Eksporty mogą wrócić w v2 jeśli admin tego potrzebuje — nie są w pętli MVP.

## Open Questions

1. **Limit treści 800 znaków** — czy to właściwy limit? Może 500? 1500? Wymaga decyzji z firmą; pierwotnie założono 800 (user: "do przedyskutowania").
2. **Retention zgłoszeń** — ile lat trzymamy? Sugerowane 2 lata; do ustalenia z działem prawnym / DPO firmy ze względu na RODO.
3. **N startowe zgłoszenia pilota** — ile zgłoszeń tygodniowo w pierwszym miesiącu pilota uznajemy za "produkt zadziałał"? N do ustalenia z firmą przy starcie pilotu.
4. **Wybór dostawcy AI** — który LLM (OpenAI, Anthropic, Azure, open-source local)? Decyzja stack-shaped, odkładana do `/10x-tech-stack-selector`. Wpływa na: koszt per submission, prywatność (czy prompt opuszcza firmę?), latency, dostępność.
5. **Format powiadomień admina** (FR-016, FR-018) — email czy Slack? Czy oba? Konfigurowalne? Do ustalenia z firmą.
6. **Lista działów** — skąd źródło dla `<select>`-a działów? Hardcoded? Integracja z HR? Manualnie konfigurowane przez admina?
7. **Co dokładnie znaczy "ton" wypowiedzi po stronie AI** — jakie etykiety wyjściowe (frustracja / neutralność / entuzjazm)? Skala 1–5? Tagi semantyczne? Do doprecyzowania przy projektowaniu promptów AI.

## Forward: tech-stack

Notatki dla `/10x-tech-stack-selector` (nie wchodzą do PRD, są informacyjne):

- Dostawca AI: do wyboru w tech-stack-selector. Kryteria: koszt per submission (oczekiwana liczba: kilkadziesiąt-kilkaset zgłoszeń tygodniowo per firma), polityka prywatności (czy treść opuszcza firmę?), latency (asynchroniczny, więc luźny budżet), dostępność (FR-018 alert gdy fail).
- Network gating (FR-015): wymaga konfiguracji na poziomie infrastruktury — firewall / reverse proxy / cloudflare access / wewnętrzny hosting. To decyzja deployment-shaped, nie tylko stack-shaped. Wpisać jako wymóg dla `/10x-infra-research`.
- Backend musi mieć kolejkę / job queue dla async AI enrichment (FR-008). Tech-stack-selector powinien uwzględnić to przy wyborze framework / runtime.
- Magic link auth (FR-009) — wybrać bibliotekę / SaaS provider (np. Auth.js, Clerk, własne).
- Dashboard z wykresami — chart library (recharts, Chart.js, etc.) do wyboru w stack.
- **Scale ceiling jako twardy upraszczacz wyborów:** firma ma max ~270 pracowników, ~80 aktywnych submitterów, kilkadziesiąt-kilkaset zgłoszeń miesięcznie. Tech-stack-selector NIE powinien rekomendować rozwiązań klasy "horizontal scaling-ready" (Kubernetes, sharding, read-replicas) — single-instance + jedna baza wystarczy z ogromnym zapasem. To otwiera drogę do najprostszych deploymentów (single-process, SQLite na małej ilości danych jest opcją; managed Postgres na najmniejszym tierze też wystarczy bez compromisu). Brak skalowania horyzontalnego ułatwia też zachowanie network gating (FR-015) — jedna instancja za firewall/VPN.

## Quality cross-check

Wynik soft-gate cross-checku z Phase 7. Wszystkie 5 elementów wymaganych dla greenfield obecnych:

| Element | Status | Uzasadnienie |
|---|---|---|
| Access Control | OK | `## Access Control` opisuje dwie asymetryczne ścieżki (network-gated link dla pracownika, magic-link na firmowy email dla admina). |
| Business Logic | OK | Reguła zaczyna się jednym zdaniem: "Każde anonimowe zgłoszenie pracownika jest automatycznie wzbogacane przez AI…". Trzy paragrafy uzupełniające. |
| Project artifacts | OK | `shape-notes.md` z pełnym frontmatterem (checkpoint, gray_areas_resolved, frs_drafted=18, quality_check_status=accepted). |
| Timeline-cost ack | OK | `mvp_weeks: 3` ≤ 3, więc skill nie wymagał osobnego `## Timeline acknowledgment` bloku. Praca w godzinach roboczych (`after_hours_only: false`) dodatkowo zmniejsza ryzyko vs. założenia afterhours-only z Phase 3. |
| Non-Goals | OK | `## Non-Goals` ma 6 wpisów: multi-tenancy, workflow/komentarze, hierarchia ról, AI-grouping, edge cases dostępu, real-time/native/eksporty. |
| Preserved behavior | N/A | Greenfield — brak istniejącego systemu do ochrony. |

Quality status w frontmatter: `accepted`. Brak warningów do propagacji do `## Open Questions` w PRD.
