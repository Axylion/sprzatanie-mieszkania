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
  const pushFeedback = byId("push-feedback");
  const pending = new Map();
  const waitLimit = 4 * 60 * 1000;
  const requestLimit = 8000;
  const storageKey = "g19-manual-duty:";
  const finalStatuses = ["none", "sent", "partial", "failed"];
  const messages = {
    pending: "Oczekuje na wynik wysyłki.",
    none: "Brak aktywnych subskrypcji dla dyżurów w wybranym pokoju.",
    sent: "Usługa push przyjęła wszystkie powiadomienia.",
    partial: "Usługa push przyjęła część powiadomień.",
    failed: "Nie udało się wysłać powiadomienia.",
    unknown: "Nie udało się potwierdzić wyniku wysyłki. Odśwież wynik przed ponownym wysłaniem.",
    expired: "Wynik wcześniejszej wysyłki nie został potwierdzony.",
    unconfirmed: "Nie potwierdzono zlecenia. Możesz ponowić ten sam wniosek lub odświeżyć wynik."
  };
  let rpc, unauthorized;
  let periods, currentRoom, currentDate;
  let saved = false, ready = false, busy = false;
  let result;
  let generation = 0;
  let pollTimer, expiryTimer;
  let receipt;
  let retryAfter = 4000;
  const toISO = timestamp => new Date(timestamp).toISOString().slice(0, 10);
  const asTimestamp = value => Date.parse(value + "T00:00:00Z");
  const selectionKey = () => currentRoom + ":" + currentDate;
  const args = () => ({ p_room: Number(currentRoom), p_starts_on: currentDate });
  function readReceipt(key) {
    if (pending.has(key)) return pending.get(key);
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey + key));
      if (!stored || !Number.isFinite(stored.deadline)) return null;
      // Old receipts could include eight seconds of grace after server expiry.
      if (stored.accepted && !stored.strictDeadline) stored.deadline -= requestLimit;
      return stored;
    } catch { return null; }
  }
  function remember(key, value) {
    if (value) value.strictDeadline = true;
    pending.set(key, value);
    try {
      if (value) sessionStorage.setItem(storageKey + key, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey + key);
    } catch { /* Retain the key in memory when storage is unavailable. */ }
  }
  function finishPolling() {
    clearTimeout(pollTimer);
    clearTimeout(expiryTimer);
  }
  async function bounded(request, deadline = Infinity) {
    const remaining = Math.min(requestLimit, deadline - Date.now());
    if (remaining <= 0) throw new Error("Request deadline reached");
    let timer;
    try {
      return await Promise.race([
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Request deadline reached")), remaining);
        }),
        request()
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const fetchResult = () => receipt
    ? rpc("duty_push_request", { p_request_id: receipt.id })
    : rpc("duty_push_result", args());
  const dirty = () => ready && missed.checked !== saved;
  const future = () => asTimestamp(currentDate) > todayInPoland();
  const showResult = () => {
    const counts = result && ["sent", "partial"].includes(result.status) ? ` (${result.sent}/${result.total})` : "";
    const message = result ? messages[result.status] + counts : "";
    byId("preview-push").textContent = message || "Nie wysłano";
    if (pushFeedback.textContent !== message) pushFeedback.textContent = message;
    pushFeedback.hidden = !message;
  };
  function controls() {
    room.disabled = date.disabled = busy;
    missed.disabled = !ready || busy || Boolean(future());
    save.disabled = !dirty() || busy;
    send.disabled = !currentDate || busy || result?.status === "pending" || result?.status === "unknown";
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
  function waitExpired() {
    finishPolling();
    result = { status: receipt && !receipt.accepted ? "unconfirmed" : "unknown" };
    controls();
  }
  function scheduleExpiry() {
    finishPolling();
    const remaining = receipt.deadline - Date.now();
    if (remaining <= 0) return waitExpired();
    if (section.hidden) return;
    expiryTimer = setTimeout(waitExpired, remaining);
    return remaining;
  }
  function schedulePoll() {
    const remaining = scheduleExpiry();
    if (!remaining) return;
    pollTimer = setTimeout(poll, Math.min(retryAfter, remaining));
  }
  function track(next) {
    retryAfter = 4000;
    finishPolling();
    const deadline = Date.parse(next?.expiresAt);
    // The server also returns "failed" for expired jobs with unfinished delivery.
    // After expiry that response alone cannot establish a delivery failure.
    if (next?.status === "failed" && !Number.isFinite(deadline)) return waitExpired();
    if (next?.status === "failed" && Date.now() >= deadline) {
      receipt = null;
      remember(selectionKey(), null);
      result = { status: "expired" };
    } else if (next && finalStatuses.includes(next.status)) {
      receipt = null;
      remember(selectionKey(), null);
      result = next;
    } else if (next?.status === "pending" && next.requestId) {
      receipt = {
        id: receipt?.id || next.requestId,
        deadline: Math.min(receipt?.deadline ?? Infinity,
          Number.isFinite(deadline) ? deadline : Date.now()),
        accepted: true
      };
      remember(selectionKey(), receipt);
      result = next;
      schedulePoll();
    } else if (receipt) {
      waitExpired();
    } else {
      result = null;
    }
    controls();
  }
  async function poll() {
    if (result?.status !== "pending" || !receipt || section.hidden) return;
    if (Date.now() >= receipt.deadline) return waitExpired();
    const request = generation;
    try {
      const next = await fetchResult();
      if (request === generation && !section.hidden && result?.status === "pending") track(next);
    } catch (err) {
      if (request !== generation || section.hidden || result?.status !== "pending") return;
      if ([401, 403].includes(err.status)) return unauthorized();
      retryAfter = 10000;
      schedulePoll();
    }
  }
  async function refresh() {
    if (busy || !currentDate) return false;
    const request = ++generation;
    const keepDraft = dirty();
    busy = true;
    if (!keepDraft) ready = false;
    controls();
    if (receipt && result?.status === "pending") scheduleExpiry();
    else finishPolling();
    const viewDeadline = result?.status === "pending" ? receipt.deadline : Infinity;
    const push = bounded(fetchResult, viewDeadline).then(next => {
      if (request === generation) track(next);
      return true;
    }, err => {
      if (request !== generation) return false;
      error(err, "Nie udało się odczytać wyniku wysyłki.");
      if (request === generation) {
        if (result?.status === "pending") schedulePoll();
        else waitExpired();
      }
      return false;
    });
    const [duty, outcome] = await Promise.allSettled([
      bounded(() => g19CalendarDetails.missedDuties()), push
    ]);
    if (request !== generation) return false;
    busy = false;
    if (duty.status === "fulfilled") {
      saved = duty.value.get(currentDate) === Number(currentRoom);
      ready = true;
      if (!keepDraft) missed.checked = saved;
    } else feedback.textContent = "Nie udało się pobrać statusu dyżuru.";
    preview();
    return duty.status === "fulfilled" && outcome.value === true;
  }
  function pick(roomNumber, period) {
    if (roomNumber !== currentRoom || !periods) populate(roomNumber);
    else if (period) date.value = period;
    currentRoom = room.value = roomNumber;
    currentDate = date.value;
    ready = saved = missed.checked = false;
    receipt = readReceipt(selectionKey());
    result = receipt && { status: receipt.accepted
      ? (Date.now() < receipt.deadline ? "pending" : "unknown")
      : "unconfirmed" };
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
    const id = receipt?.id || crypto.randomUUID();
    receipt = { id, deadline: receipt?.deadline ?? Date.now() + waitLimit, accepted: false };
    remember(key, receipt);
    busy = true;
    feedback.textContent = "";
    controls();
    try {
      const next = await bounded(() => rpc("send_duty", { ...args(), p_request_id: id }));
      if (request !== generation) return;
      track(next);
    } catch (err) {
      if (request !== generation) return;
      if (err.status && err.status < 500 && err.status !== 408 && err.status !== 429) {
        receipt = null;
        remember(key, null);
        result = null;
        error(err, "Nie udało się zlecić wysyłki powiadomienia.");
      } else {
        waitExpired();
      }
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
      if (!changed) return;
      section.hidden = !open;
      finishPolling();
      if (open) pick(currentRoom || room.value, currentDate);
      else {
        ++generation;
        busy = false;
      }
    },
    canLeave,
    refresh,
    reset() {
      ++generation;
      busy = ready = false;
      currentRoom = currentDate = result = null;
      finishPolling();
      receipt = null;
      if (dialog.open) dialog.close();
    }
  };
})();
