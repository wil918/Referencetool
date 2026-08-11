/* A link to the project's grid page (project/pages/grid-page.js), showing
 * every reference in the project regardless of folder -- folders never
 * filter this page, they only ever add a view alongside it.
 *
 * An anchor rather than a button, same reasoning as exit.js: this is
 * in-page navigation (a hash route on project.html -- see project/main.js's
 * router), so it should behave like navigation, not an action.
 *
 * config: unused -- there's exactly one grid page per project, nothing here
 * is this widget's own state to persist.
 */

export default {
  type: "grid-button",
  label: "All References",
  container: false,
  permanent: false,
  defaultSize: { w: 2, h: 1 },
  minSize: { w: 1, h: 1 },

  create(host) {
    const wrap = document.createElement("div");
    wrap.className = "widget-grid-button";

    const link = document.createElement("a");
    link.className = "btn";
    link.href = "#page=grid";
    link.title = "All references in this project";
    link.textContent = "All References";
    wrap.appendChild(link);

    host.el.appendChild(wrap);

    return {
      destroy() {
        wrap.remove();
      },
    };
  },
};
