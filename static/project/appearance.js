/* Per-project appearance -- palette, fonts, text scale and background --
 * applied before first paint, the same way theme.js applies dark mode.
 *
 * There is nothing to read from localStorage here: appearance is per-project
 * and lives server-side in project_settings (CLAUDE.md rule 2 forbids
 * localStorage for anything the user created), so the only way to avoid a
 * flash of the default look is a *synchronous* request in <head>, before the
 * stylesheet link and before project/main.js's own async fetch of the same
 * settings. The request is same-origin to the local Flask server, so the
 * cost is one blocking round trip on localhost, not a real network call.
 *
 * Settings are applied as inline custom properties on <html>, in two
 * different ways depending on how singular the property's meaning is
 * elsewhere in the stylesheet:
 *
 *   - --muted, --accent, --accent-soft, --light, --dark are redefined
 *     directly, the same trick CLAUDE.md documents for --light/--dark: every
 *     existing `var(--muted)` / `var(--accent)` in style.css picks the
 *     override up with no changes there, because nothing else gives those
 *     two names a competing meaning.
 *   - --project-ink, --project-bg, --project-button, --project-button-ink,
 *     --project-heading-font, --project-body-font, --content-scale instead
 *     sit *beside* the globals they default from (--ink, --bg, --serif,
 *     --sans), and style.css reads them with the underlying global as an
 *     explicit fallback wherever it matters (e.g. color: var(--project-ink,
 *     var(--ink))). --ink/--serif/
 *     --sans are left alone because a widget can reference one of those
 *     names directly and explicitly (project/typography.js's FONT_OPTIONS) --
 *     redefining the name itself would silently move that widget's explicit
 *     choice too, which is exactly what CLAUDE.md's widget-typography
 *     contract says a project default must never do.
 *
 * A project with no saved appearance renders identically to before this
 * existed, and index.html / the graph pages -- which never load this script
 * and never set these properties -- are unaffected.
 *
 * --content-scale set here is the project-wide *default* -- a widget with
 * its own config.contentScale (project/typography.js) sets the same custom
 * property again, scoped to its own host.el, which simply shadows this root
 * value for that widget's subtree. Nothing here knows that override exists;
 * it falls out of ordinary CSS inheritance.
 *
 * graphBg3d is carried in the settings object like everything else, but is
 * deliberately never applied as a custom property: the WebGL scenes
 * (shared/scene-host.js) don't inherit CSS, so project/scene-widget.js reads
 * it straight off window.projectAppearance.get() instead. See that file.
 */

