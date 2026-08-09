/* A user text widget -- a plain-text note, formatted through the shared
 * typography contract and nothing else. contenteditable, but HTML is never
 * allowed in: paste is intercepted down to plain text and Enter inserts a
 * literal "\n" text node rather than letting the browser split the element
 * into <div>s, so host.config.content is always a plain string that round
 * trips through el.textContent exactly.
 *
 * config: { content, typography, contentScale }
 */

import { applyTypography } from "../typography.js";
import { makeFormattable } from "../format-toolbar.js";

// Replaces the current selection with a plain text node -- the one operation
// paste and Enter both need, neither of which may use the deprecated
// execCommand or risk the browser inserting real markup.
function insertPlainText(text) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

export default {
  type: "text",
  label: "Text",
  container: false,
  permanent: false,
  defaultSize: { w: 4, h: 2 },
  minSize: { w: 1, h: 1 },

  create(host) {
    const el = document.createElement("div");
    el.className = "widget-text";
    el.contentEditable = "true";
    el.spellcheck = false;
    el.dataset.placeholder = "Type something…";
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
