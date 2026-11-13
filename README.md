# sprzatanie-mieszkania
Zasady i harmonogram sprzątania mieszkania

## Ogłoszenia i termin ważności

Publiczne wpisy znajdują się w `announcements.json`. Każdy wpis wymaga unikalnego
`id`, `title`, `body` i `publishedAt`. Opcjonalne `expiresAt` wyznacza moment
wygaśnięcia; wpis pozostaje w JSON, ale nie jest już pokazywany żadnemu mieszkańcowi.
Brak pola lub `null` oznacza brak automatycznego terminu końcowego.

```json
{
  "id": "przyklad-2026-11-15",
  "title": "Przykładowa informacja",
  "body": "Treść ogłoszenia.",
  "publishedAt": "2026-11-04T12:00:00",
  "expiresAt": "2026-11-16T00:00:00+01:00"
}
```

- `2026-11-15`: ogłoszenie jest ważne do końca tego dnia w **Europe/Warsaw**;
  znika o północy rozpoczynającej 16 listopada.
- `2026-11-15T18:30:00`: znika dokładnie o 18:30 czasu warszawskiego.
- ISO ze strefą, np. `2026-11-15T18:30:00+01:00` lub `2026-11-15T17:30:00Z`,
  oznacza konkretny moment. Ustawienie strefy na urządzeniu nie zmienia wyniku.
- Te same reguły strefy dotyczą `publishedAt`; sama data oznacza początek dnia.
- Uwzględniane są zmiany CET/CEST. Nieistniejąca godzina podczas wiosennej zmiany
  czasu jest odrzucana; dla powtórzonej godziny jesienią wybierany jest wcześniejszy
  moment. W takiej sytuacji najlepiej podać jawny offset.
- Nieprawidłowy termin (również pusty tekst) nie jest traktowany jak brak terminu:
  taki wpis nie jest pokazywany.

Otwarta strona usuwa wygasłe ogłoszenia automatycznie, także po powrocie do uśpionej
karty. Lokalny krzyżyk i „Pokaż ukryte ogłoszenia” dotyczą tylko aktywnych wpisów;
przywracanie nie reaktywuje wygasłego ogłoszenia. Zmiana terminu tworzy nową wersję
ogłoszenia, która nie dziedziczy lokalnego ukrycia poprzedniej wersji.

Testy: `node --test tests/announcements.test.cjs` (wymaga Playwright i Chromium).


## Automatyczna archiwizacja i usuwanie

Zalecany format `expiresAt` to ISO 8601 z jawnym offsetem, np.
`2026-11-16T00:00:00+01:00`. Ogłoszenie testowe ma właśnie taki termin.
Po wygaśnięciu wpis jest niewidoczny, a po **30 dniach kalendarzowych w Europe/Warsaw**
może zostać fizycznie usunięty z JSON. Próg zachowuje lokalną godzinę, uwzględniając
zmiany CET/CEST; nie jest to sztywne 720 godzin. Przy niejednoznacznym progu jesienią
wybierany jest późniejszy moment, a próg w wiosennej luce jest przesuwany do przodu,
aby nie usuwać przedwcześnie. Dla daty bez czasu 30 dni liczymy od północy po tej dacie.

Workflow `.github/workflows/cleanup-announcements.yml` działa raz dziennie o 04:17 UTC
(05:17 zimą / 06:17 latem w Warszawie) i ma ręczny `workflow_dispatch`.
Uruchomienie nastąpi dopiero po zatwierdzeniu i scaleniu PR do `main`.
Usunięcie następuje podczas pierwszego uruchomienia po osiągnięciu progu.

- Wpisy bez terminu i z `null` nie są usuwane. Nieprawidłowe daty i rekordy są
  zachowywane z ostrzeżeniem w logu. Wadliwy JSON, powtórzone klucze lub błąd zapisu
  przerywają wykonanie bez publikacji. Zapis jest atomowy.
- Kolejność, identyfikatory i pozostałe pola zachowanych wpisów nie zmieniają się.
  Formatowanie JSON może zostać ujednolicone po usunięciu; przy braku usunięć plik
  pozostaje identyczny bajt po bajcie i nie powstaje kommit.
- Publikowany jest wyłącznie `announcements.json`, z kontrolą SHA poprzedniej wersji.
  Równoległa zmiana pliku powoduje błąd zamiast nadpisania zmian właściciela.
- Uprawnienia domyślnie są wyłączone. Tylko zadanie czyszczące ma `contents: write`;
  osobne zadanie publikacji ma wyłącznie `pages: write`. Używany jest repozytoryjny
  `GITHUB_TOKEN`, bez dodatkowych sekretów i zewnętrznych usług.
