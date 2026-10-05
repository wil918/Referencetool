/* A portfolio spread: one canvas node that owns its pages.
 *
 * The spread is the thing on the canvas; the pages are its contents. That is
 * why they are not nodes of their own: a page can't be dragged loose, can't
 * take a connection, and has no position except the one the spread's layout
 * gives it -- so moving or resizing the spread carries every page with it, and
 * nothing about a page has to be kept in step with anything else. What a page
 * *can* do happens inside the spread: take an image, change how the image
 * fits, and move to another place in the order.
 *
 * The config (db.py's canvas_nodes comment) is the document: layout,
 * orientation, cover and gap, plus an ordered list of pages, each
 * { page_id, fit, crop? }. A page with no page_id is an empty slot -- a
 * portfolio in progress is mostly empty slots, and that is the normal state,
 * drawn as a slot waiting to be filled, not as an error.
 *
 * A page_id points into the project's staging store (portfolio.py), not the
 * archive. An upload is a plain request that stores the file and answers with
 * the page -- no tagging, no embedding, nothing to wait on afterwards -- and
 * the file itself is shown on the page while it travels. Replacing a page's
 * image leaves the old page in the store as an earlier version; the store is
 * where drafts belong, and the archive never sees them unless a page is
 * promoted on purpose (the Portfolio widget's management view does that).
 */

import {
  describePlan,
  exportPdf as runExport,
  exportPlan,
  pageRegistry,
  stagePage,
  thumbUrl,
} from "../portfolio.js";
import { IMAGE_EXTS, extOf } from "./file-types.js";
import {
  LAYOUTS,
  MAX_PAGE_COUNT,
  MIN_PRINT_DPI,
  ORIENTATIONS,
  emptyPage,
  isA4,
  layoutSpread,
  pageAt,
  printDpi,
} from "./spread-layout.js";

// Same threshold nodes.js uses to tell a click from a drag.
const DRAG_THRESHOLD = 3;

// What the picker offers. Explicit rather than image/*, which would let a
// HEIC through on a Mac -- ingest can't read one, and the page would fail a
// few seconds later instead of now.
const ACCEPT = [...IMAGE_EXTS].join(",");

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const stem = (filename) => filename.replace(/\.[^.]+$/, "");

/* options:
 *   entry     -- nodes.js's entry for this node ({ node, el, ... }); the node's
 *                w/h are read live, so a resize only has to call notifyResize
 *   body      -- the node's body element, which this fills
 *   viewport  -- for converting the pointer to world coordinates
 *   store     -- every write goes through store.patchNode, like any node
 *   onStatus(message) -- something worth saying out loud
 *   onChange()        -- the config or the active page changed; the floating
 *                        panel re-reads whatever it shows
 *   onEdit(before)    -- a deliberate edit to the document is about to
 *                        happen; `before` is the config as it was, for the
 *                        canvas's undo stack to hand back to restoreConfig
 */
