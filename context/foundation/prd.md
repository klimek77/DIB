---
project: "digital idea box"
version: 1
status: draft
created: 2026-05-22
context_type: greenfield
product_type: web-app
target_scale:
  users: medium
  qps: low
  data_volume: small
timeline_budget:
  mvp_weeks: 3
  hard_deadline: null
  after_hours_only: false
---

# PRD: digital idea box

## Vision & Problem Statement

Management w firmie nie ma kanału, przez który docierają do nich pomysły usprawnień i sygnały o problemach od warstwy wykonawczej — od ludzi, którzy najlepiej widzą, co można zmienić, ulepszyć lub zautomatyzować na własnym stanowisku i w swoim dziale. Najodważniejsi piszą maila do szefa; większość wstydzi się robić to osobiście, szczególnie gdy chodzi nie o pomysł, ale o problem. W rezultacie pomysły, które warstwa wykonawcza widzi codziennie, umierają w głowach pracowników, problemy się powtarzają, a usprawnienia się nie dzieją.

Insight: management widzi pojedyncze incydenty, nie wzorce. Mail do szefa to jeden punkt danych; cyfrowy, anonimowy, stale dostępny kanał, w którym zgłoszenia są przypisane do konkretnych procesów i działów, zamienia stos uwag w widoczny trend — powtarzający się problem w jednym dziale, kategoria usprawnień, która wraca, sygnał operacyjny zamiast incydentu. To, czego status quo (mail do szefa, fizyczna skrzynka na ścianie, ankieta raz w roku) nie dostarcza, to agregacja w czasie i mapowanie na strukturę firmy.

## User & Persona

**Pracownik wykonawczy** — szeregowy pracownik firmy, codziennie wykonujący operacyjną pracę na konkretnym stanowisku w konkretnym dziale. Widzi powtarzające się tarcia w swoim procesie, dostrzega możliwości automatyzacji lub usprawnienia tego, co robi. Sięga po aplikację w momencie, gdy ma pomysł lub natknął się na problem, ale bariera psychologiczna (wstyd, strach przed reakcją szefa, brak chęci eksponowania siebie) jest większa niż korzyść z zgłoszenia tego osobiście lub mailem.

### Secondary persona

**Management / administrator** — osoba decyzyjna w firmie konsumująca dashboard. Nie składa zgłoszeń; przegląda agregaty (po dziale, po procesie, po kategorii), identyfikuje wzorce i podejmuje decyzje o tym, które usprawnienia podjąć. Bez aktywności pierwszej persony dashboard jest pusty — MVP musi być przede wszystkim bezbolesny dla pracownika.

## Success Criteria

### Primary

Pętla `pracownik → AI → admin` jest zamknięta i używana:

- Pracownicy zaczynają korzystać z anonimowego kanału — w pierwszym miesiącu pilota wpada co najmniej N zgłoszeń (N do ustalenia z firmą przy starcie pilotu; patrz Open Questions).
- 100% przyjętych zgłoszeń jest wzbogaconych przez AI o trzy pola: ton wypowiedzi, klasyfikację i 1–2 zdaniowe podsumowanie.
- Admin po zalogowaniu widzi w dashboardzie agregaty (licznik z filtrem czasu, wykres kołowy typów, podział oddziałów) i może wejść w szczegóły pojedynczego zgłoszenia z jego wzbogaceniami AI.

### Secondary

- Powiadomienie admina o nowym zgłoszeniu — natychmiastowe, w kanale notyfikacyjnym wybranym przy konfiguracji systemu.
- Cotygodniowy mail w poniedziałki o 8:00 z podsumowaniem zgłoszeń minionego tygodnia (typy, oddziały, liczba, ewentualnie top-3 tematów wg AI).

### Guardrails

