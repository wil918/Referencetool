/* A sticky note -- unlike text.js and title.js, this one is never gated to
 * edit mode: it's editable and formattable right on the plain homepage,
 * exactly like text.js used to behave before Text and Title moved to
 * edit-mode-only. Notepad exists so there's still a widget type for jotting
 * things down without opening layout editing at all.
 *
 * config: { content, typography, contentScale }
 */

import { applyTypography } from "../typography.js";
import { makeFormattable } from "../format-toolbar.js";
import { insertPlainText } from "../text-utils.js";

export default {
  type: "notepad",
  label: "Notepad",
  container: false,
  permanent: false,
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 1, h: 1 },

  create(host) {
    const el = document.createElement("div");
    el.className = "widget-notepad widget-editable-text";
    el.contentEditable = "true";
    el.spellcheck = false;
    el.dataset.placeholder = "Jot something down…";
    el.textContent = host.config?.content || "";
    host.el.appendChild(el);

    function render() {
      applyTypography(host.el, host.config?.typography, host.config?.contentScale);
    }

    render();

    function persist() {
      host.save({ ...host.config, content: el.textContent });
    }

    el.addEventListener("paste", (event) => {
      event.preventDefault();
      insertPlainText(event.clipboardData.getData("text/plain"));
      persist();
    });

    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      insertPlainText("\n");
      persist();
    });

    el.addEventListener("input", persist);
    el.addEventListener("blur", persist);

    // No `enabled` guard, unlike text.js/title.js -- the toolbar activates on
    // click whether or not the grid is in edit mode.
    makeFormattable(host, {
      get: () => ({ typography: host.config?.typography, contentScale: host.config?.contentScale }),
      set: ({ typography, contentScale }) => {
        host.save({ ...host.config, typography, contentScale });
        render();
      },
    });

    return {
      destroy() {
        el.remove();
      },
    };
  },
};
