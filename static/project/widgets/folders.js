/* A small grid tile that opens the folder management modal
 * (folders-panel.js). Folders are project data rather than layout, so this
 * doesn't live inside edit mode the way Appearance/Add Widget do -- it's its
 * own widget, positioned and removed independently of the settings widget,
 * the same way sidebar and exit are their own tiles rather than buttons
 * bolted onto something else.
 *
 * Not permanent: unlike settings/exit/canvas this isn't seeded on every new
 * project, so it's addable/removable like title, text and notepad.
 *
 * config: unused -- nothing here is this widget's own state to persist.
 */

import { openFoldersModal } from "../folders-panel.js";

export default {
  type: "folders",
  label: "Folders",
  container: false,
  permanent: false,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },

  create(host) {
    const wrap = document.createElement("div");
    wrap.className = "widget-folders";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn widget-folders-btn";
    openBtn.setAttribute("aria-label", "Manage folders");
    openBtn.title = "Manage folders";
    openBtn.textContent = "🗀";
    openBtn.addEventListener("click", () => openFoldersModal(host.project.id));
    wrap.appendChild(openBtn);

    host.el.appendChild(wrap);

    return {
      destroy() {
        wrap.remove();
      },
    };
  },
};
