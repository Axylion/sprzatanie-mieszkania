# Goleszan 19 v13-8 · ogłoszenia w środowisku testowym

Zakres obejmuje projekt Supabase **goleszan-19-test** (`pbsubdmuupwmtgzncxmh`)
i Cloudflare Pages **goleszan-19-preview**. Wdrożenie wymaga osobnego potwierdzenia.

## Dane i interfejs

- Migracja **015** dodaje prywatną tabelę, wersje treści i walidację dokumentu.
  `g19_public_announcements` zwraca aktualne karty. RPC
  `g19_web_admin_announcements`, `g19_web_admin_save_announcement` oraz
  `g19_web_admin_withdraw_announcement` sprawdzają bieżącą sesję administratora.
- Migracja **016** importuje migawkę JSON z v13-7 z identyfikatorem i kluczem
  lokalnego ukrycia. Import nie ma treści przeznaczonej dla kolejki push.
- Migracja **017** dodaje `g19_db_notification_tick` i
  `g19_announcement_delivery_active` dla roli usługowej. Istniejące RPC
  `g19_push_take` i `g19_notifications` filtrują tylko ogłoszenia wycofane lub
  wygasłe. Pierwszy push odczytuje migawkę zapisaną przy publikacji.
- Domyślny okres liczy 30 dni kalendarzowych od pierwszej publikacji w Warszawie.
  Ręcznie wybrana data kończy się o północy następnego dnia. Wycofane i wygasłe
  wpisy pozostają w historii. Żądanie push przekazane do dostawcy przed
  wycofaniem lub wygaśnięciem może jeszcze dotrzeć do urządzenia.

## Kolejność wdrożenia

1. W projekcie testowym porównaj aktywny JSON z migracją 016. Wykonaj kopię
   migawki JSON i odnotuj projekt, wersję Edge Function oraz ostatni poprawny
   deployment Pages. Upewnij się, że projekt ma migracje 001–014. Jeśli JSON
   różni się od migawki, uzupełnij import przed zmianą źródła.
2. Zastosuj 015–017 po kolei. Sprawdź odczyt publiczny, zgodność klucza ukrycia
   i brak nowych pozycji kolejki związanych z importem. Sprawdź prawa sesji
   administratora i brak dostępu do niepublicznych rekordów z anon.
3. Rozwiń istniejącą funkcję `g19-deliver` z aktualnym `index.ts` i
   `events.mjs`. Zachowaj sekrety, VAPID i harmonogram Cron. Odczytaj wynik
   automatycznego wywołania. Zmienna `G19_ANNOUNCEMENTS_URL` nie jest już używana.
4. Prześlij sprawdzony ZIP v13-8 do projektu Pages. Zawiera pustą odpowiedź
   dla starego pliku `announcements.json`, aby wcześniejsze klienty PWA nie
   wyświetlały nieaktualnej treści do momentu aktualizacji. Dane źródłowe
   pozostają w Supabase i w migawce repozytorium.
5. Upewnij się, że `/index.html` prowadzi do `/` z odpowiedzią 200 i
   niepustym HTML. Sprawdź aktualizację Service Workera, adres testowej bazy,
   widok publiczny i sekcję administracji. Ręczny push na Linux Mint i Android
   przeprowadź po osobnym potwierdzeniu, korzystając z normalnego Cron.
6. Przy problemie po publikacji wstrzymaj pracę w edytorze i zachowaj rekordy
   Supabase. Przed pierwszym użyciem edytora można przywrócić frontend oraz
   poprzedni Edge, uwzględniając filtr ogłoszeń w migracji 017. Po zapisaniu
   danych przez administratora popraw frontend z zachowaniem odczytu z
   Supabase, ponieważ v13-7 nie pokaże nowych rekordów.
