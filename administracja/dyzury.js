(() => {
  const byId = id => document.getElementById("admin-duty-" + id);
  const section = document.getElementById("admin-duties");
  const room = byId("room");
  const date = byId("date");
  const missed = byId("missed");
  const save = byId("save");
  const send = byId("send");
  const dialog = byId("confirm");
  const feedback = byId("feedback");
  const pending = new Map();
  const messages = {
    pending: "Oczekuje na wynik wysyłki.",
    none: "Brak aktywnych subskrypcji dla dyżurów w wybranym pokoju.",
    sent: "Usługa push przyjęła wszystkie powiadomienia.",
    partial: "Usługa push przyjęła część powiadomień.",
    failed: "Nie udało się wysłać powiadomienia."
  };
  let rpc, unauthorized;
  let periods, currentRoom, currentDate;
  let saved = false, ready = false, busy = false;
  let result;
  let generation = 0;
  let pollTimer;
  const toISO = timestamp => new Date(timestamp).toISOString().slice(0, 10);
  const asTimestamp = value => Date.parse(value + "T00:00:00Z");
  const selectionKey = () => currentRoom + ":" + currentDate;
  const args = () => ({ p_room: Number(currentRoom), p_starts_on: currentDate });
  const dirty = () => ready && missed.checked !== saved;
  const future = () => asTimestamp(currentDate) > todayInPoland();
  const showResult = () => {
    const counts = result && ["sent", "partial"].includes(result.status) ? ` (${result.sent}/${result.total})` : "";
    byId("preview-push").textContent = result ? messages[result.status] + counts : "Nie wysłano";
  };
  function controls() {
    room.disabled = date.disabled = busy;
    missed.disabled = !ready || busy || Boolean(future());
    save.disabled = !dirty() || busy;
    send.disabled = !currentDate || busy || result?.status === "pending";
    showResult();
  }
  function populate(roomNumber) {
    periods = new Map();
    const start = nearestSaturday();
    for (let weekend = start - WEEK * 104; weekend <= start + WEEK * 52; weekend += WEEK) {
      if (roomFor(weekend) === Number(roomNumber)) periods.set(toISO(weekend), weekendText(weekend));
    }
    date.replaceChildren(...[...periods].map(([value, label]) => new Option(label, value)));
    date.value = [...periods.keys()].findLast(value => asTimestamp(value) <= todayInPoland()) || date.options[0].value;
  }
  function preview() {
    byId("preview-date").textContent = periods?.get(currentDate) || "—";
    byId("preview-room").textContent = currentRoom ? "nr " + currentRoom : "—";
    byId("preview-status").textContent = ready ? (missed.checked ? "Niewykonany" : "Brak oznaczenia") : "—";
    const visual = byId("preview-calendar");
    visual.replaceChildren();
    if (currentDate) {
      const value = asTimestamp(currentDate);
      for (const [own, label] of [[true, "Pokój nr " + currentRoom], [false, "Pozostałe pokoje"]]) {
        const column = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = label;
        const grid = document.createElement("div");
        grid.className = "admin-duty-preview-days calendar-grid";
        for (const timestamp of [value, value + dayMs]) {
          const cell = document.createElement("span");
          cell.textContent = new Date(timestamp).getUTCDate();
          cell.className = "calendar-day calendar-weekend";
          if (own) cell.classList.add("calendar-own");
          if (missed.checked) cell.classList.add(own ? "calendar-missed-own" : "calendar-missed-other");
          grid.append(cell);
        }
        column.append(title, grid);
        visual.append(column);
      }
    }
    controls();
  }
  function confirmAction(title, body, action) {
    if (dialog.open) return Promise.resolve(false);
    byId("confirm-title").textContent = title;
    byId("confirm-text").textContent = body;
    dialog.querySelector('[value="confirm"]').textContent = action;
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise(resolve => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    });
  }
  async function canLeave() {
    if (busy) return false;
    return !dirty() || confirmAction("Odrzucić zmianę?", "Status dyżuru nie został zapisany.", "Odrzuć zmianę");
  }
  function error(err, message) {
    if ([401, 403].includes(err.status)) unauthorized();
    else feedback.textContent = message;
  }
  function track(next) {
    result = next;
    controls();
    clearTimeout(pollTimer);
    if (next?.status === "pending" && !section.hidden) pollTimer = setTimeout(poll, 4000);
  }
  async function poll() {
    const request = generation;
    try {
      const next = await rpc("duty_push_result", args());
      if (request === generation && !section.hidden) track(next);
    } catch (err) {
      if (request !== generation || section.hidden) return;
      error(err, "Nie udało się odczytać wyniku wysyłki.");
      if (result?.status === "pending") pollTimer = setTimeout(poll, 10000);
    }
  }
  async function refresh() {
    if (busy || !currentDate) return false;
    const request = ++generation;
    clearTimeout(pollTimer);
    const keepDraft = dirty();
    busy = true;
    if (!keepDraft) ready = false;
    controls();
    const outcomes = await Promise.allSettled([g19CalendarDetails.missedDuties(), rpc("duty_push_result", args())]);
    if (request !== generation) return false;
    busy = false;
    if (outcomes[0].status === "fulfilled") {
      saved = outcomes[0].value.get(currentDate) === Number(currentRoom);
      ready = true;
      if (!keepDraft) missed.checked = saved;
    } else feedback.textContent = "Nie udało się pobrać statusu dyżuru.";
    preview();
    if (outcomes[1].status === "fulfilled") track(outcomes[1].value);
    else error(outcomes[1].reason, "Nie udało się odczytać wyniku wysyłki.");
    return outcomes.every(item => item.status === "fulfilled");
  }
  function pick(roomNumber, period) {
    if (roomNumber !== currentRoom || !periods) populate(roomNumber);
    else if (period) date.value = period;
    currentRoom = room.value = roomNumber;
    currentDate = date.value;
    ready = saved = missed.checked = false;
    result = null;
    feedback.textContent = "";
    preview();
    return refresh();
  }
  room.addEventListener("change", async () => {
    const value = room.value;
    room.value = currentRoom;
    if (await canLeave() && !section.hidden) pick(value);
  });
  date.addEventListener("change", async () => {
    const value = date.value;
    date.value = currentDate;
    if (await canLeave() && !section.hidden) pick(room.value, value);
  });
  missed.addEventListener("change", preview);
  save.addEventListener("click", async () => {
    if (save.disabled) return;
    const request = ++generation;
    busy = true;
    controls();
    try {
      const status = await rpc("save_duty", { ...args(), p_missed: missed.checked });
      if (request !== generation) return;
      missed.checked = saved = status;
      feedback.textContent = "Status dyżuru zapisano.";
      window.dispatchEvent(new Event("g19-duty-status-change"));
    } catch (err) {
      if (request === generation) error(err, "Nie udało się zapisać statusu dyżuru.");
    } finally {
      if (request === generation) {
        busy = false;
        preview();
        if (result?.status === "pending") track(result);
      }
    }
  });
  send.addEventListener("click", async () => {
    if (send.disabled || dialog.open) return;
    const key = selectionKey();
    if (!await confirmAction("Wyślij przypomnienie?", "Pokój nr " + currentRoom + " — dyżur " + periods.get(currentDate) + ".", "Wyślij")) return;
    if (section.hidden || key !== selectionKey() || send.disabled) return;
    const request = ++generation;
    const id = pending.get(key) || crypto.randomUUID();
    pending.set(key, id);
    busy = true;
    feedback.textContent = "";
    controls();
    try {
      const next = await rpc("send_duty", { ...args(), p_request_id: id });
      if (request !== generation) return;
      pending.delete(key);
      track(next);
      feedback.textContent = messages[next.status];
    } catch (err) {
      if (request !== generation) return;
      if (err.status && err.status < 500) pending.delete(key);
      error(err, "Nie potwierdzono zlecenia. Ponów próbę lub odśwież wynik.");
    } finally {
      if (request === generation) {
        busy = false;
        controls();
      }
    }
  });
  window.addEventListener("beforeunload", event => {
    if (!section.hidden && dirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  window.addEventListener("hashchange", async () => {
    const target = location.hash;
    if (section.hidden || target.toLowerCase() === "#administracja" || !dirty()) return;
    const allowed = await canLeave();
    if (location.hash !== target) return;
    if (allowed) { missed.checked = saved; preview(); }
    else location.hash = "administracja";
  });
  window.g19AdminDuties = {
    init(call, expired) { rpc = call; unauthorized = expired; },
    isOpen: () => !section.hidden,
    setOpen(open) {
      const changed = open === section.hidden;
      section.hidden = !open;
      clearTimeout(pollTimer);
      if (open && changed) pick(currentRoom || room.value, currentDate);
    },
    canLeave,
    refresh,
    reset() {
      ++generation;
      busy = ready = false;
      currentRoom = currentDate = result = null;
      clearTimeout(pollTimer);
      pending.clear();
      if (dialog.open) dialog.close();
    }
  };
})();
