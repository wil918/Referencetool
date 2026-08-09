/* The Colour mode's side panel: what's selected, the group's combined colour
 * profile, and the colour search run from it.
 *
 * The search itself is not reimplemented here. Selecting references and asking
 * for similar colours posts to /api/colour/search -- the same endpoint, the
 * same combined-profile semantics and the same ranking the Project Space
 * sidebar uses -- so the map is a way of *steering* that search rather than a
 * second opinion about which references are close in colour. The results come
 * back in the same shape and are rendered the same way: thumbnail, title,
 * score, and the palette that was actually compared.
 */
const DEBOUNCE_MS = 250; // matches the Project Space sidebar's slider debounce

export function createColourPanel({ onMatches, onFocus }) {
  const panel = document.getElementById("colour-panel");
  const empty = document.getElementById("cm-empty");
  const body = document.getElementById("cm-body");
  const selectedEl = document.getElementById("cm-selected");
  const combinedEl = document.getElementById("cm-combined");
  const statusEl = document.getElementById("cm-status");
  const resultsEl = document.getElementById("cm-results");
  const findBtn = document.getElementById("cm-find");
  const clearBtn = document.getElementById("cm-clear");

  let selection = [];
  let nodesById = new Map();
  let timer = null;
  let requestId = 0;
  let lastResults = [];
  let excludeBlackWhite = false;
  let onClear = () => {};

  clearBtn.addEventListener("click", () => onClear());

  findBtn.addEventListener("click", () => {
    if (!lastResults.length) return;
    renderResults(lastResults);
    // Lighting the matches in the cylinder is the whole point of searching
    // from the map: you see which region of colour space answered.
    onMatches(new Map(lastResults.map((r) => [r.id, r.score])));
  });

  function paletteStrip(palette, className = "cm-palette") {
    const strip = document.createElement("div");
    strip.className = className;
    (palette || []).forEach((entry) => {
      const block = document.createElement("span");
      block.style.background = `rgb(${entry.rgb.join(",")})`;
      block.style.flexGrow = String(Math.max(entry.weight, 0.01));
      block.title = `${Math.round(entry.weight * 100)}%`;
      strip.appendChild(block);
    });
    return strip;
  }

  function thumb(ref) {
    const img = document.createElement("img");
    img.src = `/media/${ref.id}/thumb`;
    img.alt = ref.title || "";
    img.loading = "lazy";
    return img;
  }

  function renderSelected() {
    selectedEl.innerHTML = "";
    selection.forEach((id) => {
      const ref = nodesById.get(id);
      if (!ref) return;
      const item = document.createElement("button");
      item.className = "cm-chip";
      item.title = `${ref.title} — click to centre on it`;
      item.appendChild(thumb(ref));
      item.addEventListener("click", () => onFocus(id));
      selectedEl.appendChild(item);
    });
  }

  function renderResults(results) {
    resultsEl.innerHTML = "";
    results.forEach((r) => {
      const row = document.createElement("div");
      row.className = "cm-result";

      const pick = document.createElement("button");
      pick.className = "cm-result-thumb";
      pick.appendChild(thumb(r));
      pick.title = "Centre the map on this reference";
      pick.addEventListener("click", () => onFocus(r.id));

      const info = document.createElement("div");
      const title = document.createElement("div");
      title.className = "cm-result-title";
      title.textContent = r.title || "Untitled";
      const score = document.createElement("div");
      score.className = "cm-score";
      score.textContent = `colour similarity ${r.score.toFixed(3)}`;
      info.append(title, score, paletteStrip(r.palette));

      // The archive's own viewer, rather than a second one built here.
      const open = document.createElement("a");
      open.className = "cm-open";
      open.href = `/index.html#ref=${encodeURIComponent(r.id)}`;
      open.textContent = "Open";
      open.title = "Open this reference in the library";

      row.append(pick, info, open);
      resultsEl.appendChild(row);
    });
  }

  async function runSearch() {
    if (!selection.length) return;
    const id = ++requestId;
    statusEl.textContent = "Reading the group's colour…";

    let data;
    try {
      const res = await fetch("/api/colour/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference_ids: selection,
          exclude_black_white: excludeBlackWhite,
        }),
      });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || `search failed (${res.status})`);
    } catch (err) {
      if (id !== requestId) return;
      statusEl.textContent = `Colour search unavailable — ${err.message}`;
      return;
    }
    if (id !== requestId) return;

    combinedEl.innerHTML = "";
    if (data.profile) {
      combinedEl.appendChild(paletteStrip(data.profile.palette, "cm-palette large"));
    }

    lastResults = data.results || [];
    findBtn.disabled = lastResults.length === 0;
    statusEl.textContent = selection.length > 1
      ? `Combined profile of ${data.used_ids.length} references · ${lastResults.length} similar in the archive`
      : `${lastResults.length} similar in the archive`;
  }

  return {
    setSelection(ids, refsById) {
      selection = [...ids];
      nodesById = refsById;
      panel.hidden = false;
      empty.hidden = selection.length > 0;
      body.hidden = selection.length === 0;

      if (!selection.length) {
        resultsEl.innerHTML = "";
        combinedEl.innerHTML = "";
        lastResults = [];
        onMatches(new Map());
        return;
      }

      renderSelected();
      resultsEl.innerHTML = ""; // the previous selection's matches aren't this one's
      onMatches(new Map());
      clearTimeout(timer);
      timer = setTimeout(runSearch, DEBOUNCE_MS);
    },
    setExcludeBlackWhite(value) {
      excludeBlackWhite = value;
      if (selection.length) {
        clearTimeout(timer);
        timer = setTimeout(runSearch, DEBOUNCE_MS);
      }
    },
    onClear(fn) {
      onClear = fn;
    },
    hide() {
      panel.hidden = true;
    },
  };
}
