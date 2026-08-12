/* The way into the project's infinite canvas (project/pages/canvas-page.js).
 *
 * An anchor rather than a button, same reasoning as exit.js and
 * grid-button.js: this is in-page navigation -- a hash route on project.html,
 * walked by main.js's router -- so it should behave like navigation, land in
 * the back history and be openable in a new tab. The anchor now fills the
 * whole tile rather than sitting as a small pill in the middle of it, because
 * its content is the miniature below -- the whole widget stays one link to
 * #page=canvas, there is just more of it to look at before you click.
 *
 * The miniature is deliberately cheap: an SVG built once from
 * GET /api/projects/<pid>/canvas and once more on every resize, never a live
 * subscription and never Three.js. It draws structure, not detail -- nodes as
 * blocks (a reference node's own thumbnail where it has one) at their stored
 * world positions, edges as thin lines between node centres. Nothing in it
 * takes a pointer event: no pan, no zoom, no drag, no click target of its own,
 * so a stray click anywhere on the tile always does the one thing this widget
 * has ever done, which is open the canvas.
 *
 * Permanent: every project is seeded with one (db.py's DEFAULT_WIDGETS) and
 * the API refuses to delete it, because a project whose canvas had no door
 * left would have no way back to what is on it. It can be moved and resized
 * anywhere on the homepage like anything else.
 *
 * config: unused -- there is exactly one canvas per project, so this widget
 * has no state of its own to persist.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** The world-space box every node fits inside -- same shape as
 *  canvas/nodes.js's own bounds(), recomputed here rather than shared since
 *  this is the only other place that needs it and canvas/nodes.js's version
 *  reads from its live entries map, not a plain node list. */
function computeBounds(nodes) {
  if (!nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const w = Number(node.w) || 0;
    const h = Number(node.h) || 0;
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + w);
    maxY = Math.max(maxY, node.y + h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export default {
  type: "canvas",
  label: "Canvas",
  container: false,
  permanent: true,
  // Matches the seeded row in db.py's DEFAULT_WIDGETS, so a canvas widget
  // added back to a homepage arrives the size the original was.
  defaultSize: { w: 6, h: 4 },
  minSize: { w: 1, h: 1 },

  create(host) {
    const projectId = host.project.id;

    const link = document.createElement("a");
    link.className = "widget-canvas-preview-link";
    link.href = "#page=canvas";
    link.title = "Open the canvas";

    const svgWrap = document.createElement("div");
    svgWrap.className = "widget-canvas-preview";
    link.appendChild(svgWrap);

    const caption = document.createElement("span");
    caption.className = "widget-canvas-preview-caption";
    caption.textContent = "Canvas";
    link.appendChild(caption);

    host.el.appendChild(link);

    let data = null; // { nodes, edges }, fetched once and reused by every render

    function renderEmpty() {
      svgWrap.innerHTML = "";
      const empty = document.createElement("p");
      empty.className = "muted widget-canvas-preview-empty";
      empty.textContent = "Nothing on the canvas yet.";
      svgWrap.appendChild(empty);
    }

    function render() {
      if (!data) return;
      const nodes = data.nodes || [];
      const bounds = computeBounds(nodes);
      if (!bounds) {
        renderEmpty();
        return;
      }

      svgWrap.innerHTML = "";
      // A little breathing room around the content -- proportional to its
      // own size, so a tiny cluster of nodes and a sprawling board both read
      // with the same margin relative to what's actually there.
      const pad = Math.max(bounds.w, bounds.h, 1) * 0.08;
      const svg = svgEl("svg", {
        viewBox: `${bounds.x - pad} ${bounds.y - pad} ${bounds.w + pad * 2} ${bounds.h + pad * 2}`,
        preserveAspectRatio: "xMidYMid meet",
      });
      svg.setAttribute("aria-hidden", "true");

      const byId = new Map(nodes.map((node) => [node.id, node]));
      for (const edge of data.edges || []) {
        const source = byId.get(edge.source_node_id);
        const target = byId.get(edge.target_node_id);
        if (!source || !target) continue;
        svg.appendChild(
          svgEl("line", {
            class: "widget-canvas-preview-edge",
            x1: source.x + (Number(source.w) || 0) / 2,
            y1: source.y + (Number(source.h) || 0) / 2,
            x2: target.x + (Number(target.w) || 0) / 2,
            y2: target.y + (Number(target.h) || 0) / 2,
          })
        );
      }

      for (const node of nodes) {
        const w = Number(node.w) || 0;
        const h = Number(node.h) || 0;
        const rx = Math.min(w, h) * 0.12;
        if (node.kind === "reference" && node.reference_id) {
          const image = svgEl("image", {
            class: "widget-canvas-preview-thumb",
            x: node.x,
            y: node.y,
            width: w,
            height: h,
            href: `/media/${node.reference_id}/thumb`,
            preserveAspectRatio: "xMidYMid slice",
          });
          // A text/PDF reference (or one deleted since) has no thumbnail --
          // falls back to the same plain block every other node kind draws,
          // rather than leaving a broken-image icon in the miniature.
          image.addEventListener("error", () => {
            image.replaceWith(
              svgEl("rect", {
                class: "widget-canvas-preview-block widget-canvas-preview-reference",
                x: node.x,
                y: node.y,
                width: w,
                height: h,
                rx,
              })
            );
          });
          svg.appendChild(image);
        } else {
          svg.appendChild(
            svgEl("rect", {
              class: `widget-canvas-preview-block widget-canvas-preview-${node.kind}`,
              x: node.x,
              y: node.y,
              width: w,
              height: h,
              rx,
            })
          );
        }
      }

      svgWrap.appendChild(svg);
    }

    async function load() {
      try {
        const res = await fetch(`/api/projects/${projectId}/canvas`);
        data = res.ok ? await res.json() : { nodes: [], edges: [] };
      } catch {
        data = { nodes: [], edges: [] };
      }
      render();
    }

    // Cheap enough to just rebuild -- see the module comment for why this
    // doesn't re-fetch or subscribe to anything.
    host.onResize(() => render());

    load();

    return {
      destroy() {
        link.remove();
      },
    };
  },
};