export function createSpread({
  entry,
  body,
  viewport,
  store,
  onStatus = () => {},
  onChange = () => {},
  onEdit = () => {},
}) {
  normaliseConfig();

  const config = () => entry.node.config;
  // What the store knows about each page -- chiefly its true pixel size, which
  // is what a print check has to be made from. The <img> on the page is a
  // 400px thumbnail and can't say.
  const projectId = store.projectId || entry.node.project_id;
  const registry = pageRegistry(projectId);

  let layout = null;
  let activeIndex = null;
  let cropping = false;
  let gesture = null;
  // Set when a drag ends, so the click the browser fires after it doesn't
  // also count as a click on a page.
  let swallowClick = false;
  let destroyed = false;

  // Page entry -> its element. Keyed by the entry object rather than by
  // index, so a reorder moves the elements it already has instead of building
  // new ones and making every image load again.
  const elements = new Map();
  // Client-only state, keyed the same way and never persisted: the image an
  // upload is showing while it travels, and what a replaced page held before,
  // so a failed replacement can put it back.
  const previews = new WeakMap();
  const replaced = new WeakMap();

  body.classList.add("spread-body");

  // In cover mode with the crop being adjusted: the whole image, faint, so
  // the part the page is cutting off can be seen while choosing it.
  const cropGhost = document.createElement("img");
  cropGhost.className = "spread-crop-ghost";
  cropGhost.alt = "";
  cropGhost.draggable = false;
  cropGhost.hidden = true;
  body.appendChild(cropGhost);

  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ACCEPT;
  picker.multiple = true;
  picker.hidden = true;
  body.appendChild(picker);
  let pickerTarget = null;
  picker.addEventListener("change", () => {
    const files = [...picker.files];
    picker.value = "";
    if (files.length && pickerTarget !== null) uploadFiles(pickerTarget, files);
  });

  // --- config --------------------------------------------------------------

  function normaliseConfig() {
    const c = entry.node.config && typeof entry.node.config === "object" ? entry.node.config : {};
    if (!LAYOUTS.includes(c.layout)) c.layout = "sequential";
    if (!ORIENTATIONS.includes(c.orientation)) c.orientation = "portrait";
    if (typeof c.cover !== "boolean") c.cover = true;
    if (!Array.isArray(c.pages)) c.pages = [];
    c.pages = c.pages.map((page) => (page && typeof page === "object" ? page : emptyPage()));
    if (!c.pages.length) c.pages.push(emptyPage());
    entry.node.config = c;
  }

  function persist() {
    store.patchNode(entry.node.id, { config: entry.node.config });
    onChange();
  }

  /* Hand the canvas's undo stack the document as it is, just before an edit
   * that changes it -- a reorder, a removed page, a new layout. Uploads are
   * the one kind of change that isn't recorded: they land seconds later, on
   * their own, and undoing one would mean undoing the ingest too. */
  function record() {
    onEdit(JSON.parse(JSON.stringify(entry.node.config)));
  }

  // Pending is an upload still in flight: it has its file on screen and no
  // page_id yet. Brief, now that nothing is ingested afterwards.
  const isPending = (page) => !page.page_id && previews.has(page);
  const isEmpty = (page) => !page.page_id && !previews.has(page);

  // --- drawing -------------------------------------------------------------

  function buildPage() {
    const el = document.createElement("div");
    el.className = "spread-page";

    const img = document.createElement("img");
    img.className = "spread-page-img";
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    img.hidden = true;
    img.addEventListener("load", () => onImageLoad(el, img));
    img.addEventListener("error", () => {
      // A page whose file is gone (deleted from the staged pages in another
      // tab, say) is drawn as the empty slot it effectively is.
      if (!img.getAttribute("src")) return;
      img.hidden = true;
      el.classList.add("is-missing");
    });

    const number = document.createElement("span");
    number.className = "spread-page-number";

    const flags = document.createElement("span");
    flags.className = "spread-page-flags";

    el.append(img, number, flags);
    return el;
  }

  /* Build what's missing, drop what's gone, and put every page where the
   * layout says. Cheap enough to call after any change to the page list --
   * existing pages keep their elements, and so their loaded images. */
  function render() {
    const pages = config().pages;
    const live = new Set(pages);
    for (const [page, el] of elements) {
      if (!live.has(page)) {
        el.remove();
        elements.delete(page);
      }
    }
    pages.forEach((page, index) => {
      let el = elements.get(page);
      if (!el) {
        el = buildPage();
        elements.set(page, el);
        body.insertBefore(el, picker);
      }
      updatePage(page, index);
    });
    relayout();
  }

  function updatePage(page, index) {
    const el = elements.get(page);
    if (!el) return;
    const img = el.querySelector(".spread-page-img");
    el.dataset.index = String(index);
    el.querySelector(".spread-page-number").textContent = String(index + 1);

    // The server's copy once there is one; the file itself until then.
    const src = page.page_id ? thumbUrl(page.page_id) : previews.get(page) || null;
    if (src) {
      if (img.getAttribute("src") !== src) {
        el.classList.remove("is-missing");
        img.src = src;
      }
      img.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
      el.classList.remove("is-missing");
    }

    const cover = page.fit === "cover";
    img.style.objectFit = cover ? "cover" : "contain";
    const crop = page.crop || {};
    img.style.objectPosition = cover
      ? `${clamp(crop.x ?? 0.5, 0, 1) * 100}% ${clamp(crop.y ?? 0.5, 0, 1) * 100}%`
      : "50% 50%";

    el.classList.toggle("is-empty", isEmpty(page));
    el.classList.toggle("is-pending", isPending(page));
    el.classList.toggle("is-filled", Boolean(src));
    el.classList.toggle("is-active", index === activeIndex);
    el.classList.toggle("is-cropping", cropping && index === activeIndex);
    el.title = isEmpty(page)
      ? `Page ${index + 1} — click to add an image`
      : isPending(page)
        ? `Page ${index + 1} — uploading`
        : `Page ${index + 1}`;
    updateFlags(page, el);
  }

  /** A page's real size in pixels. A staged page's comes from its record in
   *  the store; an upload still travelling has only its own file on screen,
   *  which is the full-size original, so that image can say. */
  function pixelSize(page) {
    if (page.page_id) {
      const record = registry.get(page.page_id);
      return record ? { w: record.width, h: record.height } : null;
    }
    const img = elements.get(page)?.querySelector(".spread-page-img");
    return img && !img.hidden && img.complete && img.naturalWidth
      ? { w: img.naturalWidth, h: img.naturalHeight }
      : null;
  }

  /** What the page would say about itself at print: whether the image is A4
   *  (and if not, what the fit is doing about it), and its resolution. */
  function issuesFor(page, px) {
    if (!px) return [];
    const orientation = config().orientation;
    const fit = page.fit === "cover" ? "cover" : "contain";
    const issues = [];
    if (!isA4(px.w, px.h, orientation)) {
      issues.push({
        key: "fit",
        label: fit === "cover" ? "Cropped" : "Letterboxed",
        detail:
          fit === "cover"
            ? "Not A4 proportioned — cropped to fill the page."
            : "Not A4 proportioned — letterboxed so nothing is lost. Cover fills the page and crops instead.",
      });
    }
    const dpi = printDpi(px.w, px.h, orientation, fit);
    if (dpi < MIN_PRINT_DPI) {
      issues.push({
        key: "dpi",
        label: `${Math.round(dpi)} dpi`,
        detail: `${px.w}×${px.h} px prints at about ${Math.round(dpi)} dpi on A4 — soft on paper. Aim for at least ${MIN_PRINT_DPI}.`,
        // The panel already shows the size and the dpi beside this.
        short: `Soft on paper — aim for at least ${MIN_PRINT_DPI}.`,
      });
    }
    return issues;
  }

  function updateFlags(page, el) {
    const flags = el.querySelector(".spread-page-flags");
    const issues = issuesFor(page, pixelSize(page));
    flags.replaceChildren(
      ...issues.map((issue) => {
        const flag = document.createElement("span");
        flag.className = `spread-page-flag spread-page-flag-${issue.key}`;
        flag.textContent = issue.label;
        flag.title = issue.detail;
        return flag;
      })
    );
    el.classList.toggle("has-issues", issues.length > 0);
  }

  function onImageLoad(el, img) {
    const page = pageOf(el);
    if (!page) return;
    // The server's copy has arrived: the local preview it replaced can go.
    if (page.page_id && previews.has(page) && !img.src.startsWith("blob:")) {
      URL.revokeObjectURL(previews.get(page));
      previews.delete(page);
    }
    updateFlags(page, el);
    if (Number(el.dataset.index) === activeIndex) {
      positionCropGhost();
      onChange();
    }
  }

  function pageOf(el) {
    for (const [page, pageEl] of elements) if (pageEl === el) return page;
    return null;
  }

  /* Position every page from the layout. The only thing a resize has to do --
   * and the page size is a custom property, so everything drawn inside a
   * page (its number, its flags) scales with it from CSS. */
  function relayout() {
    const c = config();
    layout = layoutSpread({
      width: entry.node.w,
      height: entry.node.h,
      count: c.pages.length,
      orientation: c.orientation,
      layout: c.layout,
      cover: c.cover,
      gap: c.gap,
    });
    body.style.setProperty("--spread-page-w", `${layout.pageW}px`);
    c.pages.forEach((page, index) => {
      const el = elements.get(page);
      const slot = layout.pages[index];
      if (!el || !slot) return;
      el.style.transform = `translate(${slot.x}px, ${slot.y}px)`;
      el.style.width = `${slot.w}px`;
      el.style.height = `${slot.h}px`;
      el.classList.toggle("is-left", slot.side === "left");
      el.classList.toggle("is-right", slot.side === "right");
    });
    positionCropGhost();
  }

  // --- the active page and its crop ------------------------------------------

  function setActive(index) {
    const next = index === null || index === undefined ? null : clamp(index, 0, config().pages.length - 1);
    if (next === activeIndex) return;
    activeIndex = next;
    cropping = false;
    config().pages.forEach((page, i) => updatePage(page, i));
    positionCropGhost();
    onChange();
  }

  function activePageEntry() {
    return activeIndex === null ? null : config().pages[activeIndex] || null;
  }

  function positionCropGhost() {
    const page = activePageEntry();
    const el = page && elements.get(page);
    const px = page && pixelSize(page);
    const slot = layout?.pages[activeIndex];
    if (!cropping || !page || page.fit !== "cover" || !px || !slot) {
      cropGhost.hidden = true;
      return;
    }
    const scale = Math.max(slot.w / px.w, slot.h / px.h);
    const w = px.w * scale;
    const h = px.h * scale;
    const crop = page.crop || {};
    // object-position's own arithmetic: the offset is the free space times
    // the percentage, and in cover the free space is negative.
    const x = slot.x + (slot.w - w) * clamp(crop.x ?? 0.5, 0, 1);
    const y = slot.y + (slot.h - h) * clamp(crop.y ?? 0.5, 0, 1);
    if (cropGhost.getAttribute("src") !== el.querySelector(".spread-page-img").getAttribute("src")) {
      cropGhost.src = el.querySelector(".spread-page-img").getAttribute("src");
    }
    cropGhost.style.transform = `translate(${x}px, ${y}px)`;
    cropGhost.style.width = `${w}px`;
    cropGhost.style.height = `${h}px`;
    cropGhost.hidden = false;
  }

  // --- gestures --------------------------------------------------------------
  //
  // A press on a page is the page's, not the node's: nodes.js's
  // pressStartsDrag leaves it alone, so the spread only moves by its grip or
  // by the space between its pages. Here a press either becomes a click
  // (the click listener below) or, past the threshold, a reorder -- or, while
  // the active page's crop is being adjusted, a pan of the image inside it.

  function toLocal(event) {
    const world = viewport.screenToWorld(event.clientX, event.clientY);
    return { x: world.x - entry.node.x, y: world.y - entry.node.y };
  }

  function onPointerDown(event) {
    if (!event.isPrimary || event.button !== 0 || event.shiftKey || gesture) return;
    const el = event.target instanceof Element ? event.target.closest(".spread-page") : null;
    if (!el || !body.contains(el)) return;
    swallowClick = false;
    const index = Number(el.dataset.index);
    const page = config().pages[index];
    const local = toLocal(event);

    if (cropping && index === activeIndex && page?.fit === "cover") {
      beginCrop(event, page, el, local);
      return;
    }

    const slot = layout.pages[index];
    gesture = {
      kind: "reorder",
      pointerId: event.pointerId,
      index,
      el,
      startX: event.clientX,
      startY: event.clientY,
      grab: { x: local.x - slot.x, y: local.y - slot.y },
      active: false,
      ghost: null,
      target: null,
    };
    listen();
  }

  function beginCrop(event, page, el, local) {
    const px = pixelSize(page);
    const slot = layout.pages[activeIndex];
    if (!px || !slot) return;
    const scale = Math.max(slot.w / px.w, slot.h / px.h);
    gesture = {
      kind: "crop",
      pointerId: event.pointerId,
      page,
      el,
      start: local,
      from: { x: page.crop?.x ?? 0.5, y: page.crop?.y ?? 0.5 },
      // How far the image overhangs the page on each axis. In cover only one
      // of these is ever more than a rounding error -- that's the axis the
      // crop actually moves along.
      overX: px.w * scale - slot.w,
      overY: px.h * scale - slot.h,
      startX: event.clientX,
      startY: event.clientY,
      active: true,
      recorded: false,
    };
    swallowClick = true;
    listen();
  }

  function listen() {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  }

  function unlisten() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
  }

  function onPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!gesture.active) {
      const moved =
        Math.abs(event.clientX - gesture.startX) >= DRAG_THRESHOLD ||
        Math.abs(event.clientY - gesture.startY) >= DRAG_THRESHOLD;
      if (!moved) return;
      gesture.active = true;
      liftPage();
    }
    const local = toLocal(event);
    if (gesture.kind === "crop") trackCrop(local);
    else trackReorder(local);
  }

  function liftPage() {
    const ghost = gesture.el.cloneNode(true);
    ghost.classList.remove("is-active", "is-drop-target");
    ghost.classList.add("spread-page-ghost");
    body.appendChild(ghost);
    gesture.ghost = ghost;
    gesture.el.classList.add("is-lifted");
  }

  function trackReorder(local) {
    const { ghost, grab } = gesture;
    ghost.style.transform = `translate(${local.x - grab.x}px, ${local.y - grab.y}px)`;
    const target = pageAt(layout, local.x, local.y);
    if (target === gesture.target) return;
    const pages = config().pages;
    if (gesture.target !== null) elements.get(pages[gesture.target])?.classList.remove("is-drop-target");
    gesture.target = target;
    if (target !== null && target !== gesture.index) {
      elements.get(pages[target])?.classList.add("is-drop-target");
    }
  }

  function trackCrop(local) {
    if (!gesture.recorded) {
      record();
      gesture.recorded = true;
    }
    const { page, from, overX, overY, start } = gesture;
    const crop = { ...from };
    // Dragging right moves the image right, which shows more of its left --
    // a smaller object-position percentage.
    if (overX > 0.5) crop.x = clamp(from.x - (local.x - start.x) / overX, 0, 1);
    if (overY > 0.5) crop.y = clamp(from.y - (local.y - start.y) / overY, 0, 1);
    page.crop = crop;
    updatePage(page, activeIndex);
    positionCropGhost();
  }

  function onPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const done = gesture;
    endGesture();
    if (!done.active) return;
    swallowClick = true;
    if (done.kind === "crop") {
      persist();
    } else if (done.target !== null && done.target !== done.index) {
      movePage(done.index, done.target);
    }
  }

  function onPointerCancel(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    endGesture();
  }

  function endGesture() {
    unlisten();
    if (gesture?.kind === "reorder") {
      gesture.ghost?.remove();
      gesture.el.classList.remove("is-lifted");
      if (gesture.target !== null) {
        elements.get(config().pages[gesture.target])?.classList.remove("is-drop-target");
      }
    }
    gesture = null;
  }

  // Clicks are handled here rather than at pointerup: opening the file
  // picker needs the user activation a real click carries.
  function onClick(event) {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    const el = event.target instanceof Element ? event.target.closest(".spread-page") : null;
    if (!el || !body.contains(el)) return;
    const index = Number(el.dataset.index);
    setActive(index);
    if (isEmpty(config().pages[index])) openPicker(index);
  }

  body.addEventListener("pointerdown", onPointerDown);
  body.addEventListener("click", onClick);

  // --- structure -------------------------------------------------------------

  /* Reorder: the page takes the place it was dropped on and everything in
   * between moves along one, the way any list reorders. The page keeps its
   * image, fit and crop -- only its number changes, and the numbers of the
   * pages it passed. */
  function movePage(from, to) {
    record();
    const pages = config().pages;
    const [page] = pages.splice(from, 1);
    pages.splice(to, 0, page);
    activeIndex = to;
    cropping = false;
    render();
    persist();
  }

  function setCount(count) {
    const pages = config().pages;
    const next = clamp(Math.round(Number(count) || 1), 1, MAX_PAGE_COUNT);
    if (next === pages.length) return;
    if (next > pages.length) {
      record();
      while (pages.length < next) pages.push(emptyPage());
    } else {
      const dropped = pages.slice(next).filter((page) => !isEmpty(page)).length;
      if (dropped) {
        const which = next + 1 === pages.length ? `page ${pages.length}` : `pages ${next + 1}–${pages.length}`;
        const images = dropped === 1 ? "an image" : `${dropped} images`;
        // The images stay in the staged pages; it's their place in this
        // document that would go.
        if (!window.confirm(`Removing ${which} takes ${images} off this spread (they stay in the staged pages). Remove them?`)) {
          onChange();
          return;
        }
      }
      record();
      for (const page of pages.slice(next)) releasePreview(page);
      pages.length = next;
      if (activeIndex !== null && activeIndex >= next) activeIndex = null;
    }
    render();
    persist();
  }

  function setOption(key, value) {
    if (config()[key] === value) return;
    // Not spacing: a slider sets it dozens of times a second, and sliding
    // back is its undo.
    if (key !== "gap") record();
    config()[key] = value;
    // Orientation changes what counts as A4, so every page's flags go too.
    config().pages.forEach((page, i) => updatePage(page, i));
    relayout();
    persist();
  }

  function setFit(fit) {
    const page = activePageEntry();
    if (!page || page.fit === fit) return;
    record();
    page.fit = fit === "cover" ? "cover" : "contain";
    if (page.fit === "contain") {
      delete page.crop;
      cropping = false;
    }
    updatePage(page, activeIndex);
    positionCropGhost();
    persist();
  }

  function setCropping(on) {
    const page = activePageEntry();
    const next = Boolean(on) && page?.fit === "cover";
    if (next === cropping) return;
    cropping = next;
    if (page) updatePage(page, activeIndex);
    positionCropGhost();
    onChange();
  }

  /** Take the image off the active page, keeping the page -- the pagination
   *  is the document, so an emptied page stays where it was. */
  function clearActive() {
    const page = activePageEntry();
    if (!page || isEmpty(page)) return;
    record();
    const index = activeIndex;
    releasePreview(page);
    config().pages[index] = emptyPage();
    cropping = false;
    render();
    persist();
  }

  /** Remove the active page itself; every page after it moves up one. */
  function deleteActive() {
    if (activeIndex === null) return;
    const pages = config().pages;
    if (pages.length === 1) {
      clearActive();
      return;
    }
    record();
    const [page] = pages.splice(activeIndex, 1);
    releasePreview(page);
    activeIndex = null;
    cropping = false;
    render();
    persist();
  }

  function releasePreview(page) {
    if (previews.has(page)) URL.revokeObjectURL(previews.get(page));
    previews.delete(page);
  }

  function openPicker(index) {
    pickerTarget = index;
    picker.click();
  }

  // --- uploads -----------------------------------------------------------------

  /* Put `files` onto the spread starting at page `startIndex`. The first
   * file goes exactly where it was aimed -- replacing that page's image if it
   * had one, since aiming at it was the point -- and the rest fill the empty
   * pages after it in filename order, which is the order an export from
   * InDesign or Illustrator already numbers them in. Nothing is ever
   * overwritten by the overflow, and the spread never grows by itself:
   * whatever doesn't fit is reported rather than placed. */
  async function uploadFiles(startIndex, files) {
    const images = files.filter((file) => IMAGE_EXTS.has(extOf(file.name)));
    const refused = files.length - images.length;
    if (!images.length) {
      onStatus("Pages take JPEG, PNG, GIF, WebP or BMP images.");
      return;
    }
    images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    const pages = config().pages;
    const targets = [startIndex];
    for (let i = startIndex + 1; i < pages.length && targets.length < images.length; i++) {
      if (isEmpty(pages[i])) targets.push(i);
    }
    const placed = images.slice(0, targets.length);
    const leftOver = images.length - placed.length;

    setActive(startIndex);
    onStatus(placed.length === 1 ? `Adding page ${startIndex + 1}…` : `Adding ${placed.length} pages…`);
    const results = await Promise.all(placed.map((file, k) => uploadInto(targets[k], file)));
    if (destroyed) return;

    const notes = [];
    const low = results.filter((r) => r?.print?.low_resolution).map((r) => r.number);
    const odd = results.filter((r) => r?.print && !r.print.a4_proportioned).map((r) => r.number);
    const failed = results.filter((r) => !r).length;
    if (low.length) {
      notes.push(
        low.length === 1 && results.length === 1
          ? results[0].print.warnings[0]
          : `${listPages(low)} will print below ${MIN_PRINT_DPI} dpi — soft on paper.`
      );
    }
    if (odd.length) {
      notes.push(
        odd.length === 1 && results.length === 1
          ? results[0].print.warnings[results[0].print.warnings.length - 1]
          : `${listPages(odd)} ${odd.length === 1 ? "isn't" : "aren't"} A4 proportioned — letterboxed, nothing cropped.`
      );
    }
    if (leftOver) {
      notes.push(
        `${leftOver} ${leftOver === 1 ? "image didn't" : "images didn't"} fit — no empty pages left after page ${startIndex + 1}. Add pages and drop ${leftOver === 1 ? "it" : "them"} again.`
      );
    }
    if (refused) notes.push(`${refused} ${refused === 1 ? "file wasn't an image" : "files weren't images"} and ${refused === 1 ? "was" : "were"} skipped.`);
    // A failure has already said so itself.
    if (notes.length || !failed) onStatus(notes.join(" "));
  }

  function listPages(numbers) {
    if (numbers.length === 1) return `Page ${numbers[0]}`;
    return `Pages ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
  }

  /** One file onto one page. Resolves to { number, print } once the store has
   *  accepted it, or null if it couldn't be uploaded at all. */
  async function uploadInto(index, file) {
    const pages = config().pages;
    const previous = pages[index];
    const page = { page_id: null, fit: previous?.fit === "cover" ? "cover" : "contain" };
    if (page.fit === "cover" && previous?.crop) page.crop = { ...previous.crop };
    previews.set(page, URL.createObjectURL(file));
    if (previous && !isEmpty(previous)) replaced.set(page, previous);
    pages[index] = page;
    releasePreview(previous);
    render();

    let staged;
    try {
      staged = await stagePage(projectId, file, { orientation: config().orientation, fit: page.fit });
    } catch (err) {
      const number = restore(page);
      onStatus(`Couldn't add "${file.name}"${number ? ` to page ${number}` : ""} — ${err.message}.`);
      return null;
    }
    const number = config().pages.indexOf(page) + 1;
    // The page was moved off the spread while it travelled: the upload is
    // staged and unplaced, which is where a page nobody has a slot for belongs.
    if (destroyed || !number) return { number, print: staged.print };
    registry.put(staged);
    page.page_id = staged.id;
    // Switches the image from the file on screen to the server's copy; the
    // preview is let go once that has loaded (onImageLoad).
    updatePage(page, number - 1);
    persist();
    return { number, print: staged.print };
  }

  /** Put back whatever an upload replaced (or an empty slot), wherever the
   *  page has moved to since. Returns its page number, or 0 if it's gone. */
  function restore(page) {
    const pages = config().pages;
    const index = pages.indexOf(page);
    releasePreview(page);
    if (index === -1) return 0;
    pages[index] = replaced.get(page) || emptyPage();
    render();
    persist();
    return index + 1;
  }

  // --- export ------------------------------------------------------------------

  async function exportSpread() {
    const pending = config().pages.filter(isPending).length;
    if (
      pending &&
      !window.confirm(
        `${pending === 1 ? "One page is" : `${pending} pages are`} still uploading and will export blank. Export anyway?`
      )
    ) {
      return;
    }
    // The server exports what it has, so it had better have the order that's
    // on screen: anything still in the debounce queue goes out first.
    await store.flush();

    // What the export will do to each page, asked before it starts so the
    // warning lands with the download rather than after the file is in the
    // wrong hands. Only a courtesy: the export doesn't depend on it.
    let notes = [];
    try {
      notes = describePlan(await exportPlan(entry.node.id));
    } catch {
      /* the export itself will say if something's wrong */
    }
    onStatus("Exporting…");
    const state = await runExport(entry.node.id);
    if (destroyed) return;
    const outcome = {
      done: "Exported.",
      cancelled: "The export was cancelled.",
      failed: "The export failed.",
      timeout: "The export is taking a while — it will land in your downloads.",
    }[state];
    onStatus([outcome, ...(state === "done" ? notes : [])].join(" "));
  }

  // --- boot --------------------------------------------------------------------

  render();
  // The pages' real sizes arrive a moment after the pages draw; the print
  // flags follow them. Best effort -- a spread with no flags is still a spread.
  registry
    .load()
    .then(() => {
      if (destroyed) return;
      config().pages.forEach((page, i) => updatePage(page, i));
      positionCropGhost();
      onChange();
    })
    .catch(() => {});

  return {
    /** nodes.js calls this on mount and on every frame of a resize. */
    notifyResize() {
      relayout();
    },

    config,
    activeIndex: () => activeIndex,
    isCropping: () => cropping,
    pageCount: () => config().pages.length,

    /** Everything the panel says about the active page, or null. */
    activePage() {
      const page = activePageEntry();
      if (!page) return null;
      const px = pixelSize(page);
      return {
        index: activeIndex,
        page,
        empty: isEmpty(page),
        pending: isPending(page),
        px,
        issues: issuesFor(page, px),
        dpi: px ? printDpi(px.w, px.h, config().orientation, page.fit) : null,
        a4: px ? isA4(px.w, px.h, config().orientation) : null,
      };
    },

    setActive,
    setLayout: (value) => setOption("layout", value),
    setCover: (value) => setOption("cover", Boolean(value)),
    setOrientation: (value) => setOption("orientation", value),
    setGap: (value) => setOption("gap", Number(value)),
    setCount,
    setFit,
    setCropping,
    clearActive,
    deleteActive,
    replaceActive() {
      if (activeIndex !== null) openPicker(activeIndex);
    },
    exportPdf: exportSpread,

    /** A file dropped from Finder onto one of this spread's pages. */
    dropFiles(pageEl, files) {
      if (!pageEl || !body.contains(pageEl)) return false;
      uploadFiles(Number(pageEl.dataset.index), files);
      return true;
    },

    /** Escape backs out one level at a time -- crop, then the active page --
     *  before nodes.js gets to clear the selection. True if it used the key. */
    handleEscape() {
      if (cropping) {
        setCropping(false);
        return true;
      }
      if (activeIndex !== null) {
        setActive(null);
        return true;
      }
      return false;
    },

    /* Delete with a page active means that page's image, never the whole
     * spread: thirty pages of layout are one keypress from gone otherwise.
     * An active empty page swallows the key for the same reason. */
    handleDelete() {
      if (activeIndex === null) return false;
      clearActive();
      return true;
    },

    /** Undo: put the document back as record() captured it. */
    restoreConfig(before) {
      entry.node.config = before;
      normaliseConfig();
      activeIndex = null;
      cropping = false;
      render();
      persist();
    },

    /** The spread stopped being the selection: nothing inside it stays active. */
    deselect() {
      setActive(null);
    },

    destroy() {
      destroyed = true;
      endGesture();
      body.removeEventListener("pointerdown", onPointerDown);
      body.removeEventListener("click", onClick);
      for (const page of config().pages) releasePreview(page);
      body.replaceChildren();
    },
  };
}
