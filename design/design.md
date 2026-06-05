# DESIGN.md — System wizualny „Hub Sugestii" (Sewera)

> Cel: przenieść **wyłącznie warstwę wizualną** (kolory, typografia, komponenty, layout)
> do innego projektu. Ten dokument NIE opisuje logiki biznesowej, danych ani API —
> tylko to, jak aplikacja **wygląda**.
>
> Stack referencyjny: Next.js 14 (App Router) + React 18 + **Tailwind CSS 3.4**.
> Wykresy są budowane ręcznie (div-y + inline SVG) — **brak biblioteki chartów**.

---

## Referencje wizualne (zrzuty ekranu)

> Pliki PNG leżą w tym samym folderze co ten dokument. Wczytaj je razem z `design.md`
> do Claude — tekst opisuje *jak* to zbudować, a zrzuty pokazują *docelowy efekt*.

**Formularz publiczny — ciemny motyw, DM Sans:**

| Ekran | Plik |
|---|---|
| Krok 1 — wybór oddziału | [form-01-branch.PNG](form-01-branch.PNG) |
| Krok 2 — wybór kategorii | [form-02-category.PNG](form-02-category.PNG) |
| Krok 3 — treść sugestii | [form-03-content.PNG](form-03-content.PNG) |
| Ekran sukcesu | [form-04-success.PNG](form-04-success.PNG) |

**Dashboard + login — jasny motyw, Lato:**

| Ekran | Plik |
|---|---|
| Logowanie | [dashboard-login.PNG](dashboard-login.PNG) |
| Dashboard — Przegląd | [dashboard.PNG](dashboard.PNG) |
| Dashboard — Tematy | [dashboard-tematy.PNG](dashboard-tematy.PNG) |
| Dashboard — Procesy | [dashboard-procesy.PNG](dashboard-procesy.PNG) |

---

## 0. TL;DR — dwa światy wizualne

Aplikacja ma dwie kompletnie różne estetyki:

