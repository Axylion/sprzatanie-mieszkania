# Goleszan 19 · aktualizacja podglądu v13-5

1. W projekcie **goleszan-19-test** (`pbsubdmuupwmtgzncxmh`) sprawdź, czy
   zastosowano migracje 001–012. Po 012 uruchom
   `202611140013_admin_history.sql` w SQL Editor. Migracja korzysta z istniejących
   dat urządzeń i audytu; nie zmienia powiązań, generacji ani treści rozmów.
   W razie aktualizacji istniejącego podglądu zachowaj login administratora,
   konfigurację VAPID i zadanie dostarczania.
2. Wgraj ZIP v13-5 do projektu Cloudflare Pages **goleszan-19-preview**.
   ZIP zachowuje publiczną konfigurację poprzedniej kompilacji. Sprawdź
   nazwę `goleszan19-shell-v13-5` w opublikowanym `sw.js`.
3. Zaloguj się i sprawdź cztery karty. Otwórz również kartę wolnego pokoju,
   rozwiń historię, odśwież i wróć do listy. Porównaj układ na komputerze
   i telefonie, oraz przełącz Systemowy, Jasny i Ciemny przed i po zalogowaniu.
4. Testy odłączania, zwalniania i ponownego podłączania wykonuj wyłącznie
   na wydzielonych urządzeniach i wolnym pokoju testowym. Nie odłączaj
   istniejących urządzeń w pokojach 1 i 2. Na potrzeby próby znanego
   identyfikatora rozłącz urządzenie jako mieszkaniec i podłącz je ponownie
   w tym samym profilu przeglądarki. Po administracyjnym odłączeniu spróbuj
   ponownie dołączyć i sprawdź wpis w historii.
5. Starsze urządzenia pokazują zarejestrowaną datę i neutralny status, jeśli
   brak klasyfikacji z rejestracji. Dawne próby, których system nie zapisał,
   nie są odtwarzane. Historia jest dostępna tylko po autoryzacji
   administracyjnej. Numer identyfikuje urządzenie w widoku, bez
   potwierdzania tożsamości mieszkańca.

Jeśli trzeba wycofać interfejs, przywróć poprzedni deployment w **testowym**
Cloudflare Pages. Migracja jest przyrostowa, a lista pokoi nadal zawiera pola
używane przez v13-4. Historii zebranych zdarzeń nie trzeba usuwać.
