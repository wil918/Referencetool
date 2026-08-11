/* The project's name, as the homepage's masthead -- and, while the grid is
 * in edit mode, the actual control for renaming the project: typing into it
 * writes straight through to PUT /api/projects/<id>, the same route the
 * Archive's own rename control uses. Outside edit mode it's read-only,
 * gated through host.editMode.
 *
 * config: { showDescription: bool, typography, contentScale }
 *
 * `align` used to be its own config field, set with no UI ever built for it.
 * It's folded into typography.align now that the format toolbar gives it a
 * real control -- an old saved value is still honoured as the fallback when
 * typography.align is unset, so nothing already saved silently reverts.
 */

import { applyTypography } from "../typography.js";
import { makeFormattable } from "../format-toolbar.js";
import { insertPlainText } from "../text-utils.js";

const RENAME_SAVE_DELAY = 400;

export default {
  type: "title",
  label: "Project Title",
  container: false,
  permanent: false,
  defaultSize: { w: 12, h: 2 },
  minSize: { w: 3, h: 1 },

  create(host) {
    const wrap = document.createElement("div");
    wrap.className = "widget-title";

    const name = document.createElement("h2");
    name.className = "widget-title-name widget-editable-text";
    name.contentEditable = "false";
    name.spellcheck = false;
    name.textContent = host.project.title;
    wrap.appendChild(name);

    const description = document.createElement("p");
    description.className = "muted widget-title-description";
    description.textContent = host.project.description || "";
    wrap.appendChild(description);

    host.el.appendChild(wrap);

    function render() {
      const config = { showDescription: true, ...(host.config || {}) };
      description.hidden = !(config.showDescription && host.project.description);

      const typography = { align: config.align, ...(config.typography || {}) };
      applyTypography(host.el, typography, config.contentScale);
    }

    render();

    // --- rename -- writes straight through to the project itself, not
    // host.config (host.save/host.config are for this widget's own display
    // settings; the title text belongs to the project record).

    let renameTimer = null;

    async function persistTitle() {
      const res = await fetch(`/api/projects/${host.project.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: name.textContent, description: host.project.description || "" }),
      });
      if (!res.ok) return; // e.g. emptied out entirely -- left as typed, retried on the next edit
      const updated = await res.json();
      host.project.title = updated.title;
      document.title = updated.title;
    }

    function scheduleRename() {
      clearTimeout(renameTimer);
      renameTimer = setTimeout(() => {
        renameTimer = null;
        persistTitle();
      }, RENAME_SAVE_DELAY);
    }

    name.addEventListener("paste", (event) => {
      event.preventDefault();
      insertPlainText(event.clipboardData.getData("text/plain"));
      scheduleRename();
    });

    name.addEventListener("keydown", (event) => {
      // A project name is one line -- Enter commits instead of inserting a
      // newline, unlike notepad.js's handling of the same key.
      if (event.key !== "Enter") return;
      event.preventDefault();
      name.blur();
    });

    name.addEventListener("input", scheduleRename);
    name.addEventListener("blur", () => {
      clearTimeout(renameTimer);
      renameTimer = null;
      persistTitle();
    });

    const unsubscribeEditMode = host.editMode.subscribe((editing) => {
      name.contentEditable = editing ? "true" : "false";
    });
    host.onDestroy(unsubscribeEditMode);

    makeFormattable(host, {
      get: () => {
        const config = host.config || {};
        return {
          typography: { align: config.align, ...(config.typography || {}) },
          contentScale: config.contentScale,
        };
      },
      set: ({ typography, contentScale }) => {
        host.save({ ...host.config, typography, contentScale });
        render();
      },
      enabled: () => host.editMode.isEditing(),
    });

    return {
      destroy() {
        // A rename made a moment before teardown is still an edit the user
        // made -- flushed rather than dropped, same as registry.js's own
        // config-save flush on destroy.
        if (renameTimer) {
          clearTimeout(renameTimer);
          renameTimer = null;
          persistTitle();
        }
        wrap.remove();
      },
    };
  },
};
