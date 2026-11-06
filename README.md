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
