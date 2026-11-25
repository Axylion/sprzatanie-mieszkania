(() => {
  const config = window.goleszanDiscussionsConfig;
  const configured = /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(config?.url) &&
    /^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.publishableKey);
  const view = document.getElementById("discussion-view");
  const status = document.getElementById("discussion-status");
  const retryHistory = document.getElementById("discussion-retry");
  const loadingHistory = "Wczytywanie rozmowy…";
  const checkingRegistration = "Sprawdzanie połączenia urządzenia…";
  const join = document.getElementById("discussion-join");
  const home = document.getElementById("harmonogram");
  const roomSetup = document.getElementById("room-setup");
  const rooms = document.getElementById("room-buttons");
  const joinAction = document.getElementById("room-confirm");
  const roomRetry = document.getElementById("room-retry");
  const roomHint = document.getElementById("room-hint");
  const deviceLimit = document.getElementById("device-limit");
  const deviceRoom = document.getElementById("device-room");
  const deviceLimitNote = document.getElementById("device-limit-note");
  const connectFromDiscussion = document.getElementById("discussion-connect");
  const returnKey = "goleszan19-return-to-discussion";
  connectFromDiscussion.addEventListener("click", () => sessionStorage.setItem(returnKey, "1"));
  document.getElementById("device-limit-dismiss").addEventListener("click", () => {
    deviceLimit.hidden = true;
    joinAction.focus();
  });
  const pairPanel = document.getElementById("discussion-pair");
  const pairCode = document.getElementById("discussion-pair-code");
  const pairTime = document.getElementById("discussion-pair-time");
  const pairRetry = document.getElementById("discussion-pair-retry");
  const pairRenew = document.getElementById("discussion-pair-renew");
  const pairBack = document.getElementById("discussion-pair-back");
  const approvalDetails = document.getElementById("discussion-approve");
  const deviceToggle = document.getElementById("discussion-device-toggle");
  const approvalStatus = document.getElementById("device-approval-status");
  function showApproval(open) {
    if (open) {
      if (!token || !boundRoom || deviceCount !== 1 || approvalDetails.open) return;
      document.getElementById("device-approval-room").textContent = "pokój nr " + boundRoom;
      approvalStatus.textContent = "";
      approvalDetails.showModal();
      deviceToggle.setAttribute("aria-expanded", "true");
      approvalCode.focus();
    } else if (approvalDetails.open) {
      approvalDetails.close();
      deviceToggle.setAttribute("aria-expanded", "false");
      approvalCode.value = "";
      updateApproval();
    }
  }
  deviceToggle.addEventListener("click", () => showApproval(true));
  approvalDetails.addEventListener("cancel", event => {
    event.preventDefault();
    if (!approval.dataset.busy) showApproval(false);
  });
  for (const id of ["device-approval-close", "device-approval-cancel"]) {
    document.getElementById(id).addEventListener("click", () => {
      if (!approval.dataset.busy) showApproval(false);
    });
  }
  const connectionStatus = document.getElementById("device-connection-status");
  const deviceSettings = document.getElementById("device-settings");
  const deviceList = document.getElementById("device-list");
  const deviceStatus = document.getElementById("device-settings-status");
  const deviceConfirm = document.getElementById("device-confirm");
  const deviceRevoke = document.getElementById("device-revoke");
  const approval = document.getElementById("discussion-approve-form");
  const approvalCode = document.getElementById("discussion-approve-code");
  const chat = document.getElementById("discussion-chat");
  const history = document.getElementById("discussion-history");
  const older = document.getElementById("discussion-older");
  const latest = document.getElementById("discussion-latest");
  const compose = document.getElementById("discussion-compose");
  const body = document.getElementById("discussion-body");
  const send = document.getElementById("discussion-send");
  const nativeComposerSizing = CSS.supports("field-sizing", "content");
  function fitComposer(input) {
    if (nativeComposerSizing || !input.offsetHeight) return;
    input.style.height = "auto";
    input.style.height = input.scrollHeight + "px";
  }
  window.g19FitComposer = fitComposer;
  if (!nativeComposerSizing) window.addEventListener("resize", () => {
    fitComposer(body);
    fitComposer(document.getElementById("private-body"));
  });
  const tokenKey = "goleszan19-discussion-device";
  const browserKey = "goleszan19-discussion-browser";
  const randomProof = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),
    byte => byte.toString(16).padStart(2, "0")).join("");
  let browserProof = localStorage.getItem(browserKey);
  if (!/^[0-9a-f]{64}$/.test(browserProof || "")) {
    browserProof = randomProof();
    localStorage.setItem(browserKey, browserProof);
  }
  localStorage.removeItem("goleszan19-discussion-reconnect");
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
  let replyTarget = null;
  let capabilities = {};
  const generalMode = () => !location.hash.startsWith("#dyskusje/prywatne");
  const replyBanner = document.getElementById("discussion-reply-target");
  function setReply(message) {
    replyTarget = message;
    replyBanner.hidden = !message;
    replyBanner.querySelector("span").textContent = message ? "Odpowiedź · Pokój nr " + message.room + ": " + message.body.slice(0,160) : "";
  }
  replyBanner.querySelector("button").addEventListener("click",()=>{setReply(null);body.focus();});
  window.addEventListener("g19-chat-capabilities",event=>{
    capabilities = event.detail || {};
    if(messages.length) renderMessages(messages,false,false);
  });
  let pollTimer;
  let pollDelay = 5000;
  let refreshError = false;
  let deviceCount;
  let deviceToRevoke;

  let availableRooms = [];
  const savedRoom = Number(localStorage.getItem("cleaning-room"));
  let chosenRoom = [1, 2, 3, 4].includes(savedRoom) ? savedRoom : null;
  let roomsLoading = false;
  let roomRequest = 0;
  let pairing = storedPairing();
  let expiredRoom;
  let pairTimer;
  let cancellingPair = false;
  let joining = false;
  let checkingPair = false;

  function storedObject(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  }

  function storedPairing() {
    const saved = storedObject(pairingKey);
    return saved && /^[0-9]{6}$/.test(saved.code) && Number.isFinite(saved.deadline) ? saved : null;
  }

  let boundRoom = null;
  function setBoundRoom(room) {
    if (room === boundRoom) return;
    boundRoom = room;
    window.dispatchEvent(new CustomEvent("g19-bound-room", {detail: room}));
  }

  function rememberRoom(room) {
    const number = Number(room);
    if ([1, 2, 3, 4].includes(number)) setBoundRoom(number);
    if ([1, 2, 3, 4].includes(number) && String(number) !== localStorage.getItem("cleaning-room")) {
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
      if (!response.ok || payload?.message === "browser_blocked") throw Object.assign(new Error("Chat request failed"), {
        status: response.status, code: payload?.message
      });
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  function showRevoked() {
    localStorage.removeItem(tokenKey);
    localStorage.removeItem(enrollmentKey);
    localStorage.removeItem(pairingKey);
    token = pairing = null;
    setBoundRoom(null);
    setReply(null);
    body.value = "";
    draft = undefined;
    window.dispatchEvent(new Event("g19-device-changed"));
    clearInterval(pairTimer);
    clearHistory();
    chat.hidden = join.hidden = pairPanel.hidden = true;
    deviceSettings.hidden = true;
    connectionStatus.textContent = "To urządzenie zostało odłączone.";
    connectionStatus.hidden = false;
    deviceList.replaceChildren();
    delete deviceList.dataset.signature;
    deviceConfirm.hidden = true;
    deviceRoom.hidden = true;
    showApproval(false);
    status.textContent = "Dostęp do dyskusji został zakończony.";
    join.hidden = view.hidden;
    if (!home.hidden) showRooms().then(schedulePoll);
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
    if (refreshError || [loadingHistory, checkingRegistration].includes(status.textContent)) status.textContent = "";
    refreshError = false;
    retryHistory.hidden = true;
  }

  function reactionButton(message, value) {
    const button = document.createElement(message.mine ? "span" : "button");
    const label = value === 1 ? "Zgadzam się" : "Nie zgadzam się";
    const count = value === 1 ? message.up : message.down;
    const ns = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(ns, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M7 11v9H3v-9h4Zm0 0 4-7a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2l-1 6a2 2 0 0 1-2 2H7");
    if (value === -1) path.setAttribute("transform", "rotate(180 12 12)");
    icon.append(path);
    button.append(icon, document.createTextNode(String(count)));
    button.setAttribute("aria-label", label + ", liczba reakcji: " + count);
    if (message.mine) {
      button.className = "reaction-count";
    } else {
      button.type = "button";
      button.dataset.reaction = String(value);
      button.setAttribute("aria-pressed", String(message.vote === value));
    }
    return button;
  }

  function renderMessages(items, scrollToEnd, resetPosition) {
    const bounds = history.getBoundingClientRect();
    const anchor = [...history.children].find(row => row.dataset.message && row.getBoundingClientRect().bottom > bounds.top);
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - bounds.top : 0;
    const active = history.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = active?.closest("[data-message]")?.dataset.message;
    const focusedSelector = active?.dataset.reaction ? `[data-reaction="${active.dataset.reaction}"]`
      : active?.closest("[data-original]") ? "[data-original]"
      : active?.closest("[data-reply]") ? "[data-reply]"
      : active?.matches(".message-author-link") ? ".message-author-link" : null;
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
      if (capabilities.privateChat && !message.mine && !message.former && message.canPrivate !== false && message.authorPeriod) {
        const link = document.createElement("a");
        link.href = "#dyskusje/prywatne/pokoj/" + message.room + "/" + message.authorPeriod;
        link.textContent = author.textContent;
        link.className = "message-author-link";
        author.replaceChildren(link);
      }
      meta.append(author, time);
      const avatar = document.createElement("span");
      avatar.className = "discussion-avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.innerHTML = '<svg viewBox="0 0 24 24"><use href="#g19-person-icon"/></svg>';
      const card = document.createElement("div");
      card.className = "discussion-card-content";
      card.append(meta);
      row.append(avatar, card);
      if (message.reply) {
        const quote = document.createElement("button");
        quote.type="button";quote.className="message-quote";quote.dataset.original=message.reply.id;
        quote.textContent="Pokój nr " + message.reply.room + ": " + message.reply.body;
        card.append(quote);
      }
      if(capabilities.replies) {
        const reply=document.createElement("button");reply.type="button";reply.className="message-reply-action";reply.dataset.reply=message.id;reply.textContent="Odpowiedz";reactions.append(reply);
      }
      card.append(content, reactions);
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
    if (focusedId && focusedSelector) {
      const focused = [...history.children].find(row => row.dataset.message === focusedId);
      focused?.querySelector(focusedSelector)?.focus({ preventScroll: true });
    }
  }

  async function loadHistory({ reset = false, bottom = false } = {}) {
    const general = generalMode();
    if (!token || view.hidden || (!general && !chat.hidden)) return;
    const id = ++loadId;
    const usedToken = token;
    const current = () => id === loadId && usedToken === token && !view.hidden && general === generalMode();
    loading = true;
    if (chat.hidden || general && (version === null && !messages.length || refreshError)) {
      status.textContent = chat.hidden ? checkingRegistration : loadingHistory;
      retryHistory.hidden = true;
    }
    try {
      const data = await rpc("read", { p_token: usedToken, p_before: before, p_version: reset ? null : version });
      if (!current()) return;
      if (!data || (!data.unchanged && !Array.isArray(data.messages))) throw new Error("Invalid history response");
      pollDelay = 5000;
      if (refreshError || [loadingHistory, checkingRegistration].includes(status.textContent)) status.textContent = "";
      refreshError = false;
      retryHistory.hidden = true;
      chat.hidden = false;
      window.dispatchEvent(new Event("g19-chat-connected"));
      join.hidden = pairPanel.hidden = true;
      if (data.room) rememberRoom(data.room);
      updateDeviceCount(data.deviceCount);
      if (!general) return;
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
      if (!before && messages.length) window.dispatchEvent(new CustomEvent("g19-chat-loaded", {
        detail: messages.at(-1).id
      }));
    } catch (error) {
      if (!current()) return;
      pollDelay = Math.min(pollDelay * 2, 30000);
      showRequestError(error, usedToken, "Nie udało się odświeżyć rozmowy. Sprawdź połączenie z internetem.");
      refreshError = error.code !== "device_invalid";
      retryHistory.hidden = !refreshError;
    } finally {
      if (id === loadId) loading = false;
      updateSend();
    }
  }

  retryHistory.addEventListener("click", () => {
    loadHistory({ reset: !messages.length, bottom: !messages.length }).then(schedulePoll);
  });

  function registrationFeedback(message, limit = false) {
    connectionStatus.textContent = limit ? "" : message;
    connectionStatus.hidden = limit || !message;
    deviceLimit.hidden = !limit;
    if (limit && !home.hidden) document.getElementById("device-limit-title").focus();
  }

  const homeRegistration = () => configured && !home.hidden && !token && !pairing && !expiredRoom;

  function updateJoinAction() {
    const selected = availableRooms.find(room => room.room === chosenRoom);
    joinAction.disabled = joining || roomsLoading || !selected;
    joinAction.textContent = selected?.occupied && !storedObject(enrollmentKey)
      ? "Podłącz kolejne urządzenie" : "Podłącz urządzenie";
    roomHint.hidden = !selected?.occupied;
    roomHint.textContent = selected?.occupied
      ? "Podłączenie wymaga potwierdzenia na urządzeniu już połączonym z tym pokojem." : "";
  }

  async function showRooms({ foreground = false } = {}) {
    if (!homeRegistration() || roomsLoading) return;
    const request = ++roomRequest;
    roomsLoading = true;
    roomSetup.hidden = false;
    roomRetry.hidden = true;
    if (foreground && !availableRooms.length) registrationFeedback("Sprawdzanie dostępności pokoi…");
    updateJoinAction();
    try {
      const result = await rpc("rooms", {});
      if (request !== roomRequest || !homeRegistration()) return;
      if (!Array.isArray(result) || result.length !== 4 ||
          new Set(result.map(room => room.room)).size !== 4 ||
          result.some(room => ![1, 2, 3, 4].includes(room.room) || typeof room.occupied !== "boolean")) {
        throw new Error("Invalid room response");
      }
      availableRooms = result;
      const buttons = result.map(({ room, occupied }) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "room-button";
        button.dataset.room = String(room);
        button.setAttribute("aria-pressed", String(chosenRoom === room));
        const state = document.createElement("span");
        state.textContent = occupied ? "Zajęty" : "Wolny";
        button.append("Pokój nr " + room, state);
        return button;
      });
      if (rooms.textContent !== buttons.map(button => button.textContent).join("")) {
        const focused = rooms.contains(document.activeElement) && document.activeElement.dataset.room;
        rooms.replaceChildren(...buttons);
        if (focused) rooms.querySelector('[data-room="' + focused + '"]')?.focus();
      }
      if (connectionStatus.textContent.startsWith("Sprawdzanie") ||
          connectionStatus.textContent.startsWith("Nie udało się pobrać listy")) registrationFeedback("");
      return result;
    } catch {
      if (request !== roomRequest || !homeRegistration()) return;
      availableRooms = [];
      rooms.replaceChildren();
      registrationFeedback("Nie udało się pobrać listy pokoi. Sprawdź połączenie z internetem.");
      roomRetry.hidden = false;
    } finally {
      if (request === roomRequest) {
        roomsLoading = false;
        updateJoinAction();
      }
    }
  }
  roomRetry.addEventListener("click", () => showRooms({foreground: true}));
  function finishPairing() {
    pairing = null;
    localStorage.removeItem(pairingKey);
    pairPanel.hidden = true;
    clearInterval(pairTimer);
  }

  function renderPairing() {
    clearInterval(pairTimer);
    roomSetup.hidden = true;
    pairPanel.hidden = false;
    document.getElementById("discussion-pair-room").textContent = "Pokój nr " + pairing.room;
    pairCode.hidden = false;
    pairRetry.hidden = pairRenew.hidden = true;
    pairCode.textContent = pairing.code.slice(0, 3) + " " + pairing.code.slice(3);
    function tick() {
      const seconds = Math.min(120, Math.max(0, Math.ceil((pairing.deadline - Date.now()) / 1000)));
      const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
      pairTime.textContent = "Kod ważny przez " + minutes + ":" + String(seconds % 60).padStart(2, "0");
    }
    tick();
    pairTimer = setInterval(tick, 250);
  }

  async function startPairing(room) {
    const data = await rpc("pair_start", { p_room: room, p_browser: browserProof });
    const remaining = Date.parse(data?.expiresAt) - Date.parse(data?.serverNow);
    if (!/^[0-9]{6}$/.test(data?.code) || typeof data.secret !== "string" || !data.secret ||
        data.room !== room || !Number.isFinite(remaining)) throw new Error("Invalid pairing response");
    pairing = { ...data, deadline: Date.now() + remaining };
    localStorage.setItem(pairingKey, JSON.stringify(pairing));
    expiredRoom = null;
    registrationFeedback("Oczekiwanie na potwierdzenie na połączonym urządzeniu.");
    if (!home.hidden) {
      renderPairing();
      document.getElementById("discussion-pair-title").focus();
    }
  }

  async function useDevice(data) {
    if (typeof data?.token !== "string" || !data.token || ![1, 2, 3, 4].includes(Number(data.room))) {
      throw new Error("Invalid registration response");
    }
    localStorage.setItem(tokenKey, data.token);
    localStorage.removeItem(enrollmentKey);
    finishPairing();
    token = data.token;
    connectionStatus.textContent = "";
    connectionStatus.hidden = true;
    window.dispatchEvent(new Event("g19-device-changed"));
    rememberRoom(data.room);
    join.hidden = true;
    roomSetup.hidden = true;
    registrationFeedback("Urządzenie zostało podłączone.");
    const returnToDiscussion = sessionStorage.getItem(returnKey) && location.hash === "#ustawienia";
    sessionStorage.removeItem(returnKey);
    if (returnToDiscussion) location.hash = "#dyskusje";
    else {
      if (!home.hidden) document.getElementById("settings-title").focus({ preventScroll: true });
      await loadDevices();
      await loadHistory({ reset: true, bottom: true });
    }
  }

  async function checkPairing() {
    const pending = pairing;
    if (!pending || checkingPair || cancellingPair) return;
    checkingPair = true;
    try {
      const data = await rpc("pair_claim", { p_secret: pending.secret });
      if (pairing !== pending || cancellingPair || token) return;
      pairRetry.hidden = true;
      if (data.state === "claimed" && data.token) {
        expiredRoom = null;
        await useDevice(data);
      } else if (data.state === "pending") {
        registrationFeedback("Oczekiwanie na potwierdzenie na połączonym urządzeniu.");
      } else if (data.state === "expired") {
        finishPairing();
        expiredRoom = pending.room;
        pairPanel.hidden = false;
        pairCode.hidden = true;
        pairTime.textContent = "Kod wygasł.";
        pairRenew.hidden = false;
        registrationFeedback("");
        if (!home.hidden) pairRenew.focus();
      } else {
        finishPairing();
        sessionStorage.removeItem(returnKey);
        registrationFeedback({
          rejected: "Prośba o podłączenie została odrzucona.",
          cancelled: "Prośba o podłączenie została anulowana.",
          device_limit: "Pokój ma już dwa połączone urządzenia.",
        }[data.state] || "Prośba o podłączenie jest niedostępna.", data.state === "device_limit");
        await showRooms();
      }
    } catch (error) {
      if (pairing === pending && !cancellingPair) {
        pairRetry.hidden = false;
        registrationFeedback("Nie udało się sprawdzić prośby. Sprawdź połączenie z internetem.");
      }
    } finally {
      checkingPair = false;
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!configured || (view.hidden && home.hidden) || document.hidden) return;
    pollTimer = setTimeout(async () => {
      if (!loading && !joining && !document.hidden) {
        if (!view.hidden && token) await loadHistory();
        else if (!home.hidden) {
          if (token) await loadDevices();
          else if (pairing) await checkPairing();
          else if (!expiredRoom) await showRooms();
        }
      }
      schedulePoll();
    }, !view.hidden && token ? pollDelay : pairing && !home.hidden ? 2000 : 5000);
  }

  async function openDiscussion() {
    if (view.hidden) {
      clearHistory();
      chat.hidden = true;
      join.hidden = true;
      return;
    }
    join.hidden = Boolean(token);
    if (!token) {
      chat.hidden = true;
      status.textContent = "";
      retryHistory.hidden = true;
      return;
    }
    if (!configured) {
      status.textContent = "Nie można sprawdzić rejestracji. Brak połączenia z serwerem.";
      return;
    }
    if (!generalMode()) {
      refreshError = false;
      retryHistory.hidden = true;
      if (chat.hidden) status.textContent = checkingRegistration;
    }
    await loadHistory({ reset: messages.length === 0, bottom: messages.length === 0 });
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
    if (!selected || joining || token) return;
    joining = true;
    registrationFeedback("Łączenie urządzenia…");
    updateJoinAction();
    try {
      async function joinDevice() {
        const stored = localStorage.getItem(tokenKey);
        if (stored) {
          token = stored;
          await loadDevices();
          return;
        }
        // Retain the proof until a successful response, so a dropped reply cannot strand a room.
        let enrollment = storedObject(enrollmentKey);
        if (enrollment && enrollment.room !== selected.room) {
          registrationFeedback("Najpierw dokończ łączenie wcześniej wybranego pokoju.");
          return;
        }
        if (!enrollment) {
          const fresh = await showRooms();
          if (!fresh) return;
          const currentRoom = fresh.find(room => room.room === selected.room);
          if (currentRoom.occupied !== selected.occupied) {
            registrationFeedback("Dostępność pokoju się zmieniła. Sprawdź status i spróbuj ponownie.");
            return;
          }
        }
        if (!selected.occupied || enrollment) {
          enrollment ||= { room: selected.room, proof: randomProof() };
          localStorage.setItem(enrollmentKey, JSON.stringify(enrollment));
          await useDevice(await rpc("bind", { p_room: selected.room, p_proof: enrollment.proof, p_browser: browserProof }));
        } else {
          pairing = storedPairing();
          if (pairing) { renderPairing(); await checkPairing(); }
          else await startPairing(selected.room);
        }
      }
      if (navigator.locks) await navigator.locks.request(tokenKey, joinDevice);
      else await joinDevice();
    } catch (error) {
      if (["room_occupied", "browser_blocked"].includes(error.code)) localStorage.removeItem(enrollmentKey);
      const message = {
        browser_blocked: "Administrator zablokował ponowne podłączenie tego urządzenia do pokoju.",
        room_occupied: "Pokój został już zajęty. Możesz poprosić o podłączenie urządzenia.",
        room_free: "Pokój jest już wolny. Wybierz go, aby dołączyć.",
        device_limit: "Pokój ma już dwa urządzenia. Odłącz jedno w ustawieniach."
      }[error.code];
      registrationFeedback(error.status === 429 ? "Odczekaj chwilę i spróbuj ponownie."
        : message || "Nie udało się połączyć urządzenia. Spróbuj ponownie.", error.code === "device_limit");
      await showRooms();
    } finally {
      joining = false;
      updateJoinAction();
      schedulePoll();
    }
  });

  pairRetry.addEventListener("click", () => checkPairing().then(schedulePoll));
  pairRenew.addEventListener("click", async () => {
    if (!expiredRoom || joining || token) return;
    joining = true;
    pairRenew.disabled = pairBack.disabled = true;
    try {
      const room = expiredRoom;
      async function renew() {
        const stored = localStorage.getItem(tokenKey);
        if (stored) {
          token = stored;
          expiredRoom = null;
          await loadDevices();
          return;
        }
        pairing = storedPairing();
        if (pairing) {
          expiredRoom = null;
          renderPairing();
          await checkPairing();
        } else {
          await startPairing(room);
        }
      }
      if (navigator.locks) await navigator.locks.request(tokenKey, renew);
      else await renew();
    } catch (error) {
      registrationFeedback("Nie udało się wygenerować kodu. Spróbuj ponownie.", error.code === "device_limit");
      if (error.code === "room_free") {
        expiredRoom = null;
        finishPairing();
        await showRooms();
      }
    } finally {
      joining = false;
      pairRenew.disabled = pairBack.disabled = false;
      schedulePoll();
    }
  });

  pairBack.addEventListener("click", async () => {
    if (cancellingPair || joining) return;
    cancellingPair = true;
    pairBack.disabled = true;
    const pending = pairing;
    try {
      if (pending) {
        const result = await rpc("pair_cancel", { p_secret: pending.secret });
        if (pairing !== pending) return;
        if (result.state === "claimed") {
          cancellingPair = false;
          await checkPairing();
          return;
        }
      }
      expiredRoom = null;
      finishPairing();
      sessionStorage.removeItem(returnKey);
      registrationFeedback("Prośba o podłączenie została anulowana.");
      await showRooms();
      if (!home.hidden) document.getElementById("settings-title").focus();
    } catch {
      registrationFeedback("Nie udało się anulować prośby. Spróbuj ponownie.");
    } finally {
      cancellingPair = false;
      pairBack.disabled = false;
      schedulePoll();
    }
  });

  function updateApproval() {
    for (const button of approval.querySelectorAll("button")) {
      button.disabled = Boolean(approval.dataset.busy) || approvalCode.value.length !== 6;
    }
  }
  approvalCode.addEventListener("input", () => {
    approvalCode.value = approvalCode.value.replace(/[^0-9]/g, "").slice(0, 6);
    updateApproval();
  });
  approvalCode.addEventListener("paste", event => {
    const pasted = event.clipboardData?.getData("text");
    if (pasted === undefined) return;
    event.preventDefault();
    const start = approvalCode.selectionStart;
    const end = approvalCode.selectionEnd;
    approvalCode.value = (approvalCode.value.slice(0, start) + pasted.replace(/[^0-9]/g, "") +
      approvalCode.value.slice(end)).slice(0, 6);
    updateApproval();
  });

  approval.addEventListener("submit", async event => {
    event.preventDefault();
    const value = approvalCode.value;
    if (!token || approval.dataset.busy || !/^[0-9]{6}$/.test(value)) return;
    const usedToken = token;
    const approve = event.submitter?.value !== "reject";
    approval.dataset.busy = "true";
    updateApproval();
    approvalStatus.textContent = "Sprawdzanie kodu…";
    try {
      const result = await rpc("pair_decide", { p_token: usedToken, p_code: value, p_approve: approve });
      if (token !== usedToken) return;
      if (result.state === "approved" || result.state === "rejected") {
        approvalCode.value = "";
      }
      approvalStatus.textContent = {
        approved: "Urządzenie zostało pomyślnie połączone.",
        rejected: "Prośba została odrzucona.",
        unavailable: "Kod jest nieprawidłowy, wygasł lub został już użyty.",
        device_limit: "Pokój ma już dwa urządzenia albo jedno czeka na połączenie.",
        rate_limited: "Za dużo prób. Odczekaj minutę i spróbuj ponownie."
      }[result.state] || "Nie udało się sprawdzić kodu.";
      if (result.state === "approved") {
        showApproval(false);
        if (home.hidden) status.textContent = approvalStatus.textContent;
        else deviceStatus.textContent = approvalStatus.textContent;
        await loadDevices();
        if (!view.hidden) await loadHistory();
      }
    } catch (error) {
      if (token !== usedToken) return;
      if (error.code === "device_invalid") showRevoked();
      else approvalStatus.textContent = error.status === 429 ? "Odczekaj chwilę i spróbuj ponownie."
        : "Nie udało się sprawdzić kodu. Spróbuj ponownie.";
    } finally {
      delete approval.dataset.busy;
      updateApproval();
    }
  });

  function updateSend() {
    send.disabled = !token || sending || !body.value.trim();
    fitComposer(body);
  }
  body.addEventListener("input", updateSend);
  compose.addEventListener("submit", async event => {
    event.preventDefault();
    const text = body.value.trim();
    if (!token || sending || !text || text.length > 1500) return;
    const reply = replyTarget?.id || null;
    if (draft?.text !== text || draft?.reply !== reply) draft = { text, reply, id: crypto.randomUUID() };
    const usedToken = token;
    sending = true;
    updateSend();
    try {
      await rpc(capabilities.replies ? "send_reply" : "send", { p_token: usedToken, p_request: draft.id, p_body: text, ...(capabilities.replies ? {p_reply:reply} : {}) });
      if(replyTarget?.id === reply) setReply(null);
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
    const reply = event.target.closest("[data-reply]");
    if(reply && !sending) {setReply(messages.find(m=>m.id===reply.dataset.reply));body.focus();return;}
    const quote = event.target.closest("[data-original]");
    if(quote && token) {
      const usedToken=token;
      try {
        let row=history.querySelector('[data-message="'+quote.dataset.original+'"]');
        if(!row) {
          const data=await rpc("general_message",{p_token:usedToken,p_message:quote.dataset.original});
          if(token!==usedToken || !generalMode() || view.hidden) return;
          before=data.before;version=null;messages=data.messages;renderMessages(messages,false,true);older.hidden=!data.hasOlder;latest.hidden=false;
          row=history.querySelector('[data-message="'+data.focusId+'"]');
        }
        if(row){row.tabIndex=-1;row.focus({preventScroll:true});row.scrollIntoView({block:"center"});row.classList.add("message-highlight");setTimeout(()=>row.classList.remove("message-highlight"),1800);}
      }catch(error){showRequestError(error,usedToken,"Wiadomość jest niedostępna.");}
      return;
    }
    const button = event.target.closest("[data-reaction]");
    if (!button || reacting || !token) return;
    const message = messages.find(item => item.id === button.closest("[data-message]").dataset.message);
    if (!message || message.mine) return;
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

  function updateDeviceCount(count) {
    deviceCount = count;
    deviceToggle.hidden = deviceCount !== 1;
    if (deviceToggle.hidden) {
      showApproval(false);
      approvalCode.value = "";
      updateApproval();
    }
  }

  function deviceKind() {
    if (/iPhone|Android.+Mobile|Windows Phone/i.test(navigator.userAgent)) return "phone";
    if (/iPad|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "other";
    return /Windows|Macintosh|Linux/i.test(navigator.userAgent) ? "computer" : "other";
  }

  function deviceRow(kind, connected, current = false) {
    const paths = {
      phone: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm2 17h4",
      computer: "M3 4h18v12H3zM12 16v4m-4 0h8",
      other: "M4 5h16v14H4zM10 16h4",
      slot: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 8v8m-4-4h8"
    };
    const row = document.createElement("li");
    row.dataset.kind = kind;
    if (connected) row.dataset.connected = "";
    const ns = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(ns, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.6");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", paths[kind] || paths.other);
    icon.append(path);
    const status = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = connected ? ({ phone: "Telefon", computer: "Komputer" }[kind] || "Urządzenie")
      : "Drugie urządzenie";
    const label = document.createElement("small");
    label.textContent = !connected ? "Niepodłączone"
      : kind === "phone" || kind === "computer" ? "Podłączony" : "Podłączone";
    if (current) {
      label.append(" · ");
      const currentLabel = document.createElement("span");
      currentLabel.textContent = "To urządzenie";
      label.append(currentLabel);
    }
    status.append(name, label);
    row.append(icon, status);
    return row;
  }

  let deviceRequest = 0;
  let loadingDevices = false;
  async function loadDevices() {
    if (home.hidden) return;
    if (!configured) {
      registrationFeedback("Podłączenie urządzeń jest chwilowo niedostępne.");
      return;
    }
    if (!token) {
      deviceSettings.hidden = deviceRoom.hidden = true;
      if (pairing) {
        if (pairPanel.hidden || !pairTimer) renderPairing();
        return;
      }
      if (!expiredRoom && !joining) await showRooms({foreground: true});
      return;
    }
    roomSetup.hidden = pairPanel.hidden = true;
    if (loadingDevices) return;
    const usedToken = token;
    const request = ++deviceRequest;
    loadingDevices = true;
    try {
      const devices = await rpc("my_devices", { p_token: usedToken, p_kind: deviceKind(), p_browser: browserProof });
      if (request !== deviceRequest || token !== usedToken || home.hidden) return;
      if (!Array.isArray(devices) || !devices.some(device => device.current)) throw new Error("Unverified device");
      if (!boundRoom) {
        // Read only the verified room, without requesting a page of messages.
        const data = await rpc("read", {p_token: usedToken, p_before: 0, p_version: null});
        if (request !== deviceRequest || token !== usedToken || home.hidden) return;
        if (![1, 2, 3, 4].includes(Number(data?.room))) throw new Error("Unverified room");
        rememberRoom(data.room);
      }
      updateDeviceCount(devices.length);
      deviceRoom.textContent = "Pokój nr " + boundRoom;
      deviceSettings.hidden = deviceRoom.hidden = false;
      registrationFeedback("");
      const rows = devices.map(device => {
        const row = deviceRow(device.kind, true, device.current);
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Odłącz";
        button.setAttribute("aria-label", "Odłącz: " + (device.current ? "to urządzenie" :
          "urządzenie połączone " + dateFormat.format(new Date(device.createdAt))));
        button.addEventListener("click", () => {
          deviceToRevoke = device;
          document.getElementById("device-confirm-text").textContent = device.current
            ? devices.length === 1
              ? "Odłączyć ostatnie urządzenie? Pokój stanie się wolny i będzie można go ponownie wybrać."
              : "Odłączyć to urządzenie? Ponowne podłączenie wymaga potwierdzenia na drugim urządzeniu."
            : "Odłączyć wybrane urządzenie? Straci dostęp do dyskusji i powiadomień.";
          deviceConfirm.hidden = false;
          deviceRevoke.focus();
        });
        row.append(button);
        return row;
      });
      if (devices.length === 1) {
        const row = deviceRow("slot", false);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "device-primary";
        button.textContent = "Podłącz";
        button.addEventListener("click", () => showApproval(true));
        row.append(button);
        rows.push(row);
      }
      deviceLimitNote.textContent = devices.length >= 2 ? "Osiągnięto limit dwóch urządzeń."
        : "Do pokoju możesz podłączyć maksymalnie dwa urządzenia.";
      const signature = JSON.stringify(devices.map(({id, current, kind}) => [id, current, kind]));
      if (deviceList.dataset.signature !== signature) {
        deviceList.replaceChildren(...rows);
        deviceList.dataset.signature = signature;
      }
      deviceStatus.textContent = "Podłączone urządzenia: " + devices.length + " z 2";
    } catch (error) {
      if (token !== usedToken) return;
      if (error.code === "device_invalid") showRevoked();
      else if (deviceSettings.hidden) registrationFeedback("Nie udało się sprawdzić rejestracji. Sprawdź połączenie z internetem.");
      else deviceStatus.textContent = "Nie udało się odczytać urządzeń. Sprawdź połączenie z internetem.";
    } finally {
      if (request === deviceRequest) loadingDevices = false;
    }
  }

  document.getElementById("device-cancel").addEventListener("click", () => {
    deviceConfirm.hidden = true;
    deviceToRevoke = null;
    document.getElementById("settings-title").focus();
  });
  deviceRevoke.addEventListener("click", async () => {
    if (!token || !deviceToRevoke || deviceRevoke.disabled) return;
    const usedToken = token;
    deviceRevoke.disabled = true;
    try {
      const current = deviceToRevoke.current;
      await rpc("revoke_device", { p_token: usedToken, p_device: deviceToRevoke.id });
      if (current && token === usedToken) {
        showRevoked();
        status.textContent = "";
        document.getElementById("settings-title").focus();
        return;
      }
      deviceConfirm.hidden = true;
      deviceToRevoke = null;
      await loadDevices();
      if (token === usedToken) {
        deviceStatus.textContent = "Urządzenie zostało odłączone.";
        document.getElementById("settings-title").focus();
      }
    } catch (error) {
      if (token !== usedToken) return;
      if (error.code === "device_invalid") showRevoked();
      else deviceStatus.textContent = "Nie udało się odłączyć urządzenia. Spróbuj ponownie.";
    } finally {
      deviceRevoke.disabled = false;
    }
  });

  async function resume() {
    if (document.hidden) return;
    await Promise.all([openDiscussion(), loadDevices()]);
    schedulePoll();
  }
  window.addEventListener("hashchange", () => {
    if (location.hash !== "#ustawienia") sessionStorage.removeItem(returnKey);
    if (view.hidden && home.hidden) showApproval(false);
    resume();
  });
  window.addEventListener("g19-device-revoked", () => { if (token) showRevoked(); });
  window.addEventListener("online", resume);
  window.addEventListener("focus", () => { if (!home.hidden) loadDevices(); });
  window.addEventListener("pageshow", event => { if (event.persisted) resume(); });
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("storage", event => {
    if (event.key === tokenKey || event.key === pairingKey || event.key === null) {
      const stored = localStorage.getItem(tokenKey);
      if (token !== stored) {
        setBoundRoom(null);
        chat.hidden = deviceSettings.hidden = deviceRoom.hidden = true;
        showApproval(false);
        deviceList.replaceChildren();
        delete deviceList.dataset.signature;
        deviceRequest++;
        loadingDevices = false;
      }
      token = stored;
      pairing = storedPairing();
      if (pairing && !home.hidden) renderPairing();
      else if (!expiredRoom) {
        pairPanel.hidden = true;
        clearInterval(pairTimer);
      }
      clearHistory();
      resume();
    }
  });
  if (configured && token && home.hidden) {
    rpc("my_devices", { p_token: token, p_kind: deviceKind(), p_browser: browserProof }).catch(() => {});
  }
  resume();
})();
