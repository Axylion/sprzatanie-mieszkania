(() => {
  const config = window.goleszanDiscussionsConfig;
  const tokenKey = "goleszan19-discussion-device";
  const panel = document.querySelector("#notification-panel");
  const badge = document.querySelector("#notification-count");
  const list = document.querySelector("#notification-list");
  const empty = document.querySelector("#notification-empty");
  const notice = document.querySelector("#notification-status");
  const readAll = document.querySelector("#notification-read-all");
  const switches = [...document.querySelectorAll("[data-push-category]")];
  const indicator = document.getElementById("announcements-push-indicator");
  const chatSwitch = switches.find(button => button.dataset.pushCategory === "messages");
  const inboxCategories = ["duties", "messages", "announcements"];
  let confirmed = [];
  let pushQueue = Promise.resolve();
  let pushContext = 0;
  const format = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });
  const localReadKey = "goleszan19-public-notifications-read";
  let snapshot = { items: [], unread: 0 };
  let refreshId = 0;
  let tab;
  let lastActivity = Date.now();
  let presence = false;
  let activityQueue = Promise.resolve();
  let chatSeen = null;
  let foregroundSince = Date.now();
  let baseline;
  let audio;
  const onChat = () => !document.querySelector("#discussion-view").hidden;
  const active = () => !document.hidden && document.hasFocus() && Date.now() - lastActivity < 120000;
  const tabId = () => tab ||= crypto.randomUUID();
  const token = () => localStorage.getItem(tokenKey);
  const ready = /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(config?.url) &&
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.publishableKey);

  async function rpc(name, args, keepalive = false) {
    const response = await fetch(config.url.replace(/\/$/, "") + "/rest/v1/rpc/g19_" + name, {
      method: "POST", cache: "no-store",
      headers: { apikey: config.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify(args), keepalive, signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw Object.assign(new Error("RPC failed"), { code: error.message });
    }
    return response.json().catch(() => null);
  }

  function reportActivity(presented = [], leaving = false) {
    const key = token();
    const isActive = !leaving && active();
    if (!ready || !key || (!leaving && !isActive && !presence)) return Promise.resolve();
    presence = isActive;
    const seen = isActive && onChat() ? chatSeen : null;
    // Send hide immediately. A server-side timeout covers a closed tab or lost network.
    const send = () => key === token() && rpc("notification_activity", {
      p_token: key, p_tab: tabId(), p_active: isActive, p_seen: seen,
      p_presented: isActive ? presented : []
    }, !isActive);
    if (!isActive) {
      const previous = activityQueue;
      const sent = send();
      activityQueue = Promise.allSettled([previous, sent]).then(() => {});
      return sent;
    }
    activityQueue = activityQueue.catch(() => {}).then(() => active() && send());
    return activityQueue;
  }

  function unlockAudio() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    try {
      audio ||= new Context();
      if (audio.state !== "running") audio.resume().catch(() => {});
    } catch { /* The inbox remains available when sound is blocked. */ }
  }

  function signal() {
    if (audio?.state !== "running") return;
    const time = audio.currentTime;
    const tone = audio.createOscillator();
    const volume = audio.createGain();
    tone.type = "sine";
    tone.frequency.value = 660;
    volume.gain.setValueAtTime(.0001, time);
    volume.gain.exponentialRampToValueAtTime(.045, time + .018);
    volume.gain.exponentialRampToValueAtTime(.0001, time + .18);
    tone.connect(volume).connect(audio.destination);
    tone.start(time);
    tone.stop(time + .19);
  }

  function present(items, key) {
    if (!active()) return [];
    const latest = items.filter(item => !item.read && (!onChat() || item.category !== "messages"));
    const previous = baseline;
    baseline = new Set(items.map(item => item.id));
    const incoming = latest.filter(item => !previous?.has(item.id));
    // Keep the existing push acknowledgement separate from sound playback.
    const presented = incoming.filter(item => key ? new Date(item.receivedAt).getTime() > foregroundSince : Boolean(previous));
    const audible = incoming.filter(item => item.category === "messages"
      ? previous && location.hash !== "#dyskusje" && !document.querySelector("#harmonogram").hidden
      : presented.includes(item));
    if (audible.length) {
      const play = () => {
        if (key !== token() || !active()) return;
        const storageKey = "goleszan19-presented-" + (key || "public");
        let shown = [];
        try { shown = JSON.parse(localStorage.getItem(storageKey)) || []; } catch { /* Start with an empty history. */ }
        const newItems = audible.filter(item => !shown.includes(item.id));
        if (!newItems.length) return;
        localStorage.setItem(storageKey, JSON.stringify([...shown, ...newItems.map(item => item.id)].slice(-150)));
        for (const [index, item] of newItems.entries()) {
          setTimeout(() => {
            if (active() && key === token() && (item.category !== "messages" ||
                !document.querySelector("#harmonogram").hidden)) signal();
          }, index * 220);
        }
      };
      if (navigator.locks) navigator.locks.request("g19-notification-sound", play).catch(() => {});
      else play();
    }
    return presented.map(item => item.id);
  }

  function localRead() {
    try { return JSON.parse(localStorage.getItem(localReadKey)) || {}; }
    catch { return {}; }
  }

  function publicAnnouncements() {
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
        : await rpc("notifications", { p_token: key, p_categories: inboxCategories });
      if (id !== refreshId || key !== token()) return;
      const presented = present(result.items, key);
      snapshot = result;
      if (presented.length && key) reportActivity(presented).catch(() => {});
      notice.textContent = "";
      render();
    } catch (error) {
      if (id !== refreshId || key !== token()) return;
      if (error.code === "device_invalid") {
        snapshot = { items: [], unread: 0 };
        render();
        window.dispatchEvent(new Event("g19-device-revoked"));
        notice.textContent = "Dostęp urządzenia został zakończony.";
      } else notice.textContent = "Nie udało się odświeżyć powiadomień.";
    }
  }

  async function mark(id) {
    try {
      if (ready && token()) {
        await rpc("notification_read", { p_token: token(), p_id: id, p_categories: inboxCategories });
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
    if (target === "calendar-title" || target.startsWith("ogloszenie-")) {
      requestAnimationFrame(() => (document.getElementById(target) ||
        (target.startsWith("ogloszenie-") && document.getElementById("announcements-card")))?.scrollIntoView?.());
    }
  }

  document.querySelector("#notification-open").addEventListener("click", () => {
    panel.showModal();
    refresh();
  });
  readAll.addEventListener("click", () => mark(null));
  const supported = "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;
  async function subscription() {
    const registration = await navigator.serviceWorker?.getRegistration();
    return registration?.pushManager?.getSubscription();
  }

  function syncPush(value, key, categories) {
    const data = value?.toJSON();
    return rpc("push_subscription", {
      p_token: key, p_endpoint: data?.endpoint ?? null, p_p256dh: data?.keys?.p256dh ?? null,
      p_auth: data?.keys?.auth ?? null, p_categories: categories
    });
  }

  function showPush(message = "", category) {
    const permitted = supported && Notification.permission === "granted";
    const blocked = supported && Notification.permission === "denied";
    for (const button of switches) {
      const name = button.dataset.pushCategory;
      const enabled = permitted && confirmed.includes(name);
      button.setAttribute("aria-checked", String(enabled));
      const status = document.getElementById("push-" + name + "-status");
      status.dataset.enabled = String(enabled);
      const explanation = blocked
        ? "Powiadomienia są zablokowane. Zezwól na nie w ustawieniach witryny przy pasku adresu."
        : !supported
          ? "Ta przeglądarka nie obsługuje push. Na iPhonie dodaj aplikację do ekranu początkowego."
          : !token() ? "Połącz urządzenie w Dyskusjach, aby włączyć powiadomienia."
            : !ready || !config.vapidPublicKey ? "Powiadomienia w tle czekają na konfigurację." : "";
      const state = name === "announcements"
        ? enabled ? "Powiadomienia włączone" : "Powiadomienia wyłączone — zalecamy włączenie"
        : "";
      status.textContent = [state, category === name && message ? message : explanation].filter(Boolean).join(". ");
    }
    const announcementActive = permitted && confirmed.includes("announcements");
    indicator.textContent = announcementActive ? "Powiadomienia włączone" : "Powiadomienia wyłączone";
    indicator.previousElementSibling.dataset.active = String(announcementActive);
  }

  async function registrationForPush() {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing?.active) return existing;
    return Promise.race([navigator.serviceWorker.ready, new Promise(resolve => setTimeout(resolve, 4000))]);
  }

  function readPush(key, current) {
    if (!current || (current.expirationTime != null && current.expirationTime <= Date.now())) return [];
    return rpc("push_status", { p_token: key, p_endpoint: current.endpoint }).then(categories => categories || []);
  }

  function updatePush(category) {
    const key = token();
    const context = pushContext;
    if (!supported || !ready || !config.vapidPublicKey || !key) return showPush();
    const currentContext = () => context === pushContext && key === token();
    pushQueue = pushQueue.catch(() => {}).then(async () => {
      if (!currentContext()) return;
      let created;
      try {
        let current = await subscription();
        if (Notification.permission !== "granted") {
          confirmed = [];
          showPush();
          return;
        }
        const settings = await readPush(key, current);
        if (!currentContext()) return;
        confirmed = settings;
        if (!category) return showPush();
        const categories = confirmed.includes(category)
          ? confirmed.filter(name => name !== category)
          : [...confirmed, category];
        if (current?.expirationTime != null && current.expirationTime <= Date.now()) {
          await current.unsubscribe();
          current = null;
        }
        if (categories.length && !current) {
          const registration = await registrationForPush();
          if (!registration?.pushManager || !currentContext()) throw new Error("Push unavailable");
          created = await registration.pushManager.subscribe({
            userVisibleOnly: true, applicationServerKey: config.vapidPublicKey
          });
        }
        if (!currentContext()) return;
        await syncPush(categories.length ? current || created : null, key, categories);
        if (!currentContext()) return;
        confirmed = categories;
        created = null;
        if (!categories.length) await current?.unsubscribe().catch(() => {});
      } catch (error) {
        if (!currentContext()) return;
        if (!category) confirmed = [];
        if (error.code === "device_invalid") window.dispatchEvent(new Event("g19-device-revoked"));
        showPush("Nie udało się zapisać lub sprawdzić subskrypcji. Spróbuj ponownie.", category || "announcements");
        return;
      } finally {
        await created?.unsubscribe().catch(() => {});
      }
      if (currentContext()) showPush();
    });
    return pushQueue;
  }

  let changingPush = false;
  for (const button of switches) {
    button.addEventListener("click", async () => {
      if (changingPush) return;
      changingPush = true;
      try {
        if (supported && ready && config.vapidPublicKey && token() && Notification.permission === "default") {
          await Notification.requestPermission().catch(() => {});
        }
        if (!supported || Notification.permission !== "granted" || !token()) return showPush();
        await updatePush(button.dataset.pushCategory);
      } finally {
        changingPush = false;
      }
    });
  }

  window.addEventListener("g19-announcements", () => { if (!token()) refresh(); scrollToTarget(); });
  function deviceChanged() {
    refreshId++;
    snapshot = { items: [], unread: 0 };
    baseline = undefined;
    chatSeen = null;
    pushContext++;
    confirmed = [];
    chatSwitch.parentElement.hidden = true;
    render();
    showPush();
    updatePush();
    refresh();
    reportActivity().catch(() => {});
  }
  window.addEventListener("g19-device-changed", deviceChanged);
  window.addEventListener("storage", event => { if (event.key === tokenKey || event.key === null) deviceChanged(); });
  window.addEventListener("g19-chat-connected", () => {
    chatSwitch.parentElement.hidden = false;
  });
  window.addEventListener("g19-chat-loaded", event => {
    chatSeen = event.detail;
    if (active()) reportActivity().then(refresh).catch(() => {});
  });
  window.addEventListener("hashchange", () => {
    if (!onChat()) chatSeen = null;
    reportActivity().catch(() => {});
    scrollToTarget();
  });
  window.addEventListener("online", () => {
    reportActivity().catch(() => {});
    updatePush();
    refresh();
  });
  function foregroundChanged() {
    if (!document.hidden && document.hasFocus()) {
      lastActivity = Date.now();
      if (!baseline) foregroundSince = lastActivity;
    }
    else {
      baseline = undefined;
      foregroundSince = Date.now();
    }
    reportActivity().catch(() => {});
    if (!document.hidden) { updatePush(); refresh(); }
  }
  navigator.serviceWorker?.addEventListener("controllerchange", () => updatePush());
  window.addEventListener("focus", foregroundChanged);
  window.addEventListener("blur", foregroundChanged);
  window.addEventListener("pagehide", () => reportActivity([], true).catch(() => {}));
  document.addEventListener("visibilitychange", foregroundChanged);
  for (const type of ["pointerdown", "keydown", "touchstart", "wheel"]) {
    window.addEventListener(type, () => {
      const wasActive = active();
      lastActivity = Date.now();
      if (!wasActive) {
        baseline = undefined;
        foregroundSince = lastActivity;
      }
      if (!presence) reportActivity().catch(() => {});
    }, { passive: true });
  }
  for (const type of ["pointerdown", "pointerup", "touchend", "keydown", "click"]) {
    window.addEventListener(type, event => {
      if (event.isTrusted && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) unlockAudio();
    }, { capture: true, passive: true });
  }
  setInterval(() => {
    if (token() && (active() || presence)) reportActivity().catch(() => {});
    if (!document.hidden && document.hasFocus() && token()) refresh();
  }, 15000);
  deviceChanged();
})();
