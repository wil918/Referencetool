/* The way into the project's infinite canvas (project/pages/canvas-page.js).
 *
 * An anchor rather than a button, same reasoning as exit.js and
 * grid-button.js: this is in-page navigation -- a hash route on project.html,
 * walked by main.js's router -- so it should behave like navigation, land in
 * the back history and be openable in a new tab.
 *
 * Permanent: every project is seeded with one (db.py's DEFAULT_WIDGETS) and
 * the API refuses to delete it, because a project whose canvas had no door
 * left would have no way back to what is on it. It can be moved and resized
 * anywhere on the homepage like anything else.
 *
 * config: unused -- there is exactly one canvas per project, so this widget
 * has no state of its own to persist.
 */

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
    const wrap = document.createElement("div");
    wrap.className = "widget-canvas";

    const link = document.createElement("a");
    link.className = "btn";
    link.href = "#page=canvas";
    link.title = "Open the canvas";
    link.textContent = "Canvas";
    wrap.appendChild(link);

    host.el.appendChild(wrap);

    return {
      destroy() {
        wrap.remove();
      },
    };
  },
};
