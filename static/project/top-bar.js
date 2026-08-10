/* The bar docked to the top of the project page.
 *
 * Everything else that floats over the grid in this file-set (the edit bar,
 * the old format-toolbar pill) is position: fixed, pinned to a corner. This
 * one is deliberately not -- it sits in normal document flow as <body>'s
 * first child, so showing it pushes #widget-grid down and hiding it
 * collapses the page straight back to "the grid starts at the top of the
 * viewport" (CLAUDE.md's project-shell rule, true again the moment nothing
 * needs the bar).
 *
 * Two consumers share it, keyed by name: appearance-panel.js's project-wide
 * controls (visible only while the grid is being edited) and
 * format-toolbar.js's per-widget controls (visible whenever a formattable
 * widget is active -- which for Notepad can be true with editing off).
 * Either, both, or neither section can be showing at once; the bar itself
 * only tracks whether it has anything to show.
 */

// Fixed rather than insertion order, so the bar reads the same regardless of
// which section happened to appear first (e.g. Notepad's format section can
// show before edit mode ever starts appearance's).
const ORDER = ["appearance", "format"];

let bar = null;
const sections = new Map(); // key -> element currently mounted

function ensureBar() {
  if (bar) return bar;
  bar = document.createElement("div");
  bar.className = "project-top-bar";
  bar.hidden = true;
  document.body.insertBefore(bar, document.body.firstChild);
  return bar;
}

function reorder() {
  for (const key of ORDER) {
    const el = sections.get(key);
    if (el) bar.appendChild(el); // appendChild on an existing node just moves it
  }
  bar.hidden = sections.size === 0;
}

/** Mount (or replace) one named section's content; ensures the bar is visible. */
export function showSection(key, el) {
  ensureBar();
  const existing = sections.get(key);
  if (existing && existing !== el) existing.remove();
  sections.set(key, el);
  reorder();
}

/** Unmount a named section. The bar collapses once none remain. */
export function hideSection(key) {
  if (!bar) return;
  sections.get(key)?.remove();
  sections.delete(key);
  reorder();
}
