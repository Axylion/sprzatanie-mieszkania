(() => {
  const icons = {
    kuchnia: '<path d="M3 10h18v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-8Zm0 0c0-3 4-4 9-4s9 1 9 4M10 6V4a2 2 0 0 1 4 0v2M1 12h2m18 0h2"/>',
    toalety: '<path d="M14 13V4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v9M2 13h19v1a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6v-1m6 7-1 3h9l-1-3M15 6h5"/>',
    lazienka: '<path d="M6 6a7 7 0 0 1 14 2v14m-3 0V8a4 4 0 0 0-8-1M2 12a6 6 0 0 1 12 0H2Zm1 3-.3 1m4.3-1v1m4-1 .3 1M2 19l-.3 1m5.3-1v1m5-1 .3 1"/>',
    pozostale: '<path d="m12 11 7.8-9a1.6 1.6 0 0 1 2.4 2.1l-7.8 9m-5.5-3.5 7.1 6-2.2 2.6-7.2-6 2.3-2.6Zm-2.1 2.8L1 18l7.4 6 5.4-5.8m-10.4 2 3.3-3.5m-.8 5.5 3.2-3.4"/>',
    szafki: '<rect x="3" y="2" width="18" height="20" rx="2"/><path d="M12 2v20m-3-11v3m6-3v3"/>',
    okap: '<path d="M9 3h6v7l7 5v3H2v-3l7-5V3Zm0 7h6M2 15h20M7 20c-1 1 1 2 0 3m5-3c-1 1 1 2 0 3m5-3c-1 1 1 2 0 3"/>',
    blysk: '<path d="M9 3c1.3 4.7 2.3 5.7 7 7-4.7 1.3-5.7 2.3-7 7-1.3-4.7-2.3-5.7-7-7 4.7-1.3 5.7-2.3 7-7Zm10 10c.6 2 1.4 2.8 3.5 3.5-2.1.7-2.9 1.5-3.5 3.5-.7-2-1.5-2.8-3.5-3.5 2-.7 2.8-1.5 3.5-3.5Z"/>',
    warstwy: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
    informacja: '<circle cx="12" cy="12" r="10"/><path d="M12 11v6m0-10v.1"/>'
  };

  const home = document.querySelector("#harmonogram");
  const homeEntry = home.querySelector('a[href="#poradnik"]');
  const guide = document.querySelector("#poradnik-view");
  const discussion = document.querySelector("#discussion-view");
  const discussionEntry = document.querySelector(".discussion-entry");
  const footer = document.querySelector("footer");
  const gallery = document.querySelector("#poradnik-gallery");
  const galleryImage = gallery.querySelector("img");
  const galleryCaption = gallery.querySelector("figcaption");
  const galleryPrevious = gallery.querySelector("[data-previous]");
  const galleryNext = gallery.querySelector("[data-next]");
  const homeTitle = document.title;
  let photos = [];
  let photoIndex = 0;
  let cardIndex = 0;
  let currentHash;
  let homeScroll = 0;

  function icon(id) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[id]}</svg>`;
  }

  function cardLink(card) {
    return `#poradnik/${card.id}`;
  }

  function categoryNav(activeSection) {
    return `<nav class="guide-categories" aria-label="Działy poradnika">${guideSections.map(section => {
      const first = guideCards.find(card => card.section === section.id);
      const active = section.id === activeSection ? ' aria-current="location"' : "";
      return `<a href="${cardLink(first)}"${active}>${icon(section.id)}<span>${section.title}</span></a>`;
    }).join("")}</nav>`;
  }

  function cardNavigation() {
    return `<nav class="guide-pagination" aria-label="Nawigacja kart poradnika">
      <button type="button" data-card-step="-1"${cardIndex === 0 ? " disabled" : ""}>‹ Poprzednia</button>
      <span class="guide-card-position">${cardIndex + 1} / ${guideCards.length}</span>
      <button type="button" data-card-step="1"${cardIndex === guideCards.length - 1 ? " disabled" : ""}>Następna ›</button>
    </nav>`;
  }

  function changeCard(step) {
    const target = guideCards[cardIndex + step];
    if (target) location.hash = cardLink(target);
  }

  function photoButton(index, className = "") {
    const { src, alt } = photos[index];
    return `<button type="button" class="guide-photo ${className}" data-photo="${index}" aria-haspopup="dialog" aria-label="Powiększ zdjęcie: ${alt}">
      <img src="${src}" alt="${alt}" decoding="async">
    </button>`;
  }

  function illustration(card, index) {
    if (index === undefined) return "";
    return `<span class="guide-illustration" aria-hidden="true" style="--tile: ${index}">
      <img src="./poradnik/media/${card.id}-ikony.webp" alt="" decoding="async">
    </span>`;
  }

  function itemPanel(card, title, items, start) {
    return `<section class="guide-panel">
      <h2>${icon("warstwy")} <span>${title}</span></h2>
      <ul class="guide-items">${items.map((item, index) => `
        <li>${illustration(card, start + index)}<span>${item}</span></li>
      `).join("")}</ul>
    </section>`;
  }

  function cardContent(card) {
    const section = guideSections.find(item => item.id === card.section);
    let detailIndex = card.photos.length;
    return `
      <article class="guide-article" aria-labelledby="guide-title">
        <div class="guide-card-header">
          ${icon(card.icon)}
          <div>
            <div class="guide-kicker">${section.title}</div>
            <h1 id="guide-title" tabindex="-1">${card.title}</h1>
            <p>${card.description}</p>
          </div>
          ${card.note ? `<p class="guide-note">${icon("blysk")} ${card.note}</p>` : ""}
        </div>
        <div class="guide-photos" role="group" aria-label="Zdjęcia">
          ${card.photos.map((_, index) => photoButton(index)).join("")}
        </div>
        <div class="guide-instructions">
          <section class="guide-panel">
            <h2>${icon("blysk")} <span>Jak czyścić?</span></h2>
            <ol class="guide-steps" role="list">${card.steps.map((step, index) => `
              <li>
                <span class="guide-step-number" aria-hidden="true">${index + 1}</span>
                ${step.photo ? photoButton(detailIndex++, "guide-detail") : illustration(card, step.illustration)}
                <div>${step.title ? `<strong>${step.title}</strong>` : ""}<p>${step.text}</p></div>
              </li>
            `).join("")}</ol>
          </section>
          <div class="guide-materials">
            ${itemPanel(card, "Potrzebne środki", card.supplies, 0)}
            ${itemPanel(card, "Przydatne akcesoria", card.accessories, card.supplies.length)}
          </div>
        </div>
        <aside class="guide-tip">${icon("informacja")}<p><strong>Wskazówka:</strong> ${card.tip}</p></aside>
      </article>
      ${cardNavigation()}
      ${categoryNav(card.section)}
    `;
  }

  function renderGuide() {
    const hash = location.hash;
    if (hash === currentHash) return;
    const wasGuide = !guide.hidden;
    const wasDiscussion = !discussion.hidden;
    const admin = document.getElementById("admin-view");
    const showAdmin = hash === "#administracja";
    const wasAdmin = !admin.hidden;
    admin.hidden = !showAdmin;
    const showDiscussion = hash === "#dyskusje";
    const showGuide = hash === "#poradnik" || hash.startsWith("#poradnik/");
    currentHash = hash;
    if (gallery.open) gallery.close();
    if ((showGuide || showDiscussion || showAdmin) && !wasGuide && !wasDiscussion && !wasAdmin) homeScroll = window.scrollY;
    discussion.hidden = !showDiscussion;
    if (!showGuide) {
      home.hidden = footer.hidden = showDiscussion || showAdmin;
      guide.hidden = true;
      document.title = homeTitle;
      if (showDiscussion) {
        document.title = "Dyskusje · Goleszan 19";
        discussion.querySelector("h1").focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: "instant" });
      } else if (showAdmin) {
        document.title = "Administracja · Goleszan 19";
        document.getElementById("admin-title").focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: "instant" });
      } else if (hash === "#ustawienia") {
        document.getElementById("settings-title").focus({ preventScroll: true });
        document.getElementById("ustawienia").scrollIntoView({ behavior: "instant" });
      } else if (wasGuide || wasDiscussion || wasAdmin) {
        (wasAdmin ? footer.querySelector('a[href="#administracja"]') : wasGuide ? homeEntry : discussionEntry).focus({ preventScroll: true });
        if (!hash.startsWith("#ogloszenie-")) window.scrollTo({ top: homeScroll, behavior: "instant" });
      }
      return;
    }

    cardIndex = Math.max(0, guideCards.findIndex(card => cardLink(card) === hash));
    const currentCard = guideCards[cardIndex];
    photos = [...currentCard.photos, ...currentCard.steps.filter(step => step.photo).map(step => step.photo)]
      .map((alt, index) => ({ alt, src: `./poradnik/media/${currentCard.id}-${index + 1}.webp` }));

    guide.innerHTML = `
      <div class="guide-frame">
        <div class="guide-top">
          <a class="guide-home-link" href="#harmonogram">← Harmonogram</a>
        </div>
        ${cardContent(currentCard)}
      </div>
    `;
    home.hidden = footer.hidden = true;
    guide.hidden = false;
    document.title = `${currentCard.title} · Poradnik sprzątania`;
    guide.querySelector("h1").focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function showPhoto(index) {
    photoIndex = (index + photos.length) % photos.length;
    const { src, alt } = photos[photoIndex];
    galleryImage.src = src;
    galleryImage.alt = alt;
    galleryCaption.textContent = `${photoIndex + 1} / ${photos.length} · ${alt}`;
  }

  guide.addEventListener("click", event => {
    const control = event.target.closest("[data-card-step]");
    if (control) {
      changeCard(Number(control.dataset.cardStep));
      return;
    }
    const photo = event.target.closest("[data-photo]");
    if (!photo) return;
    showPhoto(Number(photo.dataset.photo));
    gallery.showModal();
  });
  galleryImage.addEventListener("load", () => {
    galleryImage.style.setProperty("--photo-width", `${galleryImage.naturalWidth}px`);
  });
  gallery.querySelector("[data-close]").addEventListener("click", () => gallery.close());
  galleryPrevious.addEventListener("click", () => showPhoto(photoIndex - 1));
  galleryNext.addEventListener("click", () => showPhoto(photoIndex + 1));
  gallery.addEventListener("click", event => {
    if (event.target === gallery) gallery.close();
  });
  gallery.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      showPhoto(photoIndex + (event.key === "ArrowLeft" ? -1 : 1));
    }
  });

  function onHorizontalSwipe(surface, navigate) {
    let start;
    let verticalTravel = 0;

    surface.addEventListener("touchstart", event => {
      start = event.touches.length === 1 ? event.touches[0] : undefined;
      verticalTravel = 0;
    }, { passive: true });
    surface.addEventListener("touchmove", event => {
      if (!start) return;
      if (event.touches.length !== 1) {
        start = undefined;
        return;
      }
      verticalTravel = Math.max(verticalTravel, Math.abs(event.touches[0].clientY - start.clientY));
    }, { passive: true });
    surface.addEventListener("touchcancel", () => { start = undefined; }, { passive: true });
    surface.addEventListener("touchend", event => {
      const origin = start;
      start = undefined;
      if (!origin || event.touches.length) return;
      const end = Array.from(event.changedTouches).find(touch => touch.identifier === origin.identifier);
      if (!end) return;
      const dx = end.clientX - origin.clientX;
      const dy = Math.max(verticalTravel, Math.abs(end.clientY - origin.clientY));
      if (Math.abs(dx) < 60 || dy > 45 || Math.abs(dx) < 2 * dy) return;
      // A swipe starting on a thumbnail must not also open it as a tap.
      if (event.cancelable) event.preventDefault();
      navigate(dx < 0 ? 1 : -1);
    }, { passive: false });
  }

  onHorizontalSwipe(guide, step => {
    if (!gallery.open) changeCard(step);
  });
  onHorizontalSwipe(gallery, step => showPhoto(photoIndex + step));

  window.addEventListener("hashchange", renderGuide);
  renderGuide();
})();
