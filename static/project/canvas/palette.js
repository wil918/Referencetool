/* How things get onto the canvas.
 *
 * Two ways in, because the two kinds of thing being added want different
 * gestures. A simple text node or a widget has no particular place it
 * belongs, so it is a button: click it and it lands in the middle of what
 * you are looking at. A reference does have a place it belongs -- next to
 * the other three you are arranging it against -- so it is dragged out of a
 * picker and dropped exactly there.
 *
 * The drop uses native HTML5 drag and drop rather than the pointer gestures
 * nodes.js implements, for the same reason grid.js's move handle does: the
 * drag starts inside a floating panel and ends on the canvas behind it, and a
 * native drag is the one mechanism that keeps firing across that boundary.
 *
 * Which widgets are offered is registry.js's canvasEligible and nothing else
 * -- the same container/permanent flags the homepage grid reads, so a widget
 * that may not sit on the canvas can never appear here by being forgotten.
 */

import { makeBarThumb } from "../../shared/cards.js";
import { all as allWidgetDefinitions } from "../registry.js";

const DRAG_TYPE = "application/x-reference-id";

// Roughly half a default node, so a click-to-add lands centred on the view
// rather than with its corner at the middle of the screen. Approximate on
// purpose: the exact size depends on the kind, and being a few pixels out is
// invisible on a canvas with no grid to line up against.
const CENTRE_NUDGE = { x: 110, y: 80 };
// Successive adds without moving the view step down and right instead of
// landing on top of each other.
const CASCADE_STEP = 26;
const CASCADE_WRAP = 6;

export function createPalette({ container, viewport, references = [], addNode }) {
  let cascade = 0;

  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "canvas-dock-fab";
  fab.title = "Add to canvas";
  fab.setAttribute("aria-label", "Add to canvas");
  fab.textContent = "+";

  const panel = document.createElement("div");
  panel.className = "canvas-dock-panel";
  panel.hidden = true;

  fab.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    fab.classList.toggle("is-open", !panel.hidden);
  });

  // --- add buttons ---------------------------------------------------------

  function nextPoint() {
    const rect = viewport.container.getBoundingClientRect();
    const point = viewport.screenToWorld(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
    const offset = (cascade % CASCADE_WRAP) * CASCADE_STEP;
    cascade += 1;
    return {
      x: point.x - CENTRE_NUDGE.x + offset,
      y: point.y - CENTRE_NUDGE.y + offset,
    };
  }

  function addButton(label, fields) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn canvas-dock-add";
    btn.textContent = label;
    btn.addEventListener("click", () => addNode({ ...fields, ...nextPoint() }));
    return btn;
  }

  const addSection = document.createElement("div");
  addSection.className = "canvas-dock-section";
  const addHeading = document.createElement("p");
  addHeading.className = "muted canvas-dock-heading";
  addHeading.textContent = "Add";
  addSection.appendChild(addHeading);

  const addRow = document.createElement("div");
  addRow.className = "canvas-dock-add-row";
  // "Simple text", not "Notepad": the widget list below can also contribute a
  // Notepad node, and the two are deliberately different things. Simple text
  // takes the project's typography and has no per-selection formatting;
  // Notepad is the rich one. Do not add rich text to Simple text -- having
  // one plain option and one rich option is the point, not something to fix.
  addRow.appendChild(addButton("Simple text", { kind: "text" }));
  for (const definition of allWidgetDefinitions()) {
    if (!definition.canvasEligible) continue;
    addRow.appendChild(
      addButton(definition.label, { kind: "widget", config: { type: definition.type } })
    );
  }
  addSection.appendChild(addRow);
  panel.appendChild(addSection);

  // --- the reference picker ------------------------------------------------

  const refSection = document.createElement("div");
  refSection.className = "canvas-dock-section";
  const refHeading = document.createElement("p");
  refHeading.className = "muted canvas-dock-heading";
  refHeading.textContent = "Drag a reference onto the canvas";
  refSection.appendChild(refHeading);

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Filter references…";
  search.className = "canvas-dock-search";
  refSection.appendChild(search);

  const refList = document.createElement("div");
  refList.className = "canvas-dock-refs";
  refSection.appendChild(refList);

  const empty = document.createElement("p");
  empty.className = "muted";
  empty.textContent = references.length
    ? "Nothing matches that."
    : "No references in this project yet.";
  refSection.appendChild(empty);
  panel.appendChild(refSection);

  function renderReferences(query = "") {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? references.filter((ref) =>
          `${ref.title} ${(ref.tags || []).join(" ")}`.toLowerCase().includes(needle)
        )
      : references;

    refList.innerHTML = "";
    for (const ref of matches) {
      const item = document.createElement("div");
      item.className = "canvas-dock-ref";
      item.title = ref.title;
      item.draggable = true;
      item.appendChild(makeBarThumb(ref));
      item.addEventListener("dragstart", (event) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(DRAG_TYPE, ref.id);
        event.dataTransfer.setData("text/plain", ref.id);
      });
      refList.appendChild(item);
    }
    empty.hidden = matches.length > 0;
    refList.hidden = matches.length === 0;
  }

  search.addEventListener("input", () => renderReferences(search.value));
  renderReferences();

  // --- the drop target -----------------------------------------------------

  function onDragOver(event) {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    // Without this the drop never fires: the default action for dragover is
    // "this is not a drop target".
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    viewport.container.classList.add("is-drop-target");
  }

  function onDragLeave(event) {
    // relatedTarget is where the pointer went; still inside the canvas means
    // this is just a crossing between children, not a real leave.
    if (event.relatedTarget && viewport.container.contains(event.relatedTarget)) return;
    viewport.container.classList.remove("is-drop-target");
  }

  function onDrop(event) {
    const referenceId = event.dataTransfer.getData(DRAG_TYPE);
    viewport.container.classList.remove("is-drop-target");
    if (!referenceId) return;
    event.preventDefault();
    // Where it was dropped, in world coordinates -- so it stays there when
    // the view moves, which is the only position worth storing.
    const point = viewport.screenToWorld(event.clientX, event.clientY);
    addNode({ kind: "reference", reference_id: referenceId, x: point.x, y: point.y });
  }

  viewport.container.addEventListener("dragover", onDragOver);
  viewport.container.addEventListener("dragleave", onDragLeave);
  viewport.container.addEventListener("drop", onDrop);

  container.appendChild(panel);
  container.appendChild(fab);

  return {
    destroy() {
      viewport.container.removeEventListener("dragover", onDragOver);
      viewport.container.removeEventListener("dragleave", onDragLeave);
      viewport.container.removeEventListener("drop", onDrop);
      panel.remove();
      fab.remove();
    },
  };
}
