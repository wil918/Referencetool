/* Per-selection rich text formatting for Text and Notepad -- Google-Docs
 * style: highlight a range and only that range changes; a collapsed cursor
 * sets the style new characters will be typed in, without touching anything
 * already there. Hand-rolled against the DOM Selection/Range API rather
 * than document.execCommand (deprecated, and its fontSize/fontName commands
 * don't support arbitrary values), which also means the markup this module
 * produces is fully under our control: only <span style="..."> and plain
 * text, which is what makes sanitizeHtml's whitelist tractable.
 *
 * The six character-level fields live here as a plain object -- the same
 * shape format-toolbar.js already speaks in for whole-widget typography --
 * { family, size, colour, bold, italic, underline }, every field optional.
 * Absent means "not set at this point"; present-with-undefined (as
 * format-toolbar.js's emit() already produces for a toggled-off field)
 * means "explicitly cleared here." Align and content-scale are NOT part of
 * this module -- those stay whole-widget, via typography.js/applyTypography,
 * same as before.
 */

import { FONT_OPTIONS } from "./typography.js";

// The only CSS this module (or a sanitized widget's stored HTML) may ever
// carry. Anything else -- other tags, other attributes, other properties,
// other-shaped values -- is stripped by sanitizeHtml.
const ALLOWED_PROPS = ["color", "font-family", "font-size", "font-weight", "font-style", "text-decoration"];

// A cursor's "pending style" is materialized as a real span containing just
// this character, so native typing (including IME composition) continues
// inside it with no per-keystroke interception. Stripped out again by
// sanitizeHtml if the user never actually typed into it.
const TYPING_MARKER = "​";

function familyToCss(value) {
  return FONT_OPTIONS.find((option) => option.value === value)?.family || null;
}

function cssToFamily(cssValue) {
  return FONT_OPTIONS.find((option) => option.family === cssValue)?.value;
}

// input[type=color] only accepts hex, but reading a colour back off
// el.style.color always comes back as the browser's normalised rgb()/rgba()
// serialisation, whatever format it was set in -- same reasoning as
// format-toolbar.js's own inkFallback() comment.
function rgbToHex(value) {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(value);
  if (!m) return value;
  const toHex = (n) => Number(n).toString(16).padStart(2, "0");
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
}

// --- reading -----------------------------------------------------------------

/** This element's own inline style, as the abstract { family, size, colour,
 * bold, italic, underline } shape -- only the fields it actually sets. */
function styleFromElement(el) {
  const result = {};
  const family = cssToFamily(el.style.fontFamily);
  if (family !== undefined) result.family = family;
  const sizeMatch = /^([\d.]+)rem$/.exec(el.style.fontSize || "");
  if (sizeMatch) result.size = parseFloat(sizeMatch[1]);
  if (el.style.color) result.colour = rgbToHex(el.style.color);
  if (el.style.fontWeight === "700" || el.style.fontWeight === "bold") result.bold = true;
  if (el.style.fontStyle === "italic") result.italic = true;
  if (el.style.textDecoration && el.style.textDecoration.includes("underline")) result.underline = true;
  return result;
}

// Merges inline styles from `node` up to (not including) `boundary`, closer
// ancestors overriding farther ones -- the same rule CSS inheritance itself
// uses, just resolved by hand since we only ever read/write inline styles.
function effectiveStyleAt(node, boundary) {
  const chain = [];
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el && el !== boundary && boundary.contains(el)) {
    chain.push(el);
    el = el.parentElement;
  }
  let style = {};
  for (let i = chain.length - 1; i >= 0; i--) style = { ...style, ...styleFromElement(chain[i]) };
  return style;
}

/** The effective style at the current selection's start, for the format
 * toolbar's pressed/value state. `root` is the widget's own editable
 * element -- selections outside it are ignored. */
