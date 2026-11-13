(() => {
  const config = window.goleszanDiscussionsConfig;
  const tokenKey = "goleszan19-discussion-device";
  const panel = document.querySelector("#notification-panel");
  const badge = document.querySelector("#notification-count");
  const list = document.querySelector("#notification-list");
  const empty = document.querySelector("#notification-empty");
  const notice = document.querySelector("#notification-status");
  const readAll = document.querySelector("#notification-read-all");
  const pushStatus = document.querySelector("#push-status");
  const pushToggle = document.querySelector("#push-toggle");
  const pushChoices = [...document.querySelectorAll("#push-settings input")];
  const choices = [...document.querySelectorAll(".notification-settings input:not(#push-settings input)")];
  const format = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });
  const localReadKey = "goleszan19-public-notifications-read";
  let snapshot = { items: [], unread: 0 };
  let refreshId = 0;
  let pushBusy = false;
  const token = () => localStorage.getItem(tokenKey);
  const ready = /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(config?.url) &&
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.publishableKey);

  async function rpc(name, args) {
    const response = await fetch(config.url.replace(/\/$/, "") + "/rest/v1/rpc/g19_" + name, {
      method: "POST", cache: "no-store",
      headers: { apikey: config.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify(args), signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw Object.assign(new Error("RPC failed"), { code: error.message });
    }
    return response.json().catch(() => null);
  }

  function categories(inputs) {
    return inputs.filter(input => input.checked).map(input => input.name);
  }

  function localRead() {
    try { return JSON.parse(localStorage.getItem(localReadKey)) || {}; }
    catch { return {}; }
  }

  function publicAnnouncements() {
    if (!categories(choices).includes("announcements")) return [];
    const read = localRead();
    return activeAnnouncements.slice(0, 50).map(item => ({
      id: item.id, title: "Ważne ogłoszenie", description: item.title,
      target: "#ogloszenie-" + item.id, createdAt: new Date(announcementDates(item).published),
      read: Object.hasOwn(read, item.id)
    }));
  }

  function render() {
    badge.hidden = readAll.hidden = snapshot.unread === 0;
    badge.textContent = snapshot.unread > 99 ? "99+" : String(snapshot.unread);
    badge.parentElement.setAttribute("aria-label", snapshot.unread ? "Powiadomienia, nieprzeczytane: " + snapshot.unread : "Powiadomienia");
    empty.hidden = snapshot.items.length !== 0;
    list.replaceChildren(...snapshot.items.map(item => {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = item.target;
      if (!item.read) link.dataset.unread = "";
      const title = document.createElement("strong");
      title.textContent = item.title;
      const detail = document.createElement("span");
      detail.textContent = item.description;
      const time = document.createElement("time");
      time.dateTime = new Date(item.createdAt).toISOString();
      time.textContent = format.format(new Date(item.createdAt));
      link.append(title, detail, time);
      link.addEventListener("click", async event => {
        event.preventDefault();
        if (!item.read && !await mark(item.id)) return;
        panel.close();
        location.hash = item.target;
        scrollToTarget();
      });
      li.append(link);
      return li;
    }));
  }

  async function refresh() {
    const id = ++refreshId;
    const key = token();
    try {
      const items = !ready || !key ? publicAnnouncements() : null;
      const result = items ? { items, unread: items.filter(item => !item.read).length }
        : await rpc("notifications", { p_token: key, p_categories: categories(choices) });
      if (id !== refreshId || key !== token()) return;
      snapshot = result;
      notice.textContent = "";
      render();
    } catch (error) {
      if (id !== refreshId || key !== token()) return;
      if (error.code === "device_invalid") {
        snapshot = { items: [], unread: 0 };
        render();
        await subscription().then(s => s?.unsubscribe()).catch(() => {});
        notice.textContent = "Dostęp urządzenia został zakończony.";
      } else notice.textContent = "Nie udało się odświeżyć powiadomień.";
    }
  }

  async function mark(id) {
    try {
      if (ready && token()) {
        await rpc("notification_read", { p_token: token(), p_id: id, p_categories: categories(choices) });
      } else {
        const ids = id === null ? snapshot.items.map(item => item.id) : [id];
        localStorage.setItem(localReadKey, JSON.stringify({ ...localRead(), ...Object.fromEntries(ids.map(id => [id, true])) }));
      }
      await refresh();
      return true;
    } catch {
      notice.textContent = "Nie udało się oznaczyć powiadomienia. Spróbuj ponownie.";
      return false;
    }
  }

  function scrollToTarget() {
    const target = location.hash.slice(1);
    if (target === "calendar-title" || target === "powiadomienia" || target.startsWith("ogloszenie-")) {
      requestAnimationFrame(() => (document.getElementById(target) ||
        (target.startsWith("ogloszenie-") && document.getElementById("announcements-card")))?.scrollIntoView?.());
    }
  }

  document.querySelector("#notification-open").addEventListener("click", () => {
    panel.showModal();
    refresh();
  });
  readAll.addEventListener("click", () => mark(null));
  document.querySelector("#notification-settings-link").addEventListener("click", () => {
    panel.close();
    document.querySelector(".notification-settings").open = true;
    requestAnimationFrame(scrollToTarget);
  });

  const supported = "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;
  async function subscription() {
    const registration = await navigator.serviceWorker?.getRegistration();
    return registration?.pushManager?.getSubscription();
  }

  function syncPush(value) {
    const data = value?.toJSON();
    return rpc("push_subscription", {
      p_token: token(), p_endpoint: data?.endpoint ?? null, p_p256dh: data?.keys?.p256dh ?? null,
      p_auth: data?.keys?.auth ?? null, p_categories: categories(pushChoices)
    });
  }

  async function showPush() {
    const enabled = Boolean(await subscription().catch(() => null));
    pushToggle.disabled = pushBusy || !supported || !ready || !config.vapidPublicKey || !token();
    pushToggle.textContent = enabled ? "Wyłącz push" : "Włącz push";
    if (!supported) pushStatus.textContent = "Ta przeglądarka nie obsługuje push. Na iPhonie otwórz aplikację z ekranu początkowego.";
    else if (!ready || !config.vapidPublicKey) pushStatus.textContent = "Dostawa push czeka na konfigurację.";
    else if (!token()) pushStatus.textContent = "Połącz urządzenie w Dyskusjach, aby włączyć push.";
    else if (Notification.permission === "denied") pushStatus.textContent = "Push zablokowano w ustawieniach przeglądarki.";
    else pushStatus.textContent = enabled ? "Push jest włączony na tym urządzeniu." : "Push jest wyłączony.";
  }

  async function updatePush(changeCategories = false) {
    if (pushBusy || !supported || !ready || !config.vapidPublicKey || !token()) return;
    pushBusy = true;
    pushToggle.disabled = true;
    let error;
    let explanation;
    let created;
    try {
      const current = await subscription();
      if (current && (!changeCategories || !categories(pushChoices).length)) {
        await syncPush(null);
        await current.unsubscribe();
      } else if (current) {
        await syncPush(current);
      } else if (!changeCategories) {
        if (!categories(pushChoices).length) throw new Error(explanation = "Wybierz co najmniej jedną kategorię push.");
        // The click handler requests permission before this asynchronous work.
        if (await permission !== "granted") throw new Error(explanation = "Przeglądarka nie zezwoliła na push.");
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration?.active) throw new Error(explanation = "Odśwież stronę i spróbuj ponownie.");
        created = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: config.vapidPublicKey });
        await syncPush(created);
        created = null;
      }
    } catch {
      await created?.unsubscribe().catch(() => {});
      error = explanation || "Nie udało się zapisać ustawień push. Spróbuj ponownie.";
    } finally {
      pushBusy = false;
      await showPush();
      if (error) pushStatus.textContent = error;
    }
  }

  let permission;
  pushToggle.addEventListener("click", () => {
    if (Notification.permission === "default" && categories(pushChoices).length) permission = Notification.requestPermission();
    else permission = Promise.resolve(Notification.permission);
    updatePush();
  });
  for (const input of pushChoices) {
    const key = "goleszan19-push-" + input.name;
    input.checked = localStorage.getItem(key) !== "false";
    input.addEventListener("change", () => {
      localStorage.setItem(key, String(input.checked));
      updatePush(true);
    });
  }
  choices.forEach(input => input.addEventListener("change", refresh));
  window.addEventListener("g19-announcements", () => { if (!token()) refresh(); scrollToTarget(); });
  function deviceChanged() {
    refreshId++;
    snapshot = { items: [], unread: 0 };
    render();
    if (!token()) subscription().then(s => s?.unsubscribe()).catch(() => {});
    showPush();
    refresh();
  }
  window.addEventListener("g19-device-changed", deviceChanged);
  window.addEventListener("storage", event => { if (event.key === tokenKey || event.key === null) deviceChanged(); });
  window.addEventListener("hashchange", scrollToTarget);
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh(); showPush(); } });
  setInterval(() => { if (!document.hidden && token()) refresh(); }, 15000);
  showPush();
  refresh();
})();
