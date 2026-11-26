(() => {
  const dialog = document.getElementById("shortcut-help");
  const open = document.getElementById("shortcut-open");
  const install = document.getElementById("native-install");
  const instructions = document.getElementById("shortcut-instructions");
  const displayMode = window.matchMedia("(display-mode: standalone)");
  const key = "goleszan19-installed";
  const standalone = () => displayMode.matches || navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /Android/.test(navigator.userAgent);
  const firefox = /Firefox\//.test(navigator.userAgent);
  const mobile = ios || android || navigator.userAgentData?.mobile === true;
  const label = mobile ? "Na telefon" : "Na komputer";
  open.querySelector("span").textContent = label;
  open.setAttribute("aria-label", label + " — dodaj Goleszan 19");
  if (!mobile) open.querySelector("svg").outerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#g19-desktop-icon"/></svg>';
  let installed = false;
  let promptEvent;
  try { installed = localStorage.getItem(key) === "true"; }
  catch { /* Installation help still works without local storage. */ }

  function showInstructions() {
    install.hidden = !promptEvent;
    if (promptEvent) {
      instructions.innerHTML = "<p>Użyj przycisku „Zainstaluj”, aby otworzyć okno instalacji przeglądarki.</p>";
    } else if (ios) {
      instructions.innerHTML = "<p>W Safari wybierz <strong>Udostępnij → Do ekranu początkowego</strong>. Jeśli widzisz opcję <strong>Otwórz jako aplikację webową</strong>, włącz ją, a potem wybierz <strong>Dodaj</strong>.</p>";
    } else if (firefox && android) {
      instructions.innerHTML = "<p>W Firefox otwórz menu <strong>⋮</strong>, wybierz <strong>Zainstaluj</strong>, a następnie dodaj ikonę na ekranie głównym.</p>";
    } else if (firefox) {
      instructions.innerHTML = "<p>Firefox na komputerze nie udostępnia tej stronie okna instalacji. Jeśli w pasku adresu masz opcję dodania aplikacji do paska zadań, możesz jej użyć. Instalację PWA możesz też otworzyć w Chrome lub Edge.</p>";
    } else if (android) {
      instructions.innerHTML = "<p>Otwórz menu przeglądarki <strong>⋮</strong> i wybierz <strong>Zainstaluj aplikację</strong> lub <strong>Dodaj do ekranu głównego</strong>, jeśli widzisz taką opcję.</p>";
    } else {
      instructions.innerHTML = "<p>W Chrome lub Edge sprawdź ikonę instalacji w pasku adresu albo opcję instalacji w menu przeglądarki.</p>";
    }
  }
  const updateVisibility = () => { open.hidden = standalone() || installed; };
  updateVisibility();

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installed = false;
    try { localStorage.removeItem(key); } catch { /* Continue with the native prompt. */ }
    promptEvent = event;
    updateVisibility();
    showInstructions();
  });
  window.addEventListener("appinstalled", () => {
    promptEvent = null;
    installed = true;
    try { localStorage.setItem(key, "true"); } catch { /* The current tab still knows about installation. */ }
    if (dialog.open) dialog.close();
    updateVisibility();
  });
  displayMode.addEventListener("change", updateVisibility);
  open.addEventListener("click", () => {
    if (standalone() || installed) return;
    showInstructions();
    dialog.showModal();
  });
  install.addEventListener("click", async () => {
    if (!promptEvent) return;
    const event = promptEvent;
    promptEvent = null;
    showInstructions();
    try { await event.prompt(); }
    catch { /* The browser-menu instructions remain available. */ }
  });
  document.getElementById("shortcut-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
})();
