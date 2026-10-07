/* The portfolio's review view: the document read one page at a time, full
 * bleed, with nothing else on screen. Opened from the Portfolio widget and from
 * its management view (project/pages/portfolio-page.js).
 *
 * An overlay toggled by `hidden`, with one document keydown listener guarded on
 * it, the way shared/carousel.js does it -- but not carousel.js itself. That is
 * a reference viewer (metadata, add-to-project, similar items) and a page of a
 * portfolio wants none of it; hollowing it out would leave two callers
 * disagreeing about what a carousel is. Real fullscreen is offered on top where
 * the platform has it and is simply absent where it doesn't (the desktop build
 * is a WKWebView whose fullscreen has not been tried), so the overlay is the
 * thing that works and fullscreen is a bonus.
 *
 * ORDER. Every slot of every spread, in the order `overview.spreads` lists
 * them -- the order the widget draws them and the management view lists them,
 * since all three read the same array. Within a spread, the spread's own page
 * order. An empty slot is a page: it is drawn as an empty page carrying its
 * number, because pagination is the document (the PDF export keeps blanks for
 * the same reason) and a review that skips the gaps hides what a review is for.
 *
 * RESOLUTION. The 1200px thumbnail goes up at once -- the widget has usually
 * warmed it -- and the original is swapped in over it when it has loaded. The
 * neighbours' originals are fetched after the current one settles, so arrowing
 * is instant, but never more than the current page and the one either side are
 * held: thirty 300dpi A4 scans decoded at once would be far too much memory.
 *
 * A view, not an editor: the only keys it answers are the six below, and it
 * swallows every other one so nothing underneath (a widget, a field) can react
 * to a stray press while a page is being read.
 */

import { fileUrl, thumbUrl } from "./portfolio.js";

const IDLE_MS = 2200;

let initialized = false;
let els = {};
let pages = []; // the whole walk, flattened
let index = -1;
let opener = null; // what had focus, so closing puts it back
let idleTimer = null;
// pageId -> { thumb, original, state } for the current page and its neighbours
// only. The <img> elements live here, not in the DOM, so stepping back and
// forth re-uses what has already been decoded instead of asking the server.
let held = new Map();

/** The review's walk, from the portfolio overview. Exported so a caller can
 *  ask whether there is anything to review before offering the control. */
export function reviewPages(overview) {
  const spreads = overview?.spreads || [];
  const several = spreads.length > 1;
  return spreads.flatMap((spread) =>
    spread.slots.map((slot) => ({
      nodeId: spread.node_id,
      spread: spread.ordinal,
      several,
      number: slot.number,
      total: spread.total,
      index: slot.index,
      pageId: slot.page_id,
      fit: slot.fit === "cover" ? "cover" : "contain",
      landscape: spread.orientation === "landscape",
    }))
  );
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chromeButton(label, className, text) {
  const btn = el("button", `portfolio-review-btn ${className}`, text);
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  return btn;
}

function ensureInit() {
  if (initialized) return;
  initialized = true;

  const overlay = el("div", "portfolio-review");
  overlay.hidden = true;
  overlay.tabIndex = -1;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Portfolio review");

  const stage = el("div", "portfolio-review-stage");

  // The chrome: a page number and a close control (and fullscreen, where the
  // platform has it). It sits over the page only while the pointer is moving.
  const counter = el("p", "portfolio-review-counter");
  counter.setAttribute("aria-live", "polite");
  const fullscreenBtn = chromeButton("Full screen", "portfolio-review-fullscreen", "⤢");
  const closeBtn = chromeButton("Close", "portfolio-review-close", "×");
  // Absent, not disabled, where there is nothing to offer.
  fullscreenBtn.hidden = !(document.fullscreenEnabled && overlay.requestFullscreen);
  const tools = el("div", "portfolio-review-tools");
  tools.append(fullscreenBtn, closeBtn);

  overlay.append(stage, counter, tools);
  document.body.appendChild(overlay);
  els = { overlay, stage, counter, fullscreenBtn, closeBtn };

  closeBtn.addEventListener("click", close);
  fullscreenBtn.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", syncFullscreenButton);

  // Click to turn the page, the presentation convention: the left third goes
  // back, everywhere else goes on. There is no on-screen arrow to hit -- the
  // page is meant to have nothing beside it -- so the cursor says which.
  stage.addEventListener("click", (event) => {
    step(event.clientX < window.innerWidth / 3 ? -1 : 1);
  });
  stage.addEventListener("pointermove", (event) => {
    stage.classList.toggle("is-back", event.clientX < window.innerWidth / 3);
  });

  // Wake the chrome on any pointer movement, let it go after a still moment.
  // It stays up while a control is hovered or holds keyboard focus.
  overlay.addEventListener("pointermove", wake);
  overlay.addEventListener("pointerdown", wake);
  overlay.addEventListener("focusin", (event) => {
    if (event.target.matches(":focus-visible")) wake();
  });

  // Nothing under the overlay should scroll while a page is being read.
  overlay.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });

  // Capture phase, and every key swallowed: the six below act, the rest do
  // nothing at all rather than reaching a handler on the page underneath.
  // Browser shortcuts (anything with Ctrl / Cmd / Alt) are left alone.
  document.addEventListener(
    "keydown",
    (event) => {
      if (els.overlay.hidden) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // A key pressed on a chrome button is that button's (Enter, Space), but
      // Escape and the arrows still mean what they mean everywhere else.
      const onButton = event.target instanceof HTMLButtonElement;
      if (onButton && (event.key === "Enter" || (event.key === " " && !event.repeat))) return;

      event.stopPropagation();
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          step(-1);
          break;
        case "ArrowRight":
        case " ":
          event.preventDefault();
          step(1);
          break;
        case "Home":
          event.preventDefault();
          go(0);
          break;
        case "End":
          event.preventDefault();
          go(pages.length - 1);
          break;
        case "Escape":
          event.preventDefault();
          close();
          break;
        default:
          // Tab stays inside the overlay's own controls; nothing else is a key.
          if (event.key !== "Tab") event.preventDefault();
      }
    },
    true
  );

  // The overlay belongs to wherever it was opened from; if the route moves on
  // underneath it (back button, a link), it goes too.
  window.addEventListener("hashchange", close);
}

