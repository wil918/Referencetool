/* The project's portfolio, shown rather than linked to.
 *
 * Draws the current pages as thumbnails in page order -- every slot of every
 * spread on the canvas, an empty one as the empty slot it is -- so the state
 * of the document is visible from the homepage without opening anything.
 * Clicking opens the management view (project/pages/portfolio-page.js): which
 * slot each page fills, and per-page delete, replace and promote.
 *
 * The thumbnails are the staged pages' (portfolio.py), served from the same
 * content-hash cache the archive's cards use. Staged pages are not references
 * and are not drawn by the reference grid: they have no title, tags or
 * similarity, and pretending otherwise is how the archive got polluted.
 *
 * config: { exportDpi }. The resolution an export resamples down to (never up;
 * a page already below it is left as it came and warned about), edited here in
 * edit mode like any widget setting. Leaving it unset means the app default,
 * 300 dpi -- what university submission portals ask for. Exporting offers this
 * value and lets one export override it, so a final submission never needs the
 * homepage to be edited first.
 *
 * canvasEligible: false. A strip of thumbnails that wraps and scrolls is the
 * same internal-scroll-versus-pan/zoom clash all-references.js opts out for.
 */

import { loadPortfolio, thumbUrl } from "../portfolio.js";

const FALLBACK_RANGE = [72, 1200];
const FALLBACK_DEFAULT_DPI = 300;

export default {
  type: "portfolio",
  label: "Portfolio",
  container: false,
  permanent: false,
  canvasEligible: false,
  defaultSize: { w: 8, h: 5 },
  minSize: { w: 3, h: 3 },

  create(host) {
    const projectId = host.project.id;

    const wrap = document.createElement("div");
    wrap.className = "widget-portfolio";
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "link");
    wrap.setAttribute("aria-label", "Open the portfolio");
    wrap.title = "Open the portfolio";

    const summary = document.createElement("p");
    summary.className = "widget-portfolio-summary muted";

    const strip = document.createElement("div");
    strip.className = "widget-portfolio-strip";

    // Edit mode only: the one setting this widget owns.
    const dpiRow = document.createElement("label");
    dpiRow.className = "widget-portfolio-dpi muted";
    dpiRow.hidden = true;
    const dpiText = document.createElement("span");
    dpiText.textContent = "Export resolution";
    const dpiInput = document.createElement("input");
    dpiInput.type = "number";
    dpiInput.step = "1";
    dpiInput.inputMode = "numeric";
    dpiInput.className = "widget-portfolio-dpi-input";
    const dpiUnit = document.createElement("span");
    dpiUnit.textContent = "dpi";
    const dpiNote = document.createElement("span");
    dpiNote.className = "widget-portfolio-dpi-note";
    dpiNote.textContent = "Images above it are resampled down on export, never up.";
    dpiRow.append(dpiText, dpiInput, dpiUnit, dpiNote);

    wrap.append(summary, strip, dpiRow);
    host.el.appendChild(wrap);

    let range = FALLBACK_RANGE;
    let defaultDpi = FALLBACK_DEFAULT_DPI;
    let cancelled = false;

    function render(overview) {
      range = overview.dpi_range || FALLBACK_RANGE;
      defaultDpi = overview.default_dpi || FALLBACK_DEFAULT_DPI;
      dpiInput.min = String(range[0]);
      dpiInput.max = String(range[1]);
      dpiInput.placeholder = String(defaultDpi);
      if (document.activeElement !== dpiInput) dpiInput.value = host.config?.exportDpi ?? "";

      const total = overview.spreads.reduce((n, s) => n + s.total, 0);
      const filled = overview.spreads.reduce((n, s) => n + s.filled, 0);
      const unplaced = overview.pages.filter((p) => !p.placements.length).length;

      strip.replaceChildren();
      if (!overview.spreads.length) {
        summary.textContent = unplaced
          ? `${unplaced} staged page${unplaced === 1 ? "" : "s"}, no spread to put them on yet.`
          : "No pages yet. Draw a spread of pages on the canvas, or open this to stage some.";
        return;
      }

      summary.textContent =
        `${filled} of ${total} page${total === 1 ? "" : "s"} placed` +
        (unplaced ? ` · ${unplaced} staged, not placed` : "");

      const several = overview.spreads.length > 1;
      for (const spread of overview.spreads) {
        const group = document.createElement("div");
        group.className = "widget-portfolio-spread";
        if (several) {
          const label = document.createElement("p");
          label.className = "widget-portfolio-spread-label muted";
          label.textContent = `Spread ${spread.ordinal}`;
          group.appendChild(label);
        }
        const pages = document.createElement("div");
        pages.className = `widget-portfolio-pages${spread.orientation === "landscape" ? " is-landscape" : ""}`;
        for (const slot of spread.slots) {
          const tile = document.createElement("span");
          tile.className = "widget-portfolio-page";
          if (slot.page_id) {
            const img = document.createElement("img");
            img.src = thumbUrl(slot.page_id);
            img.alt = `Page ${slot.number}`;
            img.loading = "lazy";
            img.decoding = "async";
            img.draggable = false;
            // contain, so a page that isn't A4 shows whole rather than cropped
            // to a shape it won't print in.
            img.style.objectFit = slot.fit === "cover" ? "cover" : "contain";
            tile.appendChild(img);
          } else {
            tile.classList.add("is-empty");
            tile.textContent = String(slot.number);
          }
          pages.appendChild(tile);
        }
        group.appendChild(pages);
        strip.appendChild(group);
      }
    }

    async function refresh() {
      let overview;
      try {
        overview = await loadPortfolio(projectId);
      } catch {
        if (!cancelled) summary.textContent = "Couldn't load this project's pages.";
        return;
      }
      if (!cancelled) render(overview);
    }

    function open() {
      // In edit mode a press on the widget is the grid's: moving and sizing it.
      if (host.editMode.isEditing()) return;
      location.hash = "#page=portfolio";
    }
    wrap.addEventListener("click", (event) => {
      if (event.target.closest(".widget-portfolio-dpi")) return;
      open();
    });
    wrap.addEventListener("keydown", (event) => {
      if (event.target !== wrap || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      open();
    });

    dpiInput.addEventListener("change", () => {
      const raw = dpiInput.value.trim();
      const next = { ...host.config };
      if (!raw) {
        delete next.exportDpi; // back to the app default
      } else {
        const dpi = Math.min(range[1], Math.max(range[0], Math.round(Number(raw)) || defaultDpi));
        next.exportDpi = dpi;
        dpiInput.value = String(dpi);
      }
      host.save(next);
    });

    const unsubscribeEditMode = host.editMode.subscribe((editing) => {
      dpiRow.hidden = !editing;
      wrap.classList.toggle("is-editing", editing);
      // A link to the management view out of edit mode; in it, just a box on the grid.
      if (editing) wrap.removeAttribute("role");
      else wrap.setAttribute("role", "link");
    });
    host.onDestroy(unsubscribeEditMode);

    // The homepage stays mounted underneath the pages it opens, so coming back
    // from the management view or the canvas doesn't rebuild this widget --
    // it has to notice for itself that the pages may have changed.
    function onHashChange() {
      if (!new URLSearchParams(location.hash.slice(1)).get("page")) refresh();
    }
    window.addEventListener("hashchange", onHashChange);

    summary.textContent = "Loading…";
    refresh();

    return {
      destroy() {
        cancelled = true;
        window.removeEventListener("hashchange", onHashChange);
        wrap.remove();
      },
    };
  },
};
