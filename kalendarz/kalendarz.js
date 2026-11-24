(() => {
  const day = 86400000;
  const fixed = [
    [1, 1, "Nowy Rok"],
    [1, 6, "Święto Trzech Króli"],
    [5, 1, "Święto Pracy"],
    [5, 3, "Święto Konstytucji 3 Maja"],
    [8, 15, "Wniebowzięcie Najświętszej Maryi Panny"],
    [11, 1, "Wszystkich Świętych"],
    [11, 11, "Narodowe Święto Niepodległości"],
    [12, 25, "Boże Narodzenie — pierwszy dzień"],
    [12, 26, "Boże Narodzenie — drugi dzień"]
  ];

  function holidays(year) {
    // Gregorian computus (Meeus–Jones–Butcher).
    const a = year % 19;
    const century = Math.floor(year / 100);
    const yearOfCentury = year % 100;
    const leapCenturies = Math.floor(century / 4);
    const correction = Math.floor((8 * century + 13) / 25);
    const epact = (19 * a + century - leapCenturies - correction + 15) % 30;
    const weekday = (32 + 2 * (century % 4) + 2 * Math.floor(yearOfCentury / 4) - epact - yearOfCentury % 4) % 7;
    const adjustment = Math.floor((a + 11 * epact + 22 * weekday) / 451);
    const marchDay = epact + weekday - 7 * adjustment + 22;
    const easter = Date.UTC(year, 2, marchDay);
    const dates = new Map(fixed.map(([month, date, name]) => [Date.UTC(year, month - 1, date), name]));
    // Dz.U. 2024 poz. 1965, in force from 1 February 2025.
    if (year >= 2025) dates.set(Date.UTC(year, 11, 24), "Wigilia Bożego Narodzenia");
    dates.set(easter, "Niedziela Wielkanocna");
    dates.set(easter + day, "Poniedziałek Wielkanocny");
    dates.set(easter + 49 * day, "Zielone Świątki");
    dates.set(easter + 60 * day, "Boże Ciało");
    return dates;
  }

  function tooltips(grid, tooltip) {
    let anchor;
    let pinned = false;
    const close = () => {
      tooltip.hidden = true;
      anchor = null;
      pinned = false;
    };
    const position = () => {
      if (!anchor || tooltip.hidden) return;
      const rect = anchor.getBoundingClientRect();
      const limit = (value, max) => Math.max(8, Math.min(value, max - 8));
      const above = rect.top - tooltip.offsetHeight - 8;
      tooltip.style.left = limit(rect.left + (rect.width - tooltip.offsetWidth) / 2, innerWidth - tooltip.offsetWidth) + "px";
      tooltip.style.top = limit(above >= 8 ? above : rect.bottom + 8, innerHeight - tooltip.offsetHeight) + "px";
    };
    function show(cell, keepOpen = false) {
      if (!cell?.dataset.details) return;
      if (pinned && anchor === cell && !keepOpen) return;
      anchor = cell;
      pinned = keepOpen;
      const title = document.createElement("strong");
      title.textContent = cell.dataset.dayLabel;
      const lines = cell.dataset.details.split("\n").map(text => {
        const line = document.createElement("span");
        line.textContent = text;
        return line;
      });
      tooltip.replaceChildren(title, ...lines);
      tooltip.hidden = false;
      position();
    }
    const target = event => event.target.closest("button.calendar-day");
    grid.addEventListener("pointerover", event => { if (event.pointerType === "mouse" && !pinned) show(target(event)); });
    grid.addEventListener("pointerout", event => {
      if (!pinned && event.pointerType === "mouse" && !anchor?.contains(event.relatedTarget) &&
          !tooltip.contains(event.relatedTarget) && anchor !== document.activeElement) close();
    });
    tooltip.addEventListener("pointerleave", () => { if (!pinned && anchor !== document.activeElement) close(); });
    grid.addEventListener("focusin", event => show(target(event)));
    grid.addEventListener("focusout", event => { if (target(event) === anchor) close(); });
    grid.addEventListener("click", event => {
      const cell = target(event);
      if (pinned && cell === anchor) close();
      else if (cell) show(cell, true);
      else close();
    });
    document.addEventListener("pointerdown", event => {
      if (anchor && !anchor.contains(event.target) && !tooltip.contains(event.target)) close();
    });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && anchor) close(); });
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, { passive: true });
    return close;
  }

  function missedDuties() {
    const config = globalThis.goleszanDiscussionsConfig;
    if (!config?.url || !config.publishableKey) return Promise.reject(new Error("Brak konfiguracji dyżurów."));
    return fetch(config.url.replace(/\/$/, "") + "/rest/v1/rpc/g19_missed_duties", {
      method: "POST",
      headers: { apikey: config.publishableKey, "Content-Type": "application/json" },
      body: "{}", cache: "no-store", signal: AbortSignal.timeout(8000)
    }).then(response => {
      if (!response.ok) throw new Error("Nie udało się pobrać statusów dyżurów.");
      return response.json();
    }).then(rows => new Map(rows.map(row => [row.startsOn, row.room])));
  }

  globalThis.g19CalendarDetails = { holidays, tooltips, missedDuties };

})();
