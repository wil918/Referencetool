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
 * Folder management lives in its own widget (widgets/folders.js) rather
 * than a second button here -- it's project data, not layout, and keeping
 * it a separate tile means it can be positioned, or removed from the grid,
 * independently of this one.
 */

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
    host.el.appendChild(wrap);

    return {
      destroy() {
        wrap.remove();
      },
    };
  },
};
