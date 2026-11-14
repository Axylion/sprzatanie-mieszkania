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
  let session;
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

  function updateSubmit() {
    submit.disabled = busy || !passwordField.value;
  }

  passwordField.addEventListener("input", updateSubmit);

  function endSession(message = "") {
    session = chosen = pending = null;
    clearTimeout(expires);
    if (confirm.open) confirm.close();
    list.replaceChildren();
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

  function render(rooms) {
    const active = rooms.find(room => room.room === chosen);
    const cards = (active ? [active] : rooms).map(room => {
      const card = document.createElement("section");
      card.className = "card admin-room";
      const title = document.createElement("h2");
      title.textContent = "Pokój nr " + room.room;
      const info = document.createElement("p");
      info.textContent = (room.occupied ? "Zajęty" : "Wolny") + " · " + devicesLabel(room.devices.length);
      card.append(title, info);
      if (active) {
        card.append(action("Wszystkie pokoje", () => { chosen = null; render(rooms); }));
        const devices = document.createElement("ul");
        devices.className = "admin-devices";
        for (const [i, device] of room.devices.entries()) {
          const li = document.createElement("li");
          const label = { phone: "Telefon", computer: "Komputer", other: "Urządzenie" };
          li.append((label[device.kind] || label.other) + " " + (i + 1),
            action("Odłącz urządzenie", () => ask(room, device)));
          devices.append(li);
        }
        card.append(devices);
        if (room.occupied) card.append(action("Zwolnij pokój", () => ask(room)));
      } else if (room.occupied) {
        card.append(action("Zarządzaj", () => { chosen = room.room; render(rooms); }));
      }
      return card;
    });
    list.replaceChildren(...cards);
  }

  async function refresh() {
    const expected = session;
    try {
      const rooms = await rpc("rooms");
      if (session !== expected) return false;
      form.hidden = true;
      panel.hidden = false;
      render(rooms);
      return true;
    } catch (error) {
      if (session !== expected) return false;
      if ([401, 403].includes(error.status)) endSession("Zaloguj się ponownie.");
      else status.textContent = "Nie udało się odczytać pokoi. Spróbuj ponownie.";
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
      session = auth.access_token;
      const duration = Math.min(Number(auth.expires_in), 3600) * 1000;
      if (!session || !Number.isFinite(duration) || duration <= 0) throw new Error("Session unavailable");
      expires = setTimeout(() => endSession("Sesja wygasła. Zaloguj się ponownie."), duration);
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
    const token = session;
    endSession();
    if (token) {
      try { await request("/auth/v1/logout?scope=local", {}, token); }
      catch { status.textContent = "Wylogowano z aplikacji. Nie udało się potwierdzić zakończenia sesji na serwerze."; }
    }
  });
  document.getElementById("admin-refresh").addEventListener("click", () => { status.textContent = ""; refresh(); });
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
        if (loaded && !view.hidden) document.getElementById("admin-title").focus({ preventScroll: true });
      });
    } else {
      endSession(configured ? "" : "Panel wymaga konfiguracji administratora.");
      if (!form.hidden) document.getElementById("admin-login-title").focus({ preventScroll: true });
    }
  }
  window.addEventListener("hashchange", open);
  open();
})();