- **Twarda anonimowość.** System nigdy nie zapisuje technicznych identyfikatorów pracownika ani metadanych, które pozwalałyby na deanonimizację. Opcjonalny podpis jest jedynym źródłem tożsamości — i tylko gdy pracownik świadomie go poda. Treść wysyłana do AI nie zawiera podpisu — AI dostaje to samo dla zgłoszenia podpisanego i anonimowego.
- **Zero wycieku poza adminów.** Zgłoszenia (często skargi i krytyka) nie mogą wyciec do innych pracowników ani na zewnątrz firmy. Tylko zalogowany admin widzi cokolwiek.
- **Granica sieciowa zawsze działa.** Aplikacja nigdy nie odpowiada zewnętrznemu ruchowi. Próba dostępu spoza firmowej sieci (bez biurowego LAN-u i bez firmowego VPN-a) musi po prostu nie nawiązać połączenia.
- **Pęknięcie AI nie blokuje submisji.** Gdy AI jest niedostępne, formularz wciąż przyjmuje zgłoszenie. Wzbogacenie dochodzi później, gdy AI znów odpowiada. Pracownik nigdy nie widzi błędu wynikającego z procesu wzbogacania.

## User Stories

### US-01: Pracownik anonimowo zgłasza pomysł lub problem

- **Given** pracownik firmy znajduje się w firmowej sieci (biurowa LAN lub przez firmowy VPN) i ma w firmowym intranecie lub firmowym komunikatorze zespołowym link do formularza
- **When** otwiera link, czyta okno powitalne, klika "dalej", wypełnia formularz (dział z listy, opcjonalnie podpis, tematyka z 5 opcji, treść do 800 znaków) i naciska "wyślij"
- **Then** widzi potwierdzenie wysłania, a zgłoszenie zostaje przyjęte i zapisane bez powiązania z tożsamością nadawcy poza opcjonalnym podpisem, jeśli pracownik go świadomie wprowadził

#### Acceptance Criteria

- Próba otwarcia linka spoza firmowej sieci (bez biurowego LAN-u i bez firmowego VPN-a) nie nawiązuje połączenia z aplikacją.
- Dział jest wymagany; brak wybranego działu blokuje wysłanie formularza.
- Pole treści ma limit 800 znaków, a pracownik widzi w trakcie pisania, ile znaków pozostało do limitu.
- Po wysłaniu zgłoszenie jest wzbogacane o ton, klasyfikację i 1–2 zdaniowe podsumowanie — niezależnie od tego, czy podpis był podany; treść wysyłana do AI nie zawiera podpisu.
- Gdy AI jest niedostępne, zgłoszenie i tak zostaje przyjęte i zapisane; wzbogacenie dochodzi później, gdy AI znów odpowiada.
- Pracownik nigdy nie widzi komunikatu o błędzie wynikającego z procesu wzbogacania zgłoszenia.

## Functional Requirements

### Submission (pracownik)

- FR-001: Pracownik może otworzyć formularz zgłoszenia z poziomu firmowego intranetu lub firmowego komunikatora zespołowego. Priority: must-have
- FR-002: Pracownik widzi okno powitalne wyjaśniające, czym jest narzędzie, po co istnieje i jak z niego korzystać, zanim przejdzie do właściwego formularza. Priority: must-have
- FR-003: Pracownik może wypełnić formularz z polami: dział/oddział (z listy, wymagany), podpis (tekst, opcjonalny), tematyka (jedno z: pomysł / zgłoszenie / propozycja / błąd / skarga), treść (max 800 znaków). Priority: must-have
  > Socrates: Counter-argument considered: "opcjonalny podpis jest pułapką dla naiwnych — pracownicy podpiszą się nie rozumiejąc konsekwencji". Resolution: pole pozostaje opcjonalne bez paternalistycznych ostrzeżeń; pracownicy są dorośli i jeśli ktoś się podpisuje, to jego świadoma decyzja.
- FR-004: Pracownik widzi potwierdzenie wysłania zgłoszenia ("dziękujemy"). Priority: must-have

### AI enrichment

- FR-005: System automatycznie wzbogaca każde zgłoszenie o ton wypowiedzi nadany przez AI. Priority: must-have
  > Socrates: Counter-argument considered: "etykiety AI typu 'agresywny' biasują decyzję admina — odrzuca merytorykę przez ton". Resolution: ton pozostaje jako pole, ale jest oznaczany dla admina jako wynik AI z disclaimerem o możliwej stronniczości i nie jest pierwszorzędnym elementem widoku. Wymóg odzwierciedlony w NFR.
- FR-006: System automatycznie wzbogaca każde zgłoszenie o klasyfikację nadaną przez AI. Priority: must-have
- FR-007: System automatycznie generuje 1–2 zdaniowe podsumowanie treści zgłoszenia przy użyciu AI. Priority: must-have
  > Socrates: Counter-argument considered: "AI halucynuje lub gubi kluczowy detal, admin podejmuje decyzję na podłożu błędnego summary". Resolution: stoi jak jest — admin jest dorosły, jeśli summary podejrzane, klika w detail i czyta surowy tekst (treść do 800 znaków jest krótka). Ryzyko halucynacji akceptowane.
