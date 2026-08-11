/* A link to one folder's page (project/pages/grid-page.js, mounted by
 * project/main.js's router for #page=folder&id=<fid>).
 *
 * One of these per folder a project actually has -- there's no single
 * generic "Folder" widget the way there's a single "Sidebar" or "Notepad",
 * because a folder widget is meaningless without knowing which folder it
 * points at. The Add Widget dock offers one card per existing folder (see
 * project/main.js's shell.addableTypes and widget-dock.js), each seeding
 * this config at creation time; nothing here ever lets the user pick a
 * different folder afterwards -- add a new one from the dock instead.
 *
 * config: { folder_id }. The label is never cached in config: it's always
 * read fresh from the folder itself on mount, so a rename in the folders
 * modal (folders-panel.js) doesn't leave this tile showing a stale name.
 */

import { getFolder } from "../folders.js";

export default {
  type: "folder",
  label: "Folder",
  container: false,
  permanent: false,
  defaultSize: { w: 2, h: 1 },
  minSize: { w: 1, h: 1 },

  create(host) {
    const wrap = document.createElement("div");
    wrap.className = "widget-folder-button";

    const link = document.createElement("a");
    link.className = "btn";
    wrap.appendChild(link);
    host.el.appendChild(wrap);

    const folderId = host.config?.folder_id;
    let cancelled = false;

    if (!folderId) {
      link.textContent = "No folder set";
    } else {
      link.href = `#page=folder&id=${encodeURIComponent(folderId)}`;
      link.textContent = "Loading…";
      getFolder(folderId)
        .then((folder) => {
          if (cancelled) return;
          link.textContent = folder.name;
          link.title = `Open "${folder.name}"`;
        })
        .catch(() => {
          if (cancelled) return;
          link.textContent = "Folder deleted";
          link.removeAttribute("href");
        });
    }

    return {
      destroy() {
        cancelled = true;
        wrap.remove();
      },
    };
  },
};
