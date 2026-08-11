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
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export function createEdgeLayer(world, { onSelect } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "canvas-edges");
  svg.setAttribute("width", "1");
  svg.setAttribute("height", "1");
  world.appendChild(svg);

  // The line that follows the pointer while a connection is being drawn. It
  // belongs to no edge and is never persisted -- it exists between pointerdown
  // on a connector and pointerup on a target.
  const draft = document.createElementNS(SVG_NS, "line");
  draft.setAttribute("class", "canvas-edge-draft");
  draft.setAttribute("vector-effect", "non-scaling-stroke");
  draft.style.display = "none";
  svg.appendChild(draft);

  const entries = new Map(); // edge id -> { edge, group, line }
  let selectedId = null;

  function setLine(el, from, to) {
    el.setAttribute("x1", from.x);
    el.setAttribute("y1", from.y);
    el.setAttribute("x2", to.x);
    el.setAttribute("y2", to.y);
  }

  function add(edge, from, to) {
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "canvas-edge");

    const hit = document.createElementNS(SVG_NS, "line");
    hit.setAttribute("class", "canvas-edge-hit");
    hit.setAttribute("vector-effect", "non-scaling-stroke");

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "canvas-edge-line");
    line.setAttribute("vector-effect", "non-scaling-stroke");

    group.appendChild(hit);
    group.appendChild(line);
    // Before the draft line, so a connection being drawn stays on top of the
    // ones already there.
    svg.insertBefore(group, draft);

    setLine(hit, from, to);
    setLine(line, from, to);

    group.addEventListener("pointerdown", (event) => {
      // Otherwise the press falls through to the viewport, which would read a
      // click on a thread as a click on empty space and start a pan.
      event.stopPropagation();
      onSelect?.(edge.id);
    });

    entries.set(edge.id, { edge, group, hit, line });
  }

  /** Move one edge's endpoints. Called for every edge touching a node being
   *  dragged, and for nothing else. */
  function update(edgeId, from, to) {
    const entry = entries.get(edgeId);
    if (!entry) return;
    setLine(entry.hit, from, to);
    setLine(entry.line, from, to);
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
    setLine(draft, from, to);
    draft.style.display = "";
  }

  function hideDraft() {
    draft.style.display = "none";
  }

  return {
    add,
    update,
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