// --- chrome ----------------------------------------------------------------------

function wake() {
  els.overlay.classList.add("is-awake");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const hovered = els.overlay.querySelector(".portfolio-review-btn:hover");
    const focused = els.overlay.querySelector(".portfolio-review-btn:focus-visible");
    if (hovered || focused) return wake();
    els.overlay.classList.remove("is-awake");
  }, IDLE_MS);
}

function syncFullscreenButton() {
  if (!els.overlay) return;
  const on = document.fullscreenElement === els.overlay;
  els.fullscreenBtn.textContent = on ? "⤡" : "⤢";
  const label = on ? "Leave full screen" : "Full screen";
  els.fullscreenBtn.title = label;
  els.fullscreenBtn.setAttribute("aria-label", label);
}

function toggleFullscreen() {
  // Both directions are best-effort: a refused request leaves the overlay as
  // it was, which is the thing that works.
  // Focus goes back to the overlay either way: left on the button, the next
  // Space would press it again instead of turning the page.
  els.overlay.focus({ preventScroll: true });
  try {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else els.overlay.requestFullscreen().catch(() => {});
  } catch {
    /* no fullscreen here */
  }
}

// --- images ----------------------------------------------------------------------

function image(src) {
  const img = new Image();
  img.className = "portfolio-review-img";
  img.alt = "";
  img.decoding = "async";
  img.draggable = false;
  img.src = src;
  return img;
}

/** The held record for a page, creating it (and starting its thumbnail) if new. */
function hold(pageId) {
  let entry = held.get(pageId);
  if (!entry) {
    entry = { pageId, thumb: image(thumbUrl(pageId, "large")), original: null, state: "none" };
    held.set(pageId, entry);
  }
  return entry;
}

/** Start the original's load, once. Resolves when it has loaded or failed. */
function loadOriginal(entry) {
  if (entry.original) return entry.loaded;
  const img = image(fileUrl(entry.pageId));
  entry.original = img;
  entry.state = "loading";
  entry.loaded = new Promise((resolve) => {
    img.addEventListener(
      "load",
      () => {
        entry.state = "ready";
        // Decode ahead where the browser will, so the swap doesn't stall on
        // it; not awaited, since a hung decode must never hold up the page.
        img.decode?.().catch(() => {});
        resolve(true);
      },
      { once: true }
    );
    img.addEventListener(
      "error",
      () => {
        entry.state = "failed";
        resolve(false);
      },
      { once: true }
    );
  });
  return entry.loaded;
}

/** Let go of everything outside the current page and the one either side. */
function evict(keep) {
  for (const [pageId, entry] of held) {
    if (keep.has(pageId)) continue;
    for (const img of [entry.thumb, entry.original]) {
      if (!img) continue;
      // Dropping src is what cancels a load in flight and frees a decode.
      img.remove();
      img.removeAttribute("src");
    }
    held.delete(pageId);
  }
}

// --- drawing ----------------------------------------------------------------------