export function getSelectionStyle(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return {};
  const range = sel.getRangeAt(0);
  // startContainer is sometimes an element with startOffset indexing its
  // children (e.g. right after this module's own applySelectionStyle
  // reselects with setStartBefore/setEndAfter) rather than a text node --
  // resolve down to the actual node at that position first, same
  // normalization applyToRange already needs for the same reason.
  const { container } = textNodeBoundary(range.startContainer, range.startOffset);
  if (!container || !root.contains(container)) return {};
  return effectiveStyleAt(container, root);
}

// --- writing -------------------------------------------------------------

function mergePatch(base, patch) {
  const merged = { ...base };
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) delete merged[key];
    else merged[key] = patch[key];
  }
  return merged;
}

function isEmptyStyle(style) {
  return Object.keys(style).length === 0;
}

function applyAbstractStyleToElement(el, style) {
  if (style.colour) el.style.color = style.colour;
  if (style.family) el.style.fontFamily = familyToCss(style.family);
  if (style.size) el.style.fontSize = `${style.size}rem`;
  if (style.bold) el.style.fontWeight = "700";
  if (style.italic) el.style.fontStyle = "italic";
  if (style.underline) el.style.textDecoration = "underline";
}

/* Promotes `node` up to be a direct child of `root`, splitting every
 * ancestor it passes through along the way (a shallow clone carries off
 * whatever siblings came after it at that level, the original keeps
 * whatever came before, and either half is dropped if left empty).
 *
 * This is the piece a plain node.replaceWith() can't do: replaceWith only
 * swaps a node for another *within its current parent*, so a bare node
 * "cleared" that way is still nested inside whatever styled ancestor spans
 * it started under, and still renders styled -- CSS gives no clean way for
 * a descendant to opt back out of an ancestor's inline style once it's
 * there. Fully promoting the node clear of every ancestor first, then
 * applying the merged style directly to it, means both "clear formatting"
 * and "override an ancestor's property" are the same operation: nothing is
 * ever nested inside styling it doesn't fully, explicitly carry itself.
 */
function promoteToRoot(root, node) {
  let current = node;
  while (current.parentNode && current.parentNode !== root) {
    const parent = current.parentNode;
    const after = parent.cloneNode(false);
    while (current.nextSibling) after.appendChild(current.nextSibling);
    parent.after(current, after);
    if (!parent.hasChildNodes()) parent.remove();
    if (!after.hasChildNodes()) after.remove();
  }
  return current;
}

// Restyle one text node: resolve its current effective style from the
// (untouched) live tree, merge the patch, promote it clear of every
// ancestor, then apply the merged style directly (or leave it bare, if the
// result is empty -- see promoteToRoot for why that has to mean "no
// ancestor either," not just "no new span").
function restyleTextNode(root, node, patch) {
  const merged = mergePatch(effectiveStyleAt(node, root), patch);
  promoteToRoot(root, node);
  if (isEmptyStyle(merged)) return node;
  const span = document.createElement("span");
  applyAbstractStyleToElement(span, merged);
  node.replaceWith(span);
  span.appendChild(node);
  return span;
}

function applyCollapsedStyle(root, range, patch) {
  const merged = mergePatch(effectiveStyleAt(range.startContainer, root), patch);
  // Nothing to carry forward -- plain typing at this position already
  // means "no style," no marker needed.
  if (isEmptyStyle(merged)) return;

  const span = document.createElement("span");
  applyAbstractStyleToElement(span, merged);
  const marker = document.createTextNode(TYPING_MARKER);
  span.appendChild(marker);
  range.insertNode(span);

  const newRange = document.createRange();
  newRange.setStart(marker, marker.length);
  newRange.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(newRange);
}

