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
  "expiresAt": "2026-11-15"
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
