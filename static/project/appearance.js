/* Per-project appearance -- text colour, text scale and background -- applied
 * before first paint, the same way theme.js applies dark mode.
 *
 * There is nothing to read from localStorage here: appearance is per-project
 * and lives server-side in project_settings (CLAUDE.md rule 2 forbids
 * localStorage for anything the user created), so the only way to avoid a
 * flash of the default look is a *synchronous* request in <head>, before the
 * stylesheet link and before project/main.js's own async fetch of the same
 * settings. The request is same-origin to the local Flask server, so the
 * cost is one blocking round trip on localhost, not a real network call.
 *
 * Settings are applied as inline custom properties on <html>:
 * --project-ink, --project-bg, --content-scale. style.css reads them with
 * the existing globals as fallbacks (e.g. color: var(--project-ink, var(--ink))),
 * so a project with no saved appearance renders identically to before this
 * existed, and index.html / the graph pages -- which never load this script
 * and never set these properties -- are unaffected.
 *
 * --content-scale set here is the project-wide *default* -- a widget with
 * its own config.contentScale (project/typography.js) sets the same custom
 * property again, scoped to its own host.el, which simply shadows this root
 * value for that widget's subtree. Nothing here knows that override exists;
 * it falls out of ordinary CSS inheritance.
 */
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

    if (s.contentScale) root.setProperty("--content-scale", s.contentScale);
    else root.removeProperty("--content-scale");
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
