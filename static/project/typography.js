/* The typography contract shared by every widget that renders text --
 * title.js, text.js, and (per session 11's note) the canvas text node still
 * to come.
 *
 * A widget's typography is a plain object -- { family, size, colour, bold,
 * italic, underline, align } -- with every field optional. It is applied as
 * CSS custom properties scoped to the widget's own host.el, never as inline
 * styles on inner elements and never on :root, so it cascades to that
 * widget's content and nothing else (CLAUDE.md's widget contract). A widget's
 * own stylesheet rules read these properties with its existing hard-coded
 * look as the var() fallback, so a widget with no typography override renders
 * exactly as it did before this existed.
 *
 * contentScale travels through the same custom property the project-wide
 * default is set on (--content-scale, from project/appearance.js on the
 * document root) rather than one of its own -- setting it again here, scoped
 * to host.el, simply shadows the inherited default for this widget's subtree,
 * which is exactly the override behaviour session 4's appearance settings and
 * this widget's own config are supposed to have.
 */

export const FONT_OPTIONS = [
  { value: "serif", label: "Serif", family: "var(--serif)" },
  { value: "sans", label: "Sans", family: "var(--sans)" },
  { value: "display", label: "Display", family: "var(--display)" },
  { value: "mono", label: "Mono", family: "var(--mono)" },
];

// A small, sane list rather than a size field free for any number -- named
// steps read better in a toolbar than a text box, and these double as
// several widgets' own hard-coded defaults (2.75rem is title.js's), so
// picking the step that matches a widget's current look is a no-op.
export const SIZE_OPTIONS = [
  { value: 0.75, label: "Small" },
  { value: 0.9, label: "Normal" },
  { value: 1.1, label: "Medium" },
  { value: 1.5, label: "Large" },
  { value: 2, label: "X-Large" },
  { value: 2.75, label: "XX-Large" },
  { value: 3.5, label: "Huge" },
];

function fontFamilyValue(value) {
  return FONT_OPTIONS.find((option) => option.value === value)?.family || null;
}

/* Set (or clear) the custom properties `el`'s own CSS rules read. Called both
 * on mount and after every live edit from the format toolbar -- host.save()
 * updates host.config synchronously, so a widget can call this again right
 * after and see the change immediately, without waiting on the debounced
 * network write.
 */
export function applyTypography(el, typography, contentScale) {
  const t = typography || {};

  const set = (name, value) => {
    if (value === undefined || value === null || value === "") el.style.removeProperty(name);
    else el.style.setProperty(name, String(value));
  };

  set("--widget-font-family", fontFamilyValue(t.family));
  set("--widget-font-size", t.size ? `${t.size}rem` : null);
  set("--widget-font-colour", t.colour);
  set("--widget-font-weight", t.bold ? "700" : null);
  set("--widget-font-style", t.italic ? "italic" : null);
  set("--widget-text-decoration", t.underline ? "underline" : null);
  set("--widget-text-align", t.align);
  set("--content-scale", contentScale);
}
