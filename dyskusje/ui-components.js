function g19EmptyState(icon, title, description) {
  const state = document.getElementById("empty-state-template").content.firstElementChild.cloneNode(true);
  state.querySelector("use").setAttribute("href", "#g19-" + icon + "-icon");
  state.querySelector("strong").textContent = title;
  state.querySelector("p").textContent = description;
  return state;
}

document.getElementById("notification-empty").append(
  g19EmptyState("bell", "Brak powiadomień", "Nie masz nowych powiadomień.")
);
document.getElementById("hidden-announcements-empty").append(
  g19EmptyState("announcement", "Brak aktywnych ogłoszeń", "Obecnie nie ma ważnych ogłoszeń dla mieszkańców.")
);

for (const disclosure of document.querySelectorAll(".private-privacy")) {
  const summary = disclosure.querySelector("summary");
  const sync = () => summary.setAttribute("aria-expanded", String(disclosure.open));
  disclosure.addEventListener("toggle", sync);
  sync();
}
