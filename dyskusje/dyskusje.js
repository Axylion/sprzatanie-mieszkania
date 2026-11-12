(() => {
  const config = window.goleszanDiscussionsConfig;
  const configured = /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(config?.url) &&
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.publishableKey);
  const view = document.getElementById("discussion-view");
  const status = document.getElementById("discussion-status");
  const choose = document.getElementById("discussion-choose");
  const connect = document.getElementById("discussion-connect");
  const chat = document.getElementById("discussion-chat");
  const history = document.getElementById("discussion-history");
  const older = document.getElementById("discussion-older");
  const latest = document.getElementById("discussion-latest");
  const compose = document.getElementById("discussion-compose");
  const body = document.getElementById("discussion-body");
  const send = document.getElementById("discussion-send");
  const tokenKey = "goleszan19-discussion-device";
  const reconnectKey = "goleszan19-discussion-reconnect";
  const dateFormat = new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "short", timeStyle: "short", timeZone: "Europe/Warsaw"
  });
  let token = localStorage.getItem(tokenKey);
  let before = null;
  let version = null;
  let messages = [];
  let loadId = 0;
  let loading = false;
  let sending = false;
  let reacting = false;
  let draft;
  let pollTimer;
  let pollDelay = 5000;
  let refreshError = false;

  function savedRoom() {
    const room = Number(localStorage.getItem("cleaning-room"));
    return Number.isInteger(room) && room >= 1 && room <= 4 ? room : null;
  }

  async function rpc(name, args) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(config.url.replace(/\/$/, "") + "/rest/v1/rpc/g19_" + name, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: config.publishableKey },
        body: JSON.stringify(args),
        cache: "no-store",
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error("Chat request failed"), {
        status: response.status, code: payload?.message
      });
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  function showConnection(message) {
    chat.hidden = true;
    choose.hidden = !configured || Boolean(savedRoom());
    connect.hidden = !configured || !savedRoom();
    status.textContent = message;
  }

  function showRequestError(error, usedToken, fallback) {
    if (error.code === "device_invalid") {
      if (localStorage.getItem(tokenKey) === usedToken) {
        localStorage.setItem(reconnectKey, "true");
        localStorage.removeItem(tokenKey);
      }
      if (token === usedToken) {
        token = null;
        clearHistory();
        showConnection("Powiązanie urządzenia wygasło. Połącz urządzenie ponownie.");
      }
    } else {
      status.textContent = error.status === 429 ? "Odczekaj chwilę i spróbuj ponownie." : fallback;
    }
  }

  function clearHistory() {
    loadId++;
    loading = false;
    before = version = null;
    messages = [];
    history.replaceChildren();
  }

  function reactionButton(message, value) {
    const button = document.createElement("button");
    const label = value === 1 ? "Zgadzam się" : "Nie zgadzam się";
    const count = value === 1 ? message.up : message.down;
    button.type = "button";
    button.dataset.reaction = String(value);
    button.textContent = (value === 1 ? "👍 " : "👎 ") + count;
    button.setAttribute("aria-label", label + ", liczba reakcji: " + count);
    button.setAttribute("aria-pressed", String(message.vote === value));
    return button;
  }

  function renderMessages(items, scrollToEnd, resetPosition) {
    const bounds = history.getBoundingClientRect();
    const anchor = [...history.children].find(row => row.dataset.message && row.getBoundingClientRect().bottom > bounds.top);
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - bounds.top : 0;
    const active = history.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = active?.closest("[data-message]")?.dataset.message;
    const focusedVote = active?.dataset.reaction;
    const fragment = document.createDocumentFragment();
    if (!items.length) {
      const empty = document.createElement("li");
      empty.textContent = "Nie ma jeszcze wiadomości.";
      fragment.append(empty);
    }
    for (const message of items) {
      const row = document.createElement("li");
      row.className = "discussion-message";
      row.dataset.message = message.id;
      row.dataset.mine = String(message.mine);
      const meta = document.createElement("div");
      meta.className = "discussion-meta";
      const author = document.createElement("strong");
      author.textContent = "Pokój nr " + message.room + (message.former ? " · poprzedni mieszkaniec" : "");
      const time = document.createElement("time");
      time.dateTime = message.createdAt;
      time.textContent = dateFormat.format(new Date(message.createdAt));
      const content = document.createElement("p");
      content.textContent = message.body;
      const reactions = document.createElement("div");
      reactions.className = "discussion-reactions";
      reactions.append(reactionButton(message, 1), reactionButton(message, -1));
      meta.append(author, time);
      row.append(meta, content, reactions);
      fragment.append(row);
    }
    history.replaceChildren(fragment);
    if (scrollToEnd) {
      history.scrollTop = history.scrollHeight;
    } else if (resetPosition) {
      history.scrollTop = 0;
    } else if (anchor) {
      const restored = [...history.children].find(row => row.dataset.message === anchor.dataset.message);
      if (restored) history.scrollTop += restored.getBoundingClientRect().top - bounds.top - anchorOffset;
    }
    if (focusedId && focusedVote) {
      const focused = [...history.children].find(row => row.dataset.message === focusedId);
      focused?.querySelector(`[data-reaction="${focusedVote}"]`)?.focus({ preventScroll: true });
    }
  }

  async function loadHistory({ reset = false, bottom = false } = {}) {
    if (!token || view.hidden) return;
    const id = ++loadId;
    const usedToken = token;
    loading = true;
    try {
      const data = await rpc("read", { p_token: usedToken, p_before: before, p_version: reset ? null : version });
      if (id !== loadId || view.hidden) return;
      pollDelay = 5000;
      if (refreshError || chat.hidden) status.textContent = "";
      refreshError = false;
      chat.hidden = false;
      choose.hidden = connect.hidden = true;
      if (data.unchanged) return;

      const nearEnd = history.scrollHeight - history.scrollTop - history.clientHeight < 55;
      const previousNewest = messages.at(-1)?.id;
      const firstVisible = [...history.children].find(row => row.dataset.message &&
        row.getBoundingClientRect().bottom > history.getBoundingClientRect().top);
      // Keep the reader's page if the recent window moved beyond what they are reading.
      if (!reset && !before && !nearEnd && previousNewest && firstVisible &&
          !data.messages.some(message => message.id === firstVisible.dataset.message)) {
        before = (BigInt(previousNewest) + 1n).toString();
        latest.hidden = false;
        version = null;
        return;
      }

      const newMessages = previousNewest && data.messages.at(-1)?.id !== previousNewest;
      renderMessages(data.messages, bottom || (!before && nearEnd), reset);
      latest.hidden = !before && (reset || nearEnd || (!newMessages && latest.hidden));
      older.hidden = !data.hasOlder;
      version = data.version;
      messages = data.messages;
    } catch (error) {
      if (id !== loadId || view.hidden) return;
      pollDelay = Math.min(pollDelay * 2, 30000);
      showRequestError(error, usedToken, "Nie udało się odświeżyć rozmowy. Sprawdź połączenie z internetem.");
      refreshError = error.code !== "device_invalid";
    } finally {
      if (id === loadId) loading = false;
      updateSend();
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (view.hidden || document.hidden || !token) return;
    pollTimer = setTimeout(async () => {
      if (!loading && !document.hidden) await loadHistory();
      schedulePoll();
    }, pollDelay);
  }

  async function openDiscussion() {
    if (view.hidden) {
      clearTimeout(pollTimer);
      clearHistory();
      chat.hidden = true;
      return;
    }
    if (!configured) return showConnection("Dyskusje będą dostępne po połączeniu z serwerem.");
    if (!savedRoom()) return showConnection("Wybierz i potwierdź swój pokój, aby dołączyć do rozmowy.");
    if (!token) {
      if (localStorage.getItem(reconnectKey) === "true") {
        return showConnection("Powiązanie urządzenia wygasło. Połącz urządzenie ponownie.");
      }
      return connectDevice();
    }
    status.textContent = "Wczytywanie rozmowy…";
    await loadHistory({ reset: true, bottom: true });
    schedulePoll();
  }

  async function connectDevice() {
    const room = savedRoom();
    if (!room || connect.disabled) return;
    connect.disabled = true;
    choose.hidden = true;
    status.textContent = "Łączenie urządzenia…";
    try {
      async function bind() {
        const stored = localStorage.getItem(tokenKey);
        if (stored) return stored;
        const data = await rpc("bind", { p_room: room });
        localStorage.setItem(tokenKey, data.token);
        localStorage.removeItem(reconnectKey);
        return data.token;
      }
      token = navigator.locks ? await navigator.locks.request(tokenKey, bind) : await bind();
      await openDiscussion();
    } catch (error) {
      showConnection(error.status === 429
        ? "Odczekaj chwilę i spróbuj ponownie."
        : "Nie udało się połączyć urządzenia. Spróbuj ponownie.");
    } finally {
      connect.disabled = false;
    }
  }
  connect.addEventListener("click", connectDevice);

  function updateSend() {
    send.disabled = !token || sending || !body.value.trim();
  }
  body.addEventListener("input", updateSend);
  compose.addEventListener("submit", async event => {
    event.preventDefault();
    const text = body.value.trim();
    if (!token || sending || !text || text.length > 1500) return;
    if (draft?.text !== text) draft = { text, id: crypto.randomUUID() };
    const usedToken = token;
    sending = true;
    updateSend();
    try {
      await rpc("send", { p_token: usedToken, p_request: draft.id, p_body: text });
      if (body.value.trim() === text) body.value = "";
      draft = undefined;
      status.textContent = "";
      before = null;
      await loadHistory({ reset: true, bottom: true });
    } catch (error) {
      showRequestError(error, usedToken, "Nie udało się wysłać wiadomości. Możesz spróbować ponownie.");
    } finally {
      sending = false;
      updateSend();
    }
  });

  history.addEventListener("click", async event => {
    const button = event.target.closest("[data-reaction]");
    if (!button || reacting || !token) return;
    const message = messages.find(item => item.id === button.closest("[data-message]").dataset.message);
    if (!message) return;
    const vote = Number(button.dataset.reaction);
    const usedToken = token;
    reacting = true;
    try {
      await rpc("react", { p_token: usedToken, p_message: message.id, p_vote: message.vote === vote ? 0 : vote });
      status.textContent = "";
      await loadHistory();
    } catch (error) {
      showRequestError(error, usedToken, "Nie udało się zapisać reakcji.");
    } finally {
      reacting = false;
    }
  });

  older.addEventListener("click", () => {
    if (!messages.length || loading) return;
    before = messages[0].id;
    version = null;
    loadHistory({ reset: true, bottom: true });
  });
  latest.addEventListener("click", () => {
    before = version = null;
    loadHistory({ reset: true, bottom: true });
  });
  history.addEventListener("scroll", () => {
    if (!before && history.scrollHeight - history.scrollTop - history.clientHeight < 55) latest.hidden = true;
  });

  function resume() {
    if (!view.hidden && !document.hidden && token) loadHistory().then(schedulePoll);
    else schedulePoll();
  }
  window.addEventListener("hashchange", openDiscussion);
  window.addEventListener("online", resume);
  window.addEventListener("pageshow", event => { if (event.persisted) resume(); });
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("storage", event => {
    if (event.key === tokenKey || event.key === null) {
      token = localStorage.getItem(tokenKey);
      clearHistory();
      openDiscussion();
    }
  });
  openDiscussion();
})();
