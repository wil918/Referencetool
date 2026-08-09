/**
 * Capturing a text selection as a research reference.
 *
 * The selected text is the thing being quoted, so it is preserved exactly as
 * the user highlighted it -- never trimmed of interior whitespace, never
 * summarised, never normalised. Only the surrounding *context* is tidied,
 * because that's supporting material rather than the quotation itself.
 */
import { normaliseValue } from "./provenance.js";

/** How much surrounding paragraph to keep as context. */
const MAX_CONTEXT = 1200;

/**
 * Describe the current selection, or null if there isn't a usable one.
 * @returns {{selected_text: string, context: string, heading: string} | null}
 */
export function extractSelection(win = window) {
  const selection = win.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  // Only the outer whitespace goes -- a double space or line break *inside*
  // the quotation is part of what was on the page.
  const selected = String(selection).replace(/^\s+|\s+$/g, "");
  if (!selected) return null;

  const range = selection.getRangeAt(0);
  const anchor = elementOf(range.commonAncestorContainer);

  return {
    selected_text: selected,
    context: surroundingContext(anchor, selected),
    heading: nearestHeading(anchor),
  };
}

/**
 * The paragraph the selection sits in, for context.
 *
 * Returns "" when the selection already *is* the whole paragraph -- repeating
 * it as context would just duplicate the quote in the archive.
 */
export function surroundingContext(anchor, selected) {
  if (!anchor) return "";
  const block = anchor.closest?.("p, li, blockquote, td, dd, section, article") || anchor;
  const text = normaliseValue(block.textContent).slice(0, MAX_CONTEXT);
  if (!text) return "";

  const compact = normaliseValue(selected);
  if (text === compact) return "";
  return text;
}

/** The nearest heading above the selection, for citation context. */
export function nearestHeading(anchor) {
  if (!anchor) return "";

  // Walk up looking for a heading inside each ancestor section first -- on a
  // long article the relevant heading is the section's, not the page title.
  let node = anchor;
  while (node && node.nodeType === 1) {
    const own = node.querySelector?.(":scope > h1, :scope > h2, :scope > h3, :scope > h4");
    if (own) return normaliseValue(own.textContent);
    node = node.parentElement;
  }

  // Otherwise the closest heading that appears before it in document order.
  const doc = anchor.ownerDocument;
  const headings = [...(doc?.querySelectorAll("h1, h2, h3, h4") || [])];
  let best = "";
  for (const h of headings) {
    const position = h.compareDocumentPosition(anchor);
    // 4 = anchor follows the heading.
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) best = normaliseValue(h.textContent);
  }
  return best;
}

function elementOf(node) {
  if (!node) return null;
  return node.nodeType === 1 ? node : node.parentElement;
}
