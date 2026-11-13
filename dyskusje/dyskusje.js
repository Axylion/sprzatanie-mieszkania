(() => {
  const config = window.goleszanDiscussionsConfig;
  const configured = /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(config?.url) &&
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.publishableKey);
  const view = document.getElementById("discussion-view");
  const status = document.getElementById("discussion-status");
  const join = document.getElementById("discussion-join");
  const rooms = document.getElementById("discussion-rooms");
  const joinAction = document.getElementById("discussion-join-action");
  const pairPanel = document.getElementById("discussion-pair");
  const pairCode = document.getElementById("discussion-pair-code");
  const approval = document.getElementById("discussion-approve-form");
  const chat = document.getElementById("discussion-chat");
  const history = document.getElementById("discussion-history");
  const older = document.getElementById("discussion-older");
  const latest = document.getElementById("discussion-latest");
  const compose = document.getElementById("discussion-compose");
  const body = document.getElementById("discussion-body");
  const send = document.getElementById("discussion-send");
  const tokenKey = "goleszan19-discussion-device";
  const revokedKey = "goleszan19-discussion-reconnect";
  const enrollmentKey = "goleszan19-discussion-enrollment";
  const pairingKey = "goleszan19-discussion-pairing";
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

  let availableRooms = [];
  let chosenRoom = null;
  let pairing = storedObject(pairingKey);
  let joining = false;
  let checkingPair = false;

  function storedObject(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  function rememberRoom(room) {
    if (!/^[1-4]$/.test(localStorage.getItem("cleaning-room"))) {
      window.dispatchEvent(new CustomEvent("g19-room-linked", { detail: room }));
    }
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

  function showRevoked() {
    localStorage.setItem(revokedKey, "true");
    localStorage.removeItem(tokenKey);
    localStorage.removeItem(enrollmentKey);
    localStorage.removeItem(pairingKey);
    token = pairing = null;
    clearHistory();
    chat.hidden = join.hidden = pairPanel.hidden = true;
    status.textContent = "Dostęp do dyskusji został zakończony.";
  }

  function showRequestError(error, usedToken, fallback) {
    if (error.code === "device_invalid") {
      if (token === usedToken) showRevoked();
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
      join.hidden = pairPanel.hidden = true;
      if (data.room) rememberRoom(data.room);
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

  function updateJoinAction() {
    const selected = availableRooms.find(room => room.room === chosenRoom);
    joinAction.disabled = joining || !selected;
    joinAction.textContent = selected?.occupied ? "Połącz kolejne urządzenie" : "Połącz pokój";
  }

  async function showRooms() {
    if (view.hidden || token || pairing || localStorage.getItem(revokedKey) === "true") return;
    try {
      const result = await rpc("rooms", {});
      if (view.hidden || token || pairing || localStorage.getItem(revokedKey) === "true") return;
      availableRooms = result;
      const buttons = availableRooms.map(({ room, occupied }) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.room = String(room);
        button.setAttribute("aria-pressed", String(chosenRoom === room));
        const state = document.createElement("span");
        state.textContent = occupied ? "Zajęty" : "Wolny";
        button.append("Pokój nr " + room, state);
        return button;
      });
      if (rooms.textContent !== buttons.map(button => button.textContent).join("")) rooms.replaceChildren(...buttons);
      join.hidden = false;
      updateJoinAction();
    } catch (error) {
      showRequestError(error, null, "Nie udało się pobrać listy pokoi. Sprawdź połączenie z internetem.");
    }
  }

  function finishPairing() {
    pairing = null;
    localStorage.removeItem(pairingKey);
    pairPanel.hidden = true;
  }

  async function useDevice(data) {
    localStorage.setItem(tokenKey, data.token);
    localStorage.removeItem(enrollmentKey);
    finishPairing();
    token = data.token;
    rememberRoom(data.room);
    join.hidden = true;
    status.textContent = "Urządzenie zostało podłączone.";
    await loadHistory({ reset: true, bottom: true });
  }

  async function checkPairing() {
    const pending = pairing;
    if (!pending || checkingPair) return;
    checkingPair = true;
    try {
      const data = await rpc("pair_claim", { p_secret: pending.secret });
      if (pairing !== pending || token || localStorage.getItem(revokedKey) === "true") return;
      if (data.state === "claimed" && data.token) {
        await useDevice(data);
      } else if (data.state === "pending") {
        status.textContent = "Oczekiwanie na potwierdzenie na połączonym urządzeniu.";
      } else {
        finishPairing();
        status.textContent = {
          rejected: "Prośba o podłączenie została odrzucona.",
          cancelled: "Prośba o podłączenie została anulowana.",
          expired: "Kod wygasł. Utwórz nową prośbę."
        }[data.state] || "Prośba o podłączenie jest niedostępna.";
        await showRooms();
      }
    } catch (error) {
      showRequestError(error, null, "Nie udało się sprawdzić prośby. Sprawdź połączenie z internetem.");
    } finally {
      checkingPair = false;
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!configured || view.hidden || document.hidden || localStorage.getItem(revokedKey) === "true") return;
    pollTimer = setTimeout(async () => {
      if (!loading && !joining && !document.hidden) {
        if (token) await loadHistory();
        else if (pairing) await checkPairing();
        else await showRooms();
      }
      schedulePoll();
    }, token ? pollDelay : pairing ? 2000 : 5000);
  }

  async function openDiscussion() {
    if (view.hidden) {
      clearTimeout(pollTimer);
      clearHistory();
      chat.hidden = true;
      return;
    }
    if (!configured) {
      status.textContent = "Dyskusje będą dostępne po połączeniu z serwerem.";
      return;
    }
    if (localStorage.getItem(revokedKey) === "true") return showRevoked();
    if (token) {
      status.textContent = "Wczytywanie rozmowy…";
      await loadHistory({ reset: true, bottom: true });
    } else if (pairing) {
      join.hidden = true;
      pairCode.value = pairing.code;
      pairPanel.hidden = false;
      await checkPairing();
    } else {
      await showRooms();
    }
    schedulePoll();
  }

  rooms.addEventListener("click", event => {
    const button = event.target.closest("[data-room]");
    if (!button || joining) return;
    chosenRoom = Number(button.dataset.room);
    for (const item of rooms.children) item.setAttribute("aria-pressed", String(item === button));
    updateJoinAction();
  });

  joinAction.addEventListener("click", async () => {
    const selected = availableRooms.find(room => room.room === chosenRoom);
    if (!selected || joining || token || localStorage.getItem(revokedKey) === "true") return;
    joining = true;
    updateJoinAction();
    try {
      async function joinDevice() {
        if (localStorage.getItem(revokedKey) === "true") return;
        const stored = localStorage.getItem(tokenKey);
        if (stored) {
          token = stored;
          await openDiscussion();
          return;
        }
        // Retain the proof until a successful response, so a dropped reply cannot strand a room.
        let enrollment = storedObject(enrollmentKey);
        if (enrollment && enrollment.room !== selected.room) {
          status.textContent = "Najpierw dokończ łączenie wcześniej wybranego pokoju.";
          return;
        }
        if (!selected.occupied || enrollment) {
          enrollment ||= { room: selected.room, proof: Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("") };
          localStorage.setItem(enrollmentKey, JSON.stringify(enrollment));
          await useDevice(await rpc("bind", { p_room: selected.room, p_proof: enrollment.proof }));
        } else {
          pairing = storedObject(pairingKey) || await rpc("pair_start", { p_room: selected.room });
          localStorage.setItem(pairingKey, JSON.stringify(pairing));
          join.hidden = true;
          pairCode.value = pairing.code;
          pairPanel.hidden = false;
          status.textContent = "Oczekiwanie na potwierdzenie na połączonym urządzeniu.";
        }
      }
      if (navigator.locks) await navigator.locks.request(tokenKey, joinDevice);
      else await joinDevice();
    } catch (error) {
      if (error.code === "room_occupied") localStorage.removeItem(enrollmentKey);
      const message = {
        room_occupied: "Pokój został już zajęty. Możesz poprosić o podłączenie urządzenia.",
        room_free: "Pokój jest już wolny. Wybierz go, aby dołączyć."
      }[error.code];
      showRequestError(error, token, message || "Nie udało się połączyć urządzenia. Spróbuj ponownie.");
      await showRooms();
    } finally {
      joining = false;
      updateJoinAction();
      schedulePoll();
    }
  });

  document.getElementById("discussion-copy-code").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pairCode.value);
      status.textContent = "Kod został skopiowany.";
    } catch {
      pairCode.select();
      status.textContent = "Skopiuj zaznaczony kod.";
    }
  });
  document.getElementById("discussion-pair-back").addEventListener("click", () => {
    finishPairing();
    status.textContent = "";
    showRooms().then(schedulePoll);
  });

  approval.addEventListener("submit", async event => {
    event.preventDefault();
    if (!token || approval.dataset.busy) return;
    const code = document.getElementById("discussion-approve-code");
    const value = code.value.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      status.textContent = "Wklej pełny kod z nowego urządzenia.";
      return;
    }
    const usedToken = token;
    const approve = event.submitter?.value === "approve";
    approval.dataset.busy = "true";
    try {
      await rpc("pair_decide", { p_token: usedToken, p_code: value, p_approve: approve });
      code.value = "";
      status.textContent = approve ? "Podłączenie zostało potwierdzone." : "Prośba została odrzucona.";
    } catch (error) {
      showRequestError(error, usedToken, "Kod wygasł, został już użyty lub dotyczy innego pokoju.");
    } finally {
      delete approval.dataset.busy;
    }
  });

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
    if (!view.hidden && !document.hidden) {
      if (token) loadHistory().then(schedulePoll);
      else if (pairing) checkPairing().then(schedulePoll);
      else schedulePoll();
    } else schedulePoll();
  }
  window.addEventListener("hashchange", openDiscussion);
  window.addEventListener("online", resume);
  window.addEventListener("pageshow", event => { if (event.persisted) resume(); });
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("storage", event => {
    if (event.key === tokenKey || event.key === revokedKey || event.key === pairingKey || event.key === null) {
      token = localStorage.getItem(tokenKey);
      pairing = storedObject(pairingKey);
      clearHistory();
      openDiscussion();
    }
  });
  openDiscussion();
})();
