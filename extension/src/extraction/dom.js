/**
 * DOM traversal that sees inside web components.
 *
 * `document.querySelectorAll()` does not pierce shadow roots -- that's the
 * entire point of shadow DOM encapsulation. Sites built out of web components
 * (JSTOR's "pharos" design system among them) put most of their real markup
 * inside open shadow roots, so a plain scan of the light DOM finds almost
 * nothing: no links, no buttons, no embeds.
 *
 * `open` shadow roots are readable via `element.shadowRoot`; `closed` ones
 * are not reachable by anyone, including us, so nothing here can help there.
 */

/** How deep to recurse. Shadow trees nest, but not unboundedly in practice --
 * this is a guard against a pathological page, not a real structural limit. */
const MAX_DEPTH = 8;

/**
 * querySelectorAll, but descending into every open shadow root.
 * @returns {Element[]}
 */
export function deepQuerySelectorAll(root, selector, depth = 0) {
  if (!root?.querySelectorAll || depth > MAX_DEPTH) return [];

  const found = [...root.querySelectorAll(selector)];

  // The root passed in may itself be a shadow host -- a component element
  // whose entire content lives in its own shadow root. Checking only the
  // descendants would miss everything inside it, which is precisely the case
  // when scanning a single custom element rather than a whole document.
  if (root.shadowRoot) {
    found.push(...deepQuerySelectorAll(root.shadowRoot, selector, depth + 1));
  }

  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) {
      found.push(...deepQuerySelectorAll(el.shadowRoot, selector, depth + 1));
    }
  }
  return found;
}

/** First deep match, or null. */
export function deepQuerySelector(root, selector) {
  return deepQuerySelectorAll(root, selector)[0] || null;
}
