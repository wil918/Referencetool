/* The infinite canvas page (#page=canvas), the counterpart to the homepage
 * grid.
 *
 * This module is the assembly: it loads the canvas, hands the four pieces to
 * each other and owns the page's own chrome. The pieces themselves are
 * deliberately ignorant of one another --
 *
 *   canvas/viewport.js  where the world is, and nothing about what is in it
 *   canvas/nodes.js     what is in it, and nothing about where the view is
 *                       except through the viewport's two conversions
 *   canvas/edges.js     the threads between nodes
 *   canvas/store.js     every write, and when
 *   canvas/palette.js   how things get added
 *
 * Full bleed: the canvas takes the whole viewport (style.css pins it), which
 * is the same "no chrome inside a project" rule the shell already follows --
 * the only permanent controls are the back arrow main.js's router pins to the
 * corner, the add dock, and the zoom cluster.
 */

import { createViewport } from "../canvas/viewport.js";
import { createStore } from "../canvas/store.js";
import { createNodes } from "../canvas/nodes.js";
import { createPalette } from "../canvas/palette.js";
import { createConceptPanel } from "./concept-panel.js";
import { ensureOverlays, setActiveReferences } from "./overlays.js";

const ZOOM_STEP = 1.25;
// Roughly half a default text node, so a placed critique lands centred on the
// view rather than with its corner at the middle of the screen (same nudge
// palette.js uses for a click-to-add).
const NOTE_NUDGE = { x: 120, y: 60 };

export function createCanvasPage(el, { project }) {
  // The reference carousel a double-clicked reference node opens lives in
  // markup this builds once per document.
  ensureOverlays();

  el.innerHTML = "";

  const root = document.createElement("div");
  root.className = "canvas-page";

  // Left unclassed: createViewport marks it .canvas-viewport, so the element
  // carries exactly one name and it is the one the module that owns it gave.
  const surface = document.createElement("div");
  root.appendChild(surface);

  const status = document.createElement("p");
  status.className = "muted canvas-status";
  root.appendChild(status);

  const hint = document.createElement("p");
  hint.className = "muted canvas-hint";
  hint.textContent =
    "Nothing on the canvas yet — open + to add simple text or a widget, or drag a reference in.";
  hint.hidden = true;
  root.appendChild(hint);

  el.appendChild(root);

  let nodes = null;
  let palette = null;
  let destroyed = false;

  function setStatus(message) {
    status.textContent = message || "";
  }

  /* The zoom cluster, built before the viewport that drives it: createViewport
   * applies its transform immediately, which calls onChange, which reads the
   * readout below. The buttons' own handlers close over `viewport` and only
   * run on a click, long after it exists. */

  const controls = document.createElement("div");
  controls.className = "canvas-view-controls";

  function viewButton(label, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "canvas-view-btn";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  const zoomLabel = document.createElement("span");
  zoomLabel.className = "canvas-view-zoom";

  function showZoom(scale) {
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  }

  controls.appendChild(viewButton("−", "Zoom out", () => viewport.zoomBy(1 / ZOOM_STEP)));
  controls.appendChild(zoomLabel);
  controls.appendChild(viewButton("+", "Zoom in", () => viewport.zoomBy(ZOOM_STEP)));
  // Getting lost is the one hazard of a canvas with no edges; this is the way
  // back to whatever is actually on it.
  controls.appendChild(
    viewButton("⌖", "Show everything", () => {
      viewport.setTransform({ scale: 1 });
      viewport.showBounds(nodes?.bounds());
    })
  );
  root.appendChild(controls);

  const viewport = createViewport(surface, { onChange: ({ scale }) => showZoom(scale) });
  const store = createStore(project.id);
  store.setErrorHandler(setStatus);

  // --- concept analysis ---------------------------------------------------
  //
  // The marquee is the picker: nodes.selection() is split into the visual
  // research (reference nodes) and the thinking about it (text nodes), widget
  // nodes dropped. An empty selection runs against the whole project. The
  // critique comes back onto the canvas as a text node, centred on the view.

  function worldCentre() {
    const rect = viewport.container.getBoundingClientRect();
    const point = viewport.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { x: point.x - NOTE_NUDGE.x, y: point.y - NOTE_NUDGE.y };
  }

  const concept = createConceptPanel({
    project,
    placeNote: (text) => nodes?.addNode({ kind: "text", content: text, ...worldCentre() }),
  });

  const conceptBtn = document.createElement("button");
  conceptBtn.type = "button";
  conceptBtn.className = "canvas-concept-btn";
  conceptBtn.textContent = "Concept analysis";
  conceptBtn.title = "Critique the selected research against the brief (whole project if nothing is selected)";
  conceptBtn.addEventListener("click", () => {
    const selected = nodes ? nodes.selection() : [];
    concept.run({
      referenceIds: selected.filter((n) => n.kind === "reference" && n.reference_id).map((n) => n.reference_id),
      notes: selected.filter((n) => n.kind === "text").map((n) => n.content || ""),
    });
  });
  root.appendChild(conceptBtn);

  // --- boot ----------------------------------------------------------------

  async function boot() {
    setStatus("Loading canvas…");

    let references = [];
    let canvas = { nodes: [], edges: [] };
    try {
      const [projectRes, loaded] = await Promise.all([
        fetch(`/api/projects/${project.id}`),
        store.load(),
      ]);
      if (projectRes.ok) references = (await projectRes.json()).references || [];
      canvas = loaded;
    } catch (err) {
      if (destroyed) return;
      setStatus(err.message || "Couldn't load the canvas.");
      return;
    }
    if (destroyed) return;

    setStatus("");
    setActiveReferences(references);

    nodes = createNodes({
      viewport,
      store,
      project,
      references,
      onStatus: setStatus,
      onCountChange: (count) => {
        hint.hidden = count > 0;
      },
    });
    nodes.setData(canvas);

    // Land on the content rather than at the world origin: a board built
    // after panning a long way from it would otherwise open on empty space.
    viewport.showBounds(nodes.bounds());
    hint.hidden = nodes.count() > 0;

    palette = createPalette({ container: root, viewport, references, addNode: nodes.addNode });
  }

  boot();

  return {
    destroy() {
      destroyed = true;
      concept.destroy();
      palette?.destroy();
      nodes?.destroy();
      viewport.destroy();
      // Flushes anything a just-finished drag left in the queue -- leaving
      // the page is as final as closing the tab, as far as an edit is
      // concerned.
      store.destroy();
      root.remove();
    },
  };
}