- FR-008: Gdy AI jest niedostępne, system mimo to przyjmuje zgłoszenie i odkłada wzbogacenie na później; zgłoszenia bez wzbogacenia NIE są widoczne w dashboardzie — pokazują się dopiero po wzbogaceniu. Priority: must-have
  > Socrates: Counter-argument considered: "mieszanie wzbogaconych i 'pending' zgłoszeń w dashboardzie wprowadza chaos UX". Resolution: zmodyfikowano FR — niewzbogacone zgłoszenia czekają poza dashboardem, dashboard pokazuje tylko wzbogacone. Plus dodano FR-018 (alert admina o problemie z AI), żeby kwestie operacyjne można było szybko zafixować.

### Admin auth & dashboard

- FR-009: Admin może zalogować się przez magic link wysłany na firmowy email; lista uprawnionych adresów konfigurowana ręcznie. Priority: must-have
- FR-010: Admin widzi licznik zgłoszeń z filtrem czasu: 24h / tydzień / miesiąc / rok / custom range. Priority: must-have
- FR-011: Admin widzi wykres kołowy podziału zgłoszeń wg tematyki (pomysł / zgłoszenie / propozycja / błąd / skarga). Priority: must-have
- FR-012: Admin widzi podział zgłoszeń wg oddziału. Priority: must-have
- FR-013: Admin widzi listę zgłoszeń, każde z AI-podsumowaniem. Priority: must-have
- FR-014: Admin może otworzyć szczegóły pojedynczego zgłoszenia: pełna treść, ton, klasyfikacja, podsumowanie AI, podpis (jeśli był — wyświetlany w widocznym, nieukrytym oznaczeniu autora obok metadanych zgłoszenia), data wysłania, dział. Priority: must-have
  > Socrates: Counter-argument considered: "skoro pracownik mógł się podpisać impulsywnie, admin widzący 'Anna z księgowości' łamie twardą anonimowość dla tej osoby — czy nie ukryć podpisu pod 'pokaż'?". Resolution: podpis pokazuje się jako widoczne oznaczenie autora obok metadanych. Nie utrudniamy admina — pracownik, który się podpisał, świadomie ujawnił tożsamość (decyzja z FR-003 Socrates).

### Network access

- FR-015: ~~Aplikacja odpowiada wyłącznie na ruch z firmowej sieci LAN lub przez firmowy VPN; ruch zewnętrzny jest odrzucany zanim dotrze do aplikacji.~~ Priority: **dropped 2026-06-12**.
  > Zmiana decyzji 2026-06-12: Cloudflare Access CIDR-bypass policy (F-04) usunięty z roadmapy. Aplikacja dostępna pod publicznym workers.dev URL, ale URL dystrybuowany wyłącznie przez wewnętrzny portal firmowy / Slack — przypadkowa osoba nie trafi na formularz. Server-side guardrails (brak IP/identyfikatora w DB, RLS) są właściwą warstwą ochrony anonimowości.

### Notifications (Secondary)

- FR-016: Admin może otrzymać natychmiastowe powiadomienie o nowym zgłoszeniu w kanale notyfikacyjnym wybranym przy konfiguracji systemu. Priority: nice-to-have
- FR-017: System wysyła do admina cotygodniowy mail w poniedziałki o 8:00 z podsumowaniem zgłoszeń poprzedniego tygodnia. Priority: nice-to-have

### Operations alerting

- FR-018: Gdy wzbogacenie AI zakończy się błędem (np. niedostępność modelu, timeout, wyczerpany limit), system natychmiast powiadamia admina w kanale notyfikacyjnym o problemie operacyjnym, aby można było szybko zareagować. Priority: must-have
  > Socrates: Dodane w wyniku Socrates round na FR-008 — bez tego alertu zalegające niewzbogacone zgłoszenia oznaczałyby pusty dashboard bez przyczyny widocznej dla admina.

## Non-Functional Requirements