// A range's boundary is sometimes expressed at an element level -- e.g.
// range.selectNodeContents(someSpan) sets the container to that span
// itself, not to a text node inside it (Ctrl+A across the whole widget
// does the same at the root level). Resolving every boundary down to a
// text node (and an offset within it) first gives applyToRange below one
// consistent shape to work from regardless of how the range was built.
function textNodeBoundary(container, offset) {
  if (container.nodeType === Node.TEXT_NODE) return { container, offset };
  if (offset < container.childNodes.length) {
    let node = container.childNodes[offset];
    while (node.nodeType !== Node.TEXT_NODE && node.firstChild) node = node.firstChild;
    if (node.nodeType === Node.TEXT_NODE) return { container: node, offset: 0 };
  }
  if (offset > 0) {
    let node = container.childNodes[offset - 1];
    while (node.nodeType !== Node.TEXT_NODE && node.lastChild) node = node.lastChild;
    if (node.nodeType === Node.TEXT_NODE) return { container: node, offset: node.nodeValue.length };
  }
  return { container: null, offset: 0 }; // empty container -- nothing to normalize to
}

/* The core non-collapsed operation. Deliberately doesn't use
 * Range.extractContents()/insertNode(): per spec, when a range's start and
 * end land in the very same text node -- an ordinary, common case, e.g.
 * restyling a selection that sits entirely inside one existing run --
 * extractContents() takes a fast path that extracts *only* that text, with
 * no ancestor wrapper at all, silently dropping whatever style that run
 * already had. Splitting text nodes at the boundaries and replacing each
 * one in place (restyleTextNode, via Node.replaceWith) sidesteps that fast
 * path entirely: every text node is restyled from its own correctly
 * resolved live-tree style, however the range originally reached it.
 */
function applyToRange(root, range, patch) {
  const start = textNodeBoundary(range.startContainer, range.startOffset);
  const end = textNodeBoundary(range.endContainer, range.endOffset);
  if (!start.container || !end.container) return [];

  if (start.container === end.container) {
    let node = start.container;
    if (start.offset > 0) node = node.splitText(start.offset);
    const endInNode = end.offset - start.offset;
    if (endInNode < node.length) node.splitText(endInNode);
    return [restyleTextNode(root, node, patch)];
  }

  let startNode = start.container;
  if (start.offset > 0) startNode = startNode.splitText(start.offset);

  const endNode = end.container;
  if (end.offset > 0 && end.offset < endNode.length) endNode.splitText(end.offset);

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  walker.currentNode = startNode;
  const nodes = [startNode];
  let n = startNode;
  while (n !== endNode) {
    n = walker.nextNode();
    if (!n) break;
    nodes.push(n);
  }

  return nodes.map((node) => restyleTextNode(root, node, patch));
}

/** Apply `patch` (the abstract six-field shape, format-toolbar.js's emit()
 * shape) to the current selection within `root`. A real selection is
 * re-styled in place; a collapsed cursor gets a typing-style marker so
 * subsequent native typing (including IME composition -- this is why
 * keystrokes aren't intercepted directly) continues in the new style. */
export function applySelectionStyle(root, patch) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;

  if (range.collapsed) {
    applyCollapsedStyle(root, range, patch);
    return;
  }

  const replaced = applyToRange(root, range, patch);
  if (replaced.length) {
    const newRange = document.createRange();
    newRange.setStartBefore(replaced[0]);
    newRange.setEndAfter(replaced[replaced.length - 1]);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
}

/** Clear the six rich fields on the current selection -- deliberately
 * selection-scoped, not the whole widget (align/scale, which live outside
 * this module entirely, are untouched either way). */
export function clearSelectionStyle(root) {
  applySelectionStyle(root, {
    family: undefined,
    size: undefined,
    colour: undefined,
    bold: undefined,
    italic: undefined,
    underline: undefined,
  });
}

// --- persistence -----------------------------------------------------------

function isValidStyleValue(prop, value) {
  switch (prop) {
    case "color":
      return /^#[0-9a-f]{3,8}$/i.test(value) || /^rgba?\([\d.,\s%]+\)$/i.test(value);
    case "font-family":
      return FONT_OPTIONS.some((option) => option.family === value);
    case "font-size":
      return /^\d+(\.\d+)?rem$/.test(value);
    case "font-weight":
      return /^(400|700|normal|bold)$/.test(value);
    case "font-style":
      return /^(normal|italic)$/.test(value);
    case "text-decoration":
      return value === "none" || value === "underline";
    default:
      return false;
  }
}

