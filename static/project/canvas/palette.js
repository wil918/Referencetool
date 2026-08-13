/* How things get onto the canvas.
 *
 * Everything offered here is both a click target (lands centred on the
 * current view, stepping diagonally on repeat so successive adds don't
 * stack) and a drag source (lands exactly where it's dropped). Click is the
 * one path guaranteed to work everywhere -- keyboard activation of a
 * focused button, a screen reader's "activate", a touch device with no real
 * drag gesture -- so it is never removed in favour of the drag, only
 * layered under it.
 *
 * The drag itself is pointer events (pointerdown/move/up with
 * setPointerCapture), the same mechanism nodes.js already uses to move a
 * node once it's on the canvas -- not native HTML5 drag-and-drop. This
 * panel floats over the canvas and a drag has to start inside it and end on
 * the canvas behind it, which used to be the argument *for* native drag
 * (grid.js's move handle used to reason the same way, before it hit the
 * problem below). It's now the argument against: native drag-and-drop's
 * dragstart only fires if the browser's own gesture recogniser decides a
 * given mousedown-then-move is a drag, and confirmed against the pywebview
 * desktop wrapper (WKWebView), a real mouse-driven press-move-release
 * sequence on a `draggable` element never promotes to a `dragstart` there --
 * the element just doesn't move. Dispatching a `DragEvent` by hand works
 * fine (that only proves the drop/dataTransfer handling is correct, which it
 * is), but that isn't what a real drag does, and the app has no way to tell
 * a real user gesture from a synthetic one. Pointer events carry no such
 * promotion step -- a pointerdown is a pointerdown -- and behave identically
 * in Chrome and WKWebView, which is exactly why nodes.js was already built
 * on them for moving things once they're on the canvas.
 *
 * Which widgets are offered is registry.js's canvasEligible and nothing else
 * -- the same container/permanent flags the homepage grid reads, so a widget
 * that may not sit on the canvas can never appear here by being forgotten.
 */

import { makeBarThumb } from "../../shared/cards.js";
import { all as allWidgetDefinitions } from "../registry.js";

// Roughly half a default node, so a click-to-add lands centred on the view
// rather than with its corner at the middle of the screen. Approximate on
// purpose: the exact size depends on the kind, and being a few pixels out is
// invisible on a canvas with no grid to line up against.
const CENTRE_NUDGE = { x: 110, y: 80 };
// Successive adds without moving the view step down and right instead of
// landing on top of each other.
const CASCADE_STEP = 26;
const CASCADE_WRAP = 6;

// A press has to travel this far before it counts as a drag rather than a
// click -- same threshold and same reasoning as nodes.js's own gesture code.
const DRAG_THRESHOLD = 4;