- Po kommicie jest jawnie zlecana przebudowa istniejącej witryny GitHub Pages
  publikowanej z gałęzi `main`, ponieważ kommit z `GITHUB_TOKEN` sam jej nie uruchamia.
  Ręczny start ponawia też przebudowę, nawet jeśli nie ma już nic do usunięcia.
  Błędy API są widoczne jako nieudane wykonanie; ustawienia witryny nie są zmieniane.
  [GitHub Pages: źródło publikacji](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
  i [żądanie przebudowy](https://docs.github.com/en/rest/pages/pages#request-a-github-pages-build).
- PWA nadal pobiera ogłoszenia przez sieć bez starego cache. Harmonogram, motywy,
  instalacja i lokalne ukrywanie pozostają niezależne od czyszczenia.

Testy czyszczenia i bezpiecznej publikacji (Python 3.9+, bez pakietów zewnętrznych):
`python3 -m unittest discover -s tests -p 'test_cleanup*.py' -v`.
Lokalna próba czyszczenia na kopii danych:
`python3 scripts/cleanup-announcements.py --file /sciezka/do/kopii.json`.

## Poradnik sprzątania

Przycisk pod najbliższym dyżurem otwiera spis ośmiu kart. Bezpośredni link do
karty ma postać `./#poradnik/toaleta`. Instrukcje i opisy zdjęć są w
`poradnik/dane.js`, a szablon, nawigacja i galeria w `poradnik/poradnik.js`.
Zdjęcia i ilustracje z infografik są w `poradnik/media/`.

Aby dodać kartę, dopisz jej dane oraz pliki WebP. Numeruj zdjęcia od 1, zaczynając
od galerii, a potem dodając zdjęcia kroków w ich kolejności. Arkusz
`<id>-ikony.webp` zawiera kwadratowe pola w kolejności środków i akcesoriów,
a następnie dodatkowe ilustracje kroków. Pole `illustration` wskazuje pozycję
w arkuszu od 0. Dodaj ścieżki plików do `SHELL` i zwiększ wersję cache w `sw.js`.

Aby otworzyć podgląd lokalny i sprawdzić PWA, uruchom `python3 -m http.server 8000`
w katalogu projektu i otwórz `http://localhost:8000/`. Po pierwszym wczytaniu
i aktywacji service workera można przełączyć przeglądarkę w tryb offline
i odświeżyć bezpośredni link do karty. Test w Playwright uruchamia polecenie
`node --test tests/poradnik.test.cjs`.

## Dyskusje

Goleszan 19 udostępnia harmonogram, zasady, poradnik i ogłoszenia wszystkim
odwiedzającym. Dyskusje wymagają aktywnego powiązania urządzenia. Wcześniejszy
wybór pokoju do kalendarza (`cleaning-room`) jest zachowany. Pokój potwierdzony
w Dyskusjach uzupełnia wybór kalendarza, jeśli urządzenie nie ma go jeszcze ustawionego.

W Dyskusjach wybierz wolny pokój i użyj „Połącz pokój”. Aby podłączyć kolejne
urządzenie, wybierz zajęty pokój i „Połącz kolejne urządzenie”. Odczytaj sześciocyfrowy kod.
Na połączonym urządzeniu otwórz „Dodaj urządzenie”, wpisz sześć cyfr i potwierdź.
Nowe urządzenie uzyska dostęp automatycznie. Kod jest ważny dwie minuty.
Ekran pokazuje pozostały czas i umożliwia anulowanie lub odnowienie kodu.
Zwykła karta przeglądarki i zainstalowana PWA mogą wymagać osobnych powiązań.
Każdy mieszkaniec ma jedną reakcję na wiadomość, wspólną dla wszystkich jego urządzeń.

### Uruchomienie na Supabase

1. Utwórz dedykowany projekt Supabase na planie Free. Włącz Data API dla
   standardowego schematu `public`. Schemat `g19_private` zostaw poza API.
2. W uwierzytelnionym SQL Editor projektu wykonaj raz migrację
   `supabase/migrations/202611130001_dyskusje.sql` (tylko dla pustej bazy),
   a potem `202611130002_pairing_codes.sql`. W istniejącej bazie testowej
   wykonaj tylko drugą migrację przed wgraniem nowego ZIP do Cloudflare Pages.
   Migracja działa w transakcji, zachowuje urządzenia, wiadomości i reakcje
   oraz anuluje niezakończone prośby z poprzedniej wersji. Jeśli projekt
   korzysta z Supabase CLI, zastosuj migracje przez jego standardowy proces.
3. W `dyskusje/config.js` wpisz URL `https://<project-ref>.supabase.co` oraz
   klucz **publishable** `sb_publishable_…` z ustawień projektu. Nie wpisuj
   klucza `sb_secret_…`, service role ani danych połączenia do bazy.
4. Na podglądzie połącz dwa niezależne profile przeglądarki, wyślij wiadomość,
   sprawdź reakcję i odwołanie testowego urządzenia. Po akceptacji właściciela
   opublikuj zmiany. Jeśli konfiguracja zmienia się już po pierwszym wdrożeniu
   Dyskusji, zmień też wersję powłoki w `sw.js`, aby zaktualizować PWA.

GitHub Pages nadal serwuje stronę statyczną. Plan Free Supabase ma 500 MB bazy
i 5 GB transferu, co odpowiada małemu czatowi tekstowemu. Po tygodniu małej
aktywności projekt może zostać wstrzymany i wtedy właściciel wznawia go z
Dashboardu. Firebase ma darmowe odczyty i subskrypcje Firestore, ale typowa
implementacja wymagałaby osobnego przepływu Firebase Auth i reguł Firestore.
Tu powiązania, reakcje, odwołania i kontrola częstotliwości działają w
transakcjach Postgresa. [Supabase Free](https://supabase.com/pricing) ·
[Firebase](https://firebase.google.com/pricing)

Czat sprawdza zmiany mniej więcej co pięć sekund w widocznym oknie. Zapytanie
ze znaną wersją bez zmian zwraca tylko krótkie potwierdzenie. Strony historii
mają po 40 wiadomości. Po powrocie do aplikacji historia odświeża się od razu.
Wymiana wiadomości wymaga internetu. Historia i powiązania są zapisane w bazie.

### Uprawnienia i „Zmień mieszkańca”

Identyfikator urządzenia jest losowym kluczem wydanym przez serwer. Przeglądarka
przechowuje go lokalnie i przesyła przez HTTPS w treści żądania. Baza przechowuje
skrót SHA-256. Klucz jest dostępny dla skryptów z tego samego origin, więc na
tym origin powinien działać wyłącznie zaufany kod. Treść wiadomości jest
renderowana jako tekst. RLS i uprawnienia SQL blokują bezpośredni dostęp do
tabel, a RPC weryfikuje klucz i generację pokoju. Wysłanie ma klucz
idempotencji, limit 1500 znaków i limit częstotliwości. Reakcje też mają limit.

Osoba z dostępem do strony może zająć wolny pokój. Zajęty pokój wymaga
potwierdzenia z połączonego urządzenia tego mieszkańca. Model nie sprawdza
tożsamości. Wyczyszczenie danych witryny pozwala zgłosić nowe urządzenie.
Kod widoczny na ekranie pozwala jedynie wskazać prośbę do potwierdzenia.
Pokój ma do 12 nowych próśb i do 6 prób potwierdzenia na minutę.
Osobny sekret nowego urządzenia służy do odebrania wyniku. Powtórne odebranie
w okresie ważności zwraca to samo powiązanie po utracie odpowiedzi sieciowej.

Właściciel zarządza pokojami w zabezpieczonym Supabase Dashboard. W SQL Editor
zapisz zapytanie pod nazwą **Zmień mieszkańca**. Najpierw odczytaj stan:

```sql
select * from public.g19_admin_rooms();
```

Po sprawdzeniu numeru pokoju, generacji i liczby urządzeń uruchom funkcję z tymi
wartościami. Przykład zmiany mieszkańca pokoju 2 w generacji 1 przy dwóch
aktywnych urządzeniach:

```sql
select public.g19_admin_change_resident(2, 1, 2) as odwolane_urzadzenia;
```

Zmiana liczby urządzeń lub generacji od momentu odczytu powoduje przerwanie
operacji. Reset odwołuje wszystkie aktywne klucze tego pokoju, anuluje oczekujące
i zatwierdzone prośby, otwiera nową generację i zwalnia pokój. Stare wpisy oraz reakcje pozostają w historii. Wiadomości z
wcześniejszych generacji mają oznaczenie „poprzedni mieszkaniec”. Nowy
mieszkaniec może połączyć swoje urządzenie. Odwołany profil pokazuje „Dostęp do
dyskusji został zakończony.”. Funkcje administracyjne nie mają
uprawnień wykonania dla przeglądarki ani publicznego API.

### Przygotowanie powiadomień

Ustawienia zapisują osobno trzy lokalne preferencje, dla dyżurów, wiadomości
i ważnych ogłoszeń. Kolejny etap może synchronizować je z subskrypcją push
powiązaną z ID urządzenia i generacją mieszkańca. Zmiana mieszkańca odwoła
także subskrypcje jego urządzeń. Dla wiadomości serwer będzie mógł zapisywać
zdarzenie razem z wiadomością i deduplikować wysyłkę po ID zdarzenia i
subskrypcji. Powiadomienia o własnej wiadomości wykluczą urządzenia z tej
samej generacji tego pokoju. Krótko ważny sygnał aktywności będzie wymagał
widocznego widoku Dyskusji i aktywnego okna. Powiadomienie otworzy `#dyskusje`.
Zachowanie Web Push, szczególnie na iOS, wymaga osobnych testów platformowych.

### Testy Dyskusji

Po zainstalowaniu Playwright i `@electric-sql/pglite` uruchom
`node --test tests/dyskusje.test.mjs`. Test przeglądarkowy łączy niezależne konteksty
z rzeczywistą migracją PostgreSQL w PGlite przez lokalny odpowiednik RPC.
`CHROME_PATH` może wskazać zainstalowane Chromium. Przed publikacją pozostaje
test połączenia z konkretnym projektem Supabase.
