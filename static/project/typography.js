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

// Sizes are stored and computed in rem throughout (matches every other part
// of this contract -- applyTypography below, the CSS custom properties), but
// the format toolbar's number box reads and writes points, Google Docs'
// convention, via the standard 96dpi px<->pt math with 1rem = 16px. Not
// arbitrary: 0.9rem (the old "Normal" preset) lands on 11pt, the same
// default Docs itself uses, so existing content's sizes read naturally
// rather than landing on odd numbers.
export function remToPt(rem) {
  return Math.round(rem * 16 * 0.75);
}

export function ptToRem(pt) {
  return pt / 0.75 / 16;
}

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
