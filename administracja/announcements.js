(() => {
  const section = document.getElementById("admin-announcements");
  const rooms = document.getElementById("admin-room-management");
  const nav = document.getElementById("admin-sections");
  const list = document.getElementById("admin-announcement-list");
  const listView = document.getElementById("admin-announcement-list-view");
  const form = document.getElementById("admin-announcement-form");
  const editor = document.getElementById("announcement-editor");
  const preview = document.getElementById("admin-announcement-preview");
  const message = document.getElementById("admin-announcement-status");
  const setStatus = (text, brief = false) => g19AdminStatus(message, text, brief);
  const filter = document.getElementById("admin-announcement-filter");
  const formatter = new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Warsaw" });
  const dayFormatter = new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeZone: "Europe/Warsaw" });
  const warsawCalendar = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "numeric", day: "numeric", timeZone: "Europe/Warsaw"
  });
  const expiryPreview = document.getElementById("announcement-expiry-preview");
  const labels = { draft: "Szkic", published: "Opublikowane", expired: "Wygasłe", withdrawn: "Wycofane" };
  const content = window.g19AnnouncementContent;
  const bodyPreview = preview.querySelector(".announcement-body");
  const dateInput = form.elements.endsOn;
  const dateOpen = document.getElementById("announcement-date-open");
  const dateClear = document.getElementById("announcement-date-clear");
  const dateDialog = document.getElementById("announcement-date-dialog");
  const dateDays = document.getElementById("announcement-date-days");
  const dateMonth = document.getElementById("announcement-date-month");
  const dateNavigation = [...dateDialog.querySelectorAll("[data-step]")];
  const monthFormatter = new Intl.DateTimeFormat("pl-PL", {month:"long", year:"numeric", timeZone:"UTC"});
  const publishDialog = document.getElementById("announcement-publish-dialog");
  const publishButton = document.getElementById("announcement-publish");
  const deleteDialog = document.getElementById("announcement-delete-dialog");
  const deleteName = document.getElementById("announcement-delete-name");
  let pendingDeletion;
  deleteDialog.querySelector("[data-cancel]").addEventListener("click", () => deleteDialog.close());
  deleteDialog.querySelector("form").addEventListener("submit", event => {
    event.preventDefault();
    if (busy || !deleteDialog.open || !pendingDeletion) return;
    const {id, revision} = pendingDeletion;
    deleteDialog.close();
    save("delete_announcement", {p_id: id, p_revision: revision}, "Ogłoszenie usunięte.");
  });
  deleteDialog.addEventListener("close", () => { pendingDeletion = undefined; });
  let cursor;
  const titleInput = form.elements.title;
  let items = [];
  let selectedStatus = "published";
  let draftId;
  let current = null;
  let initial = "";
  let sessionGeneration = 0;
  let busy = false;
  let rpc;
  let onUnauthorized;
  let savedRange;

  function data() {
    return { title: titleInput.value, content: content.read(editor), endsOn: dateInput.value || null };
  }

  const confirmDialog = document.getElementById("announcement-confirm-dialog");

  function confirmAction(title, description, label) {
    if (confirmDialog.open) return false;
    document.getElementById("announcement-confirm-title").textContent = title;
    document.getElementById("announcement-confirm-description").textContent = description;
    confirmDialog.querySelector('[value="confirm"]').textContent = label;
    confirmDialog.returnValue = "";
    confirmDialog.showModal();
    return new Promise(resolve => {
      confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), {once: true});
    });
  }

  async function canLeave() {
    if (busy && !form.hidden) return false;
    return form.hidden || JSON.stringify(data()) === initial ||
      confirmAction("Opuścić formularz?", "Masz niezapisane zmiany.", "Opuść formularz");
  }

  function button(label, callback) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", callback);
    return element;
  }

  function text(tag, value) {
    const element = document.createElement(tag);
    element.textContent = value;
    return element;
  }

  const matchesFilter = (item, key) => key === "all" || item.status === key;
  const formatDay = day => dayFormatter.format(new Date(day + "T12:00:00Z"));
  function expiryLabel(item) {
    if (item.displayEndsOn) return formatDay(item.displayEndsOn);
    if (!item.expiresAt) return item.endsOn ? formatDay(item.endsOn) : "—";
    return dayFormatter.format(new Date(Date.parse(item.expiresAt) - 1));
  }
  let statusTimer;
  function scheduleStatusRefresh() {
    clearTimeout(statusTimer);
    const expiries = items.filter(item => item.status === "published" && item.expiresAt)
      .map(item => Date.parse(item.expiresAt)).filter(Number.isFinite);
    if (expiries.length) statusTimer = setTimeout(updateExpiredStatuses,
      Math.min(2147483647, Math.max(1, Math.min(...expiries) - Date.now())));
  }
  function updateExpiredStatuses() {
    const expired = items.filter(item => item.status === "published" && Date.parse(item.expiresAt) <= Date.now());
    expired.forEach(item => { item.status = "expired"; });
    if (expired.length) {
      articles();
      if (!form.hidden && current?.status === "expired") {
        dateOpen.disabled = true;
        previewContent();
      }
    }
    scheduleStatusRefresh();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") updateExpiredStatuses();
  });

  function articles() {
    const filterLabels = { all: "Wszystkie", ...labels, draft: "Szkice" };
    for (const tab of filter.querySelectorAll("[data-filter]")) {
      const key = tab.dataset.filter;
      const count = items.filter(item => matchesFilter(item, key)).length;
      tab.textContent = filterLabels[key] + " (" + count + ")";
      tab.setAttribute("aria-pressed", String(key === selectedStatus));
      tab.disabled = key === selectedStatus;
    }
    const selected = items.filter(item => matchesFilter(item, selectedStatus));
    list.replaceChildren(...selected.map(item => {
      const row = document.createElement("article");
      row.className = "admin-announcement-row";
      row.dataset.state = item.status;
      const main = document.createElement("div");
      const side = document.createElement("div");
      side.className = "admin-announcement-row-side";
      const headline = text("h3", item.title);
      const badge = text("span", labels[item.status]);
      badge.className = "admin-announcement-badge";
      badge.dataset.state = item.status;
      const dates = [
        item.publishedAt && ["Opublikowano:", formatter.format(new Date(item.publishedAt))],
        ["Koniec publikacji:", expiryLabel(item)],
        item.withdrawnAt && ["Wycofano:", formatter.format(new Date(item.withdrawnAt))]
      ].filter(Boolean);
      main.append(headline, badge, text("p", item.summary));
      for (const [label, value] of dates) {
        const date = document.createElement("p");
        date.append(text("strong", label), " " + value);
        side.append(date);
      }
      const actions = document.createElement("div");
      actions.className = "admin-actions";
      actions.append(button("Edytuj", () => edit(item)));
      if (item.status === "published") actions.append(button("Wycofaj z publikacji", async () => {
        if (!busy && await confirmAction("Wycofać ogłoszenie?", "„" + item.title + "” zniknie z listy aktywnych ogłoszeń.", "Wycofaj z publikacji")) {
          save("withdraw_announcement", { p_id: item.id, p_revision: item.revision }, "Ogłoszenie wycofane.");
        }
      }));
      if (["withdrawn", "expired"].includes(item.status)) actions.append(button("Usuń", () => {
        if (busy || deleteDialog.open) return;
        pendingDeletion = item;
        deleteName.textContent = item.title;
        deleteDialog.showModal();
      }));
      side.append(actions);
      row.append(main, side);
      return row;
    }));
    if (!selected.length) {
      const empty = {
        published: ["Brak opublikowanych ogłoszeń", "Opublikowane ogłoszenia pojawią się tutaj."],
        draft: ["Brak szkiców", "Zapisane szkice ogłoszeń pojawią się tutaj."],
        expired: ["Brak wygasłych ogłoszeń", "Ogłoszenia po zakończeniu publikacji pojawią się tutaj."],
        withdrawn: ["Brak wycofanych ogłoszeń", "Wycofane ogłoszenia pojawią się tutaj."],
        all: ["Brak ogłoszeń", "Utwórz nowe ogłoszenie, aby pojawiło się na liście."]
      };
      list.append(g19EmptyState("announcement", ...empty[selectedStatus]));
    }
  }

  function handleError(error) {
    if ([401, 403].includes(error.status)) return onUnauthorized();
    setStatus(error.status === 409
      ? "Ogłoszenie zmieniło się. Odśwież listę przed ponowieniem."
      : "Nie udało się wykonać operacji. Sprawdź dane i spróbuj ponownie.");
  }

  async function refresh() {
    if (section.hidden) return;
    const generation = sessionGeneration;
    try {
      const rows = await rpc("announcements");
      if (generation !== sessionGeneration) return;
      items = rows;
      articles();
      updateExpiredStatuses();
      return true;
    } catch (error) {
      if (generation === sessionGeneration) handleError(error);
      return false;
    }
  }

  function showList() {
    if (confirmDialog.open) confirmDialog.close();
    if (publishDialog.open) publishDialog.close();
    if (dateDialog.open) dateDialog.close();
    if (deleteDialog.open) deleteDialog.close();
    form.hidden = true;
    listView.hidden = false;
    current = null;
    draftId = null;
    savedRange = null;
    initial = "";
    form.reset();
    dateInput.value = "";
    dateOpen.textContent = "Wybierz datę";
    editor.replaceChildren();
    bodyPreview.replaceChildren();
    preview.querySelector("h3").textContent = "";
    preview.querySelector(".announcement-date").textContent = "";
    expiryPreview.textContent = "";
  }

  function warsawToday(now = new Date()) {
    const parts = Object.fromEntries(warsawCalendar.formatToParts(now).map(part => [part.type, part.value]));
    return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12));
  }

  function moveDays(date, offset) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + offset, 12));
  }

  function moveMonths(date, offset) {
    const year = date.getUTCFullYear(), month = date.getUTCMonth() + offset;
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), last), 12));
  }

  function drawDates(focusDay = false) {
    const today = warsawToday(), last = moveDays(today, 3650);
    cursor = new Date(Math.max(+today, Math.min(+last, +cursor)));
    const year = cursor.getUTCFullYear(), month = cursor.getUTCMonth();
    const first = new Date(Date.UTC(year, month, 1, 12));
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const padding = (first.getUTCDay() + 6) % 7;
    dateMonth.textContent = monthFormatter.format(cursor);
    for (const control of dateNavigation) {
      const target = moveMonths(first, Number(control.dataset.step));
      control.disabled = moveMonths(target, 1) <= today || target > last;
    }
    dateDays.replaceChildren(...Array.from({length: padding}, () => document.createElement("span")));
    for (let day = 1; day <= lastDay; day++) {
      const date = new Date(Date.UTC(year, month, day, 12));
      const key = date.toISOString().slice(0, 10);
      const control = button(String(day), () => {
        if (date < warsawToday()) { drawDates(true); return; }
        dateInput.value = key;
        previewContent();
        dateDialog.close();
      });
      control.disabled = date < today || date > last;
      control.tabIndex = +date === +cursor ? 0 : -1;
      control.setAttribute("aria-label", dayFormatter.format(date));
      control.setAttribute("aria-pressed", String(key === dateInput.value));
      if (+date === +today) control.setAttribute("aria-current", "date");
      dateDays.append(control);
    }
    if (focusDay) dateDays.querySelector('[tabindex="0"]').focus();
  }

  dateOpen.addEventListener("click", () => {
    cursor = dateInput.value ? new Date(dateInput.value + "T12:00:00Z") : warsawToday();
    dateDialog.showModal();
    drawDates(true);
  });
  dateClear.addEventListener("click", () => {
    dateInput.value = "";
    previewContent();
    dateOpen.focus();
  });
  dateDialog.addEventListener("close", () => { if (!form.hidden) dateOpen.focus(); });
  for (const control of dateNavigation) control.addEventListener("click", () => {
    const step = Number(control.dataset.step);
    cursor = moveMonths(cursor, step);
    drawDates();
    if (control.disabled) dateDays.querySelector('[tabindex="0"]').focus();
  });
  dateDays.addEventListener("keydown", event => {
    const offsets = {ArrowLeft:-1, ArrowRight:1, ArrowUp:-7, ArrowDown:7,
      Home:-((cursor.getUTCDay() + 6) % 7), End:6 - ((cursor.getUTCDay() + 6) % 7)};
    if (event.key in offsets) cursor = moveDays(cursor, offsets[event.key]);
    else if (event.key === "PageUp" || event.key === "PageDown") {
      cursor = moveMonths(cursor, (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1));
    } else return;
    event.preventDefault();
    drawDates(true);
  });

  function previewContent() {
    preview.querySelector("h3").textContent = titleInput.value.trim() || "Tytuł ogłoszenia";
    const now = new Date();
    const publication = current?.publishedAt
      ? "Opublikowano: " + dayFormatter.format(new Date(current.publishedAt))
      : "Podgląd — nieopublikowane";
    const archived = {withdrawn: "Wycofane", expired: "Wygasłe"}[current?.status];
    preview.querySelector(".announcement-date").textContent = archived ? archived + " · " + publication : publication;
    const defaultDay = moveDays(warsawToday(now), 30);
    dateOpen.textContent = dateInput.value ? dayFormatter.format(new Date(dateInput.value + "T12:00:00Z")) : "Wybierz datę";
    dateClear.disabled = dateOpen.disabled || Boolean(current?.publishedAt) || !dateInput.value;
    expiryPreview.textContent = current?.expiresAt && (dateInput.value || null) === current.endsOn
      ? "Koniec publikacji: " + expiryLabel(current)
      : dateInput.value ? "Koniec publikacji: " + formatDay(dateInput.value)
      : !current?.publishedAt ? "Przy publikacji dziś: " + dayFormatter.format(defaultDay) : "";
    content.render(bodyPreview, content.read(editor));
  }

  function edit(item = null) {
    current = item;
    draftId = item?.id || crypto.randomUUID();
    document.getElementById("admin-announcement-form-title").textContent = item ? "Edytuj ogłoszenie" : "Nowe ogłoszenie";
    titleInput.value = item?.title || "";
    dateInput.value = item?.endsOn || "";
    content.render(editor, item?.content || []);
    const draft = !item || item.status === "draft";
    dateOpen.disabled = Boolean(item && ["expired", "withdrawn"].includes(item.status));
    document.getElementById("announcement-save-draft").hidden = !draft;
    document.getElementById("announcement-publish").hidden = !draft;
    document.getElementById("announcement-save-changes").hidden = draft;
    setStatus("");
    g19AdminStatus(document.getElementById("admin-status"), "");
    listView.hidden = true;
    form.hidden = false;
    initial = JSON.stringify(data());
    previewContent();
    savedRange = null;
    titleInput.focus();
  }

  async function save(method, args, feedback) {
    if (busy) return;
    busy = true;
    form.inert = true;
    const generation = sessionGeneration;
    try {
      await rpc(method, args);
      if (generation !== sessionGeneration) return;
      setStatus(feedback, true);
      showList();
      await refresh();
    } catch (error) {
      if (generation === sessionGeneration) handleError(error);
    } finally {
      if (generation === sessionGeneration) { busy = false; form.inert = false; }
    }
  }

  function saveForm(publish) {
    if (!form.reportValidity() || !titleInput.value.trim()) return;
    if (publish && !editor.textContent.trim()) {
      setStatus("Wpisz treść ogłoszenia przed publikacją.");
      editor.focus();
      return;
    }

    const value = data();
    save("save_announcement", { p_id: draftId, p_revision: current?.revision || null,
      p_title: value.title, p_content: value.content, p_ends_on: value.endsOn, p_publish: publish },
    publish ? "Ogłoszenie opublikowane." : "Zapisano ogłoszenie.");
  }

  form.addEventListener("submit", event => event.preventDefault());
  form.addEventListener("input", () => { rememberEditorSelection(); previewContent(); });
  document.getElementById("announcement-new").addEventListener("click", () => edit());
  document.getElementById("announcement-cancel").addEventListener("click", async () => { if (await canLeave()) showList(); });
  document.getElementById("announcement-save-draft").addEventListener("click", () => saveForm(false));
  document.getElementById("announcement-save-changes").addEventListener("click", () => saveForm(false));
  publishButton.addEventListener("click", () => {
    if (busy || publishDialog.open || !form.reportValidity()) return;
    if (!editor.textContent.trim()) { saveForm(true); return; }
    publishDialog.showModal();
  });
  publishDialog.querySelector("[data-cancel]").addEventListener("click", () => publishDialog.close());
  publishDialog.querySelector("form").addEventListener("submit", event => {
    event.preventDefault();
    if (!publishDialog.open || busy) return;
    publishDialog.close();
    saveForm(true);
  });
  publishDialog.addEventListener("close", () => { if (!form.hidden && !busy) publishButton.focus(); });
  filter.addEventListener("click", event => {
    const key = event.target.closest("[data-filter]")?.dataset.filter;
    if (!key || key === selectedStatus) return;
    selectedStatus = key;
    articles();
  });

  function rememberEditorSelection() {
    const selection = document.getSelection();
    if (selection.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      savedRange = selection.getRangeAt(0).cloneRange();
    }
  }
  document.addEventListener("selectionchange", rememberEditorSelection);
  editor.addEventListener("keyup", rememberEditorSelection);
  document.getElementById("announcement-tools").addEventListener("pointerdown", rememberEditorSelection);

  function restoreEditorSelection() {
    const range = savedRange;
    editor.focus();
    if (!range || !editor.contains(range.commonAncestorContainer)) return;
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function command(name, value = null) {
    restoreEditorSelection();
    document.execCommand(name, false, value);
    rememberEditorSelection();
    previewContent();
  }
  for (const control of document.querySelectorAll("#announcement-tools button[data-command]")) {
    control.addEventListener("mousedown", event => event.preventDefault());
    control.addEventListener("click", () => {
      const type = control.dataset.command;
      if (type === "link") {
        restoreEditorSelection();
        const anchor = document.getSelection().anchorNode;
        const currentLink = (anchor?.parentElement || anchor)?.closest?.("a");
        const value = window.prompt("Adres linku (https:// lub http://). Usuń adres, aby usunąć link.", currentLink?.href || "");
        if (value === null) return;
        if (!value.trim()) return command("unlink");
        const url = content.safeLink(value.trim());
        if (!url) { setStatus("Wpisz prawidłowy adres http:// lub https://."); return; }
        if (document.getSelection().isCollapsed && currentLink) {
          document.getSelection().selectAllChildren(currentLink);
          savedRange = document.getSelection().getRangeAt(0).cloneRange();
        } else if (document.getSelection().isCollapsed) {
          command("insertText", url);
          const caret = document.getSelection().getRangeAt(0).cloneRange();
          if (caret.endContainer.nodeType !== Node.TEXT_NODE || caret.endOffset < url.length) return;
          caret.setStart(caret.endContainer, caret.endOffset - url.length);
          savedRange = caret;
        }
        command("createLink", url);
      } else if (type === "clear") {
        command("unlink");
        command("removeFormat");
        restoreEditorSelection();
        for (const listCommand of ["insertUnorderedList", "insertOrderedList"]) {
          if (document.queryCommandState(listCommand)) document.execCommand(listCommand);
        }
        document.execCommand("formatBlock", false, "p");
        previewContent();
      } else command(type);
    });
  }
  document.getElementById("announcement-paragraph").addEventListener("change", event => {
    command("formatBlock", event.target.value);
    event.target.value = "";
  });
  editor.addEventListener("paste", event => {
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
  });
  editor.addEventListener("drop", event => event.preventDefault());

  const duties = window.g19AdminDuties;
  async function activate(name, force = false) {
    const active = !section.hidden ? "announcements" : duties.isOpen() ? "duties" : "rooms";
    if (!force && (active === name || (active === "announcements" && !await canLeave()) ||
        (active === "duties" && !await duties.canLeave()))) return;
    showList();
    rooms.hidden = name !== "rooms";
    section.hidden = name !== "announcements";
    duties.setOpen(name === "duties");
    for (const control of nav.querySelectorAll("button")) {
      const selected = control.dataset.section === name;
      control.setAttribute("aria-pressed", String(selected));
      control.disabled = selected && (name !== "rooms" || !document.querySelector("#admin-rooms.admin-room-selected"));
    }
    if (name === "announcements") refresh();
    document.getElementById("admin-title").textContent = ({ announcements: "Ważne ogłoszenia", duties: "Dyżury", rooms: "Zarządzanie pokojami" })[name];
  }
  nav.addEventListener("click", async event => {
    const name = event.target.dataset.section;
    if (!name) return;
    await activate(name);
    if (event.target.getAttribute("aria-pressed") === "true") document.getElementById("admin-title").focus();
  });
  window.addEventListener("beforeunload", event => {
    if (!form.hidden && JSON.stringify(data()) !== initial) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  window.addEventListener("hashchange", async () => {
    const target = location.hash;
    if (target.toLowerCase() === "#administracja" || form.hidden || confirmDialog.open) return;
    const allowed = await canLeave();
    if (location.hash !== target) return;
    if (allowed) showList();
    else location.hash = "administracja";
  });
  window.g19AdminAnnouncements = {
    init(call, unauthorized) { rpc = call; onUnauthorized = unauthorized; },
    refresh,
    isOpen: () => !section.hidden,
    canLeave,
    reset() {
      ++sessionGeneration;
      busy = false;
      form.inert = false;
      items = [];
      clearTimeout(statusTimer);
      selectedStatus = "published";
      list.replaceChildren();
      setStatus("");
      showList();
      activate("rooms", true);
    }
  };
})();
