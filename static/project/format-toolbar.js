/* The format toolbar -- one shared instance for the whole project page. A
 * widget opts in by calling makeFormattable(host, { get, set }) from its own
 * create(); mousedown inside that widget's host.el mounts these controls
 * into the shared top bar's "format" section (top-bar.js) and the toolbar
 * edits only that widget from then on, until the user clicks or focuses
 * outside both the widget and the toolbar itself.
 *
 * `get()` returns { typography, contentScale } for the active widget and
 * `set(next)` is called with the same shape on every edit -- what a widget
 * does with it (host.save, then re-apply its own styles for the live
 * preview) is the widget's business, not this module's. That whole-widget
 * channel is still exactly how Title works (align + contentScale are the
 * only fields it has), and it's still how align + contentScale work for
 * every widget -- alignment is paragraph-level and content-scale is this
 * app's own zoom control, neither is a per-character property.
 *
 * Text and Notepad additionally pass `richText` -- { getSelectionStyle,
 * applySelectionStyle, clearSelectionStyle }, built from rich-text.js
 * against the widget's own element -- opting the other six fields (family,
 * size, colour, bold, italic, underline) into per-selection formatting
 * instead: highlight a range and only that range changes; a collapsed
 * cursor sets the style new characters are typed in. See rich-text.js for
 * the mechanics. Title never passes this, so its six fields keep going
 * through get/set exactly as before -- zero change to how it behaves.
 *
 * One instance rather than one per widget: only one widget can be "being
 * edited" at a time, and session 11's canvas text node is meant to reuse
 * this exact module rather than growing a second toolbar.
 */

import { FONT_OPTIONS, remToPt, ptToRem } from "./typography.js";
import { showSection, hideSection } from "./top-bar.js";

const RICH_FIELDS = ["family", "size", "colour", "bold", "italic", "underline"];

// Google Docs' own preset list, shown as a dropdown under the size box.
const PRESET_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];
const DEFAULT_PT = 11;

let bar = null;
let active = null; // { host, get, set, richText } for whichever widget is pinned
let familySelect, sizeInput, sizeDropdown, colourInput, boldBtn, italicBtn, underlineBtn;
let alignBtns, scaleInput, clearBtn;

// A rich-text widget's own selection lives in window.getSelection(), but
// that Selection is destroyed the moment focus moves to a form control
// outside the contenteditable element -- clicking into the size box (to
// type a value or use its spin buttons) does exactly that. Without this,
// applySelectionStyle() silently no-ops: it reads an empty/foreign
// selection and has nothing to restyle. Every rich-text mousedown/keyup
// inside the widget updates this; every rich-field emit restores it first
// if the live selection has since moved outside the widget.
let savedRange = null;

function saveActiveSelection() {
  if (!active || !active.richText) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (active.host.el.contains(range.commonAncestorContainer)) savedRange = range.cloneRange();
}

function restoreActiveSelection() {
  if (!active || !active.richText || !savedRange) return;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && active.host.el.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
  sel.removeAllRanges();
  sel.addRange(savedRange);
}

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
  bar.className = "format-toolbar-fields";
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

  // A typeable number, Google Docs' own font-size control -- but also
  // backed by its own preset dropdown (also Docs' own list), since typing
  // an exact point value and picking a common one are both things people
  // want. Displayed/edited in points (typography.js's remToPt/ptToRem);
  // stored as rem internally, same as everything else in this system.
  const sizeWrap = document.createElement("div");
  sizeWrap.className = "format-toolbar-size-wrap";

  sizeInput = document.createElement("input");
  sizeInput.type = "number";
  sizeInput.min = "6";
  sizeInput.max = "200";
  sizeInput.step = "1";
  sizeInput.placeholder = "pt";
  sizeInput.title = "Font size (pt)";
  sizeInput.className = "format-toolbar-size";

  sizeDropdown = document.createElement("div");
  sizeDropdown.className = "format-toolbar-size-dropdown";
  sizeDropdown.hidden = true;
  // Keeps focus (and the selection it's tied to) on sizeInput when a
  // preset is picked with the mouse -- without this, mousedown's default
  // action would blur sizeInput before the click handler below ever runs.
  sizeDropdown.addEventListener("mousedown", (event) => event.preventDefault());
  for (const pt of PRESET_SIZES) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "format-toolbar-size-option";
    option.textContent = String(pt);
    option.addEventListener("click", () => {
      sizeInput.value = pt;
      sizeDropdown.hidden = true;
      emit({ size: ptToRem(pt) });
    });
    sizeDropdown.appendChild(option);
  }

  sizeWrap.appendChild(sizeInput);
  sizeWrap.appendChild(sizeDropdown);

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
  bar.appendChild(sizeWrap);
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

  familySelect.addEventListener("change", () => emit({ family: familySelect.value || undefined }));
  // "change" rather than "input": the native spinner buttons still fire it
  // immediately (live feedback for those), but typing digits doesn't apply
  // an intermediate size on every keystroke before the number is finished.
  sizeInput.addEventListener("change", () =>
    emit({ size: sizeInput.value ? ptToRem(Number(sizeInput.value)) : undefined })
  );
  sizeInput.addEventListener("focus", () => {
    sizeDropdown.hidden = false;
  });
  sizeInput.addEventListener("blur", () => {
    sizeDropdown.hidden = true;
  });
  sizeInput.addEventListener("keydown", (event) => {
    // Number inputs don't fire "change" on Enter by themselves -- blur
    // forces the commit (the "change" listener above then applies it) the
    // same way clicking away already does. Escape just backs out of the
    // dropdown without touching the selection.
    if (event.key === "Enter") sizeInput.blur();
    else if (event.key === "Escape") sizeDropdown.hidden = true;
  });
  colourInput.addEventListener("input", () => emit({ colour: colourInput.value }));
  boldBtn.addEventListener("click", () => emit({ bold: !activeStyle().bold || undefined }));
  italicBtn.addEventListener("click", () => emit({ italic: !activeStyle().italic || undefined }));
  underlineBtn.addEventListener("click", () => emit({ underline: !activeStyle().underline || undefined }));
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
    // Selection-scoped for rich-text widgets (consistent with the rest of
    // this module for them), whole-widget for Title -- same split as
    // everywhere else here.
    if (active.richText) {
      restoreActiveSelection();
      active.richText.clearSelectionStyle();
    } else {
      active.set({ typography: {}, contentScale: undefined });
    }
    refresh();
  });
}

