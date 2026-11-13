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
  const pairTime = document.getElementById("discussion-pair-time");
  const pairRetry = document.getElementById("discussion-pair-retry");
  const pairRenew = document.getElementById("discussion-pair-renew");
  const pairBack = document.getElementById("discussion-pair-back");
  const approval = document.getElementById("discussion-approve-form");
  const approvalCode = document.getElementById("discussion-approve-code");
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
    clearInterval(pairTimer);
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
    if (view.hidden || token || pairing || expiredRoom || localStorage.getItem(revokedKey) === "true") return;
    try {
      const result = await rpc("rooms", {});
      if (view.hidden || token || pairing || expiredRoom || localStorage.getItem(revokedKey) === "true") return;
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
    clearInterval(pairTimer);
  }

  function renderPairing() {
    clearInterval(pairTimer);
    join.hidden = true;
    pairPanel.hidden = false;
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
    const data = await rpc("pair_start", { p_room: room });
    pairing = { ...data, deadline: Date.now() + Date.parse(data.expiresAt) - Date.parse(data.serverNow) };
    localStorage.setItem(pairingKey, JSON.stringify(pairing));
    expiredRoom = null;
    status.textContent = "Oczekiwanie na potwierdzenie na połączonym urządzeniu.";
    if (!view.hidden) renderPairing();
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
    if (!pending || checkingPair || cancellingPair) return;
    checkingPair = true;
    try {
      const data = await rpc("pair_claim", { p_secret: pending.secret });
      if (pairing !== pending || cancellingPair || token || localStorage.getItem(revokedKey) === "true") return;
      pairRetry.hidden = true;
      if (data.state === "claimed" && data.token) {
        expiredRoom = null;
        await useDevice(data);
      } else if (data.state === "pending") {
        status.textContent = "Oczekiwanie na potwierdzenie na połączonym urządzeniu.";
      } else if (data.state === "expired") {
        finishPairing();
        expiredRoom = pending.room;
        pairPanel.hidden = false;
        pairCode.hidden = true;
        pairTime.textContent = "Kod wygasł.";
        pairRenew.hidden = false;
        status.textContent = "";
      } else {
        finishPairing();
        status.textContent = {
          rejected: "Prośba o podłączenie została odrzucona.",
          cancelled: "Prośba o podłączenie została anulowana.",
        }[data.state] || "Prośba o podłączenie jest niedostępna.";
        await showRooms();
      }
    } catch (error) {
      if (pairing === pending && !cancellingPair) {
        pairRetry.hidden = false;
        showRequestError(error, null, "Nie udało się sprawdzić prośby. Sprawdź połączenie z internetem.");
      }
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
        else if (!expiredRoom) await showRooms();
      }
      schedulePoll();
    }, token ? pollDelay : pairing ? 2000 : 5000);
  }

  async function openDiscussion() {
    if (view.hidden) {
      clearTimeout(pollTimer);
      clearInterval(pairTimer);
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
      renderPairing();
      await checkPairing();
    } else if (!expiredRoom) {
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
          pairing = storedPairing();
          if (pairing) await openDiscussion();
          else await startPairing(selected.room);
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

  pairRetry.addEventListener("click", () => checkPairing().then(schedulePoll));
  pairRenew.addEventListener("click", async () => {
    if (!expiredRoom || joining || token || localStorage.getItem(revokedKey) === "true") return;
    joining = true;
    pairRenew.disabled = pairBack.disabled = true;
    try {
      const room = expiredRoom;
      async function renew() {
        if (localStorage.getItem(revokedKey) === "true") return showRevoked();
        const stored = localStorage.getItem(tokenKey);
        if (stored) {
          token = stored;
          expiredRoom = null;
          await openDiscussion();
          return;
        }
        pairing = storedPairing();
        if (pairing) {
          expiredRoom = null;
          await openDiscussion();
        } else {
          await startPairing(room);
        }
      }
      if (navigator.locks) await navigator.locks.request(tokenKey, renew);
      else await renew();
    } catch (error) {
      showRequestError(error, null, "Nie udało się wygenerować kodu. Spróbuj ponownie.");
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
      status.textContent = "Prośba o podłączenie została anulowana.";
      await showRooms();
    } catch {
      status.textContent = "Nie udało się anulować prośby. Spróbuj ponownie.";
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
    try {
      const result = await rpc("pair_decide", { p_token: usedToken, p_code: value, p_approve: approve });
      if (token !== usedToken) return;
      if (result.state === "approved" || result.state === "rejected") {
        approvalCode.value = "";
      }
      status.textContent = {
        approved: "Podłączenie zostało potwierdzone.",
        rejected: "Prośba została odrzucona.",
        unavailable: "Kod jest nieprawidłowy, wygasł lub został już użyty.",
        rate_limited: "Za dużo prób. Odczekaj minutę i spróbuj ponownie."
      }[result.state] || "Nie udało się sprawdzić kodu.";
    } catch (error) {
      showRequestError(error, usedToken, "Nie udało się sprawdzić kodu. Spróbuj ponownie.");
    } finally {
      delete approval.dataset.busy;
      updateApproval();
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
      pairing = storedPairing();
      if (!pairing && !expiredRoom) {
        pairPanel.hidden = true;
        clearInterval(pairTimer);
      }
      clearHistory();
      openDiscussion();
    }
  });
  openDiscussion();
})();
