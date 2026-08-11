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

export function createAppearancePanel({ projectId }) {
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
  const primaryFont = fontRow("appearance-primary-font", "Primary font");
  const secondaryFont = fontRow("appearance-secondary-font", "Secondary font");
  const graphBg3d = colourRow("appearance-graph-bg", "3D graph background");

  dropdown.append(
    muted.wrap,
    button.wrap,
    primaryFont.wrap,
    secondaryFont.wrap,
    graphBg3d.wrap
  );
  advancedWrap.append(advancedToggle, dropdown);

  el.append(bg.wrap, ink.wrap, accent.wrap, scaleWrap, advancedWrap);

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

  async function persist() {
    const next = { ...saved(), ...formValue() };
    const res = await fetch(`/api/projects/${projectId}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: next }),
    });
    if (!res.ok) return;
    const body = await res.json();
    window.projectAppearance?.set(body.settings);
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

  return {
    show() {
      fillForm();
      showSection("appearance", el);
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
