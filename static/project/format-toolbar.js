/* The floating format toolbar -- one shared instance for the whole project
 * page, in the manner of Google Docs. A widget opts in by calling
 * makeFormattable(host, { get, set }) from its own create(); mousedown inside
 * that widget's host.el pins the toolbar above it (or below, if there's no
 * room above) and the toolbar edits only that widget from then on, until the
 * user clicks or focuses outside both the widget and the toolbar itself.
 *
 * `get()` returns { typography, contentScale } for the active widget and
 * `set(next)` is called with the same shape on every edit -- what a widget
 * does with it (host.save, then re-apply its own styles for the live
 * preview) is the widget's business, not this module's.
 *
 * One instance rather than one per widget: only one widget can be "being
 * edited" at a time, and session 11's canvas text node is meant to reuse
 * this exact module rather than growing a second toolbar.
 */

import { FONT_OPTIONS, SIZE_OPTIONS } from "./typography.js";

let bar = null;
let active = null; // { host, get, set } for whichever widget is pinned
let familySelect, sizeSelect, colourInput, boldBtn, italicBtn, underlineBtn;
let alignBtns, scaleInput, clearBtn;

function fieldButton(label, title) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "format-toolbar-btn";
  btn.title = title;
  btn.innerHTML = label;
  return btn;
}

function build() {
  if (bar) return;

  bar = document.createElement("div");
  bar.className = "format-toolbar";
  bar.hidden = true;
  // onOutside (below) already whitelists anything inside `bar`, so this
  // isn't load-bearing for that check -- it just keeps a mousedown on the
  // toolbar's own controls from bubbling any further than the toolbar.
  bar.addEventListener("mousedown", (event) => event.stopPropagation());

  familySelect = document.createElement("select");
  familySelect.title = "Font family";
  const defaultFamilyOption = document.createElement("option");
  defaultFamilyOption.value = "";
  defaultFamilyOption.textContent = "Default font";
  familySelect.appendChild(defaultFamilyOption);
  for (const { value, label } of FONT_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    familySelect.appendChild(option);
  }

  sizeSelect = document.createElement("select");
  sizeSelect.title = "Font size";
  const defaultSizeOption = document.createElement("option");
  defaultSizeOption.value = "";
  defaultSizeOption.textContent = "Default size";
  sizeSelect.appendChild(defaultSizeOption);
  for (const { value, label } of SIZE_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    sizeSelect.appendChild(option);
  }

  colourInput = document.createElement("input");
  colourInput.type = "color";
  colourInput.title = "Text colour";

  boldBtn = fieldButton("<b>B</b>", "Bold");
  italicBtn = fieldButton("<i>I</i>", "Italic");
  underlineBtn = fieldButton("<u>U</u>", "Underline");

  const left = fieldButton("L", "Align left");
  const center = fieldButton("C", "Align center");
  const right = fieldButton("R", "Align right");
  alignBtns = [
    { btn: left, value: "left" },
    { btn: center, value: "center" },
    { btn: right, value: "right" },
  ];

  scaleInput = document.createElement("input");
  scaleInput.type = "range";
  scaleInput.min = "0.8";
  scaleInput.max = "2";
  scaleInput.step = "0.1";
  scaleInput.title = "Content scale";
  scaleInput.className = "format-toolbar-scale";

  clearBtn = fieldButton("↺", "Clear formatting");

  const divider = () => {
    const d = document.createElement("div");
    d.className = "format-toolbar-divider";
    return d;
  };

  bar.appendChild(familySelect);
  bar.appendChild(sizeSelect);
  bar.appendChild(colourInput);
  bar.appendChild(divider());
  bar.appendChild(boldBtn);
  bar.appendChild(italicBtn);
  bar.appendChild(underlineBtn);
  bar.appendChild(divider());
  for (const { btn } of alignBtns) bar.appendChild(btn);
  bar.appendChild(divider());
  bar.appendChild(scaleInput);
  bar.appendChild(clearBtn);
  document.body.appendChild(bar);

  familySelect.addEventListener("change", () => emit({ family: familySelect.value || undefined }));
  sizeSelect.addEventListener("change", () =>
    emit({ size: sizeSelect.value ? Number(sizeSelect.value) : undefined })
  );
  colourInput.addEventListener("input", () => emit({ colour: colourInput.value }));
  boldBtn.addEventListener("click", () => emit({ bold: !current().typography?.bold || undefined }));
  italicBtn.addEventListener("click", () => emit({ italic: !current().typography?.italic || undefined }));
  underlineBtn.addEventListener("click", () =>
    emit({ underline: !current().typography?.underline || undefined })
  );
  for (const { btn, value } of alignBtns) {
    btn.addEventListener("click", () => emit({ align: value }));
  }
  scaleInput.addEventListener("input", () => {
    if (!active) return;
    active.set({ typography: current().typography, contentScale: Number(scaleInput.value) });
    refresh();
  });
  clearBtn.addEventListener("click", () => {
    if (!active) return;
    active.set({ typography: {}, contentScale: undefined });
    refresh();
  });
}

