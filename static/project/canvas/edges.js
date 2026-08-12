/* The connections drawn between canvas nodes.
 *
 * One SVG element inside the world layer, holding one line per edge. Because
 * it is inside the layer, edge geometry is written in world coordinates and
 * the viewport's single transform carries it exactly as it carries the nodes
 * -- there is no separate projection to keep in step, and a pan or zoom
 * touches nothing in here at all.
 *
 * The SVG has no useful size of its own (the world it draws into is
 * unbounded, and its coordinates are routinely negative), so it is a 1x1 box
 * at the world origin with overflow visible. An SVG root clips to its
 * viewport by default, which for a 1x1 box would mean drawing nothing.
 *
 * Two lines per edge: a hairline that is what you see, and a fat transparent
 * one underneath that is what you can hit. A 1px target is not clickable, and
 * thickening the visible line to make it so would turn every connection into
 * a rope. Both carry vector-effect="non-scaling-stroke" so a thread stays a
 * thread at 4x and is still findable at 0.1x -- stroke width is the one
 * dimension here that should not scale with the world.
 *
 * Both lines are <path>, not <line>, even for the straight case: a straight
 * edge is just an "M ... L ..." path, and sharing one element type between
 * shapes means switching an edge from straight to curved is a `d` rewrite,
 * not a swap of DOM element kind.
 *
 * Per-edge style (colour, arrowhead, shape) lives on `edge.style`, the JSON
 * blob canvas_edges.style persists. Colour is deliberately *not* written as
 * an inline style unless the edge has been explicitly recoloured: leaving
 * `line.style.stroke` empty falls through to style.css's
 * `.canvas-edge-line { stroke: var(--accent); }`, so an edge that has never
 * been styled tracks the project accent for free, live, with no listener of
 * our own -- the CSS custom property does the following. Only setStyle()
 * writing an explicit colour breaks that link, which is exactly the
 * "explicitly coloured edges keep their own value" rule.
 *
 * Arrowheads are one shared <marker>, referenced by every edge that wants
 * one, whose arrowhead path has fill="context-stroke" -- an SVG2 keyword
 * that paints the marker with whatever the referencing path's own used
 * stroke colour is. That means the marker never needs recolouring by hand
 * either: it inherits the same accent-or-explicit colour the line just
 * resolved, automatically, including when the accent changes under an
 * unstyled edge.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

// Unique per layer instance so two canvases on one page (unlikely today, but
// nothing stops it) don't reference each other's marker.
let layerCount = 0;

export function createEdgeLayer(world, { onSelect } = {}) {
  const markerId = `canvas-edge-arrow-${++layerCount}`;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "canvas-edges");
  svg.setAttribute("width", "1");
  svg.setAttribute("height", "1");
  world.appendChild(svg);

  // Sized in world units (markerUnits="userSpaceOnUse"), so the arrowhead
  // scales with the world exactly like everything else drawn into it, rather
  // than staying a fixed screen size the way the non-scaling stroke does.
  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", markerId);
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "10");
  marker.setAttribute("markerHeight", "10");
  marker.setAttribute("markerUnits", "userSpaceOnUse");
  // auto-start-reverse only affects marker-start (rotating it 180deg from
  // auto); marker-end is unaffected. That is exactly what a shared marker
  // needs to look right whichever end it is placed on: pointing away from
  // the path's own direction of travel at the start, and along it at the end.
  marker.setAttribute("orient", "auto-start-reverse");
  const arrowhead = document.createElementNS(SVG_NS, "path");
  arrowhead.setAttribute("d", "M0,0 L10,5 L0,10 z");
  arrowhead.setAttribute("fill", "context-stroke");
  marker.appendChild(arrowhead);
  defs.appendChild(marker);
  svg.appendChild(defs);

  // The line that follows the pointer while a connection is being drawn. It
  // belongs to no edge and is never persisted -- it exists between pointerdown
  // on a connector and pointerup on a target. Left as a plain <line>: a draft
  // has no style to preview, so it never needs the path machinery below.
  const draft = document.createElementNS(SVG_NS, "line");
  draft.setAttribute("class", "canvas-edge-draft");
  draft.setAttribute("vector-effect", "non-scaling-stroke");
  draft.style.display = "none";
  svg.appendChild(draft);

  const entries = new Map(); // edge id -> { edge, group, hit, line, from, to }
  let selectedId = null;

  /* A cubic whose control points are offset along whichever axis the
   * connection runs along more -- horizontal for a mostly-sideways edge,
   * vertical for a mostly-up-down one. That is what keeps two crossing
   * curved edges legible instead of both bowing the same way regardless of
   * their own direction. */
  function pathD(from, to, shape) {
    if (shape !== "curved") return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let c1, c2;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const offset = dx / 2;
      c1 = { x: from.x + offset, y: from.y };
      c2 = { x: to.x - offset, y: to.y };
    } else {
      const offset = dy / 2;
      c1 = { x: from.x, y: from.y + offset };
      c2 = { x: to.x, y: to.y - offset };
    }
    return `M ${from.x} ${from.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`;
  }

  const styleOf = (edge) => edge.style || {};

  function redraw(entry) {
    const shape = styleOf(entry.edge).shape === "curved" ? "curved" : "straight";
    const d = pathD(entry.from, entry.to, shape);
    entry.hit.setAttribute("d", d);
    entry.line.setAttribute("d", d);
  }

  // Empty string, not a removed attribute: an empty inline stroke falls
  // through to the CSS class's var(--accent), which is the whole "follow the
  // accent" mechanism described above.
  function applyColour(entry) {
    entry.line.style.stroke = styleOf(entry.edge).colour || "";
  }

  function applyArrowhead(entry) {
    const mode = styleOf(entry.edge).arrowhead || "none";
    entry.line.removeAttribute("marker-start");
    entry.line.removeAttribute("marker-end");
    if (mode === "target") entry.line.setAttribute("marker-end", `url(#${markerId})`);
    else if (mode === "source") entry.line.setAttribute("marker-start", `url(#${markerId})`);
  }

  function add(edge, from, to) {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "canvas-edge");

    const hit = document.createElementNS(SVG_NS, "path");
    hit.setAttribute("class", "canvas-edge-hit");
    hit.setAttribute("fill", "none");
    hit.setAttribute("vector-effect", "non-scaling-stroke");

    // Markers go on the visible line only -- the hit path is transparent and
    // exists purely to be wide enough to click.
    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("class", "canvas-edge-line");
    line.setAttribute("fill", "none");
    line.setAttribute("vector-effect", "non-scaling-stroke");

    group.appendChild(hit);
    group.appendChild(line);
    // Before the draft line, so a connection being drawn stays on top of the
    // ones already there.
    svg.insertBefore(group, draft);

    group.addEventListener("pointerdown", (event) => {
      // Otherwise the press falls through to the viewport, which would read a
      // click on a thread as a click on empty space and start a pan.
      event.stopPropagation();
      onSelect?.(edge.id);
    });

    const entry = { edge, group, hit, line, from, to };
    entries.set(edge.id, entry);
    redraw(entry);
    applyColour(entry);
    applyArrowhead(entry);
  }

  /** Move one edge's endpoints. Called for every edge touching a node being
   *  dragged or resized, and for nothing else. */
  function update(edgeId, from, to) {
    const entry = entries.get(edgeId);
    if (!entry) return;
    entry.from = from;
    entry.to = to;
    redraw(entry);
  }

  /** Merge a style patch into one edge and re-render it. A key set to `null`
   *  (colour, to drop back to following the accent) clears explicitly rather
   *  than being left out -- callers always pass the field they mean to
   *  change. Returns the edge's full, merged style object, which is what the
   *  caller persists. */
  function setStyle(edgeId, patch) {
    const entry = entries.get(edgeId);
    if (!entry) return null;
    entry.edge.style = { ...styleOf(entry.edge), ...patch };
    redraw(entry);
    applyColour(entry);
    applyArrowhead(entry);
    return entry.edge.style;
  }

  function remove(edgeId) {
    const entry = entries.get(edgeId);
    if (!entry) return;
    entry.group.remove();
    entries.delete(edgeId);
    if (selectedId === edgeId) selectedId = null;
  }

  function select(edgeId) {
    if (selectedId === edgeId) return;
    entries.get(selectedId)?.group.classList.remove("is-selected");
    selectedId = edgeId;
    entries.get(selectedId)?.group.classList.add("is-selected");
  }

  function showDraft(from, to) {
    draft.setAttribute("x1", from.x);
    draft.setAttribute("y1", from.y);
    draft.setAttribute("x2", to.x);
    draft.setAttribute("y2", to.y);
    draft.style.display = "";
  }

  function hideDraft() {
    draft.style.display = "none";
  }

  return {
    add,
    update,
    setStyle,
    remove,
    select,
    has: (edgeId) => entries.has(edgeId),
    get: (edgeId) => entries.get(edgeId)?.edge || null,
    list: () => [...entries.values()].map((entry) => entry.edge),
    getSelected: () => selectedId,
    showDraft,
    hideDraft,
    destroy() {
      entries.clear();
      svg.remove();
    },
  };
}
