/* The settings widget: permanent, movable, never deletable.
 *
 * "Project Settings" used to be a modal opened from here, with its own
 * "Edit Layout" button one click further in. Now the gear *is* the edit
 * button -- clicking it jumps straight into layout-edit mode (host.shell,
 * the narrow controller main.js hands specifically to this widget for
 * page-level actions -- see registry.js's mountWidget). Everything the old
 * modal held has a new home reachable from edit mode itself: Add Widget is
 * the dock (widget-dock.js), Appearance is a section of the shared top bar
 * (appearance-panel.js), and Save/Cancel is the floating edit bar main.js
 * already renders.
 *
 * config: unused -- nothing here is this widget's own state to persist.
 *
 * Folder management (folders-panel.js) hangs off this widget too: folders
 * are project data rather than layout, so unlike Add Widget/Appearance they
 * don't belong to edit mode -- a second button opens that modal directly.
 */

import { openFoldersModal } from "../folders-panel.js";

export default {
  type: "settings",
  label: "Settings",
  container: false,
  permanent: true,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },

  create(host) {
    const wrap = document.createElement("div");
    wrap.className = "widget-settings";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn widget-settings-btn";
    openBtn.setAttribute("aria-label", "Edit project layout");
    openBtn.title = "Edit project layout";
    openBtn.textContent = "⚙";
    openBtn.addEventListener("click", () => host.shell.enterEdit());
    wrap.appendChild(openBtn);

    const foldersBtn = document.createElement("button");
    foldersBtn.type = "button";
    foldersBtn.className = "btn widget-settings-btn";
    foldersBtn.setAttribute("aria-label", "Manage folders");
    foldersBtn.title = "Manage folders";
    foldersBtn.textContent = "🗀";
    foldersBtn.addEventListener("click", () => openFoldersModal(host.project.id));
    wrap.appendChild(foldersBtn);

    host.el.appendChild(wrap);

    return {
      destroy() {
        wrap.remove();
      },
    };
  },
};
