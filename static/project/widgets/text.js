/* A user text widget -- formatted per-selection, Google-Docs style, through
 * rich-text.js: highlight a range and only that range changes; the rest of
 * the note is untouched. contentEditable, but raw HTML is never trusted in
 * or out: paste is intercepted down to plain text, Enter inserts a literal
 * "\n" text node rather than letting the browser split the element into
 * <div>s, and host.config.content is always run through rich-text.js's
 * sanitizeHtml before it's set via innerHTML or written back -- see that
 * module for why this is also what makes old plain-text content (saved
 * before this widget could format per-selection) load through the exact
 * same path with no separate migration step.
 *
 * Editable only while the grid is in edit mode (host.editMode) -- outside
 * that, the widget is read-only, the mirror image of Notepad, which is
 * always editable. See CLAUDE.md's widget contract for why this is gated
 * through host.editMode rather than each widget guessing at page state.
 *
 * config: { content, typography: { align }, contentScale }
 *
 * typography here only ever carries `align` now -- the other six fields
 * (family/size/colour/bold/italic/underline) live inline in `content`
 * itself, per selection, rather than as one setting for the whole widget.
 */

import { applyTypography } from "../typography.js";
import { makeFormattable } from "../format-toolbar.js";
import { insertPlainText } from "../text-utils.js";
import { sanitizeHtml, getSelectionStyle, applySelectionStyle, clearSelectionStyle, pruneEmptySpans } from "../rich-text.js";

export default {
  type: "text",
  label: "Text",
  container: false,
  permanent: false,
  defaultSize: { w: 4, h: 2 },
  minSize: { w: 1, h: 1 },

  create(host) {
    const el = document.createElement("div");
    el.className = "widget-text widget-editable-text";
    el.contentEditable = "false";
    el.spellcheck = false;
    el.dataset.placeholder = "Type something…";
    el.innerHTML = sanitizeHtml(host.config?.content || "");
    host.el.appendChild(el);

    const unsubscribeEditMode = host.editMode.subscribe((editing) => {
      el.contentEditable = editing ? "true" : "false";
    });
    host.onDestroy(unsubscribeEditMode);

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
      // Native typing/deletion isn't intercepted (see the module comment),
      // so a styled run backspaced down to nothing can leave an empty,
      // still-styled <span> behind -- see rich-text.js's pruneEmptySpans
      // for why that alone is enough to keep the caret/line spacing stuck
      // at the old size. Run before every persist so it's cleaned up as
      // part of normal editing, not just on next load.
      pruneEmptySpans(el);
      persist();
    });
    el.addEventListener("blur", persist);

    makeFormattable(host, {
      // Whole-widget: align + contentScale only, exactly as every widget
      // that isn't rich-text-capable already works.
      get: () => ({ typography: host.config?.typography, contentScale: host.config?.contentScale }),
      set: ({ typography, contentScale }) => {
        host.save({ ...host.config, typography, contentScale });
        render();
      },
      // Per-selection: the six character-level fields, against this
      // widget's own element.
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
      enabled: () => host.editMode.isEditing(),
    });

    return {
      destroy() {
        el.remove();
      },
    };
  },
};
