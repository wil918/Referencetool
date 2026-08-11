/* A sticky note -- unlike title.js, this one is never gated to edit mode:
 * it's editable and formattable right on the plain homepage. Notepad is the
 * project's one rich-text widget, so it exists both for jotting things down
 * without opening layout editing at all, and as the format toolbar's home
 * for per-selection styling on the homepage grid.
 *
 * Formatted per-selection, Google-Docs style, through rich-text.js: highlight
 * a range and only that range changes; the rest of the note is untouched.
 * contentEditable, but raw HTML is never trusted in or out: paste is
 * intercepted down to plain text, Enter inserts a literal "\n" text node
 * rather than letting the browser split the element into <div>s, and
 * host.config.content is always run through rich-text.js's sanitizeHtml
 * before it's set via innerHTML or written back -- see that module for why
 * this is also what makes old plain-text content (saved before this widget
 * could format per-selection) load through the exact same path with no
 * separate migration step.
 *
 * config: { content, typography: { align }, contentScale }
 */

import { applyTypography } from "../typography.js";
import { makeFormattable } from "../format-toolbar.js";
import { insertPlainText } from "../text-utils.js";
import { sanitizeHtml, getSelectionStyle, applySelectionStyle, clearSelectionStyle, pruneEmptySpans } from "../rich-text.js";

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
    el.innerHTML = sanitizeHtml(host.config?.content || "");
    host.el.appendChild(el);

    function render() {
      applyTypography(host.el, { align: host.config?.typography?.align }, host.config?.contentScale);
    }

    render();

    function persist() {
      host.save({ ...host.config, content: sanitizeHtml(el.innerHTML) });
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

    el.addEventListener("input", () => {
      // See text.js's identical listener -- native deletion can leave an
      // empty, still-styled <span> behind that keeps the caret/line
      // spacing stuck at its old size until pruned.
      pruneEmptySpans(el);
      persist();
    });
    el.addEventListener("blur", persist);

    // No `enabled` guard, unlike text.js/title.js -- the toolbar activates on
    // click whether or not the grid is in edit mode.
    makeFormattable(host, {
      get: () => ({ typography: host.config?.typography, contentScale: host.config?.contentScale }),
      set: ({ typography, contentScale }) => {
        host.save({ ...host.config, typography, contentScale });
        render();
      },
      richText: {
        getSelectionStyle: () => getSelectionStyle(el),
        applySelectionStyle: (patch) => {
          applySelectionStyle(el, patch);
          persist();
        },
        clearSelectionStyle: () => {
          clearSelectionStyle(el);
          persist();
        },
      },
    });

    return {
      destroy() {
        el.remove();
      },
    };
  },
};
