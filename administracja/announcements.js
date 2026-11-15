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
  const titleInput = form.elements.title;
  let items = [];
  let selectedStatus = "all";
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

  function canLeave() {
    if (busy && !form.hidden) return false;
    return form.hidden || JSON.stringify(data()) === initial ||
      window.confirm("Masz niezapisane zmiany. Opuścić formularz?");
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

  function articles() {
    const filterLabels = { all: "Wszystkie", ...labels, draft: "Szkice" };
    for (const tab of filter.querySelectorAll("[data-filter]")) {
      const key = tab.dataset.filter;
      const count = key === "all" ? items.length : items.filter(item => item.status === key).length;
      tab.textContent = filterLabels[key] + " (" + count + ")";
      tab.setAttribute("aria-pressed", String(key === selectedStatus));
    }
    const selected = items.filter(item => selectedStatus === "all" || item.status === selectedStatus);
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
        item.publishedAt && "Opublikowano: " + formatter.format(new Date(item.publishedAt)),
        "Koniec publikacji: " + (item.expiresAt ? formatter.format(new Date(item.expiresAt))
          : item.endsOn ? dayFormatter.format(new Date(item.endsOn + "T12:00:00Z")) : "—"),
        item.withdrawnAt && "Wycofano: " + formatter.format(new Date(item.withdrawnAt))
      ].filter(Boolean);
      main.append(headline, badge, text("p", item.summary));
      side.append(...dates.map(date => text("p", date)));
      const actions = document.createElement("div");
      actions.className = "admin-actions";
      actions.append(button("Edytuj", () => edit(item)));
      if (item.status === "published") actions.append(button("Wycofaj z publikacji", () => {
        if (window.confirm("Wycofać z publikacji ogłoszenie „" + item.title + "”?")) {
          save("withdraw_announcement", { p_id: item.id, p_revision: item.revision }, "Ogłoszenie wycofane.");
        }
      }));
      side.append(actions);
      row.append(main, side);
      return row;
    }));
    if (!selected.length) list.append(text("p", "Brak ogłoszeń w tym widoku."));
  }

  function handleError(error) {
    if ([401, 403].includes(error.status)) return onUnauthorized();
    message.textContent = error.status === 409
      ? "Ogłoszenie zmieniło się. Odśwież listę przed ponowieniem."
      : "Nie udało się wykonać operacji. Sprawdź dane i spróbuj ponownie.";
  }

  async function refresh() {
    if (section.hidden) return;
    const generation = sessionGeneration;
    try {
      const rows = await rpc("announcements");
      if (generation !== sessionGeneration) return;
      items = rows;
      articles();
    } catch (error) {
      if (generation === sessionGeneration) handleError(error);
    }
  }

  function showList() {
    form.hidden = true;
    listView.hidden = false;
    current = null;
    draftId = null;
    savedRange = null;
    initial = "";
    form.reset();
    editor.replaceChildren();
    bodyPreview.replaceChildren();
    preview.querySelector("h3").textContent = "";
    preview.querySelector(".announcement-date").textContent = "";
    expiryPreview.textContent = "";
  }

  function previewContent() {
    preview.querySelector("h3").textContent = titleInput.value.trim() || "Tytuł ogłoszenia";
    const now = new Date();
    preview.querySelector(".announcement-date").textContent = "Opublikowano: " +
      dayFormatter.format(current?.publishedAt ? new Date(current.publishedAt) : now);
    const parts = Object.fromEntries(warsawCalendar.formatToParts(now).map(part => [part.type, part.value]));
    const defaultDay = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 30, 12));
    expiryPreview.textContent = dateInput.value ? "Koniec publikacji: " + dayFormatter.format(new Date(dateInput.value + "T12:00:00Z"))
      : current?.expiresAt ? "Koniec publikacji: " + formatter.format(new Date(current.expiresAt))
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
    dateInput.disabled = Boolean(item && ["expired", "withdrawn"].includes(item.status));
    document.getElementById("announcement-save-draft").hidden = !draft;
    document.getElementById("announcement-publish").hidden = !draft;
    document.getElementById("announcement-save-changes").hidden = draft;
    message.textContent = "";
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
      message.textContent = feedback;
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
      message.textContent = "Wpisz treść ogłoszenia przed publikacją.";
      editor.focus();
      return;
    }
    if (publish && !window.confirm("Opublikować ogłoszenie i wysłać powiadomienie subskrybentom?")) return;
    const value = data();
    save("save_announcement", { p_id: draftId, p_revision: current?.revision || null,
      p_title: value.title, p_content: value.content, p_ends_on: value.endsOn, p_publish: publish },
    publish ? "Ogłoszenie opublikowane." : "Zapisano ogłoszenie.");
  }

  form.addEventListener("submit", event => event.preventDefault());
  form.addEventListener("input", () => { rememberEditorSelection(); previewContent(); });
  document.getElementById("announcement-new").addEventListener("click", () => edit());
  document.getElementById("announcement-cancel").addEventListener("click", () => { if (canLeave()) showList(); });
  document.getElementById("announcement-save-draft").addEventListener("click", () => saveForm(false));
  document.getElementById("announcement-save-changes").addEventListener("click", () => saveForm(false));
  document.getElementById("announcement-publish").addEventListener("click", () => saveForm(true));
  filter.addEventListener("click", event => {
    const key = event.target.closest("[data-filter]")?.dataset.filter;
    if (!key) return;
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
        if (!url) { message.textContent = "Wpisz prawidłowy adres http:// lub https://."; return; }
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

  function activate(announcements) {
    if (section.hidden === !announcements || !canLeave()) return;
    showList();
    rooms.hidden = announcements;
    section.hidden = !announcements;
    for (const control of nav.querySelectorAll("button")) {
      control.setAttribute("aria-pressed", String((control.dataset.section === "announcements") === announcements));
    }
    if (announcements) refresh();
    document.getElementById("admin-panel").setAttribute("aria-labelledby", announcements ? "admin-announcements-title" : "admin-title");
  }
  nav.addEventListener("click", event => {
    if (!event.target.dataset.section) return;
    const openAnnouncements = event.target.dataset.section === "announcements";
    activate(openAnnouncements);
    if (openAnnouncements === !section.hidden) {
      document.getElementById(openAnnouncements ? "admin-announcements-title" : "admin-title").focus();
    }
  });
  window.addEventListener("beforeunload", event => {
    if (!form.hidden && JSON.stringify(data()) !== initial) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  window.addEventListener("hashchange", () => {
    if (location.hash.toLowerCase() === "#administracja" || form.hidden) return;
    if (!canLeave()) location.hash = "administracja";
    else showList();
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
      selectedStatus = "all";
      list.replaceChildren();
      message.textContent = "";
      showList();
      activate(false);
    }
  };
})();
