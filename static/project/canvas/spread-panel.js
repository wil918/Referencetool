/* The floating editor a selected spread opens.
 *
 * One instance per canvas, shown and hidden rather than rebuilt -- the same
 * arrangement as edge-style-panel.js and shape-style-panel.js, and the same
 * raised-pill classes, so the three read as one family. nodes.js decides when
 * it is open (exactly one spread selected) and where (just above the spread,
 * via viewport.worldToScreen); this module only renders what the spread
 * handle (spread.js) reports and calls back into it.
 *
 * Two halves: the spread's own settings -- layout, cover, orientation, page
 * count, spacing, export -- always, and the active page's -- fit, crop,
 * replace, clear, delete, and what the page will look like in print -- when a
 * page has been clicked.
 */

import { MAX_GAP, MAX_PAGE_COUNT, MIN_GAP } from "./spread-layout.js";

function button(label, className = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `spread-panel-btn ${className}`.trim();
  btn.textContent = label;
  return btn;
}

/** A row of mutually exclusive options; `set(value)` lights one of them. */
function segmented(options, onPick) {
  const group = document.createElement("div");
  group.className = "spread-panel-seg";
  const buttons = new Map();
  for (const [value, label] of options) {
    const btn = button(label);
    btn.addEventListener("click", () => onPick(value));
    buttons.set(value, btn);
    group.appendChild(btn);
  }
  return {
    el: group,
    set(value) {
      for (const [v, btn] of buttons) {
        btn.classList.toggle("is-active", v === value);
        btn.setAttribute("aria-pressed", String(v === value));
      }
    },
  };
}

function labelled(text, control) {
  const wrap = document.createElement("label");
  wrap.className = "spread-panel-field";
  const span = document.createElement("span");
  span.className = "spread-panel-label";
  span.textContent = text;
  wrap.append(span, control);
  return wrap;
}

