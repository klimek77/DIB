-- Seed data for local dev (loaded by `supabase db reset`, NOT applied to production).
-- Six representative rows derived from context/foundation/DIB_example_database.csv:
--   • 5 enriched rows (enrichment_status = 'done') covering each topic value
--     and each tone value at least once.
--   • 1 pending row (enrichment_status = 'pending', no AI fields) — proves the
--     FR-008 invisibility default (dashboard should NOT show this row until
--     F-03 consumer marks it 'done').

INSERT INTO public.submissions (
    id, created_at,
    department, branch, topic, content, signature,
    enrichment_status, enrichment_attempts, enrichment_attempted_at,
    ai_title, ai_tone, ai_classification, ai_summary
) VALUES
-- SUG-4 — idea, sales/Gliwice, positive
(
    gen_random_uuid(),
    '2026-03-17 16:07:00+00',
    'Sprzedaż', 'Gliwice', 'Pomysł',
    'Myślę, że fajnym pomysłem byłoby umożliwienie pracownikom spędzenia jednego dnia w miesiącu w innym dziale. Pozwoliłoby to lepiej zrozumieć jak działa firma i poprawić współpracę między zespołami.',
    NULL,
    'done', 1, '2026-03-17 16:08:00+00',
    'Pomysł na rotację między działami',
    'Pozytywny',
    'Proces rozwoju pracowników → program shadow / rotacja',
    'Propozycja programu rotacji międzydziałowej (1 dzień/miesiąc) w celu lepszego zrozumienia procesów firmy.'
),
-- SUG-5 — problem, warehouse/Oświęcim, negative
(
    gen_random_uuid(),
    '2026-03-17 16:07:00+00',
    'Magazyn', 'Oświęcim', 'Problem',
    'Zamówienie materiałów musi przejść przez 4 osoby zanim zostanie zatwierdzone. Czasem czekamy tydzień na podpis jednej osoby, bo jest na urlopie. Przy małych kwotach (do 500 zł) mogłoby to iść szybciej.',
    NULL,
    'done', 1, '2026-03-17 16:08:00+00',
    'Zbyt długi obieg akceptacji zamówień',
    'Negatywny',
    'Proces zamówień materiałowych → uproszczenie ścieżki akceptacji dla kwot < 500 zł',
    'Proces akceptacji zamówień materiałowych zbyt powolny (4 etapy). Sugestia uproszczenia dla niskich kwot.'
),
-- SUG-3 — improvement, HR/Sosnowiec, negative
(
    gen_random_uuid(),
    '2026-03-17 16:07:00+00',
    'HR', 'Sosnowiec', 'Usprawnienie',
    'Procedury firmowe są rozrzucone — część na dysku, część w mailach, część w głowach ludzi. Nowi pracownicy nie wiedzą gdzie szukać i pytają wszystkich dookoła. Przydałaby się jedna baza wiedzy.',
    NULL,
    'done', 1, '2026-03-17 16:08:00+00',
    'Brak jednego miejsca na procedury',
    'Negatywny',
    'Proces onboardingu + zarządzanie wiedzą firmową → baza wiedzy / wiki',
    'Procedury rozproszone w wielu miejscach. Brak centralnej bazy wiedzy utrudnia onboarding nowych pracowników.'
),
-- SUG-25 — improvement, operational/Chrzanów, neutral
(
    gen_random_uuid(),
    '2026-03-18 11:44:00+00',
    'Operacyjny', 'Chrzanów', 'Usprawnienie',
    'Niektóre spotkania wymagają dojazdu do innego oddziału — godzina w jedną stronę, godzina w drugą. Część z nich świetnie działałaby jako wideokonferencja. Zaoszczędzimy czas i paliwo.',
    NULL,
    'done', 1, '2026-03-18 11:45:00+00',
    'Spotkania online zamiast dojazdów międzyoddziałowych',
    'Neutralny',
    'Komunikacja międzyoddziałowa → polityka hybrid remote/on-site',
    'Część spotkań międzyoddziałowych można zastąpić wideokonferencjami. Oszczędność czasu i kosztów.'
),
-- SUG-14 — other (positive feedback), warehouse/Oświęcim, positive
(
    gen_random_uuid(),
    '2026-03-18 11:43:00+00',
    'Magazyn', 'Oświęcim', 'Inne',
    'Chciałem napisać coś pozytywnego — nasz zespół magazynowy naprawdę dobrze ze sobą współpracuje. Kierownik potrafi słuchać i rozwiązywać problemy na bieżąco. Warto to docenić.',
    NULL,
    'done', 1, '2026-03-18 11:44:00+00',
    'Świetna atmosfera w zespole magazynu',
    'Pozytywny',
    'Komunikacja wewnętrzna → feedback loop pozytywny, program doceniania',
    'Pozytywna opinia o atmosferze i zarządzaniu w zespole magazynowym.'
),
-- Synthetic pending row — proves FR-008 invisibility default
(
    gen_random_uuid(),
    now(),
    'IT', 'Katowice', 'Pomysł',
    'To zgłoszenie czeka na wzbogacenie AI — nie powinno być widoczne w dashboardzie, dopóki F-03 nie ustawi enrichment_status na done.',
    NULL,
    'pending', 0, NULL,
    NULL, NULL, NULL, NULL
);
