# Goleszan 19 F1 na środowisku testowym

Projekt Supabase `goleszan-19-test` (`pbsubdmuupwmtgzncxmh`), Cloudflare Pages `goleszan-19-preview`.

## Przed wdrożeniem

- Sprawdź kopię testowej bazy i możliwość odtworzenia. Zachowaj kod wdrożonej funkcji `g19-deliver` oraz adres istniejącego wdrożenia Pages UI7.
- Porównaj stan migracji 020–021 oraz definicje `g19_push_take()` i `g19_push_finish(bigint,uuid,text)` z kodem bazowym. Potwierdź, że istniejące zadanie dostawy i konfiguracja VAPID działają. Nie odczytuj wartości sekretów do raportu.
- Zastosuj migracje 022 i 023, w tej kolejności. Dodają trzy prywatne tabele z RLS. Wystawiają odczyt statusów i funkcje admina oparte na istniejącej sesji. Nie dodają nowych uprawnień do tabel ani do kluczy push.
- Wdróż zaktualizowaną funkcję `g19-deliver` wyłącznie dla projektu testowego. Pozostaw dotychczasową konfigurację Cron, VAPID i autoryzację wywołań.
- Opublikuj paczkę F1 w testowym projekcie Pages. Sprawdź wersję Service Workera i odczyt statusów po przeładowaniu. Wysyłkę potwierdź na przeznaczonych do testu urządzeniach, bez używania rzeczywistych subskrypcji mieszkańców.

## Wysyłka

Przycisk potwierdza kolejkę, a panel odczytuje jej wynik co 4 sekundy. Wybierane są wyłącznie aktywne subskrypcje kategorii dyżurów w wybranym pokoju. Wynik „przyjęte” oznacza akceptację przez usługę push. Nie potwierdza wyświetlenia na urządzeniu. System próbuje lokalnie dostarczyć zlecenie w ciągu 3 minut. Po 4 minutach zamyka wynik oczekiwania. Ponowna próba wymaga nowej ręcznej akcji.

## Powrót do UI7

1. Zablokuj zapis i nowe zlecenia F1 skryptem `maintenance/rollback-f1.sql`. Skrypt zachowuje wpisy statusów i historię prób. Oznacza niewysłane zadania jako zakończone bez sukcesu i wyklucza je z dotychczasowej kolejki.
2. Poczekaj na zakończenie wywołania funkcji dostawy, jeśli jest aktywne. Przywróć wcześniejszą funkcję Edge i wdrożenie Pages UI7. Ponieważ stare karty PWA mogą nadal działać, sprawdź, czy UI7 przejął cache po zmianie wdrożenia.
3. Przed kolejnym wdrożeniem F1 uruchom ponownie migracje 022–023, aby przywrócić dostęp. Nie usuwaj tabel ani wpisów. Nie zmieniaj harmonogramu automatycznych powiadomień.

## Korekta statusu wysyłki F1

W testowym SQL Editor uruchom skrypt odczytu `maintenance/inspect-manual-duty-push.sql`, dobierając pokój i przedział czasu. Wynik pokazuje kolejkę, dzierżawę i wynik dostawcy bez danych subskrypcji. Następnie zastosuj migrację 024 przed wdrożeniem aktualizacji Pages. Aktualizacja nie wymaga ponownego wdrożenia funkcji Edge ani zmiany Cron. Starszy klient nadal może odpytywać ostatnie zlecenie dla pokoju i daty.