- Pracownik widzi potwierdzenie wysłania zgłoszenia w czasie poniżej 1 sekundy od kliknięcia "wyślij", niezależnie od stanu wzbogacania AI.
- Każda etykieta nadana przez AI (ton, klasyfikacja, podsumowanie) jest oznaczona dla admina jako wynik AI z komunikatem, że może być stronnicza — admin nigdy nie zobaczy etykiety AI prezentowanej jako fakt.
- Zgłoszenia podlegają polityce retencji: są automatycznie usuwane po N latach od daty wysłania (N do ustalenia z działem prawnym firmy; sugerowane 2 lata — patrz Open Questions).
- System nie zbiera ani nie zapisuje technicznych identyfikatorów pracownika (adres sieciowy klienta, identyfikator klienta przeglądarki, identyfikatory trwałe sesji) poza opcjonalnym podpisem podanym świadomie w formularzu.
- Aplikacja pozostaje użyteczna na bieżących wersjach mainstreamowych przeglądarek desktopowych oraz na ekranach mobilnych — wielu pracowników wypełni formularz z telefonu przez firmowy VPN preinstalowany na służbowym urządzeniu.

## Business Logic

Każde anonimowe zgłoszenie pracownika jest automatycznie wzbogacane przez AI o trzy interpretacyjne warstwy (ton wypowiedzi, klasyfikację, podsumowanie 1–2 zdaniowe), a admin otrzymuje agregaty (po typie, po oddziale, w czasie) i wzbogacone pojedyncze zgłoszenia — nie surowe teksty.

Wejściem reguły jest treść zgłoszenia podana przez pracownika (max 800 znaków) wraz z metadanymi, które sam wprowadził (dział z listy, tematyka z 5 predefiniowanych kategorii, opcjonalnie podpis). Wyjściem są trzy nowe atrybuty dołączone do zgłoszenia: ton (interpretacyjna etykieta wypowiedzi), klasyfikacja (kategoria nadana przez AI, niezależna od pracowniczej tematyki) oraz podsumowanie (1–2 zdania kondensujące treść). Te trzy atrybuty plus oryginalne dane są źródłem zarówno widoku szczegółowego pojedynczego zgłoszenia, jak i agregatów dashboardu.

W produktowym flow pracownik nigdy nie widzi wzbogaceń (one są dla admina); admin nigdy nie widzi surowego procesu wzbogacania (ono dzieje się niezależnie od pracownika) — widzi tylko gotowy, wzbogacony rekord w dashboardzie lub w widoku szczegółów. Wartość reguły leży w tym, że zamienia ona stos anonimowych tekstów (które same w sobie wymagałyby ręcznego czytania i kategoryzowania) w strukturyzowaną wiedzę gotową do agregacji i analizy.

## Access Control

Dwie asymetryczne ścieżki dostępu — jedno źródło danych, dwa zupełnie różne profile uprawnień.

**Ścieżka pracownika (zgłaszający, anonimowy):** wspólny, ogólnodostępny link do formularza. Bez konta, bez logowania, bez śladu tożsamości — system nie zapisuje adresu sieciowego klienta, identyfikatora przeglądarki ani innych atrybutów, które pozwoliłyby na deanonimizację. Wszystko, co system wie o nadawcy, to to, co nadawca sam wpisze w formularzu (np. dział, którego dotyczy zgłoszenie — wybierany z listy). Dostęp do linku ograniczony jest dystrybucją: URL udostępniany wyłącznie przez wewnętrzny portal firmowy / Slack — brak network-level gate. Anonimowość gwarantowana server-side (brak adresu IP i identyfikatorów technicznych w DB). System nie weryfikuje tożsamości pracownika żadnymi innymi środkami. *(Decyzja 2026-06-12: Cloudflare Access CIDR-bypass usunięty z zakresu MVP — patrz F-04 dropped w roadmapie.)*

**Ścieżka admina (manager, czytelnik dashboardu):** logowanie przez magic link wysyłany na firmowy email. Bez haseł, bez SSO. Lista uprawnionych adresów email konfigurowana ręcznie (mała grupa). Po zalogowaniu admin ma pełny dostęp do agregatów i pojedynczych zgłoszeń — ale system nie przechowuje powiązania zgłoszenia z tożsamością nadawcy, więc nawet admin nie może dotrzeć do tego, kto je wysłał. MVP zakłada jeden poziom adminów (płaski model); hierarchia ról (np. team lead widzący tylko swój dział) jest poza zakresem MVP.

