(() => {
  const config = window.goleszanDiscussionsConfig;
  const tokenKey = "goleszan19-discussion-device";
  const panel = document.querySelector("#notification-panel");
  const badge = document.querySelector("#notification-count");
  const chatBadge = document.querySelector("#chat-count");
  const announcementBadge = document.getElementById("announcements-count");
  const indicators = {
    messages: document.getElementById("chat-push-indicator"),
    announcements: document.getElementById("announcements-push-indicator")
  };
  let chatCount = 0;
  let privateCount = 0;
  let capabilities = window.g19ChatCapabilities || {};
  let chatVisitPending = true;
  let chatNavigationRequest = 0;
  const chatCursorKey = key => "goleszan19-chat-visited:" + config?.url + ":" + key;
  function readChatCursor(key) {
    try {
      const value = localStorage.getItem(chatCursorKey(key));
      return /^[0-9]+$/.test(value || "") ? value : null;
    } catch { return null; }
  }
  function saveChatCursor(key, latest) {
    const previous = readChatCursor(key);
    const value = previous && BigInt(previous) > BigInt(latest) ? previous : latest;
    try { localStorage.setItem(chatCursorKey(key), value); } catch { /* Storage can be unavailable. */ }
  }
  function renderChatCount() {
    renderHeaderIndicator(chatBadge, indicators.messages, "messages", chatCount + privateCount, "Dyskusje");
  }

  function renderHeaderIndicator(count, indicator, category, unread, label) {
    const active = canReceivePush(category);
    count.hidden = !active || unread === 0;
    count.textContent = unread > 99 ? "99+" : String(unread);
    indicator.textContent = active ? "Powiadomienia włączone" : "Powiadomienia wyłączone";
    indicator.previousElementSibling.dataset.active = String(active);
    count.parentElement.setAttribute("aria-label", count.hidden ? label : label + ", nieprzeczytane: " + unread);
  }

  function renderAnnouncementCount() {
    renderHeaderIndicator(announcementBadge, indicators.announcements, "announcements", announcementUnread, "Ważne ogłoszenia");
  }
  async function refreshChatCount() {
    const request = ++chatNavigationRequest;
    const key = token();
    if (!ready || !key) { chatCount = 0; renderChatCount(); return; }
    const seen = readChatCursor(key);
    try {
      const count = await rpc("chat_navigation_count", {p_token:key, p_seen:seen});
      if (request !== chatNavigationRequest || key !== token()) return;
      if (!/^[0-9]+$/.test(count?.latest) || !Number.isSafeInteger(count.unread) || count.unread < 0) return;
      const viewing = onChat() && !document.hidden;
      if (seen === null || viewing) saveChatCursor(key, count.latest);
      chatCount = viewing || seen === null ? 0 : count.unread;
      renderChatCount();
    } catch {
      // Keep the last confirmed count during a transient network failure.
    }
  }
  const list = document.querySelector("#notification-list");
  const empty = document.querySelector("#notification-empty");
  const notice = document.querySelector("#notification-status");
  const readAll = document.querySelector("#notification-read-all");
  const switches = [...document.querySelectorAll("[data-push-category]")];
  const chatSwitch = switches.find(button => button.dataset.pushCategory === "messages");
  const inboxCategories = ["duties", "messages", "announcements"];
  let confirmed = [];
  let pushQueue = Promise.resolve();
  let pushContext = 0;
  const format = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw" });
  const localReadKey = "goleszan19-public-notifications-read";
  let snapshot = { items: [], unread: 0 };
  let announcementUnread = 0;
  let refreshId = 0;
  let tab;
  let lastActivity = Date.now();
  let presence = false;
  let activityQueue = Promise.resolve();
  let chatSeen = null;
  let foregroundSince = Date.now();
  let baseline;
  let audio;
  const onChat = () => !document.querySelector("#discussion-view").hidden && !location.hash.startsWith("#dyskusje/prywatne");
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
    const send = () => key === token() && rpc(capabilities.version === 1 ? "notification_activity_v2" : "notification_activity", {
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
    const latest = items.filter(item => !item.read && (item.kind === "private" ? location.hash !== item.target : (!onChat() || item.category !== "messages")));
    const previous = baseline;
    baseline = new Set(items.map(item => item.id));
    const incoming = latest.filter(item => !previous?.has(item.id));
    // Keep the existing push acknowledgement separate from sound playback.
    const presented = incoming.filter(item => key ? new Date(item.receivedAt).getTime() > foregroundSince : Boolean(previous));
    const audible = incoming.filter(item => item.kind === "private" ? previous && location.hash !== item.target : item.category === "messages"
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
      id: item.id, category: "announcements", title: "Ważne ogłoszenie", description: item.title,
      target: "#ogloszenie-" + item.id, createdAt: new Date(announcementDates(item).published),
      read: Object.hasOwn(read, item.id)
    }));
  }

  function categoryIcon(category) {
    const paths = {
      messages: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
      announcements: '<path d="m8 8 12-4v16L8 16H4V8h4Zm0 0v8m-3 0 2 5h4l-2-5M2 9v6"/>',
      duties: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-10 4 2 2 4-4"/>'
    };
    const icon = document.createElement("span");
    icon.className = "notification-category-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      (paths[category] || paths.announcements) + '</svg>';
    return icon;
  }

  function render() {
    renderAnnouncementCount();
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
      const content = document.createElement("span");
      content.className = "notification-content";
      const heading = document.createElement("span");
      heading.className = "notification-item-heading";
      const unreadDot = document.createElement("span");
      unreadDot.className = "notification-unread-dot";
      unreadDot.setAttribute("aria-hidden", "true");
      heading.append(title);
      content.append(heading, detail, time);
      const icon = categoryIcon(item.category);
      icon.append(unreadDot);
      link.append(icon, content);
      link.addEventListener("click", async event => {
        event.preventDefault();
        if (item.kind !== "private" && !item.read && !await mark(item.id)) return;
        panel.close();
        if (item.target.startsWith("#ogloszenie-") && window.g19OpenAnnouncement?.(item.target)) return;
        location.hash = item.target;
        scrollToTarget();
      });
      li.append(link);
      return li;
    }));
  }

  async function refresh() {
    refreshChatCount();
    const id = ++refreshId;
    const key = token();
    try {
      const items = !ready || !key ? publicAnnouncements() : null;
      const result = items ? { items, unread: items.filter(item => !item.read).length }
        : await rpc(capabilities.version === 1 ? "notifications_v2" : "notifications", { p_token: key, p_categories: inboxCategories });
      if (id !== refreshId || key !== token()) return;
      if (ready && key && onChat() && !document.hidden && (chatVisitPending || result.items.some(item => item.category === "messages" && item.kind !== "private" && !item.read))) {
        await rpc("notification_read", {p_token:key, p_id:null, p_categories:["messages"]});
        if (id !== refreshId || key !== token()) return;
        chatVisitPending = false;
        return refresh();
      }
      const presented = present(result.items, key);
      snapshot = result;
      const visibleUnread = result.items.filter(item => !item.read);
      announcementUnread = visibleUnread.filter(item => item.category === "announcements").length;
      if (key && ready && result.unread > visibleUnread.length) {
        // The mixed inbox can omit older unread announcements beyond its page limit.
        const endpoint = capabilities.version === 1 ? "notifications_v2" : "notifications";
        rpc(endpoint, {p_token: key, p_categories: ["announcements"]}).then(count => {
          if (id === refreshId && key === token() && Number.isSafeInteger(count?.unread)) {
            announcementUnread = count.unread;
            renderAnnouncementCount();
          }
        }).catch(() => {});
      }
      if (presented.length && key) reportActivity(presented).catch(() => {});
      notice.textContent = "";
      render();
    } catch (error) {
      if (id !== refreshId || key !== token()) return;
      if (error.code === "device_invalid") {
        snapshot = { items: [], unread: 0 };
        announcementUnread = 0;
        render();
        window.dispatchEvent(new Event("g19-device-revoked"));
        notice.textContent = "Dostęp urządzenia został zakończony.";
      } else notice.textContent = "Nie udało się odświeżyć powiadomień.";
    }
  }

  async function mark(id) {
    try {
      if (ready && token()) {
        await rpc(capabilities.version === 1 ? "notification_read_v2" : "notification_read", { p_token: token(), p_id: id, p_categories: inboxCategories });
        window.dispatchEvent(new Event("g19-inbox-read"));
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
    if (target === "calendar-title") {
      requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView());
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

  function canReceivePush(category) {
    return Boolean(supported && ready && token() && config.vapidPublicKey &&
      Notification.permission === "granted" && confirmed.includes(category));
  }

  function showPush(message = "", category) {
    const blocked = supported && Notification.permission === "denied";
    for (const button of switches) {
      const name = button.dataset.pushCategory;
      const enabled = canReceivePush(name);
      button.setAttribute("aria-checked", String(enabled));
      const status = document.getElementById("push-" + name + "-status");
      status.dataset.enabled = String(enabled);
      const explanation = blocked
        ? "Powiadomienia są zablokowane. Zezwól na nie w ustawieniach witryny przy pasku adresu."
        : !supported
          ? "Ta przeglądarka nie obsługuje push. Na iPhonie dodaj aplikację do ekranu początkowego."
          : !token() ? "Połącz urządzenie w Dyskusjach, aby włączyć powiadomienia."
            : !ready || !config.vapidPublicKey ? "Powiadomienia w tle czekają na konfigurację." : "";
      const state = enabled ? "Powiadomienia włączone" : "Powiadomienia wyłączone";
      const stateLabel = button.querySelector(".push-state");
      if (stateLabel) {
        stateLabel.textContent = state;
        status.textContent = category === name ? message || explanation : "";
      } else {
        status.textContent = [state, category === name && message ? message : explanation].filter(Boolean).join(". ");
      }
    }
    renderChatCount();
    renderAnnouncementCount();
  }

  async function registrationForPush() {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing?.active) return existing;
    return Promise.race([navigator.serviceWorker.ready, new Promise(resolve => setTimeout(resolve, 4000))]);
  }

  function readPush(key, current) {
    if (!current || (current.expirationTime != null && current.expirationTime <= Date.now())) return [];
    return rpc("push_status", { p_token: key, p_endpoint: current.endpoint }).then(categories => Array.isArray(categories) ? categories : []);
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
        confirmed = [];
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
        if (!supported || Notification.permission !== "granted" || !token()) return showPush("", button.dataset.pushCategory);
        await updatePush(button.dataset.pushCategory);
      } finally {
        changingPush = false;
      }
    });
  }

  window.addEventListener("g19-announcements", () => { if (!token()) refresh(); scrollToTarget(); });
  function deviceChanged() {
    privateCount = 0;
    refreshId++;
    snapshot = { items: [], unread: 0 };
    announcementUnread = 0;
    baseline = undefined;
    chatSeen = null;
    chatCount = 0;
    chatVisitPending = true;
    ++chatNavigationRequest;
    renderChatCount();
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
  window.addEventListener("storage", event => {
    if (event.key === tokenKey || event.key === null) deviceChanged();
    else if (token() && event.key === chatCursorKey(token())) refreshChatCount();
  });
  window.addEventListener("g19-chat-capabilities", event => {capabilities = event.detail || {};refresh();});
  window.addEventListener("g19-private-count", event => {privateCount = Number.isSafeInteger(event.detail) && event.detail > 0 ? event.detail : 0;renderChatCount();});
  window.addEventListener("g19-private-read", () => refresh());
  window.addEventListener("g19-chat-connected", () => {
    chatSwitch.parentElement.hidden = false;
  });
  window.addEventListener("g19-chat-loaded", event => {
    chatSeen = event.detail;
    if (active()) reportActivity().then(refresh).catch(() => {});
  });
  window.addEventListener("hashchange", () => {
    if (!onChat()) chatSeen = null;
    else { chatVisitPending = true; chatCount = 0; renderChatCount(); }
    refresh();
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
