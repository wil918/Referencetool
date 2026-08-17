/* The project's whole reference grid, embedded as a widget instead of
 * navigated to -- grid-button.js is the link to pages/grid-page.js; this
 * mounts the exact same page component directly into the widget's own
 * element, so selection, delete, colour similarity and analyze all behave
 * identically to the full page. Nothing here is a second copy: the heading,
 * toolbar, grid and modals are all built by createGridPage itself.
 *
 * defaultSize is large on purpose -- this is meant to dominate a homepage,
 * not sit alongside a handful of small tiles.
 *
 * canvasEligible: false. The canvas already has its own ways of holding
 * references (reference nodes, folders), and an embedded page with its own
 * internal scroll would fight the canvas's pan/zoom viewport transform.
 *
 * config: unused, same reasoning as grid-button.js -- there's exactly one
 * grid per project, nothing here is this widget's own state to persist.
 *
 * One shared limitation worth knowing about, not worth solving here:
 * createGridPage's Analyze modal carries a fixed id (analysis-panel.js's
 * #analyze-overlay, used by pages/overlays.js to close it on a ref-link
 * click). A homepage widget stays mounted while the user is on a
 * hash-routed page, so this widget and, say, the full grid page can both be
 * live at once, each with their own Analyze modal sharing that id -- a
 * ref-link click while both happen to be mid-conversation could close the
 * wrong one. Cosmetic and narrow enough (two Analyze conversations open in
 * two places at once) not to be worth restructuring the shared panel's
 * contract over.
 */

import { createGridPage, projectGridDeleteBehaviour } from "../pages/grid-page.js";

export default {
  type: "all-references",
  label: "Reference Grid",
  container: false,
  permanent: false,
  canvasEligible: false,
  defaultSize: { w: 16, h: 8 },
  minSize: { w: 6, h: 4 },

  create(host) {
    // .widget-body clips to the widget's rounded box (style.css); this
    // wrapper is what actually scrolls inside that clip, so a long reference
    // list never grows the widget or pushes anything else on the grid.
    const wrap = document.createElement("div");
    wrap.className = "widget-all-references";
    host.el.appendChild(wrap);

    const page = createGridPage(wrap, {
      project: host.project,
      heading: host.project.title,
      subheading: "All references in this project -- folders are just a view, nothing here is filtered by them.",
      emptyMessage: "No references in this project yet. Add some from the Archive page.",
      colourSource: "archive",
      async load() {
        const res = await fetch(`/api/projects/${host.project.id}`);
        const data = await res.json();
        // Kept in step so a rename made elsewhere (the title widget) shows
        // up here without waiting for a reload -- same as main.js's own
        // grid page route does.
        host.project.title = data.title;
        host.project.description = data.description;
        return data.references;
      },
      deleteBehaviour: projectGridDeleteBehaviour(host.project.id),
    });

    return {
      destroy() {
        page.destroy();
        wrap.remove();
      },
    };
  },
};