function sanitizeSpanAttributes(span) {
  for (const attr of [...span.attributes]) {
    if (attr.name !== "style") span.removeAttribute(attr.name);
  }
  const kept = ALLOWED_PROPS.map((prop) => [prop, span.style.getPropertyValue(prop)]).filter(
    ([prop, value]) => value && isValidStyleValue(prop, value)
  );
  span.removeAttribute("style");
  for (const [prop, value] of kept) span.style.setProperty(prop, value);
}

// Only SPAN and text nodes survive. Anything else is unwrapped -- its text
// kept, the tag dropped -- rather than deleted outright, so e.g. a pasted
// <div> degrades to plain text instead of vanishing.
function sanitizeNode(parent) {
  for (const child of [...parent.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.remove();
      continue;
    }
    if (child.tagName === "SPAN") {
      sanitizeSpanAttributes(child);
      sanitizeNode(child);
    } else {
      sanitizeNode(child);
      while (child.firstChild) parent.insertBefore(child.firstChild, child);
      child.remove();
    }
  }
}

// Strips leftover typing-style markers the user opened (via the toolbar on
// a collapsed cursor) but never actually typed into -- the marker's zero-
// width space is removed, and if that leaves its wrapping span with nothing
// left in it, the span goes too. A marker the user *did* type into keeps
// its real text and style, only the stray zero-width character is dropped.
function stripEmptyMarkers(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const toStrip = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue.includes(TYPING_MARKER)) toStrip.push(n);
  }
  for (const textNode of toStrip) {
    textNode.nodeValue = textNode.nodeValue.split(TYPING_MARKER).join("");
    if (textNode.nodeValue !== "") continue;
    const parent = textNode.parentNode;
    textNode.remove();
    if (parent && parent.tagName === "SPAN" && !parent.hasChildNodes()) parent.remove();
  }
}

/* Removes any <span> left with no text at all -- not the ZWSP-marker case
 * above (that always has one character until stripEmptyMarkers runs), but
 * the native-editing case: backspacing every character out of a styled run
 * doesn't delete the browser's own <span>, and deliberately leaves the
 * cursor inside it so continued typing keeps the style. Left alone, that
 * span still carries its old font-size/line-height into the line box even
 * though it renders no text -- an empty inline element's own font metrics
 * still count toward CSS line-height calculation, which is exactly why a
 * deleted "big" run leaves the caret and line spacing stuck big.
 *
 * If the cursor is currently inside a span being removed, it's relocated
 * to a bare (unstyled) text node planted in the span's place, rather than
 * left dangling -- that's also the correct "no active style" reset once
 * the run it belonged to is gone. */
export function pruneEmptySpans(root) {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  const cursorNode = range && range.collapsed && root.contains(range.startContainer) ? range.startContainer : null;

  const spans = [...root.querySelectorAll("span")];
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (span.textContent !== "") continue;
    const cursorWasInside = cursorNode && span.contains(cursorNode);
    const placeholder = document.createTextNode("");
    span.replaceWith(placeholder);
    if (cursorWasInside) {
      const newRange = document.createRange();
      newRange.setStart(placeholder, 0);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
  }
}

/** Whitelist-sanitize an HTML string down to <span style="..."> (six known
 * properties, shape-checked values) and plain text, nothing else. Also
 * doubles as the migration path for old plain-text content: a plain string
 * has no tags to strip and no styles to validate, so sanitizing it is a
 * no-op -- there is no separate "is this old data" branch anywhere. */
export function sanitizeHtml(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  sanitizeNode(container);
  stripEmptyMarkers(container);
  pruneEmptySpans(container);
  return container.innerHTML;
}