## Non-Goals

Następujące rzeczy MVP **świadomie NIE robi** — są wycięte z zakresu, żeby nie wracały chyłkiem w trakcie pracy.

- **Multi-tenancy / SaaS dla wielu firm.** Jedna firma = jedna instancja produktu. Brak panelu zarządzania klientami, brak billowania, brak izolacji per tenant. To dopinka do twardego scale ceiling: nie celujemy w klientów na rynku, tylko w jedną organizację z ~270 pracownikami.
- **Workflow statusów zgłoszeń / komentarze admina / kanał zwrotny do pracownika.** Admin tylko czyta i agreguje. Nie ma "zaznacz jako rozpatrzone", komentarzy pod zgłoszeniami, przypisania osoby odpowiedzialnej, statusów workflow. Brak zwrotnej komunikacji do pracownika — i tak nie da się jej dostarczyć przy twardej anonimowości.
- **Hierarchia ról adminów (team-lead per dział, read-only audytor).** Płaski model: każdy admin widzi wszystko. Nie ma admina, który widzi tylko swój oddział. Nie ma osobnej roli read-only. Jeden poziom uprawnień dla całej grupy adminów konfigurowanej ręcznie.
- **Algorytm "podobnych" zgłoszeń / auto-generowanie meta-pomysłów po progu N.** AI klasyfikuje pojedyncze zgłoszenie i nic więcej — nie grupuje, nie wykrywa duplikatów, nie generuje meta-pomysłów po wykryciu N zbliżonych zgłoszeń. Te funkcje są explicite wycięte do v2.
- **Edge cases dostępu: kontraktorzy / audytorzy / goście / nowi pracownicy przed konfiguracją VPN.** Świadomie zaakceptowana strata — MVP jest dla etatowych pracowników z firmowym VPN-em na służbowych urządzeniach. Inne osoby muszą używać kanałów poza systemem (mail).
- **Real-time / live updates dashboardu, natywne aplikacje mobilne, eksport raportów (PDF/CSV).** Domyślnie poza scope. Dashboard odświeża się przy załadowaniu strony lub wymuszonym odświeżeniu. Pracownik wypełnia formularz w przeglądarce (responsywny widok, nie natywna aplikacja). Eksporty mogą wrócić w v2 jeśli admin tego potrzebuje — nie są w pętli MVP.

## Open Questions

1. **Limit treści 800 znaków** — czy to właściwy limit? Może 500? 1500? Wymaga decyzji z firmą; pierwotnie założono 800. — Owner: user (consult firmy). Block: no.
2. **Retention zgłoszeń** — ile lat trzymamy? Sugerowane 2 lata; do ustalenia z działem prawnym / DPO firmy ze względu na RODO. — Owner: user (consult dział prawny). Block: no (sugerowana wartość 2 lata wystarcza dla MVP).
3. **N startowe zgłoszenia pilota** — ile zgłoszeń tygodniowo w pierwszym miesiącu pilota uznajemy za "produkt zadziałał"? N do ustalenia z firmą przy starcie pilotu. — Owner: user. By: start pilota.
4. **Wybór dostawcy AI** — który dostawca / model? Decyzja stack-shaped, odkładana do `/10x-tech-stack-selector`. Wpływa na: koszt per submission, prywatność (czy treść opuszcza firmę?), latency (asynchroniczny, więc luźny budżet), dostępność (FR-018 alert gdy fail). — Owner: tech-stack-selector. Block: no (PRD definiuje wymaganie, nie dostawcę).
5. **Format powiadomień admina** (FR-016, FR-018) — kanał email czy firmowy komunikator zespołowy? Czy oba? Konfigurowalne? Do ustalenia z firmą i routowane do stack-shaped wyboru integracji. — Owner: user + tech-stack-selector. Block: no.
6. **Lista działów** — skąd źródło dla wyboru działu w formularzu? Hardcoded na starcie, integracja z HR, czy manualnie konfigurowane przez admina? — Owner: user. Block: no (MVP może startować z hardcoded listą).
7. **Co dokładnie znaczy "ton" wypowiedzi po stronie AI** — jakie etykiety wyjściowe (frustracja / neutralność / entuzjazm)? Skala 1–5? Tagi semantyczne? Do doprecyzowania przy projektowaniu promptów AI. — Owner: user (przy projektowaniu promptów). Block: no.