function show(next) {
  index = next;
  const page = pages[index];

  const neighbours = neighbouringPages();
  evict(new Set([page.pageId, ...neighbours.map((p) => p.pageId)].filter(Boolean)));
  // Their thumbnails are cheap and make the next press instant even if the
  // original isn't in yet.
  for (const neighbour of neighbours) hold(neighbour.pageId);

  els.counter.textContent =
    `${page.several ? `Spread ${page.spread} · ` : ""}Page ${page.number} of ${page.total}`;

  // The page itself, at the proportions it prints in, so a contained image is
  // letterboxed on its sheet and a covered one cropped exactly as in the
  // widget and the PDF -- not stretched to whatever the screen happens to be.
  const sheet = el("div", "portfolio-review-page");
  sheet.classList.toggle("is-landscape", page.landscape);
  els.stage.replaceChildren(sheet);
  els.stage.dataset.page = String(page.number);
  els.stage.dataset.spread = String(page.spread);

  if (!page.pageId) {
    sheet.classList.add("is-empty");
    sheet.appendChild(el("span", "portfolio-review-blank", String(page.number)));
    return;
  }

  const entry = hold(page.pageId);
  for (const img of [entry.thumb, entry.original]) if (img) img.style.objectFit = page.fit;
  if (entry.state !== "ready") sheet.appendChild(entry.thumb);

  // Until something has loaded the sheet is a dim placeholder, not white
  // paper: a cold thumbnail would otherwise read as a blank white page, which
  // is exactly the thing a review is looking for.
  if (entry.state !== "ready" && !entry.thumb.complete) {
    sheet.classList.add("is-loading");
    const loaded = () => sheet.classList.remove("is-loading");
    entry.thumb.addEventListener("load", loaded, { once: true });
  }

  // A file that has gone missing reads as a blank that says so, not a broken-image icon.
  entry.thumb.onerror = () => {
    if (pages[index] !== page) return;
    sheet.replaceChildren(el("span", "portfolio-review-blank", String(page.number)));
    sheet.classList.add("is-empty");
  };

  // Already in -- the page was a neighbour a press ago -- goes straight on,
  // with no frame of the thumbnail in between.
  if (entry.state === "ready") {
    swapIn(sheet, entry, page);
    preloadNeighbours();
    return;
  }
  loadOriginal(entry).then((ok) => {
    if (ok && pages[index] === page && sheet.isConnected) swapIn(sheet, entry, page);
    if (pages[index] === page) preloadNeighbours();
  });
}

function swapIn(sheet, entry, page) {
  entry.original.style.objectFit = page.fit;
  sheet.appendChild(entry.original);
  // The thumbnail stays under the original for two frames, then goes: no flash
  // if the original hasn't painted yet, and nothing showing through a PNG's
  // transparency afterwards.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (entry.original?.isConnected) entry.thumb.remove();
    })
  );
}

/** The nearest page with an image on either side of this one, next first. A
 *  blank has no file to fetch, so the walk steps over it: arrowing onto a
 *  blank costs nothing, and the page after it is what needs to be ready. */
function neighbouringPages() {
  const found = [];
  for (const dir of [1, -1]) {
    let i = index + dir;
    while (pages[i] && !pages[i].pageId) i += dir;
    if (pages[i] && pages[i].pageId !== pages[index].pageId) found.push(pages[i]);
  }
  return found;
}

/** After the page on screen has its original: next, then previous. Nothing is
 *  started before then, so what is being looked at is never queued behind
 *  what might be looked at. */
function preloadNeighbours() {
  for (const neighbour of neighbouringPages()) loadOriginal(hold(neighbour.pageId));
}

function go(next) {
  if (next < 0 || next >= pages.length || next === index) return;
  show(next);
}

function step(delta) {
  go(index + delta);
}

// --- entry points -------------------------------------------------------------------

/** Open the review over `overview` (the portfolio overview the caller already
 *  has). `start` is `{ nodeId, index }` -- a spread and a slot in it -- to begin
 *  at that page; left out, it begins at the first. Does nothing if there are no
 *  pages at all. */
export function openReview(overview, { start } = {}) {
  const walk = reviewPages(overview);
  if (!walk.length) return;
  ensureInit();

  pages = walk;
  const found = start ? pages.findIndex((p) => p.nodeId === start.nodeId && p.index === start.index) : -1;

  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  els.overlay.hidden = false;
  els.overlay.focus({ preventScroll: true });
  syncFullscreenButton();
  show(found === -1 ? 0 : found);
  wake();
}

export function close() {
  if (!els.overlay || els.overlay.hidden) return;
  if (document.fullscreenElement === els.overlay) document.exitFullscreen?.().catch(() => {});
  clearTimeout(idleTimer);
  els.overlay.classList.remove("is-awake");
  els.overlay.hidden = true;
  els.stage.replaceChildren();
  evict(new Set()); // nothing is held while nothing is open
  pages = [];
  index = -1;
  const back = opener;
  opener = null;
  // Back to exactly where it was opened from, if that is still on the page.
  if (back?.isConnected) back.focus({ preventScroll: true });
}

export function isOpen() {
  return Boolean(els.overlay) && !els.overlay.hidden;
}
