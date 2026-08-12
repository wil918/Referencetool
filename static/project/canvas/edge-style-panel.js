/* The small floating editor a click on a connection opens.
 *
 * One instance per canvas, created once and shown/hidden rather than built
 * and torn down per click -- the same reasoning as every other piece of
 * canvas chrome (the view controls, the add dock). It owns no selection
 * state of its own: nodes.js decides *when* it is open (an edge is selected)
 * and *where* (edgeMidpointWorld -> viewport.worldToScreen), this module only
 * renders whatever style object it is handed and reports edits upward.
 *
 * Positioned with `position: fixed` and raw client coordinates, which is what
 * viewport.worldToScreen already returns -- true regardless of where in the
 * DOM this panel's element actually lives, as long as nothing between it and
 * the viewport introduces its own containing block (nothing here does).
 */

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

const ICONS = {
  arrowNone: () => icon(["M4 12h16"]),
  arrowTarget: () => icon(["M4 12h14", "M13 6l6 6-6 6"]),
  arrowSource: () => icon(["M6 12h14", "M11 6l-6 6 6 6"]),
  shapeStraight: () => icon(["M4 12h16"]),
  shapeCurved: () => icon(["M4 18C10 18 8 6 20 6"]),
  reset: () => icon(["M4 4v6h6", "M4.5 15a8 8 0 1 0 2-8.9L4 10"]),
};

function segmented(options) {
  const el = document.createElement("div");
  el.className = "edge-style-group";
  const buttons = options.map(({ value, label, renderIcon }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "edge-style-btn";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.appendChild(renderIcon());
    el.appendChild(btn);
    return { value, btn };
  });

  let onPick = () => {};
  for (const { value, btn } of buttons) {
    btn.addEventListener("click", () => onPick(value));
  }

  return {
    el,
    setActive(value) {
      for (const { value: v, btn } of buttons) btn.classList.toggle("is-active", v === value);
    },
    onSelect(fn) {
      onPick = fn;
    },
  };
}

/* options:
 *   container -- element to mount the (initially hidden) panel into
 *   onChange(edgeId, patch) -- a control was used; patch is the style fields
 *     that changed (colour, arrowhead or shape), never the whole object --
 *     the caller (nodes.js, via edges.js's setStyle) owns merging it in.
 */
export function createEdgeStylePanel({ container, onChange }) {
  const el = document.createElement("div");
  el.className = "edge-style-panel";
  el.hidden = true;

  const colourRow = document.createElement("div");
  colourRow.className = "edge-style-row edge-style-colour-row";
  const colourInput = document.createElement("input");
  colourInput.type = "color";
  colourInput.className = "edge-style-colour";
  colourInput.title = "Line colour";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "edge-style-btn edge-style-reset";
  resetBtn.title = "Match project accent";
  resetBtn.setAttribute("aria-label", "Match project accent");
  resetBtn.appendChild(ICONS.reset());
  colourRow.append(colourInput, resetBtn);

  const arrowGroup = segmented([
    { value: "none", label: "No arrowhead", renderIcon: ICONS.arrowNone },
    { value: "target", label: "Arrow at target end", renderIcon: ICONS.arrowTarget },
    { value: "source", label: "Arrow at source end", renderIcon: ICONS.arrowSource },
  ]);

  const shapeGroup = segmented([
    { value: "straight", label: "Straight", renderIcon: ICONS.shapeStraight },
    { value: "curved", label: "Curved", renderIcon: ICONS.shapeCurved },
  ]);

  el.append(colourRow, arrowGroup.el, shapeGroup.el);
  container.appendChild(el);

  let currentEdgeId = null;

  const projectAccent = () =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#c23b2e";

  function render(style) {
    const s = style || {};
    colourInput.value = s.colour || projectAccent();
    resetBtn.disabled = !s.colour;
    arrowGroup.setActive(s.arrowhead || "none");
    shapeGroup.setActive(s.shape || "straight");
  }

  colourInput.addEventListener("input", () => {
    if (!currentEdgeId) return;
    onChange(currentEdgeId, { colour: colourInput.value });
    resetBtn.disabled = false;
  });

  resetBtn.addEventListener("click", () => {
    if (!currentEdgeId || resetBtn.disabled) return;
    onChange(currentEdgeId, { colour: null });
    colourInput.value = projectAccent();
    resetBtn.disabled = true;
  });

  arrowGroup.onSelect((value) => {
    if (!currentEdgeId) return;
    onChange(currentEdgeId, { arrowhead: value });
    arrowGroup.setActive(value);
  });

  shapeGroup.onSelect((value) => {
    if (!currentEdgeId) return;
    onChange(currentEdgeId, { shape: value });
    shapeGroup.setActive(value);
  });

  function reposition(screenPos) {
    if (el.hidden || !screenPos) return;
    el.style.left = `${screenPos.x}px`;
    el.style.top = `${screenPos.y}px`;
  }

  return {
    show(edgeId, style, screenPos) {
      currentEdgeId = edgeId;
      render(style);
      el.hidden = false;
      reposition(screenPos);
    },
    reposition,
    hide() {
      el.hidden = true;
      currentEdgeId = null;
    },
    isOpen: () => !el.hidden,
    currentEdgeId: () => currentEdgeId,
    destroy() {
      el.remove();
    },
  };
}
