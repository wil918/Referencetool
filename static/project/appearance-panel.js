/* Project-wide Appearance controls -- palette, fonts, background, content
 * scale. Used to live in the Project Settings modal; now they're a section
 * of the shared top bar (top-bar.js), shown only while the grid is in edit
 * mode and no widget is pinned to the format toolbar (main.js wires
 * show()/hide() to shell.subscribe and format-toolbar.js's
 * onActiveWidgetChange -- see settings.js for why the gear jumps straight
 * into edit mode instead of opening a modal at all now).
 *
 * There are more settings than the bar has room for, so only the four
 * most-used stay inline (background, primary text, accent, content scale);
 * everything else (secondary text, button colour, the two font pickers, the
 * 3D graph background) sits behind an "Advanced" control that drops down
 * from the bar rather than joining it -- see the .appearance-advanced-*
 * rules in style.css, which position it absolutely so opening it never
 * pushes the grid down the way the bar itself does.
 *
 * Inputs preview live through window.projectAppearance.apply (see
 * project/appearance.js), same as before, and auto-persist debounced
 * instead of waiting on an explicit Save button -- there's no modal left to
 * hold one, and this matches how every other in-place edit on this page
 * already works (a widget's own config, via registry.js's CONFIG_SAVE_DELAY).
 */

import { showSection, hideSection } from "./top-bar.js";
import { FONT_OPTIONS } from "./typography.js";

const SAVE_DELAY = 400;

// The graph pages' own THEMES (static/graph-common.js) hard-code these same
// two colours -- duplicated here, not imported, because that module pulls in
// Three.js, and this picker's seed value isn't worth loading a renderer for.
// See project/scene-widget.js for how a saved graphBg3d actually reaches the
// scene.
const DEFAULT_GRAPH_BG = { light: "#eff2f9", dark: "#262b31" };

function colourRow(id, label) {
  const wrap = document.createElement("div");
  wrap.className = "colour-control";
  const control = document.createElement("label");
  control.setAttribute("for", id);
  control.textContent = label;
  const input = document.createElement("input");
  input.type = "color";
  input.id = id;
  wrap.append(control, input);
  return { wrap, input };
}

// The style picker's own value space, kept separate from a real style's id:
// "" always means "Default", i.e. no saved row at all but the instruction to
// clear every appearance override so the project falls back to style.css's
// globals and starts following the light/dark toggle again. A saved style,
// by contrast, is a fixed set of colours copied out of project_settings --
// picking one never moves when the theme changes, only Default does.
const DEFAULT_STYLE_VALUE = "";

// A hidden, unselectable third option -- shown only when the project's
// current settings match neither {} nor any saved style (e.g. a colour was
// hand-tweaked after applying one). Without it the select would have to fall
// back to displaying "Default" for a state that isn't actually Default, and
// a later click on the real Default option -- already the displayed value as
// far as the <select> is concerned -- wouldn't fire a change event at all.
const CUSTOM_STYLE_VALUE = "__custom__";

function styleRow() {
  const wrap = document.createElement("div");
  wrap.className = "colour-control";
  const label = document.createElement("label");
  label.setAttribute("for", "appearance-style-select");
  label.textContent = "Style";
  const select = document.createElement("select");
  select.id = "appearance-style-select";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn";
  saveBtn.textContent = "Save current style";
  wrap.append(label, select, saveBtn);
  return { wrap, select, saveBtn };
}

// Loads db.py's baked-in DEFAULT_WIDGETS -- not a row in the layouts table,
// exactly as DEFAULT_STYLE_VALUE's "Default" is not a row in styles. Unlike
// that value, it can't just be "" and mean "clear everything": there is
// concrete widget data behind it, fetched on demand from
// GET /api/layouts/default (see fetchDefaultLayoutWidgets below).
const DEFAULT_LAYOUT_VALUE = "__default__";

// The layout select always shows this placeholder between loads rather than
// tracking a "currently active" value the way the style select does --
// there's nothing to compare a project's live widgets against, so instead of
// syncStyleSelect's settingsEqual dance, picking a layout is a one-shot
// action: fire loadLayout, then reset back here so the same entry can be
// picked again later.
const LAYOUT_PLACEHOLDER_VALUE = "";