export function createSpreadPanel({ container }) {
  const el = document.createElement("div");
  el.className = "edge-style-panel spread-panel";
  el.hidden = true;
  // A press inside the panel is the panel's -- it must not reach the canvas
  // behind it and start a pan or clear the selection it's editing.
  el.addEventListener("pointerdown", (event) => event.stopPropagation());

  let spread = null;
  const call = (fn) => (...args) => spread && fn(spread, ...args);

  // --- the spread ----------------------------------------------------------

  const spreadRow = document.createElement("div");
  spreadRow.className = "spread-panel-row";

  const layout = segmented(
    [["sequential", "Sequential"], ["booklet", "Booklet"]],
    call((s, v) => s.setLayout(v))
  );

  const coverBox = document.createElement("input");
  coverBox.type = "checkbox";
  coverBox.addEventListener("change", call((s) => s.setCover(coverBox.checked)));
  const cover = labelled("Cover", coverBox);
  cover.classList.add("spread-panel-cover");
  cover.title = "Page 1 stands alone as a cover, and every pair after it starts one page later";

  const orientation = segmented(
    [["portrait", "Portrait"], ["landscape", "Landscape"]],
    call((s, v) => s.setOrientation(v))
  );

  const countInput = document.createElement("input");
  countInput.type = "number";
  countInput.min = "1";
  countInput.max = String(MAX_PAGE_COUNT);
  countInput.className = "spread-panel-count";
  // On change, not on input: typing "3" on the way to "30" must not trim the
  // spread to three pages in between.
  countInput.addEventListener("change", call((s) => s.setCount(countInput.value)));
  const count = labelled("Pages", countInput);

  const gapInput = document.createElement("input");
  gapInput.type = "range";
  gapInput.min = String(MIN_GAP);
  gapInput.max = String(MAX_GAP);
  gapInput.step = "0.01";
  gapInput.className = "spread-panel-gap";
  gapInput.addEventListener("input", call((s) => s.setGap(gapInput.value)));
  const gap = labelled("Spacing", gapInput);

  const exportBtn = button("Export PDF", "spread-panel-export");
  exportBtn.title = "Download the spread as A4 pages, in order, blanks included";
  exportBtn.addEventListener("click", call((s) => s.exportPdf()));

  spreadRow.append(layout.el, cover, orientation.el, count, gap, exportBtn);

  // --- the active page -------------------------------------------------------

  const pageRow = document.createElement("div");
  pageRow.className = "spread-panel-row spread-panel-page";

  const pageLabel = document.createElement("span");
  pageLabel.className = "spread-panel-page-label";

  const fit = segmented(
    [["contain", "Contain"], ["cover", "Cover"]],
    call((s, v) => s.setFit(v))
  );
  fit.el.title = "Contain shows the whole image; Cover fills the page and crops the overflow";

  const cropBtn = button("Adjust crop");
  cropBtn.title = "Drag the page to choose what the crop keeps";
  cropBtn.addEventListener("click", call((s) => s.setCropping(!s.isCropping())));

  const replaceBtn = button("Replace…");
  replaceBtn.addEventListener("click", call((s) => s.replaceActive()));

  const clearBtn = button("Remove image");
  clearBtn.title = "Empty this page, keeping it in place (the image stays in the archive)";
  clearBtn.addEventListener("click", call((s) => s.clearActive()));

  const deleteBtn = button("Delete page", "spread-panel-danger");
  deleteBtn.title = "Remove this page; the pages after it move up one";
  deleteBtn.addEventListener("click", call((s) => s.deleteActive()));

  const note = document.createElement("p");
  note.className = "spread-panel-note";

  pageRow.append(pageLabel, fit.el, cropBtn, replaceBtn, clearBtn, deleteBtn, note);

  el.append(spreadRow, pageRow);
  container.appendChild(el);

  // --- rendering ---------------------------------------------------------------

  function render() {
    if (!spread) return;
    const c = spread.config();
    layout.set(c.layout);
    coverBox.checked = c.cover;
    // Cover only means something when pages pair up; dimmed rather than
    // hidden so the row doesn't jump as the layout is switched.
    cover.classList.toggle("is-disabled", c.layout !== "booklet");
    coverBox.disabled = c.layout !== "booklet";
    orientation.set(c.orientation);
    if (document.activeElement !== countInput) countInput.value = String(c.pages.length);
    if (document.activeElement !== gapInput) gapInput.value = String(c.gap ?? 0.12);

    const active = spread.activePage();
    pageRow.hidden = !active;
    if (!active) return;

    pageLabel.textContent = `Page ${active.index + 1} of ${c.pages.length}`;
    const hasImage = !active.empty;
    fit.set(active.page.fit === "cover" ? "cover" : "contain");
    fit.el.classList.toggle("is-disabled", !hasImage);
    const canCrop = hasImage && active.page.fit === "cover" && active.a4 === false;
    cropBtn.disabled = !canCrop;
    cropBtn.classList.toggle("is-active", spread.isCropping());
    replaceBtn.textContent = hasImage ? "Replace…" : "Add image…";
    clearBtn.disabled = !hasImage;

    note.textContent = describe(active);
    note.classList.toggle("is-warning", active.issues.length > 0);
  }

  function describe(active) {
    if (active.empty) return "Empty — click the page or drop an image on it.";
    if (active.pending && !active.px) return "Being added to the archive…";
    if (!active.px) return "";
    const size = `${active.px.w}×${active.px.h} px · ${Math.round(active.dpi)} dpi at A4`;
    if (!active.issues.length) return `${size} · A4 — lands exactly.`;
    return `${size} · ${active.issues.map((issue) => issue.short || issue.detail).join(" ")}`;
  }

  /* Anchored just above the spread's top edge -- or, when the spread's top
   * is too close to the top of the canvas for that, just below its bottom
   * edge, so the panel never sits over the spread's own first row. When
   * neither fits (a spread taller than the window) it pins to the top of
   * the canvas rather than leaving the window altogether.
   *
   * `anchor` is { x, top, bottom } in client coordinates. */
  function reposition(anchor) {
    if (el.hidden || !anchor) return;
    const bounds = container.getBoundingClientRect();
    // Measured after render(), which is what decides how tall it is.
    const box = el.getBoundingClientRect();
    const margin = 12;
    const gap = 14;
    const halfW = box.width / 2;
    const x = Math.min(Math.max(anchor.x, bounds.left + halfW + margin), bounds.right - halfW - margin);
    const fitsAbove = anchor.top - gap - box.height >= bounds.top + margin;
    const fitsBelow = anchor.bottom + gap + box.height <= bounds.bottom - margin;
    let top;
    if (fitsAbove) top = anchor.top - gap - box.height;
    else if (fitsBelow) top = anchor.bottom + gap;
    else top = bounds.top + margin;
    el.style.left = `${x}px`;
    el.style.top = `${top}px`;
  }

  return {
    show(handle, anchor) {
      spread = handle;
      el.hidden = false;
      render();
      reposition(anchor);
    },
    /** Re-read the spread -- its config or its active page changed, and
     *  with it, possibly, how tall the panel is. */
    refresh(anchor) {
      if (el.hidden) return;
      render();
      if (anchor) reposition(anchor);
    },
    reposition,
    hide() {
      el.hidden = true;
      spread = null;
    },
    current: () => spread,
    destroy() {
      el.remove();
    },
  };
}
