const guideSections = [
  { id: "kuchnia", title: "Kuchnia" },
  { id: "toalety", title: "Toalety" },
  { id: "lazienka", title: "Łazienka" },
  { id: "pozostale", title: "Pozostałe" }
];

const guideCards = [
  {
    id: "szafki", section: "kuchnia", icon: "szafki", label: "Szafki kuchenne",
    title: "Szafki kuchenne i ściana robocza",
    description: "Czyste fronty, uchwyty i płytki bez tłustych osadów.",
    note: "Usuwaj tłuszcz na bieżąco, aby łatwiej utrzymać czystość.",
    photos: ["Płytki na ścianie roboczej", "Fronty szafek kuchennych", "Zbliżenie uchwytu szafki"],
    steps: [
      { text: "Spryskaj płytki, fronty szafek i uchwyty odtłuszczaczem do kuchni.", illustration: 4 },
      { text: "Przetrzyj powierzchnię ręcznikiem papierowym.", illustration: 5 },
      { text: "Usuń pozostałości środka wilgotną gąbką lub ściereczką.", illustration: 6 }
    ],
    supplies: ["Odtłuszczacz do kuchni (antytłuszcz)"],
    accessories: ["Gąbka", "Ściereczka z mikrofibry", "Ręcznik papierowy"],
    tip: "Szczególną uwagę zwróć na uchwyty i okolice płyty grzewczej – tam najczęściej osadza się tłuszcz."
  },
  {
    id: "okap", section: "kuchnia", icon: "okap", label: "Okap kuchenny",
    title: "Okap kuchenny (wyciąg)",
    description: "Czysty filtr i powierzchnie bez tłuszczu.",
    note: "Utrzymuj czystość w kuchni na co dzień.",
    photos: ["Otwarty okap kuchenny z filtrem", "Wyjęty filtr okapu", "Filtr w zlewie z pianą"],
    steps: [
      { text: "Zdejmij filtr z okapu.", illustration: 5 },
      { text: "Spryskaj filtr odtłuszczaczem do kuchni i pozostaw na 5–10 minut.", illustration: 6 },
      { text: "Umyj filtr gąbką, spłucz wodą i dokładnie wysusz.", illustration: 7 },
      { text: "Przetrzyj zewnętrzne powierzchnie okapu odtłuszczaczem.", illustration: 8 }
    ],
    supplies: ["Odtłuszczacz do kuchni (antytłuszcz)", "Płyn do mycia naczyń"],
    accessories: ["Gąbka", "Ściereczka z mikrofibry (wilgotna)", "Ściereczka z mikrofibry (sucha)"],
    tip: "Filtr czyść regularnie (np. co 2–4 tygodnie), aby okap działał skutecznie i nie gromadził nadmiaru tłuszczu."
  },
  {
    id: "urzadzenia", section: "kuchnia", icon: "kuchnia", label: "Urządzenia kuchenne",
    title: "Płyta indukcyjna, piekarnik i kuchenka mikrofalowa",
    description: "Czyszczenie zewnętrznych i wewnętrznych powierzchni urządzeń.",
    photos: ["Płyta indukcyjna", "Kuchenka mikrofalowa", "Piekarnik"],
    steps: [
      {
        title: "Powierzchnie zewnętrzne",
        text: "Obudowy, drzwi, panele i płytę indukcyjną przetrzyj przy pomocy środka do mycia szyb (szkłoczyszczacza).",
        illustration: 0
      },
      {
        title: "Powierzchnie wewnętrzne",
        text: "Wnętrze piekarnika i kuchenki mikrofalowej wyczyść przy pomocy odpowiednich specjalnych środków.",
        illustration: 1
      }
    ],
    supplies: ["Środek do szyb", "Środek do piekarnika"],
    accessories: ["Gąbka", "Ściereczka z mikrofibry", "Ręczniki papierowe"],
    tip: "Utrzymuj urządzenia w czystości i dobrym stanie."
  },
  {
    id: "zlewozmywak", section: "kuchnia", icon: "kuchnia",
    title: "Zlewozmywak i blat",
    description: "Czyste powierzchnie, bez kamienia i osadów.",
    note: "Utrzymuj czystość w kuchni na co dzień.",
    photos: ["Zlewozmywak z baterią na drewnianym blacie", "Połączenie blatu i płytek", "Odpływ zlewu"],
    steps: [
      { title: "Styki i fugi", text: "Nałóż środek przeciw pleśni i osadom.", photo: "Styki blatu i fugi", illustration: 0 },
      { title: "Bateria", text: "Użyj środka od kamienia.", photo: "Bateria kuchenna", illustration: 1 },
      { title: "Zlew", text: "Umyj środkiem do mycia naczyń.", photo: "Odpływ zlewu z bliska", illustration: 2 },
      { title: "Blat", text: "Użyj uniwersalnego środka do czyszczenia powierzchni.", photo: "Drewniany blat", illustration: 3 }
    ],
    supplies: ["Środek przeciw pleśni i osadom", "Środek od kamienia", "Środek do mycia naczyń", "Uniwersalny środek do czyszczenia powierzchni"],
    accessories: ["Gąbka", "Ściereczka z mikrofibry", "Ręczniki papierowe"],
    tip: "Regularne czyszczenie zapobiega osadom, kamieniowi i pleśni, dzięki czemu blat i zlew dłużej zachowują świeżość i estetyczny wygląd."
  },
  {
    id: "toaleta", section: "toalety", icon: "toalety",
    title: "WC, umywalka, lustro i szafki",
    description: "Czyste i higieniczne wyposażenie łazienki.",
    note: "Utrzymuj czystość na co dzień.",
    photos: ["Otwarta muszla WC i szczotka", "Umywalka z baterią", "Lustro i szafki nad umywalką"],
    steps: [
      { text: "Umyj WC, w tym deskę i zewnętrzne powierzchnie muszli, środkiem antybakteryjnym.", illustration: 5 },
      { text: "Umywalkę i armaturę wyczyść środkiem antybakteryjnym.", illustration: 6 },
      { text: "Lustro spryskaj środkiem do szyb, przetrzyj papierowym ręcznikiem i wypoleruj do sucha.", illustration: 7 },
      { text: "Szafki zewnętrznie przetrzyj wilgotną ściereczką, usuwając zabrudzenia i ślady palców.", illustration: 8 }
    ],
    supplies: ["Środek antybakteryjny (do WC i umywalki)", "Środek do szyb (do lustra)"],
    accessories: ["Ręcznik papierowy", "Ściereczka z mikrofibry", "Rękawiczki ochronne"],
    tip: "Regularnie czyść WC, umywalkę i lustro, aby zachować higienę i estetyczny wygląd łazienki."
  },
  {
    id: "kabina", section: "lazienka", icon: "lazienka",
    title: "Kabina prysznicowa",
    description: "Czysta kabina, bez osadów i pleśni.",
    note: "Utrzymuj czystość w kabinie, aby zapobiegać pleśni i osadom z kamienia.",
    photos: ["Szklana kabina prysznicowa i armatura", "Fugi pomiędzy płytkami w kabinie", "Połączenie szyby kabiny z brodzikiem"],
    steps: [
      { text: "Zewnętrzne strony kabiny pomyj środkiem do szyb, wewnętrzne – środkiem do kabin prysznicowych.", illustration: 6 },
      { text: "Armaturę wyczyść środkiem od kamienia.", illustration: 7 },
      { text: "Szwy płytek wyczyść środkiem od pleśni, gdzie to konieczne.", illustration: 8 }
    ],
    supplies: ["Środek do szyb (do zewnętrznej strony)", "Środek do kabin prysznicowych (do wewnątrz)", "Środek przeciw pleśni (do fug i łączeń)"],
    accessories: ["Gąbka", "Ściereczka z mikrofibry", "Ściągaczka do wody"],
    tip: "Po każdym prysznicu usuń wodę ściągaczką, aby ograniczyć powstawanie osadu i pleśni."
  },
  {
    id: "powierzchnie", section: "pozostale", icon: "blysk",
    title: "Powierzchnie użytkowe",
    description: "Stoły, krzesła, blaty i inne codzienne powierzchnie.",
    note: "Utrzymuj czystość na co dzień.",
    photos: ["Drzwi z klamką i włącznik światła", "Stół i krzesła", "Krawędź stołu i siedzisko krzesła"],
    steps: [
      { text: "Drzwi, klamki, włączniki, stoły i krzesła przetrzyj łagodnym środkiem czyszczącym do powierzchni.", illustration: 0 }
    ],
    supplies: ["Łagodny środek czyszczący do powierzchni"],
    accessories: ["Ściereczka z mikrofibry (wilgotna)", "Ściereczka z mikrofibry (sucha)"],
    tip: "Używaj łagodnych środków, aby nie uszkodzić powierzchni i zachować ich estetyczny wygląd."
  },
  {
    id: "podloga", section: "pozostale", icon: "pozostale",
    title: "Podłoga i wycieraczka",
    description: "Czyste podłogi i zadbana wycieraczka.",
    note: "Utrzymuj czystość w kuchni na co dzień.",
    photos: ["Płytki podłogowe", "Wycieraczka przy drzwiach", "Włókna wycieraczki z bliska"],
    steps: [
      { text: "Podłogę umyj odpowiednim środkiem do podłóg (zgodnie z instrukcją na opakowaniu).", illustration: 3 },
      { text: "Wycieraczkę odkurz lub wytrzep, a w razie potrzeby umyj i pozostaw do wyschnięcia.", illustration: 7 }
    ],
    supplies: ["Płyn do podłóg (uniwersalny)", "Środek do dezynfekcji (opcjonalnie)", "Środek do usuwania zabrudzeń (na plamy)"],
    accessories: ["Mop (płaski)", "Ściereczka z mikrofibry (do mopa)", "Ściereczka z mikrofibry", "Szczoteczka do wycieraczki (lub odkurzacz)"],
    tip: "Usuwaj zabrudzenia na bieżąco, aby podłoga dłużej pozostawała czysta i estetyczna."
  }
];