// The drag ghost previews roughly the size a reference node actually gets
// once dropped (nodes.js's own DEFAULT_SIZE.reference.w), not the palette's
// small grid-cell thumbnail. Left unconstrained, the cloned thumbnail's own
// `width: 100%` (sized for a ~90px grid cell) resolves against the ghost's
// unconstrained fixed-position box instead of the cell it came from and
// blows up to whatever the browser's shrink-to-fit fallback happens to be --
// this pins it down explicitly. Height is left to the thumbnail's own 1:1
// aspect-ratio rather than also forcing nodes.js's mismatched card height
// (200x236), which would leave dead space under a square image.
const REFERENCE_GHOST_WIDTH = 200;

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

  // --- shared drag machinery -------------------------------------------------

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

  /** Whether `clientX,clientY` lands on the canvas itself, as opposed to
   *  back on this floating panel (or its own FAB) -- releasing over the
   *  panel is how a drag is cancelled, the same as dragging a file back onto
   *  its own folder to abort a move. elementFromPoint, not a bounding-box
   *  check: the panel floats *over* the canvas at a fixed screen position,
   *  so the canvas's own rect covers that same area and can't tell the two
   *  apart on its own. */
  function isOverCanvas(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    return Boolean(el && viewport.container.contains(el));
  }

  function makeGhost(sourceEl, width) {
    const ghost = document.createElement("div");
    ghost.className = "canvas-drag-ghost";
    const clone = sourceEl.cloneNode(true);
    // Explicit, not left to the clone's own CSS -- see REFERENCE_GHOST_WIDTH.
    // Set on the clone itself, not just the ghost wrapper: a cloned <button>
    // turns out not to reliably fill a block-level parent's width the way a
    // <div> would, even with this codebase's own `display: block` reset on
    // it (confirmed by hand -- the wrapper measured a correct 200px while
    // the button clone inside it collapsed to 1px, and setting the button's
    // own width directly is what actually fixed it). Left unset for a widget
    // button: its content is a text label, which sizes itself to fit and has
    // no percentage-width child to collapse in the first place.
    if (width) {
      ghost.style.width = `${width}px`;
      clone.style.width = `${width}px`;
      clone.style.boxSizing = "border-box";
    }
    ghost.appendChild(clone);
    document.body.appendChild(ghost);
    return ghost;
  }

  function moveGhost(ghost, clientX, clientY) {
    // The offset and scale live here, in the same inline transform, rather
    // than the stylesheet: an element's own inline style always wins over a
    // CSS rule for the same property outright rather than merging with it,
    // so a `transform` set on every pointermove would otherwise silently
    // erase the CSS one that shrinks and drops a shadow under the ghost.
    ghost.style.transform = `translate3d(${clientX + 14}px, ${clientY + 14}px, 0) scale(0.92)`;
  }

  /** Wire `el` so a plain click adds via `onClick` and a real drag past the
   *  threshold adds via `onDrop(worldPoint)` at the exact release point --
   *  but only when the release lands on the canvas; releasing back over the
   *  panel cancels with no effect, same as any other drag-to-cancel. Only
   *  one of the two ever fires for a given press: a click listener would
   *  double up with the "didn't move" branch below, so there is no separate
   *  click listener at all -- this owns the whole gesture. */
  function makeDraggable(el, { onClick, onDrop, ghostWidth }) {
    // A reference thumbnail is mostly an <img>, and browsers make images
    // (and links) natively draggable by default -- left alone, pressing down
    // and moving over one starts the browser's own drag-the-image gesture at
    // the same time as the pointer gesture below, and the two fight: the
    // native one wins, and what should have been a clean pointerup becomes a
    // pointercancel with neither onDrop nor onClick ever called. Squashed at
    // the source rather than hunting down which descendant is draggable.
    el.addEventListener("dragstart", (event) => event.preventDefault());

    el.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) return;

      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;
      let ghost = null;

      function onMove(moveEvent) {
        if (!active) {
          const moved =
            Math.abs(moveEvent.clientX - startX) >= DRAG_THRESHOLD ||
            Math.abs(moveEvent.clientY - startY) >= DRAG_THRESHOLD;
          if (!moved) return;
          active = true;
          ghost = makeGhost(el, ghostWidth);
          el.classList.add("is-dragging");
        }
        moveGhost(ghost, moveEvent.clientX, moveEvent.clientY);
        viewport.container.classList.toggle(
          "is-drop-target",
          isOverCanvas(moveEvent.clientX, moveEvent.clientY)
        );
      }

      function onUp(upEvent) {
        cleanup();
        if (active) {
          if (isOverCanvas(upEvent.clientX, upEvent.clientY)) {
            onDrop(viewport.screenToWorld(upEvent.clientX, upEvent.clientY));
          }
        } else {
          onClick();
        }
      }

      function onCancel() {
        cleanup();
      }

      function cleanup() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
        ghost?.remove();
        el.classList.remove("is-dragging");
        viewport.container.classList.remove("is-drop-target");
      }

      // Listeners first, capture second -- not the other order. Confirmed
      // against the pywebview wrapper: WKWebView can throw NotFoundError out
      // of setPointerCapture (nodes.js's own gesture code happens to survive
      // this because its window listeners are already registered once at
      // module load, before any gesture starts; this one registers them
      // per-gesture, so getting the order backwards here left the drag
      // permanently dead on arrival there -- the throw skipped every line
      // after it, and the three addEventListener calls never ran). Wrapped
      // in try/catch too, on top of the reorder, since a capture that fails
      // is still fine to proceed without: cleanup()'s own release is already
      // guarded by hasPointerCapture, so a no-op capture just means this
      // gesture rides on bubbling instead of capture, same as it would if
      // the pointer never leaves `el` at all.
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        // Ignored -- see above.
      }
    });
  }

  // --- add buttons -----------------------------------------------------------

  function addButton(label, fields) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn canvas-dock-add";
    btn.textContent = label;
    btn.addEventListener("click", () => addNode({ ...fields, ...nextPoint() }));
    return btn;
  }

  // A drag source landing at the exact drop point, click-to-add as the
  // fallback -- NOT addButton() plus makeDraggable() layered on top: that
  // used to add a native "click" listener (addButton's own) *and*
  // makeDraggable's pointer-driven click-equivalent to the same button, and
  // both fired. For a plain click that meant two nodes every time; for a
  // real drag it meant the browser's own trailing "click" event still landed
  // on the button afterward and fired the stale listener a second time,
  // dropping a second widget at nextPoint() while the first sat correctly
  // wherever the drag ended. One button, one gesture-owning listener, same
  // as the reference picker below.
  //
  // Text stays plain addButton() (click-only, no drag): a simple text node
  // has no particular place it belongs on the canvas the way a widget or a
  // reference does, so a precise drop point buys it nothing. Do not add rich
  // text to Simple text either -- see the addRow comment below, a separate
  // rule this one isn't.
  function addDraggableButton(label, fields) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn canvas-dock-add canvas-dock-draggable";
    btn.textContent = label;
    makeDraggable(btn, {
      onClick: () => addNode({ ...fields, ...nextPoint() }),
      onDrop: (point) => addNode({ ...fields, ...point }),
    });
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
      addDraggableButton(definition.label, { kind: "widget", config: { type: definition.type } })
    );
  }
  addSection.appendChild(addRow);
  panel.appendChild(addSection);

  // --- the reference picker ----------------------------------------------

  const refSection = document.createElement("div");
  refSection.className = "canvas-dock-section";
  const refHeading = document.createElement("p");
  refHeading.className = "muted canvas-dock-heading";
  refHeading.textContent = "Drag a reference onto the canvas, or click to add it centred";
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
      // A button, not a bare div: click-to-add is this item's keyboard and
      // screen-reader path, and only a real control can be focused and
      // activated without a pointer.
      const item = document.createElement("button");
      item.type = "button";
      item.className = "canvas-dock-ref";
      item.title = ref.title;
      item.appendChild(makeBarThumb(ref));
      const fields = { kind: "reference", reference_id: ref.id };
      makeDraggable(item, {
        onClick: () => addNode({ ...fields, ...nextPoint() }),
        onDrop: (point) => addNode({ ...fields, ...point }),
        ghostWidth: REFERENCE_GHOST_WIDTH,
      });
      refList.appendChild(item);
    }
    empty.hidden = matches.length > 0;
    refList.hidden = matches.length === 0;
  }

  search.addEventListener("input", () => renderReferences(search.value));
  renderReferences();

  container.appendChild(panel);
  container.appendChild(fab);

  return {
    destroy() {
      panel.remove();
      fab.remove();
    },
  };
}
