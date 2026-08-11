/* The Colour Similarity sidebar -- ported from the old project detail view
 * in app.js, parameterized instead of reaching for module-level
 * currentProject/currentList/selectedRefIds globals, so grid-page.js can
 * mount one of these per page instance (the project grid, or any folder).
 *
 * Searches the archive for references whose colour character resembles the
 * ones currently selected. It reuses whatever selection grid-page.js already
 * tracks rather than introducing its own, and adds results through the
 * existing project-reference endpoint -- always to the project, never a
 * folder, since colour search is project-wide regardless of which page
 * happens to be hosting it (folders never filter what's searched, the same
 * as everywhere else in the project space).
 *
 * Ranking is colour only. The CLIP embeddings behind "similar items" rank by
 * shape and semantics, so blending them in would break the promise that the
 * four sliders explain the ordering.
 */

import { makeBarThumb } from "../../shared/cards.js";

// Slider changes only re-rank precomputed profiles, but that's still a round
// trip -- debounced so dragging one doesn't fire a request per pixel.
const DEBOUNCE_MS = 250;

export function createColourPanel({ project, getReferences, onReferenceAdded }) {
  let currentIds = [];
  let searchTimer = null;
  let requestId = 0;

  const sidebar = document.createElement("aside");
  sidebar.className = "colour-sidebar";
  sidebar.hidden = true;
  sidebar.innerHTML = `
    <div class="analysis-sidebar-header">
      <h3>Colour Similarity</h3>
      <button type="button" class="btn colour-sidebar-close">Close</button>
    </div>

    <p class="muted colour-empty">Select one or more references to search by colour.</p>

    <div class="colour-body" hidden>
      <div class="colour-section">
        <div class="colour-section-label">Selected</div>
        <div class="colour-selected"></div>
        <div class="colour-section-label">Combined palette</div>
        <div class="palette-strip large colour-combined-palette"></div>
      </div>

      <div class="colour-section">
        <div class="colour-controls">
          <label class="colour-control">
            <span>Hue</span>
            <input type="range" min="0" max="100" value="50" data-weight="hue">
          </label>
          <label class="colour-control">
            <span>Lightness</span>
            <input type="range" min="0" max="100" value="50" data-weight="lightness">
          </label>
          <label class="colour-control">
            <span>Saturation</span>
            <input type="range" min="0" max="100" value="50" data-weight="saturation">
          </label>
          <label class="colour-control">
            <span>Proportions</span>
            <input type="range" min="0" max="100" value="50" data-weight="proportions">
          </label>
        </div>
        <label class="checkbox-label colour-bw-toggle">
          <input type="checkbox" class="colour-exclude-bw">
          Remove black &amp; white
        </label>
      </div>

      <p class="muted colour-status"></p>
      <div class="colour-results"></div>
    </div>
  `;
  document.body.appendChild(sidebar);

  const emptyEl = sidebar.querySelector(".colour-empty");
  const bodyEl = sidebar.querySelector(".colour-body");
  const selectedEl = sidebar.querySelector(".colour-selected");
  const combinedPaletteEl = sidebar.querySelector(".colour-combined-palette");
  const statusEl = sidebar.querySelector(".colour-status");
  const resultsEl = sidebar.querySelector(".colour-results");
  const sliders = [...sidebar.querySelectorAll("[data-weight]")];
  const excludeBW = sidebar.querySelector(".colour-exclude-bw");

  sidebar.querySelector(".colour-sidebar-close").addEventListener("click", () => {
    sidebar.hidden = true;
  });

  for (const slider of sliders) {
    slider.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, DEBOUNCE_MS);
    });
  }

  excludeBW.addEventListener("change", () => {
    clearTimeout(searchTimer);
    runSearch(); // a checkbox click isn't a drag -- no need to debounce
  });

  function weights() {
    const w = {};
    for (const slider of sliders) w[slider.dataset.weight] = Number(slider.value) / 50;
    return w;
  }

  async function runSearch() {
    if (currentIds.length === 0) {
      emptyEl.hidden = false;
      bodyEl.hidden = true;
      return;
    }
    emptyEl.hidden = true;
    bodyEl.hidden = false;

    renderSelected(currentIds);
    statusEl.textContent = "Searching…";

    // Only the newest request may paint: dragging a slider can leave an
    // earlier, slower response arriving after a later one.
    const thisRequestId = ++requestId;

    let data;
    try {
      const res = await fetch("/api/colour/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference_ids: currentIds,
          project_id: project.id,
          weights: weights(),
          exclude_black_white: excludeBW.checked,
        }),
      });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || `search failed (${res.status})`);
    } catch (err) {
      if (thisRequestId !== requestId) return;
      statusEl.textContent = `Colour search unavailable — ${err.message}`;
      return;
    }
    if (thisRequestId !== requestId) return;

    renderCombinedPalette(data.profile);
    renderResults(data);
  }

  function renderSelected(ids) {
    selectedEl.innerHTML = "";
    const list = getReferences();
    for (const id of ids) {
      const ref = list.find((r) => r.id === id);
      if (ref) selectedEl.appendChild(makeBarThumb(ref));
    }
  }

  /** Blocks proportional to each colour's share, so the strip reads as the
   *  image's actual colour makeup rather than a flat swatch list. */
  function makePaletteStrip(palette, className = "palette-strip") {
    const strip = document.createElement("div");
    strip.className = className;
    for (const entry of palette || []) {
      const block = document.createElement("span");
      block.style.width = `${Math.max(2, entry.weight * 100)}%`;
      block.style.background = `rgb(${entry.rgb.join(",")})`;
      block.title = `${Math.round(entry.weight * 100)}%`;
      strip.appendChild(block);
    }
    return strip;
  }

  function renderCombinedPalette(profile) {
    combinedPaletteEl.innerHTML = "";
    for (const block of makePaletteStrip(profile?.palette).children) {
      combinedPaletteEl.appendChild(block.cloneNode(true));
    }
  }

  function renderResults(data) {
    const results = data.results || [];
    resultsEl.innerHTML = "";

    if (!results.length) {
      const coverage = data.coverage || {};
      if (coverage.pending > 0) {
        // Genuinely still working through the archive.
        statusEl.textContent = `Colour analysis is being prepared — ${coverage.pending} image(s) left.`;
      } else if (data.reason === "no_colour_data") {
        // Nothing pending, but nothing in the selection has a palette either
        // -- a text or PDF reference. Saying "being prepared" here would
        // imply a wait that is never going to end.
        statusEl.textContent = "Selected references have no image to analyse.";
      } else {
        statusEl.textContent = "No close colour matches found.";
      }
      return;
    }

    const selectedCount = (data.used_ids || []).length;
    statusEl.textContent =
      selectedCount > 1
        ? `${results.length} matches for the combined colour of ${selectedCount} references.`
        : `${results.length} matches.`;

    for (const result of results) resultsEl.appendChild(makeResultRow(result));
  }

  function makeResultRow(result) {
    const row = document.createElement("div");
    row.className = "colour-result";
    row.appendChild(makeBarThumb(result));

    const body = document.createElement("div");
    body.className = "colour-result-body";

    const title = document.createElement("div");
    title.className = "colour-result-title";
    const dot = document.createElement("span");
    dot.className = "colour-score";
    // The numeric score lives in the tooltip: useful when you want it, not
    // competing with the images when you don't.
    dot.title = `colour similarity ${result.score.toFixed(3)}`;
    title.append(dot, document.createTextNode(result.title || "Untitled"));

    body.append(title, makePaletteStrip(result.palette));
    row.appendChild(body);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn colour-add-btn";
    addBtn.textContent = "+ Add";
    addBtn.addEventListener("click", () => addResultToProject(result.id, addBtn));
    row.appendChild(addBtn);

    return row;
  }

  async function addResultToProject(referenceId, button) {
    button.disabled = true;
    button.textContent = "Adding…";

    try {
      // The same endpoint the archive grid and carousel use -- adding here
      // creates no second kind of project membership, and the backend's
      // INSERT OR IGNORE means a repeat can't duplicate the relationship.
      const res = await fetch(`/api/projects/${project.id}/references`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference_id: referenceId }),
      });
      if (!res.ok) throw new Error("could not add");

      button.textContent = "Added";
      button.classList.add("is-added");
      onReferenceAdded?.();
    } catch {
      button.disabled = false;
      button.textContent = "+ Add";
    }
  }

  return {
    isOpen: () => !sidebar.hidden,

    open(ids) {
      currentIds = ids;
      sidebar.hidden = false;
      runSearch();
    },

    /** Keep an open sidebar in step with the selection -- re-searches rather
     *  than leaving stale results next to a selection that no longer
     *  produced them. A no-op while the sidebar is closed. */
    syncSelection(ids) {
      currentIds = ids;
      if (sidebar.hidden) return;
      if (ids.length === 0) {
        emptyEl.hidden = false;
        bodyEl.hidden = true;
        resultsEl.innerHTML = "";
        return;
      }
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, DEBOUNCE_MS);
    },

    destroy() {
      clearTimeout(searchTimer);
      sidebar.remove();
    },
  };
}
