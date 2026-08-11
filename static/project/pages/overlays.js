/* Page-singleton overlay markup shared by every page mounted into
 * #project-page-container (grid-page.js, for both the project grid and each
 * folder): the reference carousel, and the reference-link hover preview used
 * by Analyze transcripts.
 *
 * shared/carousel.js only ever looks its markup up by id -- it doesn't care
 * how that markup got into the document -- so this builds the same structure
 * index.html hard-codes, once, and appends it to <body>. Built lazily on
 * first use rather than unconditionally at module load, so importing this
 * file has no side effect on a page that never opens a reference.
 *
 * A page instance comes and goes as the user navigates between the project
 * grid and its folders, but this markup does not: recreating it on every
 * navigation would leave shared/carousel.js's cached element references
 * (captured once, on its own first use) pointing at elements this module had
 * since removed.
 */

import * as carousel from "../../shared/carousel.js";

let ready = false;

// The reference list a ref-link click (in whichever Analyze transcript is
// currently open) should jump within. Set by the active grid-page instance
// each time its own list loads -- see grid-page.js's setActiveReferences call.
let activeReferences = [];

function buildCarouselMarkup() {
  const overlay = document.createElement("div");
  overlay.id = "carousel-overlay";
  overlay.className = "carousel-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <button id="carousel-close" class="carousel-close" title="Close (Esc)">&times;</button>
    <button id="carousel-prev" class="carousel-arrow left" title="Previous (&larr;)">&#8249;</button>
    <button id="carousel-next" class="carousel-arrow right" title="Next (&rarr;)">&#8250;</button>

    <div class="carousel-body">
      <div id="carousel-media" class="carousel-media"></div>
      <div id="carousel-info" class="carousel-info">
        <h2 id="info-title"></h2>
        <p id="info-type" class="muted"></p>
        <span id="info-own-work" class="own-work-badge" hidden>Own work</span>
        <div id="info-tags" class="tag-list"></div>
        <p id="info-description"></p>
        <p id="info-source" class="muted"></p>
        <p id="info-notes" class="muted"></p>

        <div class="project-add">
          <label for="carousel-project-select">Add to project</label>
          <select id="carousel-project-select">
            <option value="" selected>Choose a project…</option>
            <option value="__new__">+ New project…</option>
          </select>
          <p id="carousel-project-status" class="muted"></p>
        </div>
      </div>
    </div>

    <div class="similar-panel">
      <h3>Similar items</h3>
      <div id="similar-grid" class="grid small"></div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function buildRefPreviewMarkup() {
  const popup = document.createElement("div");
  popup.id = "ref-preview-popup";
  popup.className = "ref-preview-popup";
  popup.hidden = true;
  popup.innerHTML = `
    <div id="ref-preview-media" class="ref-preview-media"></div>
    <div id="ref-preview-title" class="ref-preview-title"></div>
  `;
  document.body.appendChild(popup);

  const media = popup.querySelector("#ref-preview-media");
  const title = popup.querySelector("#ref-preview-title");

  document.addEventListener("mouseover", (e) => {
    const link = e.target.closest(".ref-link");
    if (!link) return;
    media.innerHTML = "";
    const img = document.createElement("img");
    img.src = `/media/${link.dataset.refId}/thumb`;
    img.onerror = () => img.remove();
    media.appendChild(img);
    title.textContent = link.textContent;
    popup.hidden = false;
  });

  document.addEventListener("mouseout", (e) => {
    if (e.target.closest(".ref-link")) popup.hidden = true;
  });

  document.addEventListener("mousemove", (e) => {
    if (popup.hidden) return;
    const offset = 16;
    let x = e.clientX + offset;
    let y = e.clientY + offset;
    if (x + 170 > window.innerWidth) x = e.clientX - 170 - offset;
    if (y + 190 > window.innerHeight) y = e.clientY - 190 - offset;
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
  });
}

// Clicking a linked reference (in a live Analyze transcript or the Previous
// Analysis sidebar's saved view) jumps to it in the carousel -- only possible
// when it's part of activeReferences; a related item pulled in purely for
// context won't be, and the click is just a no-op there. Delegated on the
// document, same as index.html/app.js's version, so it covers every Analyze
// surface regardless of which page mounted it.
function wireRefLinkJump() {
  document.addEventListener("click", (e) => {
    const link = e.target.closest(".ref-link");
    if (!link) return;
    e.preventDefault();
    const idx = activeReferences.findIndex((r) => r.id === link.dataset.refId);
    if (idx === -1) return;
    // Closing the live analyze overlay (if that's where the click came from)
    // so the carousel isn't fighting it for the screen -- a no-op if it's
    // already hidden, or if the click came from the sidebar's saved view.
    const analyzeOverlay = document.getElementById("analyze-overlay");
    if (analyzeOverlay) analyzeOverlay.hidden = true;
    carousel.open(activeReferences, idx);
  });
}

export function ensureOverlays() {
  if (ready) return;
  ready = true;
  buildCarouselMarkup();
  buildRefPreviewMarkup();
  wireRefLinkJump();
}

export function setActiveReferences(list) {
  activeReferences = list || [];
}
