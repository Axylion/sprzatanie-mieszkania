# Goleszan 19 — dostarczanie powiadomień w podglądzie

1. W projekcie **goleszan-19-test** zastosuj brakujące migracje w kolejności.
   Po 001–004 potrzebne są tylko `202611130005_notification_inbox.sql` i
   `202611130006_web_push.sql`. Zachowaj schemat `g19_private` poza Data API.
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
   `sw.js` jeśli aktualizujesz konfigurację po pierwszym wgraniu v10.
7. Włącz push ręcznie w ustawieniach. Na dwóch urządzeniach z różnych pokoi
   wyślij wiadomość i sprawdź powiadomienie u odbiorcy przy zamkniętej karcie.
   Sprawdź również wyłączenie kategorii, kliknięcie w push i odwołanie
   urządzenia. Na iOS/iPadOS 16.4+ użyj aplikacji dodanej do ekranu początkowego.

Wiadomość tworzy prywatne wydarzenia w tej samej transakcji. Serwer pomija
wszystkie urządzenia autora. Ogłoszenia pochodzą z aktualnego publicznego JSON.
Przypomnienie powstaje od piątku 14:00 do północy czasu warszawskiego.
Każde zdarzenie ma unikalny klucz na urządzenie, a odczyt jest niezależny.
Połączenie pokoju jest wymagane do prywatnego centrum oraz push. Gość może
czytać powiadomienia o publicznych ogłoszeniach, z odczytem zapisanym lokalnie.

Zadanie obsługuje ograniczoną partię i ponawia błędy przejściowe do pięciu prób.
Odpowiedzi 404/410 usuwają nieaktualną subskrypcję. Logi podają tylko liczniki.
Tag powiadomienia i temat push ograniczają powtórzenia przy niejednoznacznym
błędzie transportu. Push już zaakceptowany przez przeglądarkę przed odwołaniem
może jeszcze dotrzeć, dlatego payload zawiera tylko kategorię i cel. Pełną
historię rozmowy nadal chroni powiązanie urządzenia.

[Supabase Cron i Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)
· [Web Push na iOS](https://webkit.org/blog/13878/)
