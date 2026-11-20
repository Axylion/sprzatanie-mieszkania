# Goleszan 19 · wdrożenie testowe v13

Użyj wyłącznie projektu **goleszan-19-test** (`pbsubdmuupwmtgzncxmh`)
oraz podglądu **goleszan-19-preview**. Zachowaj istniejące klucze VAPID,
funkcję dostawy i harmonogram. Nowe migracje nie usuwają historii rozmów.

## Weryfikacja przed wdrożeniem

W SQL Editor odczytaj status pokoju 1:

```sql
select * from public.g19_admin_rooms() where room = 1;
```

Migracja 010 naprawia pokoje oznaczone jako zajęte, które nie mają żadnego
aktywnego urządzenia. Ustawia je jako wolne i anuluje otwarte kody parowania
z tej samej generacji. Nie uruchamia administracyjnego resetu, nie zmienia
generacji i nie modyfikuje powiązań działających urządzeń. Jeżeli pokój 1 ma
aktywne urządzenia, zatrzymaj się i sprawdź ich stan przed podjęciem działań.

## Supabase i podgląd

1. Po migracjach 001–009 zastosuj wyłącznie `202611140010_room_access.sql`
   i `202611140011_admin_panel.sql`. Wykonaj ponownie odczyt pokoju 1.
   Jeżeli był pusty, oczekuj statusu wolnego i tej samej generacji.
2. W Authentication → Users utwórz jednego użytkownika administratora,
   z potwierdzonym adresem i silnym unikalnym hasłem. Sprawdź w Authentication
   limity prób logowania. Adres służy do logowania w Supabase Auth, będzie
   widoczny w publicznej konfiguracji strony. Można użyć dedykowanego aliasu.
3. Skopiuj UUID utworzonego użytkownika. W SQL Editor zarejestruj ten UUID
   jako jedynego operatora panelu, zastępując tekst w cudzysłowie apostrofowym:

   ```sql
   insert into g19_private.web_admin (user_id)
   values ('WSTAW_UUID_UŻYTKOWNIKA_Z_AUTHENTICATION');
   ```

   W przypadku wymiany administratora właściciel aktualizuje ten jeden wpis.
   Sesja panelu jest przechowywana w pamięci strony. Serwer wymaga zgodności
   UUID oraz aktywnej sesji Supabase utworzonej w ciągu ostatniej godziny.
4. Rozpakuj ZIP v13. W `dyskusje/config.js` wpisz adres tego użytkownika
   w polu `adminEmail`. Hasło wpisuje się wyłącznie w formularzu logowania.
   Użyj nowej nazwy cache w `sw.js` przy każdej kolejnej publikacji ze zmianą
   konfiguracji (np. `goleszan19-shell-v13-1`).
5. Wgraj katalog do testowego projektu Cloudflare Pages i otwórz panel
   Administracja. Próbę odłączenia lub zwolnienia wykonaj wyłącznie na
   uzgodnionym pokoju testowym. Nie zwalniaj administracyjnie pokoju 1 bez zgody.

## Odbiór testowy

- W v13 komputer i telefon z zapisanym starym komunikatem mogą ponownie
  otworzyć Dyskusje bez czyszczenia danych. Najpierw połącz urządzenie z wolnym
  pokojem, potem sparuj drugie. Sprawdź historię na obu.
- Sprawdź dwa urządzenia, osobno odłączenie jednego i ostatniego. Sprawdź
  powtórne parowanie, odwołanie starego dostępu, push i ustawienia kategorii.
- Sprawdź panel po wylogowaniu, błędne hasło i brak dostępu po zakończeniu
  sesji. Sprawdź potwierdzanie obu działań i wpisy w
  `g19_private.room_reset_audit` jako właściciel.
- Blokada działa dla utrwalonego identyfikatora przeglądarki zapisanego przez
  v13. Przeglądarka musi co najmniej raz połączyć się z v13 z działającą
  sesją, aby uzupełnić ten identyfikator dla starszego urządzenia.
  Urządzenia bez zapisanego identyfikatora w starym kliencie oraz po
  wyczyszczeniu danych witryny mogą zostać rozpoznane jako nowe.
- Sprawdź na telefonie siatkę miesięcy, oznaczenie swojego pokoju, instalację
  PWA oraz powiadomienia, w tym dyżur w piątek o 14:00 Europe/Warsaw.

## Wycofanie

W Cloudflare można przywrócić poprzednią wersję testowego frontendu.
Migracje są przyrostowe, a starsze wywołania akceptowane dzięki opcjonalnemu
identyfikatorowi. Powrót do v12 przywraca jej zachowanie ekranu po odłączeniu.
Aby natychmiast wyłączyć dostęp przez nowy panel, właściciel usuwa wpis
operatora z `g19_private.web_admin`. Nie cofaj już wykonanych odłączeń przez
ręczne przywracanie starych kluczy.
