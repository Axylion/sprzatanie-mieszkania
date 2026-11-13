# Goleszan 19 — dostarczanie powiadomień w podglądzie

1. W projekcie **goleszan-19-test** zastosuj brakujące migracje w kolejności.
   Jeśli v10 ma już migracje 001–006, zastosuj tylko
   `202611130007_unified_notifications.sql` i `202611130008_device_revocation_audit.sql`.
   Stan migracji zweryfikuj przed uruchomieniem. Zachowaj schemat `g19_private` poza Data API.
2. Włącz Supabase Cron (pg_cron), pg_net oraz Vault. Wygeneruj osobny losowy
   sekret zadania, np. `openssl rand -hex 32`. Zapisz go w Edge Function Secrets
   jako `G19_DELIVERY_SECRET` i w Vault jako `g19_delivery_secret`.
   W Vault zapisz URL testowego projektu pod nazwą `g19_project_url`.
3. Dodaj konfigurację Edge Function w testowym projekcie:

   | Zmienna | Wartość |
   |---|---|
   | G19_ANNOUNCEMENTS_URL | `https://goleszan-19-preview.pages.dev/announcements.json` |
   | G19_DUTY_ENABLED | `true` włącza przypomnienie w piątek o 14:00 w Europe/Warsaw |
   | G19_VAPID_SUBJECT | Adres kontaktowy operatora, np. `mailto:operator@example.org` |
   | G19_VAPID_PUBLIC_KEY | Klucz publiczny z `npx web-push@3.6.7 generate-vapid-keys` |
   | G19_VAPID_PRIVATE_KEY | Klucz prywatny z tej samej pary, wyłącznie w Edge Function Secrets |
   | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY | Zmienne serwerowe dostarczane przez Supabase |

   Bez VAPID funkcja nadal tworzy wydarzenia w aplikacji. Używaj tej samej
   pary VAPID dla wszystkich aktualizacji danego podglądu.
4. W katalogu repozytorium uruchom
   `supabase functions deploy g19-deliver --project-ref <test-ref> --no-verify-jwt`.
   Funkcja uwierzytelnia wywołania przez `x-g19-delivery`, porównując sekret
   z konfiguracją. Sprawdź, że żądanie bez sekretu zwraca 401.
5. W SQL Editor testowego projektu skonfiguruj harmonogram:

   ```sql
   select cron.schedule('g19-delivery', '*/2 * * * *', $job$
     select net.http_post(
       url := rtrim((select decrypted_secret from vault.decrypted_secrets
                     where name = 'g19_project_url'), '/') || '/functions/v1/g19-deliver',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-g19-delivery', (select decrypted_secret from vault.decrypted_secrets
                           where name = 'g19_delivery_secret')
       ),
       body := '{}'::jsonb
     );
   $job$);
   ```

   W razie potrzeby zatrzymaj harmonogram poleceniem
   `select cron.unschedule('g19-delivery');`.
6. W testowym ZIP ustaw w `dyskusje/config.js` wyłącznie testowy URL, klucz
   `sb_publishable_…` i `vapidPublicKey` równy wartości G19_VAPID_PUBLIC_KEY.
   Wgraj ZIP do istniejącego projektu Cloudflare Pages. Zmień wersję cache w
   `sw.js` jeśli aktualizujesz konfigurację po pierwszym wgraniu v11.
7. Zaznacz kategorie i użyj przycisku zezwolenia na powiadomienia w tle. Na dwóch urządzeniach z różnych pokoi
   wyślij wiadomość i sprawdź powiadomienie u odbiorcy przy zamkniętej karcie.
   Sprawdź również wyłączenie kategorii, kliknięcie w push i odwołanie
   urządzenia. Na iOS/iPadOS 16.4+ użyj aplikacji dodanej do ekranu początkowego.

Wiadomość tworzy prywatne wydarzenia w tej samej transakcji. Serwer pomija
wszystkie urządzenia autora. Ogłoszenia pochodzą z aktualnego publicznego JSON.
Przypomnienie powstaje od piątku 14:00 do północy czasu warszawskiego.
Każde zdarzenie ma unikalny klucz na urządzenie, a odczyt jest niezależny.
Kategorie są wspólne dla urządzeń bieżącego mieszkańca. Pierwszy klient v11,
który zapisze ustawienia pokoju, przenosi lokalne ustawienia centrum z v10.
Kolejne urządzenia pobierają ustawienia pokoju.