| | **Formularz publiczny** | **Dashboard + Login** |
|---|---|---|
| Nastrój | Dark, glassmorphism, „premium / poufne" | Light, korporacyjny, „panel danych" |
| Tło | Granatowy gradient `#0f1923 → #1a2a3a → #0d2137` | `bg-gray-50` (#F9FAFB) |
| Akcent | Emerald (zielony) | Sewera blue `#0176D0` |
| Czcionka | **DM Sans** | **Lato** |
| Karty | `bg-white/[0.03–0.12]` + `border-white/[…]` | białe + `border-gray-300` `rounded-lg` |
| Przyciski | gradient emerald + glow | pełny `sewera-primary` |
| Promień | duży, miękki (`rounded-xl` = 12px, `14px`) | umiarkowany (`rounded-lg` = 8px, `rounded-md` = 6px) |

Login jest „mostem": ciemne tło formularza + niebieski przycisk dashboardu.

---

## 1. Design tokens

### 1.1. Paleta kolorów

#### Marka (Sewera) — używana w dashboardzie
| Token | Hex | Zastosowanie |
|---|---|---|
| `sewera-primary` | `#0176D0` | główny niebieski: TopBar, nagłówki sekcji, aktywny tab, słupki, przyciski |
| `sewera-cta` | `#006BBB` | hover na przyciskach primary |
| `sewera-dark` | `#15377B` | granat: liczby/wartości KPI, etykiety na wykresach |
| `#005FA3` | `#005FA3` | ciemniejszy chip z logotypem „Sewera" (TopBar / login) — **kolor hardcoded** |

#### Kolory semantyczne (status / sentyment)
| Token | Hex | Znaczenie |
|---|---|---|
| `success` | `#44872E` | pozytywne / innowacyjne / OK |
| `warning` | `#DB6600` | do analizy / ostrzeżenie |
| `danger` | `#FF0000` | krytyczne / negatywne |
| `teal` | `#299FAB` | „procesy wykryte", akcent automatyzacji |

Jasne tła semantyczne (badge, kafelki): `bg-red-50`, `bg-orange-50`, `bg-blue-50` (Tailwind default).

#### Akcent formularza — emerald (Tailwind default)
| Klasa | Hex | Zastosowanie |
|---|---|---|
| `emerald-600` | `#059669` | główny akcent, ramki zaznaczenia, gradient od |
| `emerald-500` | `#10b981` | gradient przycisku do |
| `emerald-400` | `#34d399` | gradient pasków postępu / sukcesu do |

#### Ciemny motyw — tło + tekst
| Element | Wartość |
|---|---|
| Gradient tła | `bg-gradient-to-br from-[#0f1923] via-[#1a2a3a] to-[#0d2137]` |
| Tekst główny | `text-slate-200` (#E2E8F0) |
| Tekst drugorzędny | `text-slate-400` |
| Tekst pomocniczy / labelki | `text-slate-500` |
| Tekst wyciszony / disabled / placeholder | `text-slate-600` |
| Powierzchnie (glass) | `bg-white/[0.03]` → `0.04` → `0.05` → `0.06` → `0.08` → `0.12` |
| Ramki (glass) | `border-white/[0.05]` → `0.06` → `0.08` → `0.10` → `0.15` → `0.20` |

#### Jasny motyw — tło + tekst (dashboard)
| Element | Wartość |
|---|---|
| Tło strony | `bg-gray-50` |
| Tekst nagłówków / wartości | `text-gray-700` |
| Tekst body / domyślny | `text-gray-600` |
| Tekst pomocniczy | `text-gray-500` |
| Ramki kart / separatory | `border-gray-300` |
| Tory wykresów / wypełnienia | `bg-gray-200` |
| Słupek „niebieżący" (trend tyg.) | `bg-blue-200` |

#### Kolory kategorii wpisów (ikona + akcent)
| Kategoria | Ikona | Kolor |
|---|---|---|
| Pomysł | 💡 | `#059669` |
| Problem | ⚠ | `#dc2626` |
| Usprawnienie | ⚙ | `#2563eb` |
| Inne | 💬 | `#6b7280` |

#### Pierścień sentymentu (SVG)
- tor: `#E8E8E8` · pozytywne: `#44872E` · negatywne: `#FF0000` · neutralne: `#D6D6D6`

---

### 1.2. Typografia

Dwie rodziny, jedna na „świat":

| Rodzina | Gdzie | Jak ładowana |
|---|---|---|
| **DM Sans** | Formularz publiczny (`font-dm-sans`) | `next/font/google`, subsets `latin` + `latin-ext`, jako CSS var `--font-dm-sans` |
| **Lato** | Dashboard + Login (`font-lato`) | ⚠️ **patrz uwaga niżej** |

> ⚠️ **WAŻNE przy przenoszeniu:** w oryginale `Lato` jest zadeklarowana w Tailwind
> (`fontFamily.lato`) i używana wszędzie w dashboardzie, ale **nigdy nie jest
> ładowana jako webfont** — `layout.tsx` importuje tylko DM Sans. Skutkiem jest, że
> `font-lato` renderuje się jako systemowy `sans-serif` fallback. Aby odtworzyć
> **zamierzony** wygląd, załaduj Lato (patrz §3.2). Jeśli chcesz odtworzyć stan
> faktyczny 1:1 — nie ładuj Lato i zostaw fallback.

**Skala (formularz, DM Sans):**
| Element | Klasy |
|---|---|
| H1 (hero) | `text-[2rem] font-semibold leading-tight` (32px) |
| H2 (krok) | `text-xl font-medium` (20px) |
| Body | `text-base leading-relaxed` |
| Opis / sub | `text-sm` (slate-400/500) |
| Eyebrow | `text-xs uppercase tracking-wider font-medium` |

**Skala (dashboard, Lato):**
| Element | Klasy |
|---|---|
| Wartość KPI | `text-[32px] font-extrabold leading-tight` |
| Label KPI | `text-xs font-semibold uppercase tracking-wider` |
| Nagłówek sekcji | `text-sm font-bold tracking-wide` |
| Liczba kategorii | `text-[26px] font-extrabold` |
| Liczba w pierścieniu | `text-[22px] font-extrabold` |
| Wiersz tabeli / proces | `text-sm` / `text-[13px] font-bold` |
| Mikro-etykiety | `text-[11px]`, `text-[10px]`, `text-[9px]` |

Wagi w użyciu: `font-medium` (500), `font-semibold` (600), `font-bold` (700), `font-extrabold` (800), `font-black` (900 — logotyp).

---

### 1.3. Promienie (border-radius)

| Klasa | px | Zastosowanie |
|---|---|---|
| `rounded-xl` | 12 | inputy, przyciski, karty ciemnego motywu, komunikaty błędów |
| `rounded-[14px]` | 14 | przyciski wyboru kategorii (formularz) |
| `rounded-[10px]` | 10 | kwadratowy badge z liczbą wpisów (proces) |
| `rounded-lg` | 8 | karty dashboardu, KPI, kafelki kategorii, chip logo (login) |
| `rounded-md` | 6 | chip logo TopBar, selecty, przycisk retry, nagłówki sekcji (`rounded-t-md`) |
| `rounded-full` | ∞ | kropki statusu, badge, kółko procesu, „✓" sukcesu, kropka pulsująca |
| `rounded-sm` | 2 | paski postępu, mini-słupki, kropki legendy |
| `rounded` / `rounded-t` | 4 | tory i słupki wykresów |

### 1.4. Cienie i efekty

**Ciemny motyw — glow (kluczowy dla „premium" feelingu):**
```
kropka pulsująca:  shadow-[0_0_12px_rgba(5,150,105,0.5)]
przycisk primary:  shadow-[0_4px_24px_rgba(5,150,105,0.3)]
„✓" sukcesu:       shadow-[0_0_60px_rgba(5,150,105,0.3)]
```
- Glassmorphism = półprzezroczyste białe tło + półprzezroczysta biała ramka (patrz §1.1).
- `backdrop-blur-sm` na przycisku ekranu sukcesu.

**Jasny motyw:**
- `shadow-md` na TopBar (jedyny cień w dashboardzie — reszta na ramkach `border-gray-300`).

### 1.5. Animacje

```js
// keyframe fadeUp — wejście kroków formularza i ekranu sukcesu
fadeUp: { from: { opacity:0, transform:'translateY(16px)' },
          to:   { opacity:1, transform:'translateY(0)'   } }
animation.fadeUp = 'fadeUp 0.4s ease-out'   // klasa: animate-fadeUp
```
- `animate-pulse` (Tailwind) — kropka „live" w nagłówku formularza.
- Tranzycje: `transition-all` / `transition-colors` z `duration-300/400/500` na słupkach, paskach postępu, pierścieniu, hover-stanach.

---

## 2. Layout / kompozycja

### Formularz (publiczny)
- `min-h-screen` + gradient tła, font DM Sans, `text-slate-200`.
- Treść wyśrodkowana, **`max-w-[640px] mx-auto`**, padding `px-8`.
- Sekwencja pionowa: Header → `StepProgress` → krok → (błąd) → nawigacja → trust-footer.

### Dashboard
- `min-h-screen bg-gray-50`, font Lato, `text-gray-600`.
- Pełnoszerokie: `TopBar` (h-14) + `TabNav`, potem kontener **`max-w-[1100px] mx-auto px-6 py-5 pb-10`**.
- Zakładka „Przegląd": grid **`grid-cols-[1fr_340px] gap-4 items-start`**, zwija się do 1 kolumny na `max-lg`.
- Karta = `bg-white border border-gray-300 rounded-lg overflow-hidden` z kolorowym nagłówkiem `SectionHeader` na górze.

---

## 3. Pliki do skopiowania (gotowiec)

### 3.1. `tailwind.config.ts`
```ts
import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        "sewera-primary": "#0176D0",
        "sewera-cta": "#006BBB",
        "sewera-dark": "#15377B",
        success: "#44872E",
        warning: "#DB6600",
        danger: "#FF0000",
        teal: "#299FAB",
      },
      fontFamily: {
        lato: ["Lato", "sans-serif"],
        "dm-sans": ["DM Sans", "sans-serif"],
      },
      keyframes: {
        fadeUp: {
          from: { opacity: "0", transform: "translateY(16px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: { fadeUp: "fadeUp 0.4s ease-out" },
    },
  },
  plugins: [],
};
export default config;
```

### 3.2. Ładowanie czcionek (`app/layout.tsx`)
Oryginał ładuje tylko DM Sans. **Zalecane** — załaduj obie, żeby dashboard miał faktyczne Lato:
```tsx
import { DM_Sans, Lato } from "next/font/google";

const dmSans = DM_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-dm-sans" });
const lato   = Lato({ subsets: ["latin", "latin-ext"], weight: ["400","700","900"], variable: "--font-lato" });

// <body className={`${dmSans.variable} ${lato.variable} antialiased`}>
```
Aby `font-lato` używała zmiennej, ustaw w configu: `lato: ["var(--font-lato)", "sans-serif"]`
(analogicznie dla `dm-sans`). Bez tego Tailwind szuka lokalnie zainstalowanej „Lato".

### 3.3. `app/globals.css`
W oryginale minimalny — tylko dyrektywy Tailwind (brak własnych zmiennych mimo
`var(--background)`/`var(--foreground)` w configu; są to pozostałości szablonu i można je pominąć):
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

---

## 4. Receptury komponentów (gotowe `className`)

> Skopiuj string klas 1:1. Dynamiczne kolory podawane są inline `style={{ color }}`
> tam, gdzie wartość pochodzi z danych (kategorie, KPI, sentyment).

### 4.1. CIEMNY MOTYW (formularz / login)

**Kontener strony**
```
min-h-screen bg-gradient-to-br from-[#0f1923] via-[#1a2a3a] to-[#0d2137] font-dm-sans text-slate-200
```

**Eyebrow z pulsującą kropką „live"**
```html
<div class="flex items-center gap-3 mb-2">
  <div class="w-2.5 h-2.5 rounded-full bg-emerald-600 shadow-[0_0_12px_rgba(5,150,105,0.5)] animate-pulse"></div>
  <span class="text-xs text-slate-500 tracking-wider uppercase font-medium">Anonimowo · Bezpiecznie · Poufnie</span>
</div>
```

**Pasek postępu (3 segmenty)** — segment aktywny vs nieaktywny:
```
flex-1 h-[3px] rounded-sm transition-all duration-400
  • aktywny:   bg-gradient-to-r from-emerald-600 to-emerald-400
  • nieaktywny: bg-white/[0.08]
```
Kontener: `flex gap-1.5 mb-8`.

**Przycisk primary (CTA)** — stan aktywny vs disabled:
```
px-8 py-3 rounded-xl text-[0.95rem] font-semibold transition-all border-none
  • aktywny:  bg-gradient-to-br from-emerald-600 to-emerald-500 text-white
              shadow-[0_4px_24px_rgba(5,150,105,0.3)] cursor-pointer
  • disabled: bg-white/[0.05] text-slate-600 cursor-not-allowed
```

**Przycisk secondary (Wstecz)**
```
bg-transparent border border-white/10 text-slate-400 px-6 py-3 rounded-xl
text-[0.95rem] font-medium transition-all hover:bg-white/[0.06]
```

**Przycisk „glass" (ekran sukcesu)**
```
bg-white/[0.08] border border-white/15 text-slate-200 px-8 py-3 rounded-xl
text-[0.95rem] font-medium transition-all backdrop-blur-sm hover:bg-white/[0.14]
```

**Kafelek wyboru (oddział)** — zaznaczony vs domyślny:
```
text-left px-4 py-3.5 rounded-xl text-[0.95rem] transition-all border
  • zaznaczony: bg-emerald-600/15 border-emerald-600/50 text-emerald-400 font-medium
  • domyślny:   bg-white/[0.04] border-white/[0.08] text-slate-400 hover:bg-white/[0.08]
```
Grid: `grid grid-cols-2 gap-2.5`.

**Kafelek z ikoną (kategoria)** — kolor akcentu z danych:
```
flex items-center gap-3.5 px-5 py-[18px] rounded-[14px] text-left transition-all border
  • zaznaczony: border-current/30 bg-current/10  + style={{ color: c.color }}
  • hover:      bg-white/[0.06] border-white/[0.08]
  • domyślny:   bg-white/[0.03] border-white/[0.08]
```

**Input / textarea / select (dark)**
```
w-full px-4 py-3.5 rounded-xl bg-white/[0.04] border border-white/10 text-slate-200
text-base outline-none transition-colors focus:border-emerald-600/50 placeholder:text-slate-600
```
(textarea dodatkowo `resize-y leading-relaxed`; select `appearance-none cursor-pointer`,
a `<option>` dostaje `text-slate-800`, bo natywne menu jest jasne).

**Komunikat błędu (dark)**
```
mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm
```

**Ikona sukcesu (duże „✓")**
```
w-20 h-20 rounded-full bg-gradient-to-br from-emerald-600 to-emerald-400
flex items-center justify-center text-4xl text-white shadow-[0_0_60px_rgba(5,150,105,0.3)]
```

**Trust-footer** (separator + ikony zaufania)
```
mt-12 pt-6 border-t border-white/[0.05] flex gap-6 justify-center flex-wrap
  └ pozycja: flex items-center gap-1.5 text-xs text-slate-600   (🔒 / 👤 / 🚫)
```

**Chip logotypu „Sewera" (login)**
```
bg-[#005FA3] inline-block rounded-lg px-5 py-2 font-black text-xl text-white tracking-wide
```

### 4.2. JASNY MOTYW (dashboard)

**TopBar (pasek górny)**
```
bg-sewera-primary px-6 h-14 flex items-center justify-between shadow-md
  ├ chip logo: bg-[#005FA3] rounded-md px-3.5 py-1.5 font-black text-lg text-white tracking-wide
  ├ podtytuł:  text-white/70 text-sm
  ├ select:    bg-white/[0.12] border border-white/20 text-white px-3 py-1.5 rounded-md text-[13px] appearance-none
  └ chip daty: bg-white/15 rounded-md px-3 py-1.5 text-xs text-white/80
```

**TabNav (zakładki)** — aktywna vs nieaktywna:
```
kontener: bg-white border-b border-gray-300 flex px-6
tab:      px-5 py-3.5 text-sm transition-all border-b-[3px]
  • aktywna:   font-bold text-sewera-primary border-sewera-primary
  • nieaktywna: font-normal text-gray-500 border-transparent
```

**Karta z nagłówkiem (wzorzec bazowy)**
```html
<div class="bg-white border border-gray-300 rounded-lg overflow-hidden">
  <!-- SectionHeader -->
  <div class="bg-sewera-primary text-white px-4 py-2.5 font-bold text-sm tracking-wide
              flex items-center gap-2 rounded-t-md">
    <span class="text-base">📊</span> Tytuł sekcji
  </div>
  <!-- treść -->
</div>
```

**KPICard** (kolor wartości z danych przez `style`)
```
bg-white border border-gray-300 rounded-lg px-4 py-[18px] flex-1 min-w-[140px] flex flex-col gap-1
  ├ label: text-xs text-gray-500 font-semibold uppercase tracking-wider
  ├ value: text-[32px] font-extrabold leading-tight  + style={{ color: accent || '#15377B' }}
  └ sub:   text-xs text-gray-500
```
Rząd kart: `flex gap-3 flex-wrap mb-5`. Logika koloru akcentu (przykład):
`thisWeek > avg → #44872E`, `neg% > 35 → #DB6600 : #44872E`, „procesy" → `#299FAB`.

**StatusBadge** (pigułka statusu)
```
text-[11px] font-bold px-2.5 py-0.5 rounded-full whitespace-nowrap
  • critical: bg-red-50    text-danger          („Priorytet")
  • warning:  bg-orange-50 text-warning         („Do analizy")
  • info:     bg-blue-50   text-sewera-primary   („Monitorowany")
```

**Słupek poziomy (BranchChart)**
```
tor:    bg-gray-200 rounded h-[22px] overflow-hidden flex-1
fill:   h-full bg-sewera-primary rounded transition-all duration-500   (width: %)
etykieta nazwy: w-[90px] text-[13px] font-semibold text-gray-700 text-right
wartość:        w-[30px] text-[13px] font-bold text-sewera-dark text-right
```
Pod spodem segmentowane paski neg/innow (`bg-danger` / `bg-success`, `h-2 rounded-sm`)
+ legenda z kropkami `w-2.5 h-2.5 rounded-sm`.

**Kafelek kategorii (CategoryGrid)**
```
flex-1 text-center py-3.5 px-2 bg-gray-50 rounded-lg border border-gray-300
  ├ liczba: text-[26px] font-extrabold  + style={{ color: c.color }}
  ├ nazwa:  text-xs text-gray-500
  └ pasek:  h-1 rounded-sm bg-gray-200  ›  fill h-full rounded-sm (background: c.color, width: %)
```

**Słupki pionowe (WeeklyChart)**
```
kontener: flex items-end gap-1 h-20 px-1
słupek:   w-full max-w-[36px] rounded-t transition-all duration-300
  • bieżący tydzień: bg-sewera-primary
  • pozostałe:       bg-blue-200
wartość nad:  text-[11px] font-bold text-sewera-dark
etykieta pod: text-[10px] text-gray-500
```
Wysokość liczona w px: `height = round(count/max * 56)px`.

**Pierścień sentymentu (SentimentRing — inline SVG)**
```
viewBox 0 0 128 128, r=54, cx=cy=64, strokeWidth=14, strokeLinecap="round"
  tor:        stroke #E8E8E8
  pozytywne:  stroke #44872E
  negatywne:  stroke #FF0000
  neutralne:  stroke #D6D6D6
dasharray = (val/total)*obwód ; kolejne offsety sumują poprzednie segmenty
  startowy offset = obwód * 0.25  (start od góry)
center: text-[22px] font-extrabold text-sewera-dark + text-[10px] text-gray-500 „wpisów"
legenda: text-lg font-extrabold (success/danger/gray-400) + text-[11px] text-gray-500
```

**Tabela (TopicsTable)** — zebra + sticky-styl nagłówka:
```
nagłówek: grid grid-cols-[1fr_70px_50px_50px] px-4 py-2.5 bg-gray-50
          text-[11px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-300
wiersz:   grid (te same kolumny) px-4 py-3 items-center
          parzysty bg-white / nieparzysty bg-gray-50 ; border-b border-gray-300 (oprócz ostatniego)
badge liczby: text-sm font-extrabold px-2.5 py-0.5 rounded-full
          • ≥12: bg-red-50 text-danger   • ≥8: bg-orange-50 text-warning   • reszta: bg-gray-50 text-gray-700
trend:    ▲ text-danger / ▼ text-success / ● text-gray-500
sentyment: kropka inline-block w-2 h-2 rounded-full (success/danger/gray-500)
stopka:   px-4 py-3 bg-gray-50 border-t border-gray-300 ; text-[11px] text-gray-500 italic
```

**Lista procesów (ProcessList)** — wiersz z kwadratowym badge liczby:
```
wiersz: px-5 py-4 flex gap-4 items-start ; zebra bg-white/bg-gray-50 ; border-b border-gray-300
badge:  min-w-[44px] h-11 rounded-[10px] flex flex-col items-center justify-center
  • critical: bg-red-50    + liczba text-danger
  • warning:  bg-orange-50 + liczba text-warning
  • info:     bg-blue-50   + liczba text-sewera-primary
  liczba: text-lg font-black ; podpis „wpisów": text-[9px] text-gray-500
tytuł:  text-base font-bold text-gray-700  (+ StatusBadge obok)
opis:   text-[13px] text-gray-600 leading-relaxed
tagi:   bg-gray-50 border border-gray-300 rounded px-2.5 py-1 text-[11px]
        (drugi tag: text-teal font-bold „Kandydat do automatyzacji")
```
**Kafelek podsumowania (ikona w gradiencie marki):**
```
ikona: w-12 h-12 rounded-xl bg-gradient-to-br from-sewera-primary to-teal
       flex items-center justify-center text-[22px] text-white   (⚡)
karta: bg-white border border-gray-300 rounded-lg p-5 flex items-center gap-4
```

**Stopka dashboardu**
```
mt-6 pt-3.5 border-t border-gray-300 flex justify-between items-center
  └ tekst: text-[11px] text-gray-500
```

**Stany ładowania / błędu**
```
loading: min-h-screen bg-gray-50 font-lato flex items-center justify-center
         › text-gray-500 text-lg „Ładowanie danych..."
retry:   bg-sewera-primary text-white px-6 py-2 rounded-md
```

---

## 5. Zasady spójności (żeby nie rozjechać stylu)

1. **Nie mieszaj światów.** Powierzchnie publiczne = dark + DM Sans + emerald.
   Powierzchnie panelu = light + Lato + sewera-blue. Login łączy dark tło z niebieskim CTA.
2. **Glow tylko na ciemnym tle** (`shadow-[…rgba(5,150,105,…)]`). Na jasnym — wyłącznie `shadow-md` na TopBarze, resztę niosą ramki `border-gray-300`.
3. **Hierarchia liczb w dashboardzie**: duże wartości zawsze `font-extrabold`, kolor `sewera-dark` (#15377B) lub semantyczny z danych.
4. **Kolory z danych** podawaj inline `style={{ color }}` — tylko kolory tokenowe trzymaj w klasach Tailwind.
5. **Promienie**: dark = miękkie (12–14px), light = umiarkowane (6–8px), pigułki/kropki = `rounded-full`.
6. **Zebra w listach/tabelach**: parzysty `bg-white`, nieparzysty `bg-gray-50`, separator `border-gray-300`.
7. **Wejścia kroków** zawsze `animate-fadeUp`; akcenty „live" — `animate-pulse`.
8. **Akcent emerald = Tailwind default** (`emerald-400/500/600`) — nie definiuj własnego, żeby gradienty i `/15`, `/30`, `/50` alpha działały spójnie.

---

## 6. Mapa: ekran → komponenty (referencja źródłowa)

| Ekran | Komponenty (kolejność wizualna) |
|---|---|
| **Formularz** | Header(eyebrow+H1+lead) › `StepProgress` › `StepBranch` / `StepCategory` / `StepContent` › nawigacja(Wstecz/Dalej) › trust-footer |
| **Sukces** | `SuccessScreen` (✓ w glow + tekst + przycisk glass) |
| **Login** | chip „Sewera" › H1 › input hasła › przycisk `sewera-primary` |
| **Dashboard / Przegląd** | `TopBar` › `TabNav` › `KPICards` › grid[ `BranchChart` + `CategoryGrid` ‖ `WeeklyChart` + `SentimentRing` + top procesy ] › stopka |
| **Dashboard / Tematy** | `SectionHeader` + `TopicsTable` |
| **Dashboard / Procesy** | `ProcessList` (lista + kafelek podsumowania) |

> Wszystkie komponenty są bezstanowe wizualnie (stan trzymany w stronach).
> Aby przenieść wygląd: skopiuj `tailwind.config.ts` (§3.1), ustaw czcionki (§3.2),
> i odtwórz komponenty z receptur (§4). Wykresy = czysty Tailwind + inline SVG, bez zależności.