function current() {
  return active ? active.get() || {} : {};
}

// The six character-level fields' current state -- from the live selection
// for a rich-text widget, from the whole-widget typography object
// otherwise (Title). Used by refresh() and by the toggle buttons, which
// need to know the current state to know which way to flip.
function activeStyle() {
  if (active?.richText) {
    restoreActiveSelection();
    return active.richText.getSelectionStyle();
  }
  return current().typography || {};
}

// Routes a field's change to whichever channel owns it: the six
// character-level fields go to the active widget's selection when it's a
// rich-text widget, everything else (and every field, for a non-rich-text
// widget like Title) goes through the whole-widget get/set this module has
// always used.
function emit(patch) {
  if (!active) return;
  const isRichField = Object.keys(patch).some((key) => RICH_FIELDS.includes(key));
  if (isRichField && active.richText) {
    restoreActiveSelection();
    active.richText.applySelectionStyle(patch);
  } else {
    const typography = { ...(current().typography || {}), ...patch };
    active.set({ typography, contentScale: current().contentScale });
  }
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
  const style = activeStyle();
  const { typography = {}, contentScale } = current();
  familySelect.value = style.family || "";
  // Not applied unless the user actually changes it -- just the visible
  // default, matching what unstyled text already renders at (typography.js's
  // own 0.9rem "Normal" default lands on 11pt too, see remToPt's comment).
  sizeInput.value = style.size ? remToPt(style.size) : DEFAULT_PT;
  colourInput.value = style.colour || inkFallback();
  boldBtn.classList.toggle("is-active", Boolean(style.bold));
  italicBtn.classList.toggle("is-active", Boolean(style.italic));
  underlineBtn.classList.toggle("is-active", Boolean(style.underline));
  for (const { btn, value } of alignBtns) {
    btn.classList.toggle("is-active", (typography.align || "left") === value);
  }
  scaleInput.value = contentScale || 1;
}

function onOutside(event) {
  if (!active) return;
  if (bar.contains(event.target) || active.host.el.contains(event.target)) return;
  close();
}

// Keeps the toolbar's pressed/value state in sync as the cursor or
// selection moves inside a rich-text widget by anything other than the
// mousedown that opened the toolbar (arrow keys, click-drag then release,
// clicking to a new spot without leaving the widget).
function onSelectionChange() {
  if (!active || !active.richText) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  if (!active.host.el.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
  saveActiveSelection();
  refresh();
}

function close() {
  if (!active) return;
  const hadRichText = Boolean(active.richText);
  active = null;
  savedRange = null;
  hideSection("format");
  document.removeEventListener("mousedown", onOutside, true);
  if (hadRichText) document.removeEventListener("selectionchange", onSelectionChange);
}

function activate(host, get, set, richText) {
  build();
  if (active && active.host !== host) close();
  active = { host, get, set, richText };
  savedRange = null;
  saveActiveSelection();
  refresh();
  showSection("format", bar);
  document.addEventListener("mousedown", onOutside, true);
  if (richText) document.addEventListener("selectionchange", onSelectionChange);
}

/** Opt a widget into the shared toolbar. See the module comment for the
 * shape of `get`/`set`/`richText`. `enabled`, if given, is checked on every
 * mousedown -- Text and Title only allow formatting while host.editMode
 * says the grid is being edited; Notepad passes nothing and stays
 * always-on. */
export function makeFormattable(host, { get, set, enabled, richText }) {
  const onMouseDown = () => {
    if (enabled && !enabled()) return;
    activate(host, get, set, richText);
  };
  host.el.addEventListener("mousedown", onMouseDown);
  host.onDestroy(() => {
    host.el.removeEventListener("mousedown", onMouseDown);
    if (active && active.host === host) close();
  });
}
