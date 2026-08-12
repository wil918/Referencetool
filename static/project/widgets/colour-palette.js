/* The combined colour palette of a chosen set of this project's references.
 *
 * The palette itself is never computed here -- it comes from
 * /api/colour/search's combined-profile semantics, the same endpoint the
 * Colour Similarity sidebar (pages/colour-panel.js) ranks from, so a palette
 * shown on this widget can never disagree with what a colour search from the
 * same references would say. `limit: 0` skips the ranking work the widget
 * has no use for; the profile is computed regardless of limit.
 *
 * config: { reference_ids }
 */

import { makeBarThumb } from "../../shared/cards.js";

export default {
  type: "colour-palette",
  label: "Colour Palette",
  container: false,
  permanent: false,
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 2, h: 2 },

  create(host) {
    const projectId = host.project.id;
    let referenceIds = [...(host.config?.reference_ids || [])];
    // Fetched once, lazily, and cached -- the picker needs every project
    // reference to choose from, the palette view only needs the handful
    // that are picked, so nothing is fetched at all until one or the other
    // is actually shown.
    let allReferences = null;
    let paletteRequestId = 0;

    const wrap = document.createElement("div");
    wrap.className = "widget-colour-palette";

    const view = document.createElement("div");
    view.className = "colour-palette-view";
    wrap.appendChild(view);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn widget-chrome-btn colour-palette-edit";
    editBtn.title = "Choose references";
    editBtn.textContent = "Edit";
    wrap.appendChild(editBtn);

    const picker = document.createElement("div");
    picker.className = "colour-palette-picker";
    picker.hidden = true;
    wrap.appendChild(picker);

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Filter references…";
    search.className = "colour-palette-search";
    picker.appendChild(search);

    const pickerList = document.createElement("div");
    pickerList.className = "colour-palette-picker-list";
    picker.appendChild(pickerList);

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "btn primary colour-palette-done";
    doneBtn.textContent = "Done";
    picker.appendChild(doneBtn);

    host.el.appendChild(wrap);

    async function ensureReferences() {
      if (allReferences) return allReferences;
      // No standalone GET for a project's reference list -- it rides along
      // with the project itself (main.js and canvas-page.js fetch it the
      // same way); /api/projects/<id>/references is POST/DELETE only.
      const res = await fetch(`/api/projects/${projectId}`);
      allReferences = res.ok ? (await res.json()).references || [] : [];
      return allReferences;
    }

    function toggleReference(id) {
      const idx = referenceIds.indexOf(id);
      if (idx === -1) referenceIds.push(id);
      else referenceIds.splice(idx, 1);
      host.save({ ...host.config, reference_ids: referenceIds });
      renderPickerList(search.value);
    }

    function renderPickerList(query = "") {
      const needle = query.trim().toLowerCase();
      const matches = needle
        ? allReferences.filter((ref) =>
            `${ref.title} ${(ref.tags || []).join(" ")}`.toLowerCase().includes(needle)
          )
        : allReferences;

      pickerList.innerHTML = "";
      if (!matches.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = allReferences.length ? "Nothing matches that." : "No references in this project yet.";
        pickerList.appendChild(empty);
        return;
      }
      for (const ref of matches) {
        const item = document.createElement("div");
        item.className = "colour-palette-picker-item";
        item.classList.toggle("is-selected", referenceIds.includes(ref.id));
        item.title = ref.title;
        item.appendChild(makeBarThumb(ref));
        item.addEventListener("click", () => {
          toggleReference(ref.id);
          item.classList.toggle("is-selected", referenceIds.includes(ref.id));
        });
        pickerList.appendChild(item);
      }
    }

    async function openPicker() {
      picker.hidden = false;
      view.hidden = true;
      editBtn.hidden = true;
      await ensureReferences();
      renderPickerList(search.value);
    }

    function closePicker() {
      picker.hidden = true;
      view.hidden = false;
      editBtn.hidden = false;
      renderPalette();
    }

    editBtn.addEventListener("click", openPicker);
    doneBtn.addEventListener("click", closePicker);
    search.addEventListener("input", () => renderPickerList(search.value));

    function renderMessage(message, actionLabel, actionHref) {
      view.innerHTML = "";
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = message;
      view.appendChild(p);
      if (actionLabel && actionHref) {
        const link = document.createElement("a");
        link.className = "btn";
        link.href = actionHref;
        link.textContent = actionLabel;
        view.appendChild(link);
      }
    }

    async function renderPalette() {
      if (!referenceIds.length) {
        renderMessage("Choose references to build a combined palette.");
        return;
      }

      const thisRequest = ++paletteRequestId;
      let data;
      try {
        const res = await fetch("/api/colour/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference_ids: referenceIds, limit: 0 }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || `Colour search failed (${res.status}).`);
      } catch (err) {
        if (thisRequest !== paletteRequestId) return;
        renderMessage(err.message);
        return;
      }
      if (thisRequest !== paletteRequestId) return;

      if (!data.profile) {
        const pending = data.coverage?.pending || 0;
        renderMessage(
          pending
            ? `Selected references have no colour profile yet — ${pending} still to analyse across the archive.`
            : "Selected references have no image to analyse.",
          pending ? "Analyse Colour in Settings" : null,
          pending ? "/index.html#settings" : null
        );
        return;
      }

      view.innerHTML = "";

      await ensureReferences();
      const thumbs = document.createElement("div");
      thumbs.className = "colour-palette-refs";
      for (const id of referenceIds) {
        const ref = allReferences.find((r) => r.id === id);
        if (ref) thumbs.appendChild(makeBarThumb(ref));
      }
      view.appendChild(thumbs);

      const strip = document.createElement("div");
      strip.className = "palette-strip large colour-palette-strip";
      for (const entry of data.profile.palette || []) {
        const block = document.createElement("span");
        block.style.width = `${Math.max(2, entry.weight * 100)}%`;
        block.style.background = `rgb(${entry.rgb.join(",")})`;
        block.title = `${Math.round(entry.weight * 100)}%`;
        strip.appendChild(block);
      }
      view.appendChild(strip);
    }

    renderPalette();

    return {
      destroy() {
        wrap.remove();
      },
    };
  },
};
