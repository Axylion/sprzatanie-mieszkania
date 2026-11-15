(() => {
  const config = window.goleszanDiscussionsConfig;
  const view = document.getElementById("admin-view");
  const form = document.getElementById("admin-login");
  const passwordField = form.elements.password;
  const submit = form.querySelector('button[type="submit"]');
  const panel = document.getElementById("admin-panel");
  const list = document.getElementById("admin-rooms");
  const status = document.getElementById("admin-status");
  const confirm = document.getElementById("admin-confirm");
  const confirmAction = document.getElementById("admin-confirm-action");
  const configured = /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(config?.url) &&
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.publishableKey) && Boolean(config.adminEmail);
  // Keep only the short-lived access token in this tab. The server still
  // checks the session and administrator role before any data is displayed.
  const sessionKey = "goleszan19-admin-session:" + config?.url?.replace(/\/$/, "");
  let session;
  let deadline = 0;
  let expires;
  let busy = false;
  let chosen;
  let pending;

  async function request(path, body, token = session) {
    const headers = { apikey: config.publishableKey, "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(config.url.replace(/\/$/, "") + path, {
      method: "POST", headers, body: JSON.stringify(body), cache: "no-store",
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw Object.assign(new Error("Request failed"), { status: res.status });
    return res.status === 204 ? null : res.json();
  }

  const rpc = (name, args = {}) => request("/rest/v1/rpc/g19_web_admin_" + name, args);

  const announcements = window.g19AdminAnnouncements;
  announcements.init(rpc, () => endSession("Zaloguj się ponownie."));

  function updateSubmit() {
    submit.disabled = busy || !passwordField.value;
  }

  passwordField.addEventListener("input", updateSubmit);

  function useSession(token, expiresAt) {
    if (typeof token !== "string" || !token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("Session unavailable");
    }
    session = token;
    deadline = expiresAt;
    clearTimeout(expires);
    expires = setTimeout(() => endSession("Sesja wygasła. Zaloguj się ponownie."), expiresAt - Date.now());
  }

  function restoreSession() {
    if (!configured) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(sessionKey));
      if (saved) useSession(saved.token, saved.deadline);
    } catch {
      endSession("Zaloguj się ponownie.");
    }
  }

  function endSession(message = "") {
    session = chosen = pending = null;
    deadline = 0;
    try { sessionStorage.removeItem(sessionKey); } catch { /* Storage can be unavailable. */ }
    clearTimeout(expires);
    if (confirm.open) confirm.close();
    list.replaceChildren();
    announcements.reset();
    form.reset();
    updateSubmit();
    form.hidden = !configured;
    panel.hidden = true;
    status.textContent = message;
  }

  function action(label, callback) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", callback);
    return button;
  }

  function ask(room, device) {
    pending = { room, device };
    document.getElementById("admin-confirm-text").textContent = device
      ? "Odłączyć to urządzenie od pokoju nr " + room.room + "?"
      : "Czy na pewno chcesz zwolnić pokój nr " + room.room + "? Wszystkie podłączone urządzenia zostaną odłączone.";
    confirmAction.textContent = device ? "Odłącz urządzenie" : "Zwolnij pokój";
    confirm.showModal();
  }

  function devicesLabel(count) {
    return count + (count === 1 ? " urządzenie" : count >= 2 && count <= 4 ? " urządzenia" : " urządzeń");
  }

  const symbols = {
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 9a8 8 0 0 1 13-3l2 3M4 15l2 3a8 8 0 0 0 13-3"/>',
    logout: '<path d="M10 4H5v16h5m-1-8h12m-4-4 4 4-4 4"/>',
    devices: '<path d="M13 16H3V5h14v4M7 19h4m-2-3v3"/><rect x="15" y="11" width="6" height="9" rx="1"/>',
    computer: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6m-3-4v4"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    history: '<path d="M3 4v6h6M4 10a8 8 0 1 1 1 7m7-9v5l3 2"/>',
    unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7-2"/>',
    shield: '<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6zM12 8v5m0 3h.01"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>'
  };
  const dates = new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw"
  });
  const historyLabels = {
    connected: "Nowe urządzenie podłączone",
    reconnected: "Ponownie podłączono znany identyfikator",
    connected_legacy: "Podłączono urządzenie",
    self_detached: "Urządzenie odłączone przez mieszkańca",
    admin_detached: "Urządzenie odłączone przez administratora",
    detached_legacy: "Odłączono urządzenie",
    room_released: "Pokój zwolniony przez administratora",
    blocked: "Zablokowano próbę podłączenia"
  };

  function icon(name) {
    const holder = document.createElement("span");
    holder.className = "admin-icon";
    holder.setAttribute("aria-hidden", "true");
    holder.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${symbols[name]}</svg>`;
    return holder;
  }

  document.getElementById("admin-refresh").prepend(icon("refresh"));
  document.getElementById("admin-logout").prepend(icon("logout"));

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function roomStatus(room) {
    const pill = node("span", "admin-pill", room.occupied ? "Zajęty" : "Wolny");
    if (room.occupied) pill.classList.add("admin-pill-green");
    return pill;
  }

  function selectedRoom(room, rooms) {
    chosen = room;
    render(rooms);
    list.querySelector("h2, button")?.focus();
  }

  function overview(room, rooms) {
    const card = action("", () => selectedRoom(room.room, rooms));
    card.className = "admin-room admin-overview";
    const title = node("span", "admin-room-row");
    title.append(node("span", "", "Pokój nr " + room.room), roomStatus(room));
    const count = node("span", "admin-count");
    count.append(icon("devices"), devicesLabel(room.devices.length));
    card.append(title, count, node("span", room.occupied ? "admin-manage" : "admin-empty", room.occupied
      ? "Zarządzaj" : "Brak podłączonych urządzeń"));
    return card;
  }

  function deviceCard(room, device, index) {
    const card = node("li", "admin-device");
    const row = node("div", "admin-room-row");
    const name = node("strong", "admin-device-name");
    const kind = { phone: "Telefon", computer: "Komputer" }[device.kind] || "Urządzenie";
    name.append(icon(symbols[device.kind] ? device.kind : "devices"), kind + " " + (index + 1));
    const badge = node("span", "admin-pill",
      device.known == null ? "Brak danych o identyfikatorze" : device.known ? "Znany identyfikator" : "Nowy identyfikator");
    if (device.known != null) badge.classList.add("admin-pill-green");
    row.append(name, badge);
    const date = node("p", "admin-muted", device.connectedAt
      ? "Połączono: " + dates.format(new Date(device.connectedAt)) : "Brak daty połączenia");
    const actions = node("div", "admin-device-actions");
    const detach = action("Odłącz urządzenie", () => ask(room, device));
    detach.setAttribute("aria-label", "Odłącz urządzenie: " + kind + " " + (index + 1));
    actions.append(detach);
    card.append(row, date);
    if (device.known === false) card.append(node("p", "admin-muted", "Brak wcześniejszej historii tego identyfikatora"));
    card.append(actions);
    return card;
  }

  function historyCard(room) {
    const details = node("details", "admin-history");
    const summary = node("summary");
    const heading = node("span", "admin-history-heading");
    heading.append(icon("history"), node("strong", "", "Historia pokoju"), icon("chevron"));
    summary.append(heading, node("span", "admin-history-hint admin-muted", "Rozwiń, aby zobaczyć historię połączeń"));
    const events = node("ul", "admin-events");
    const message = node("p", "admin-muted");
    message.setAttribute("role", "status");
    const more = action("Pokaż wcześniejsze", () => load());
    more.hidden = true;
    let cursor;
    let loading = false;
    let loaded = false;

    async function load() {
      if (loading) return;
      loading = more.disabled = true;
      message.textContent = "Wczytywanie historii…";
      try {
        const page = await rpc("history", {
          p_room: room.room, p_before_time: cursor?.at ?? null, p_before_key: cursor?.key ?? null
        });
        if (!details.isConnected) return;
        const older = document.createDocumentFragment();
        for (const event of [...page.events].reverse()) {
          const item = node("li", "admin-event");
          item.dataset.kind = event.kind;
          const time = node("time", "admin-muted", dates.format(new Date(event.at)));
          time.dateTime = event.at;
          item.append(icon(event.kind === "blocked" || event.kind === "admin_detached" ? "shield" : "history"),
            node("span", "", historyLabels[event.kind] || "Zdarzenie"), time);
          older.append(item);
        }
        events.prepend(older);
        cursor = page.events.at(-1) || cursor;
        loaded = true;
        more.textContent = "Pokaż wcześniejsze";
        message.textContent = events.children.length ? "" : "Brak zapisanej historii pokoju.";
        more.hidden = !page.more;
      } catch (error) {
        if (!details.isConnected) return;
        if ([401, 403].includes(error.status)) endSession("Zaloguj się ponownie.");
        else {
          message.textContent = "Nie udało się wczytać historii.";
          more.textContent = "Spróbuj ponownie";
          more.hidden = false;
        }
      } finally {
        loading = more.disabled = false;
      }
    }

    details.append(summary, events, message, more);
    details.addEventListener("toggle", () => {
      if (details.open && !loaded) load();
    });
    return details;
  }

  function detail(room, rooms, historyOpen) {
    const card = node("section", "admin-room admin-room-detail");
    const row = node("div", "admin-room-row admin-detail-header");
    const info = node("div");
    const title = node("h2", "", "Pokój nr " + room.room);
    title.tabIndex = -1;
    const count = node("p", "admin-count");
    count.append(roomStatus(room), devicesLabel(room.devices.length));
    info.append(title, count);
    row.append(info, action("Wszystkie pokoje", () => selectedRoom(null, rooms)));
    card.append(row);
    if (room.devices.length) {
      const devices = node("ul", "admin-devices");
      devices.append(...room.devices.map((device, index) => deviceCard(room, device, index)));
      card.append(devices);
    } else card.append(node("p", "admin-empty", "Brak podłączonych urządzeń"));
    const history = historyCard(room);
    history.open = historyOpen;
    card.append(history);
    if (room.occupied) {
      const actions = node("div", "admin-room-actions");
      const release = action("Zwolnij pokój", () => ask(room));
      release.prepend(icon("unlock"));
      actions.append(release);
      card.append(actions);
    }
    return card;
  }

  function render(rooms) {
    const active = rooms.find(room => room.room === chosen);
    const historyOpen = Boolean(list.querySelector(".admin-history[open]"));
    list.classList.toggle("admin-room-selected", Boolean(active));
    list.replaceChildren(...(active ? [detail(active, rooms, historyOpen)] : rooms.map(room => overview(room, rooms))));
  }

  async function refresh() {
    const expected = session;
    if (!expected || deadline <= Date.now()) {
      endSession("Sesja wygasła. Zaloguj się ponownie.");
      return false;
    }
    try {
      const rooms = await rpc("rooms");
      if (session !== expected) return false;
      try { sessionStorage.setItem(sessionKey, JSON.stringify({ token: expected, deadline })); }
      catch { /* Login still works when the browser disables storage. */ }
      form.hidden = true;
      panel.hidden = false;
      render(rooms);
      return true;
    } catch (error) {
      if (session !== expected) return false;
      if ([401, 403].includes(error.status)) endSession("Zaloguj się ponownie.");
      else {
        status.textContent = "Nie udało się odczytać pokoi. Spróbuj ponownie.";
        if (panel.hidden) {
          const retry = action("Spróbuj ponownie", () => {
            status.textContent = "";
            refresh();
          });
          status.append(" ", retry);
        }
      }
      return false;
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!configured || busy) return;
    busy = true;
    updateSubmit();
    const password = passwordField.value;
    form.reset();
    try {
      const auth = await request("/auth/v1/token?grant_type=password", { email: config.adminEmail, password }, null);
      const now = Date.now();
      const limits = [now + Math.min(Number(auth.expires_in), 3600) * 1000];
      if (Number.isFinite(auth.expires_at)) limits.push(auth.expires_at * 1000);
      useSession(auth.access_token, Math.min(...limits));
      status.textContent = "";
      if (await refresh() && !view.hidden) document.getElementById("admin-title").focus();
    } catch (error) {
      endSession(error.status === 429 ? "Za dużo prób. Spróbuj ponownie później." : "Nie udało się zalogować.");
    } finally {
      busy = false;
      updateSubmit();
    }
  });

  document.getElementById("admin-logout").addEventListener("click", async () => {
    if (!announcements.canLeave()) return;
    const token = session;
    endSession();
    if (token) {
      try { await request("/auth/v1/logout?scope=local", {}, token); }
      catch { status.textContent = "Wylogowano z aplikacji. Nie udało się potwierdzić zakończenia sesji na serwerze."; }
    }
  });
  document.getElementById("admin-refresh").addEventListener("click", () => { status.textContent = ""; if (announcements.isOpen()) announcements.refresh(); else refresh(); });
  confirmAction.addEventListener("click", async () => {
    if (!session || busy || !pending) return;
    const { room, device } = pending;
    busy = true;
    confirmAction.disabled = true;
    try {
      const args = { p_room: room.room, p_generation: room.generation };
      if (device) await rpc("detach", { ...args, p_device: device.id });
      else await rpc("release", { ...args, p_devices: room.devices.map(item => item.id) });
      status.textContent = device ? "Urządzenie zostało odłączone." : "Pokój został zwolniony.";
    } catch (error) {
      status.textContent = error.status === 409
        ? "Stan pokoju zmienił się. Sprawdź aktualną listę."
        : "Nie udało się potwierdzić wyniku. Sprawdź aktualną listę przed ponowieniem.";
    } finally {
      confirm.close();
      confirmAction.disabled = false;
      busy = false;
      pending = null;
      if (session) await refresh();
    }
  });

  function open() {
    if (view.hidden) {
      if (confirm.open) confirm.close();
      return;
    }
    if (session) {
      refresh().then(loaded => {
        if (loaded && !view.hidden) document.getElementById(announcements.isOpen() ? "admin-announcements-title" : "admin-title").focus({ preventScroll: true });
      });
    } else {
      endSession(configured ? "" : "Panel wymaga konfiguracji administratora.");
      if (!form.hidden) document.getElementById("admin-login-title").focus({ preventScroll: true });
    }
  }
  restoreSession();
  window.addEventListener("hashchange", open);
  open();
})();
