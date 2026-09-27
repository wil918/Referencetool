/* The small floating editor a click on a shape node opens.
 *
 * One instance per canvas, created once and shown/hidden rather than built
 * and torn down per click -- the same reasoning, and largely the same shape,
 * as edge-style-panel.js: nodes.js decides *when* it is open (exactly one
 * shape node is selected) and *where* (the node's own top edge, converted
 * through viewport.worldToScreen), this module only renders whatever config
 * it is handed and reports edits upward as a patch. It shares
 * edge-style-panel's row/colour/button classes in style.css on purpose --
 * one floating-pill-with-a-colour-swatch visual language, not two.
 *
 * Fill and stroke are independent and both nullable -- an outline-only shape
 * and a fill-only shape are both ordinary requests (the task brief's own
 * words), so each gets its own swatch plus a "no colour" toggle, rather than
 * one control trying to cover both "what colour" and "colour at all".
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

// A swatch, crossed out -- "no colour", the same idea a checkerboard
// transparency pattern signals elsewhere, without needing a second graphic
// language just for this one control.
const NONE_ICON = () => icon(["M5 5h14v14H5z", "M5 19L19 5"]);

export const DEFAULT_FILL = "#c9c2b4";
export const DEFAULT_STROKE = "#2a2a28";
export const DEFAULT_STROKE_WIDTH = 2;

/** One colour row: a swatch plus a toggle for "no colour at all". Shared
 *  shape between the fill row and the stroke row below -- the only
 *  difference between them is the label and which config field they write. */
function colourField(title) {
  const row = document.createElement("div");
  row.className = "edge-style-row edge-style-colour-row shape-style-row";

  const input = document.createElement("input");
  input.type = "color";
  input.className = "edge-style-colour";
  input.title = title;

  const noneBtn = document.createElement("button");
  noneBtn.type = "button";
  noneBtn.className = "edge-style-btn shape-style-none";
  noneBtn.title = `No ${title.toLowerCase()}`;
  noneBtn.setAttribute("aria-label", `No ${title.toLowerCase()}`);
  noneBtn.appendChild(NONE_ICON());

  row.append(input, noneBtn);

  let onPick = () => {};
  let onNone = () => {};
  input.addEventListener("input", () => onPick(input.value));
  noneBtn.addEventListener("click", () => onNone());

  return {
    el: row,
    render(value, fallback) {
      input.value = value || fallback;
      noneBtn.classList.toggle("is-active", !value);
    },
    onColour(fn) {
      onPick = fn;
    },
    onNone(fn) {
      onNone = fn;
    },
  };
}

/* options:
 *   container -- element to mount the (initially hidden) panel into
 *   onChange(nodeId, patch) -- a control was used; patch is the config
 *     fields that changed (fill, stroke or strokeWidth), never the whole
 *     object -- the caller (nodes.js) owns merging it into the node's config
 *     and persisting it, the same division edge-style-panel.js uses.
 */
export function createShapeStylePanel({ container, onChange }) {
  const el = document.createElement("div");
  el.className = "edge-style-panel shape-style-panel";
  el.hidden = true;

  const fill = colourField("Fill");
  const stroke = colourField("Stroke");

  const widthRow = document.createElement("div");
  widthRow.className = "shape-style-row shape-style-width-row";
  const widthLabel = document.createElement("span");
  widthLabel.className = "shape-style-width-label";
  widthLabel.textContent = "Width";
  const widthInput = document.createElement("input");
  widthInput.type = "number";
  widthInput.className = "shape-style-width";
  widthInput.min = "1";
  widthInput.max = "40";
  widthInput.step = "1";
  widthInput.title = "Stroke width";
  widthRow.append(widthLabel, widthInput);

  el.append(fill.el, stroke.el, widthRow);
  container.appendChild(el);

  let currentNodeId = null;

  function render(config) {
    const c = config || {};
    fill.render(c.fill, DEFAULT_FILL);
    stroke.render(c.stroke, DEFAULT_STROKE);
    widthInput.value = c.strokeWidth || DEFAULT_STROKE_WIDTH;
    // Width means nothing without a stroke to apply it to -- disabled rather
    // than hidden, so the row doesn't jump as stroke is toggled on and off.
    widthRow.classList.toggle("is-disabled", !c.stroke);
  }

  fill.onColour((value) => {
    if (!currentNodeId) return;
    onChange(currentNodeId, { fill: value });
    fill.render(value, value);
  });
  fill.onNone(() => {
    if (!currentNodeId) return;
    onChange(currentNodeId, { fill: null });
    fill.render(null, DEFAULT_FILL);
  });

  stroke.onColour((value) => {
    if (!currentNodeId) return;
    onChange(currentNodeId, { stroke: value });
    stroke.render(value, value);
    widthRow.classList.remove("is-disabled");
  });
  stroke.onNone(() => {
    if (!currentNodeId) return;
    onChange(currentNodeId, { stroke: null });
    stroke.render(null, DEFAULT_STROKE);
    widthRow.classList.add("is-disabled");
  });

  widthInput.addEventListener("input", () => {
    if (!currentNodeId) return;
    const value = Math.max(1, Number(widthInput.value) || DEFAULT_STROKE_WIDTH);
    onChange(currentNodeId, { strokeWidth: value });
  });

  function reposition(screenPos) {
    if (el.hidden || !screenPos) return;
    el.style.left = `${screenPos.x}px`;
    el.style.top = `${screenPos.y}px`;
  }

  return {
    show(nodeId, config, screenPos) {
      currentNodeId = nodeId;
      render(config);
      el.hidden = false;
      reposition(screenPos);
    },
    reposition,
    hide() {
      el.hidden = true;
      currentNodeId = null;
    },
    isOpen: () => !el.hidden,
    currentNodeId: () => currentNodeId,
    destroy() {
      el.remove();
    },
  };
}