Widoczna karta z fokusem wysyła sygnał aktywności co 15 sekund przez maksymalnie
dwie minuty od ostatniej interakcji. Sygnał wygasa po 40 sekundach, również
gdy karta została zamknięta bez zgłoszenia lub urządzenie straciło sieć.
Po wygaśnięciu serwer może dostarczyć zdarzenie w tle. Zdarzenia pokazane
na aktywnym urządzeniu pozostają w centrum i są wyłączane z dostawy w tle.
Wczytanie najnowszej rozmowy oznacza wiadomości jako przeczytane tylko na tym
urządzeniu. Krótki dźwięk wymaga wcześniejszej interakcji z przeglądarką.
Połączenie pokoju jest wymagane do prywatnego centrum oraz push. Gość może
czytać powiadomienia o publicznych ogłoszeniach, z odczytem zapisanym lokalnie.

Zadanie obsługuje ograniczoną partię i ponawia błędy przejściowe do pięciu prób.
Odpowiedzi 404/410 usuwają nieaktualną subskrypcję. Logi podają tylko liczniki.
Tag powiadomienia i temat push ograniczają powtórzenia przy niejednoznacznym
błędzie transportu. Push już zaakceptowany przez przeglądarkę przed odwołaniem
może jeszcze dotrzeć, dlatego payload zawiera tylko kategorię i cel. Pełną
historię rozmowy nadal chroni powiązanie urządzenia.

## Dostęp administracyjny i wymiana mieszkańca

Właściciel może używać dotychczasowego SQL Editor. Dla audytu imiennego
przypisz każdemu operatorowi osobny login bazodanowy. Właściciel tworzy login
z unikalną nazwą, nadaje mu silne hasło poza repozytorium, a następnie nadaje
wyłącznie członkostwo w roli `g19_room_admin`. Operator łączy się przez TLS
bezpośrednio lub przez Session Pooler. Rola udostępnia dwie funkcje i nie
przyznaje dostępu do prywatnych tabel. Przy odebraniu dostępu usuń członkostwo
i wyłącz login.

```sql
-- Jako właściciel, dla utworzonego wcześniej imiennego loginu.
grant g19_room_admin to operator_g19;

-- Jako operator, odczytaj pokoje i potwierdź numer oraz liczbę urządzeń.
select * from public.g19_admin_rooms();
-- Przykład: pokój 2, generacja 1, dwa urządzenia.
select public.g19_admin_change_resident(2, 1, 2);

-- Jako właściciel, odczytaj audyt.
select room, generation, performed_at, administrator, result, devices_revoked
from g19_private.room_reset_audit order by id desc;
```

SQL Editor zwykle używa współdzielonej roli `postgres`. Przy takim wywołaniu
dziennik zapisze tę rolę. Identyfikację indywidualną zapewniają imienne loginy.
Błędny pokój lub nieaktualny stan powoduje odmowę i wpis w logach bazy.
Reset zachowuje wiadomości i reakcje, odwołuje urządzenia i subskrypcje
oraz zwalnia pokój do ponownego połączenia.

## Sprawdzenie opublikowanego podglądu

- Na komputerze i telefonie sprawdź instalację, ikonę, obie palety oraz powrót z Poradnika i Dyskusji.
- Z dwóch pokoi wyślij wiadomość do aktywnej strony głównej, aktywnego czatu i zamkniętej karty. Powtórz z dwoma urządzeniami odbiorcy w tym samym pokoju.
- Wyłącz każdą kategorię oddzielnie. Sprawdź odmowę zgody przeglądarki i odzyskanie połączenia po zapisaniu ustawień bez sieci.
- Na koncie testowym odłącz urządzenie, wykonaj zmianę mieszkańca i sprawdź stary klucz, historię oraz nową rejestrację.
- Sprawdź dostawę piątkowego przypomnienia dla dyżurnego pokoju i brak duplikatu po kolejnym uruchomieniu Cron.

[Supabase Cron i Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)
· [Web Push na iOS](https://webkit.org/blog/13878/)