function layoutRow() {
  const wrap = document.createElement("div");
  wrap.className = "colour-control";
  const label = document.createElement("label");
  label.setAttribute("for", "appearance-layout-select");
  label.textContent = "Layout";
  const select = document.createElement("select");
  select.id = "appearance-layout-select";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn";
  saveBtn.textContent = "Save current layout";
  wrap.append(label, select, saveBtn);
  return { wrap, select, saveBtn };
}

function fontRow(id, label) {
  const wrap = document.createElement("div");
  wrap.className = "colour-control";
  const control = document.createElement("label");
  control.setAttribute("for", id);
  control.textContent = label;
  const select = document.createElement("select");
  select.id = id;
  const fallback = document.createElement("option");
  fallback.value = "";
  fallback.textContent = "Default";
  select.appendChild(fallback);
  for (const { value, label: optionLabel } of FONT_OPTIONS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = optionLabel;
    select.appendChild(option);
  }
  wrap.append(control, select);
  return { wrap, select };
}

export function createAppearancePanel({ projectId, loadLayout }) {
  const el = document.createElement("div");
  el.className = "appearance-panel";

  // --- the four controls that stay in the bar itself ------------------------
  const bg = colourRow("appearance-bg", "Background");
  const ink = colourRow("appearance-ink", "Primary text");
  const accent = colourRow("appearance-accent", "Accent");

  const scaleWrap = document.createElement("div");
  scaleWrap.className = "colour-control";
  const scaleLabel = document.createElement("label");
  scaleLabel.setAttribute("for", "appearance-scale");
  scaleLabel.textContent = "Content scale";
  const scaleInput = document.createElement("input");
  scaleInput.type = "range";
  scaleInput.id = "appearance-scale";
  scaleInput.min = "0.8";
  scaleInput.max = "1.6";
  scaleInput.step = "0.05";
  scaleWrap.append(scaleLabel, scaleInput);

  // --- everything else, behind Advanced --------------------------------------
  const advancedWrap = document.createElement("div");
  advancedWrap.className = "appearance-advanced";
  const advancedToggle = document.createElement("button");
  advancedToggle.type = "button";
  advancedToggle.className = "btn";
  advancedToggle.textContent = "Advanced";
  const dropdown = document.createElement("div");
  dropdown.className = "appearance-advanced-dropdown";
  dropdown.hidden = true;

  const muted = colourRow("appearance-muted", "Secondary text");
  const button = colourRow("appearance-button", "Button colour");
  const buttonInk = colourRow("appearance-button-ink", "Button text colour");
  const primaryFont = fontRow("appearance-primary-font", "Primary font");
  const secondaryFont = fontRow("appearance-secondary-font", "Secondary font");
  const graphBg3d = colourRow("appearance-graph-bg", "3D graph background");

  dropdown.append(
    muted.wrap,
    button.wrap,
    buttonInk.wrap,
    primaryFont.wrap,
    secondaryFont.wrap,
    graphBg3d.wrap
  );
  advancedWrap.append(advancedToggle, dropdown);

  const styleRowEls = styleRow();
  const layoutRowEls = layoutRow();

  el.append(styleRowEls.wrap, layoutRowEls.wrap, bg.wrap, ink.wrap, accent.wrap, scaleWrap, advancedWrap);

  // style.css's colour custom properties are plain #rrggbb, so they drop
  // straight into <input type="color"> with no conversion.
  const computed = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.dataset.theme === "dark";
  const defaults = {
    bg: computed.getPropertyValue("--bg").trim() || "#eff2f9",
    ink: computed.getPropertyValue("--ink").trim() || "#46545f",
    accent: computed.getPropertyValue("--accent").trim() || "#c23b2e",
    muted: computed.getPropertyValue("--muted").trim() || "#8b97a2",
    // Buttons fall back to the page's own colour when unset -- see style.css --
    // so that's the truest "what will this look like if I leave it blank".
    button: computed.getPropertyValue("--bg").trim() || "#eff2f9",
    // Button text falls back to --ink, independent of the button's own
    // background default above.
    buttonInk: computed.getPropertyValue("--ink").trim() || "#46545f",
    graphBg3d: isDark ? DEFAULT_GRAPH_BG.dark : DEFAULT_GRAPH_BG.light,
  };

  function saved() {
    return (window.projectAppearance && window.projectAppearance.get()) || {};
  }

  function fillForm() {
    // A fresh edit session starts with nothing touched -- every input is
    // showing exactly what's saved (or a computed default), and only an
    // actual edit in *this* session should turn into a write.
    touched.clear();
    const s = saved();
    bg.input.value = s.bg || defaults.bg;
    ink.input.value = s.ink || defaults.ink;
    accent.input.value = s.accent || defaults.accent;
    scaleInput.value = s.contentScale || 1;
    muted.input.value = s.muted || defaults.muted;
    button.input.value = s.button || defaults.button;
    buttonInk.input.value = s.buttonInk || defaults.buttonInk;
    primaryFont.select.value = s.primaryFont || "";
    secondaryFont.select.value = s.secondaryFont || "";
    graphBg3d.input.value = s.graphBg3d || defaults.graphBg3d;
  }

  // Only fields the user has actually touched are ever saved -- an untouched
  // colour picker showing a computed default is not the same as the user
  // choosing that colour, and saving it would stop the field from tracking
  // the app default (or the theme) if that ever changed. Each field starts
  // "untouched" and is marked touched on its own first input event.
  const touched = new Set();
  function markTouched(key) {
    return () => touched.add(key);
  }

  function formValue() {
    const value = {};
    if (touched.has("bg")) value.bg = bg.input.value;
    if (touched.has("ink")) value.ink = ink.input.value;
    if (touched.has("accent")) value.accent = accent.input.value;
    if (touched.has("contentScale")) value.contentScale = Number(scaleInput.value);
    if (touched.has("muted")) value.muted = muted.input.value;
    if (touched.has("button")) value.button = button.input.value;
    if (touched.has("buttonInk")) value.buttonInk = buttonInk.input.value;
    if (touched.has("primaryFont") && primaryFont.select.value) value.primaryFont = primaryFont.select.value;
    if (touched.has("secondaryFont") && secondaryFont.select.value) value.secondaryFont = secondaryFont.select.value;
    if (touched.has("graphBg3d")) value.graphBg3d = graphBg3d.input.value;
    return value;
  }

  function preview() {
    // formValue() alone would drop every untouched field back to nothing on
    // every keystroke -- fine for what's actually being persisted, wrong for
    // a live preview, which has to keep showing whatever is already saved
    // for the fields this edit isn't touching.
    window.projectAppearance?.apply({ ...saved(), ...formValue() });
  }

  let saveTimer = null;

  // The one place that writes a project's settings wholesale -- both the
  // per-field autosave below and the style picker (applying a style or
  // "Default") funnel through this, so there is only ever one path from "new
  // settings object" to "persisted and applied".
  async function putSettings(next) {
    const res = await fetch(`/api/projects/${projectId}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: next }),
    });
    if (!res.ok) return;
    const body = await res.json();
    window.projectAppearance?.set(body.settings);
    // Whatever just got written might now match a different style (or none,
    // or Default) than the picker was showing -- e.g. a colour tweaked by
    // hand after a style was applied no longer matches that style exactly.
    syncStyleSelect();
  }

  async function persist() {
    await putSettings({ ...saved(), ...formValue() });
  }

  function onInput() {
    preview();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persist();
    }, SAVE_DELAY);
  }

  bg.input.addEventListener("input", markTouched("bg"));
  bg.input.addEventListener("input", onInput);
  ink.input.addEventListener("input", markTouched("ink"));
  ink.input.addEventListener("input", onInput);
  accent.input.addEventListener("input", markTouched("accent"));
  accent.input.addEventListener("input", onInput);
  scaleInput.addEventListener("input", markTouched("contentScale"));
  scaleInput.addEventListener("input", onInput);
  muted.input.addEventListener("input", markTouched("muted"));
  muted.input.addEventListener("input", onInput);
  button.input.addEventListener("input", markTouched("button"));
  button.input.addEventListener("input", onInput);
  buttonInk.input.addEventListener("input", markTouched("buttonInk"));
  buttonInk.input.addEventListener("input", onInput);
  primaryFont.select.addEventListener("change", markTouched("primaryFont"));
  primaryFont.select.addEventListener("change", onInput);
  secondaryFont.select.addEventListener("change", markTouched("secondaryFont"));
  secondaryFont.select.addEventListener("change", onInput);
  graphBg3d.input.addEventListener("input", markTouched("graphBg3d"));
  graphBg3d.input.addEventListener("input", onInput);

  function closeAdvanced() {
    dropdown.hidden = true;
    document.removeEventListener("mousedown", onOutsideAdvanced, true);
  }

  function onOutsideAdvanced(event) {
    if (advancedWrap.contains(event.target)) return;
    closeAdvanced();
  }

  advancedToggle.addEventListener("click", () => {
    if (!dropdown.hidden) {
      closeAdvanced();
      return;
    }
    dropdown.hidden = false;
    document.addEventListener("mousedown", onOutsideAdvanced, true);
  });

  // --- styles: named, global, reusable snapshots of an appearance ----------

  let styles = []; // [{ id, name, settings, date_created }, ...]

  // There is no project_settings column recording which style (if any) is
  // "active" -- a project only ever stores the resolved settings a style
  // left behind (see putSettings). So the select's value is derived fresh,
  // by comparing those settings against every loaded style rather than
  // remembered, each time either side could have changed.
  function settingsEqual(a, b) {
    const aKeys = Object.keys(a || {});
    const bKeys = Object.keys(b || {});
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => (a || {})[key] === (b || {})[key]);
  }

  function buildStyleOptions() {
    styleRowEls.select.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = DEFAULT_STYLE_VALUE;
    defaultOption.textContent = "Default (follows theme)";
    styleRowEls.select.appendChild(defaultOption);
    for (const style of styles) {
      const option = document.createElement("option");
      option.value = style.id;
      option.textContent = style.name;
      styleRowEls.select.appendChild(option);
    }
    // Never offered as a real choice -- hidden from the open dropdown and
    // disabled so a user can't select it directly -- it only exists so the
    // closed select has a label for "none of the above" instead of falling
    // back to Default's own value, which would make Default's box misreport
    // custom settings as itself. See CUSTOM_STYLE_VALUE.
    const customOption = document.createElement("option");
    customOption.value = CUSTOM_STYLE_VALUE;
    customOption.textContent = "Custom";
    customOption.hidden = true;
    customOption.disabled = true;
    styleRowEls.select.appendChild(customOption);
  }

  function syncStyleSelect() {
    const current = saved();
    if (Object.keys(current).length === 0) {
      styleRowEls.select.value = DEFAULT_STYLE_VALUE;
      return;
    }
    const match = styles.find((s) => settingsEqual(s.settings, current));
    styleRowEls.select.value = match ? match.id : CUSTOM_STYLE_VALUE;
  }

  async function loadStyles() {
    const res = await fetch("/api/styles");
    styles = res.ok ? await res.json() : [];
    buildStyleOptions();
    syncStyleSelect();
  }

  styleRowEls.select.addEventListener("change", async () => {
    const value = styleRowEls.select.value;
    // "Default" clears every appearance override for this project outright
    // -- it is not a style with an id, just the instruction to fall back to
    // style.css's globals, which is what makes the theme toggle affect this
    // project again. Every real style is a fixed snapshot of colours and
    // stays put when the theme changes.
    const next = value === DEFAULT_STYLE_VALUE ? {} : styles.find((s) => s.id === value)?.settings;
    if (next === undefined) return;
    window.projectAppearance?.apply(next); // immediate preview, same path every input uses
    await putSettings(next); // also resyncs the select once the write lands
    fillForm();
  });

  styleRowEls.saveBtn.addEventListener("click", async () => {
    const name = window.prompt("Save the current appearance as a style named:");
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    const existing = styles.find((s) => s.name === trimmed);
    if (existing) {
      if (!window.confirm(`A style named "${trimmed}" already exists. Overwrite it?`)) return;
      const res = await fetch(`/api/styles/${existing.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: saved() }),
      });
      if (!res.ok) return;
    } else {
      const res = await fetch("/api/styles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, settings: saved() }),
      });
      if (!res.ok) return;
    }
    await loadStyles();
  });

  // --- layouts: named, global, reusable snapshots of a widget arrangement --
  //
  // Unlike appearance, a layout is not something this project is currently
  // "in" -- loading one immediately creates/removes/repositions widgets
  // (main.js's loadLayout) rather than previewing and debouncing a save the
  // way every field above does, so there is no persist/preview split here.

  let layouts = []; // [{ id, name, widgets, date_created }, ...]
  let defaultLayoutWidgets = null; // fetched once, lazily -- see below

  function buildLayoutOptions() {
    layoutRowEls.select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = LAYOUT_PLACEHOLDER_VALUE;
    placeholder.textContent = "Load a layout…";
    placeholder.disabled = true;
    layoutRowEls.select.appendChild(placeholder);

    const defaultOption = document.createElement("option");
    defaultOption.value = DEFAULT_LAYOUT_VALUE;
    defaultOption.textContent = "Default";
    layoutRowEls.select.appendChild(defaultOption);

    for (const layout of layouts) {
      const option = document.createElement("option");
      option.value = layout.id;
      option.textContent = layout.name;
      layoutRowEls.select.appendChild(option);
    }
    layoutRowEls.select.value = LAYOUT_PLACEHOLDER_VALUE;
  }

  async function loadLayoutList() {
    const res = await fetch("/api/layouts");
    layouts = res.ok ? await res.json() : [];
    buildLayoutOptions();
  }

  // DEFAULT_WIDGETS is baked-in Python data, not a database row -- there is
  // nothing for GET /api/layouts to return for it, so it comes from its own
  // route and is cached here rather than refetched on every pick (it cannot
  // change over a page's lifetime).
  async function fetchDefaultLayoutWidgets() {
    if (defaultLayoutWidgets) return defaultLayoutWidgets;
    const res = await fetch("/api/layouts/default");
    const body = res.ok ? await res.json() : { widgets: [] };
    defaultLayoutWidgets = body.widgets;
    return defaultLayoutWidgets;
  }

  layoutRowEls.select.addEventListener("change", async () => {
    const value = layoutRowEls.select.value;
    if (value === LAYOUT_PLACEHOLDER_VALUE) return;
    const widgets =
      value === DEFAULT_LAYOUT_VALUE
        ? await fetchDefaultLayoutWidgets()
        : layouts.find((l) => l.id === value)?.widgets;
    // Reset immediately rather than after loadLayout resolves -- picking the
    // same entry twice in a row must fire another change event each time.
    layoutRowEls.select.value = LAYOUT_PLACEHOLDER_VALUE;
    if (!widgets) return;
    await loadLayout(widgets);
  });

  layoutRowEls.saveBtn.addEventListener("click", async () => {
    const name = window.prompt("Save the current layout as:");
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    // Overwriting re-captures this project's widgets fresh, same as saving
    // under a new name -- a stale snapshot under a reused name would be a
    // worse surprise than the confirm below.
    const existing = layouts.find((l) => l.name === trimmed);
    if (existing) {
      if (!window.confirm(`A layout named "${trimmed}" already exists. Overwrite it?`)) return;
      const res = await fetch(`/api/layouts/${existing.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
      });
      if (!res.ok) return;
    } else {
      const res = await fetch("/api/layouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, project_id: projectId }),
      });
      if (!res.ok) return;
    }
    await loadLayoutList();
  });

  return {
    async show() {
      fillForm();
      showSection("appearance", el);
      // Styles and layouts are both global -- another project may have saved
      // or deleted one since this panel last opened, so the lists are
      // refreshed every time rather than cached for the page's lifetime.
      await loadStyles();
      await loadLayoutList();
    },
    hide() {
      // A colour picked a moment before edit mode ends (or the format
      // toolbar takes over) is still an edit the user made -- flushed rather
      // than dropped, same as title.js's rename and registry.js's own
      // config-save flush on widget teardown.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        persist();
      }
      closeAdvanced();
      hideSection("appearance");
    },
  };
}
