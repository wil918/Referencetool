/* Project-wide Appearance controls -- text colour, background, content
 * scale. Used to live in the Project Settings modal; now they're a section
 * of the shared top bar (top-bar.js), shown only while the grid is in edit
 * mode (main.js wires show()/hide() to the same shell.subscribe the floating
 * edit bar already uses -- see settings.js for why the gear jumps straight
 * into edit mode instead of opening a modal at all now).
 *
 * Inputs preview live through window.projectAppearance.apply (see
 * project/appearance.js), same as before, and now auto-persist debounced
 * instead of waiting on an explicit Save button -- there's no modal left to
 * hold one, and this matches how every other in-place edit on this page
 * already works (a widget's own config, via registry.js's CONFIG_SAVE_DELAY).
 */

import { showSection, hideSection } from "./top-bar.js";

const SAVE_DELAY = 400;

export function createAppearancePanel({ projectId }) {
  const el = document.createElement("div");
  el.className = "appearance-panel";
  el.innerHTML = `
    <div class="colour-control">
      <label for="appearance-ink">Text colour</label>
      <input type="color" id="appearance-ink" data-role="ink">
    </div>
    <div class="colour-control">
      <label for="appearance-scale">Content scale</label>
      <input type="range" id="appearance-scale" data-role="scale" min="0.8" max="1.6" step="0.05">
    </div>
    <div class="colour-control">
      <label for="appearance-bg">Background</label>
      <input type="color" id="appearance-bg" data-role="bg">
    </div>
  `;

  const inkInput = el.querySelector('[data-role="ink"]');
  const scaleInput = el.querySelector('[data-role="scale"]');
  const bgInput = el.querySelector('[data-role="bg"]');

  // style.css's --ink/--bg custom properties are plain #rrggbb, so they drop
  // straight into <input type="color"> with no conversion.
  const computed = getComputedStyle(document.documentElement);
  const defaultInk = computed.getPropertyValue("--ink").trim() || "#46545f";
  const defaultBg = computed.getPropertyValue("--bg").trim() || "#eff2f9";

  function saved() {
    return (window.projectAppearance && window.projectAppearance.get()) || {};
  }

  function fillForm() {
    const s = saved();
    inkInput.value = s.ink || defaultInk;
    bgInput.value = s.bg || defaultBg;
    scaleInput.value = s.contentScale || 1;
  }

  function formValue() {
    return { ink: inkInput.value, bg: bgInput.value, contentScale: Number(scaleInput.value) };
  }

  function preview() {
    window.projectAppearance?.apply(formValue());
  }

  let saveTimer = null;

  async function persist() {
    const res = await fetch(`/api/projects/${projectId}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: formValue() }),
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

  inkInput.addEventListener("input", onInput);
  bgInput.addEventListener("input", onInput);
  scaleInput.addEventListener("input", onInput);

  return {
    show() {
      fillForm();
      showSection("appearance", el);
    },
    hide() {
      // A colour picked a moment before edit mode ends is still an edit the
      // user made -- flushed rather than dropped, same as title.js's rename
      // and registry.js's own config-save flush on widget teardown.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        persist();
      }
      hideSection("appearance");
    },
  };
}