function current() {
  return active ? active.get() || {} : {};
}

// Merge one field's change into the active widget's typography and hand the
// whole thing back through `set` -- the widget owns turning that into a
// save plus a live re-render, this module only ever knows the shape of the
// typography object itself.
function emit(patch) {
  if (!active) return;
  const typography = { ...(current().typography || {}), ...patch };
  active.set({ typography, contentScale: current().contentScale });
  refresh();
}

// input[type=color].value only accepts a hex string -- the computed *value*
// of --ink/--project-ink is already one (see :root in style.css), unlike
// getComputedStyle(el).color, which resolves to an rgb() string the input
// would silently reject.
function inkFallback() {
  const computed = getComputedStyle(document.documentElement);
  return computed.getPropertyValue("--project-ink").trim() || computed.getPropertyValue("--ink").trim() || "#46545f";
}

function refresh() {
  const { typography = {}, contentScale } = current();
  familySelect.value = typography.family || "";
  sizeSelect.value = typography.size || "";
  colourInput.value = typography.colour || inkFallback();
  boldBtn.classList.toggle("is-active", Boolean(typography.bold));
  italicBtn.classList.toggle("is-active", Boolean(typography.italic));
  underlineBtn.classList.toggle("is-active", Boolean(typography.underline));
  for (const { btn, value } of alignBtns) {
    btn.classList.toggle("is-active", (typography.align || "left") === value);
  }
  scaleInput.value = contentScale || 1;
}

function position() {
  if (!active) return;
  const rect = active.host.el.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  const gap = 8;

  let top = rect.top - barRect.height - gap;
  if (top < gap) top = rect.bottom + gap; // no room above -- flip below

  let left = rect.left + rect.width / 2 - barRect.width / 2;
  left = Math.min(Math.max(gap, left), window.innerWidth - barRect.width - gap);

  bar.style.top = `${Math.max(gap, top)}px`;
  bar.style.left = `${left}px`;
}

function onReposition() {
  position();
}

function onOutside(event) {
  if (!active) return;
  if (bar.contains(event.target) || active.host.el.contains(event.target)) return;
  close();
}

function close() {
  if (!active) return;
  active = null;
  bar.hidden = true;
  window.removeEventListener("scroll", onReposition, true);
  window.removeEventListener("resize", onReposition);
  document.removeEventListener("mousedown", onOutside, true);
}

function activate(host, get, set) {
  build();
  if (active && active.host !== host) close();
  active = { host, get, set };
  bar.hidden = false;
  refresh();
  position();
  window.addEventListener("scroll", onReposition, true);
  window.addEventListener("resize", onReposition);
  document.addEventListener("mousedown", onOutside, true);
}

/** Opt a widget into the shared toolbar. See the module comment for the shape
 * of `get`/`set`. */
export function makeFormattable(host, { get, set }) {
  const onMouseDown = () => activate(host, get, set);
  host.el.addEventListener("mousedown", onMouseDown);
  host.onDestroy(() => {
    host.el.removeEventListener("mousedown", onMouseDown);
    if (active && active.host === host) close();
  });
}
