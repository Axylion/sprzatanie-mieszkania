# Goleszan 19 v13-10-0

Ta wersja wymaga migracji 019 po oddzielnym zatwierdzeniu.
Przygotowanie ZIP i testy nie stosują zmian do projektu Supabase.

## Licznik dyskusji

Dotychczasowy RPC powiadomień zwraca tylko 50 ostatnich pozycji i uwzględnia
preferencje kategorii. Migracja 019 dodaje odczytowy RPC
`g19_chat_navigation_count(text,bigint)`, autoryzowany istniejącym tokenem
urządzenia przez `lock_device`. Zwraca liczbę wiadomości i ostatni identyfikator.
Nie zmienia tabel, subskrypcji, kolejki, funkcji dostawy ani harmonogramu Cron.

Tożsamością uczestnika pozostaje pokój wraz z generacją lokatora, tak jak
w istniejących powiadomieniach. Wiadomości z obu urządzeń własnego pokoju
nie zwiększają licznika. Wiadomości pozostałych pokoi są liczone również
przy wyłączonej kategorii push, bez ograniczenia do 50 wpisów.

Ostatnia wizyta jest zapisywana lokalnie osobno dla tokenu urządzenia i projektu.
Pierwsze uruchomienie bez zapisanego znacznika ustanawia punkt początkowy na
ostatniej wiadomości i nie pokazuje całej historycznej rozmowy jako nowej.
Otwarcie dyskusji zeruje licznik, a kolejne odświeżenia podczas widocznej rozmowy
aktualizują ten znacznik. Istniejący `g19_notification_read` oznacza jako
przeczytane wyłącznie powiadomienia kategorii `messages`.
Dane są sprawdzane przy wejściu/wyjściu, powrocie do aplikacji i co 15 sekund
w otwartej aktywnej aplikacji. Przy braku sieci pozostaje ostatni potwierdzony wynik.

## Wdrożenie po zatwierdzeniu

1. Wykonaj migawkę schematu testowego i sprawdź projekt.
2. Zastosuj 019 tylko w goleszan-19-test.
3. Opublikuj ZIP tylko w goleszan-19-preview po sprawdzeniu 54 plików.
4. Sprawdź aktualizację Service Worker z v13-9-0-r2 i licznik na dwóch pokojach.

Wycofanie frontendu nie wymaga wycofania odczytowego RPC. Można przywrócić
poprzedni deployment. Migracja nie ma operacji na danych użytkowników.
