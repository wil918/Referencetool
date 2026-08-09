/* The project's name, as the homepage's masthead.
 *
 * config: { showDescription: bool, typography, contentScale }
 *
 * `align` used to be its own config field, set with no UI ever built for it.
 * It's folded into typography.align now that the format toolbar gives it a
 * real control -- an old saved value is still honoured as the fallback when
 * typography.align is unset, so nothing already saved silently reverts.
 */

import { applyTypography } from "../typography.js";
import { makeFormattable } from "../format-toolbar.js";

export default {
  type: "title",
  label: "Project Title",
  container: false,
  permanent: false,
  defaultSize: { w: 12, h: 2 },
  minSize: { w: 3, h: 1 },

  create(host) {
    const wrap = document.createElement("div");
    wrap.className = "widget-title";

    const name = document.createElement("h2");
    name.className = "widget-title-name";
    name.textContent = host.project.title;
    wrap.appendChild(name);

    const description = document.createElement("p");
    description.className = "muted widget-title-description";
    description.textContent = host.project.description || "";
    wrap.appendChild(description);

    host.el.appendChild(wrap);

    function render() {
      const config = { showDescription: true, ...(host.config || {}) };
      description.hidden = !(config.showDescription && host.project.description);

      const typography = { align: config.align, ...(config.typography || {}) };
      applyTypography(host.el, typography, config.contentScale);
    }

    render();

    makeFormattable(host, {
      get: () => {
        const config = host.config || {};
        return {
          typography: { align: config.align, ...(config.typography || {}) },
          contentScale: config.contentScale,
        };
      },
      set: ({ typography, contentScale }) => {
        host.save({ ...host.config, typography, contentScale });
        render();
      },
    });

    return {
      destroy() {
        wrap.remove();
      },
    };
  },
};