// The four family slots a project (or a widget) can pick between -- kept in
// step with project/typography.js's FONT_OPTIONS by hand rather than
// imported, because this file is a plain synchronous <head> script (loaded
// before the stylesheet, ahead of the importmap) and typography.js is an ES
// module -- pulling module resolution in this early is exactly what
// scene-widget.js's on-demand Three.js import is careful to avoid, for the
// same reason.
const FONT_STACK_VARS = {
  serif: "var(--serif)",
  sans: "var(--sans)",
  display: "var(--display)",
  mono: "var(--mono)",
};
(function () {
  function projectIdFromURL() {
    try {
      return new URLSearchParams(window.location.search).get("id");
    } catch (err) {
      return null;
    }
  }

  // Parses any valid CSS colour (hex, rgb(), named, ...) by letting the
  // browser's own CSS engine resolve it, rather than hand-rolling a parser
  // that only covers the formats the colour picker happens to emit.
  function parseColor(value) {
    if (!value) return null;
    const probe = document.createElement("span");
    probe.style.color = "";
    probe.style.color = value;
    if (!probe.style.color) return null; // invalid -- left unset by the assignment above
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    document.documentElement.removeChild(probe);
    const m = computed.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b] = m[1].split(",").map((n) => parseFloat(n));
    if ([r, g, b].some((n) => Number.isNaN(n))) return null;
    return { r, g, b };
  }

  // WCAG relative luminance, 0 (black) to 1 (white).
  function relativeLuminance({ r, g, b }) {
    const linear = (channel) => {
      const s = channel / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  }

  const lerp = (a, b, t) => a + (b - a) * t;

  // style.css's light and dark themes both build --light/--dark from the
  // same two colours -- near-white rgb(250, 251, 255) for the highlight,
  // near-black rgb(22, 27, 29) for the shadow -- and only vary the alpha
  // with how pale or dark the surface is: on the light theme's pale page the
  // highlight is nearly opaque and the shadow is a soft 0.23; on the dark
  // theme's near-black page the highlight falls away to a faint 0.035 rim
  // and the shadow deepens to 0.6. Interpolating that same alpha by the
  // background's own luminance -- rather than switching between the two
  // fixed pairs at a threshold -- means dragging the colour picker sweeps
  // smoothly between them instead of jumping.
  function deriveShadowVars(bg) {
    const rgb = parseColor(bg);
    if (!rgb) return null;
    const t = relativeLuminance(rgb);
    const lightAlpha = lerp(0.035, 1, t);
    const darkAlpha = lerp(0.6, 0.23, t);
    return {
      light: `rgba(250, 251, 255, ${lightAlpha.toFixed(3)})`,
      dark: `rgba(22, 27, 29, ${darkAlpha.toFixed(3)})`,
      // The default --ink fallback assumes a pale page. A background dark
      // enough to fail that assumption needs the light-theme ink instead, or
      // the text becomes unreadable against the user's own choice of
      // background.
      ink: t < 0.5 ? "#dfe4e9" : "#46545f",
    };
  }

  // --accent-soft is always the same red at half alpha (style.css's own
  // default, rgba(194, 59, 46, 0.5)) -- so a custom accent gets a matching
  // soft variant the same way, rather than leaving glows/focus rings on the
  // old red once the solid accent has moved.
  function deriveAccentSoft(accent) {
    const rgb = parseColor(accent);
    if (!rgb) return null;
    return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, 0.5)`;
  }

  function apply(settings) {
    const s = settings || {};
    const root = document.documentElement.style;

    const shadows = s.bg ? deriveShadowVars(s.bg) : null;

    if (s.bg) root.setProperty("--project-bg", s.bg);
    else root.removeProperty("--project-bg");

    // --raise-* / --press-* in style.css resolve var(--light) and var(--dark)
    // at their point of use, so redefining those two custom properties here
    // on the project root is enough to make every shadow in the subtree
    // recompute for the custom background -- no other CSS changes needed.
    if (shadows) {
      root.setProperty("--light", shadows.light);
      root.setProperty("--dark", shadows.dark);
    } else {
      root.removeProperty("--light");
      root.removeProperty("--dark");
    }

    if (s.ink) root.setProperty("--project-ink", s.ink);
    else if (shadows) root.setProperty("--project-ink", shadows.ink);
    else root.removeProperty("--project-ink");

    // --muted has one meaning everywhere it's read, so it's redefined
    // directly rather than through a --project-muted/fallback pair -- see
    // the module comment.
    if (s.muted) root.setProperty("--muted", s.muted);
    else root.removeProperty("--muted");

    if (s.accent) {
      root.setProperty("--accent", s.accent);
      const soft = deriveAccentSoft(s.accent);
      if (soft) root.setProperty("--accent-soft", soft);
      else root.removeProperty("--accent-soft");
    } else {
      root.removeProperty("--accent");
      root.removeProperty("--accent-soft");
    }

    // Buttons default to the page's own surface (style.css's fallback chain
    // is var(--project-button, var(--project-bg, var(--bg)))) -- this only
    // needs setting when a project wants its controls to sit on a distinct
    // colour instead.
    if (s.button) root.setProperty("--project-button", s.button);
    else root.removeProperty("--project-button");

    // Independent of --project-button: a project can recolour its button
    // surface without recolouring the label on it, or vice versa. Falls back
    // to --ink, same as the text everywhere else on an unstyled button.
    if (s.buttonInk) root.setProperty("--project-button-ink", s.buttonInk);
    else root.removeProperty("--project-button-ink");

    if (s.primaryFont && FONT_STACK_VARS[s.primaryFont]) {
      root.setProperty("--project-heading-font", FONT_STACK_VARS[s.primaryFont]);
    } else {
      root.removeProperty("--project-heading-font");
    }

    if (s.secondaryFont && FONT_STACK_VARS[s.secondaryFont]) {
      root.setProperty("--project-body-font", FONT_STACK_VARS[s.secondaryFont]);
    } else {
      root.removeProperty("--project-body-font");
    }

    if (s.contentScale) root.setProperty("--content-scale", s.contentScale);
    else root.removeProperty("--content-scale");

    // graphBg3d is deliberately not applied here -- see the module comment.
  }

  function loadSync(projectId) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", `/api/projects/${encodeURIComponent(projectId)}/settings`, false);
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        return JSON.parse(xhr.responseText).settings || {};
      }
    } catch (err) {
      // No project id yet, offline, a project that was just deleted, JSON
      // that failed to parse -- any of these fall through to the defaults
      // rather than blocking the page on a broken request.
    }
    return {};
  }

  const projectId = projectIdFromURL();
  let current = projectId ? loadSync(projectId) : {};
  apply(current);

  // project/widgets/settings.js reads this to seed its form without a second
  // round trip, and writes back through set() after a save so a re-open of
  // the panel (or a live preview) starts from what's actually persisted.
  window.projectAppearance = {
    get: () => current,
    apply,
    set(settings) {
      current = settings || {};
      apply(current);
    },
  };
})();
