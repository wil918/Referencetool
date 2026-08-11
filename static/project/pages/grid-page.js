/* A reusable page: a heading, a grid of references and the full selection
 * toolbar (Move to folder, Delete, Colour Similarity, Analyze). Two widgets
 * navigate here with different data (widgets/grid-button.js for every
 * reference in the project, widgets/folder.js for one folder's references)
 * -- everything below is identical between them except what `load` fetches
 * and what `deleteBehaviour` does, both supplied by the caller.
 *
 * Delete means something different in each place -- "remove from the
 * project" vs. "remove from this folder only" -- so deleteBehaviour carries
 * its own confirmation copy rather than this module guessing at wording.
 */

import { makeCard, markSelectable } from "../../shared/cards.js";
import * as carousel from "../../shared/carousel.js";
import * as folders from "../folders.js";
import { ensureOverlays, setActiveReferences } from "./overlays.js";
import { createAnalysisPanel } from "./analysis-panel.js";
import { createColourPanel } from "./colour-panel.js";

/**
 * @param el - the page container to render into (emptied first)
 * @param options.project - {id, title, ...}
 * @param options.heading - page heading text
 * @param options.subheading - optional muted line under the heading
 * @param options.emptyMessage - shown when the list is empty
 * @param options.load - async () => referencesArray, called on mount and
 *   after any mutation that changes what belongs on this page
 * @param options.deleteBehaviour - {
 *     label,            // button text, e.g. "Delete" or "Remove from folder"
 *     confirmHeading,    // modal heading
 *     confirmText(n),    // modal body text for n selected references
 *     note,              // extra muted clarifying line in the modal
 *     perform(ids),      // async -> { deleted, failed }
 *   }
 */
export function createGridPage(el, options) {
  const { project, heading, subheading, emptyMessage, load, deleteBehaviour } = options;

  ensureOverlays();

  let references = [];
  let selectionMode = false;
  const selectedIds = new Set();

  el.innerHTML = "";

  const header = document.createElement("div");
  header.className = "project-detail-header";
  header.innerHTML = `
    <div class="project-detail-heading-row">
      <h2></h2>
      <div class="project-detail-actions">
        <button type="button" class="btn analysis-sidebar-btn">Previous Analysis</button>
        <button type="button" class="btn select-btn">Select</button>
      </div>
    </div>
    <p class="muted"></p>
  `;
  header.querySelector("h2").textContent = heading;
  header.querySelector(".project-detail-header > p").textContent = subheading || "";
  el.appendChild(header);

  const toolbar = document.createElement("div");
  toolbar.className = "selection-toolbar";
  toolbar.hidden = true;
  toolbar.innerHTML = `
    <span class="muted selection-count">0 selected</span>
    <div class="selection-actions">
      <select class="folder-select" disabled>
        <option value="" selected>Move to folder…</option>
      </select>
      <button type="button" class="btn delete-btn" disabled></button>
      <button type="button" class="btn colour-btn" disabled>Colour Similarity</button>
      <button type="button" class="btn primary analyze-btn" disabled>Analyze</button>
    </div>
  `;
  toolbar.querySelector(".delete-btn").textContent = deleteBehaviour.label;
  el.appendChild(toolbar);

  const statusEl = document.createElement("p");
  statusEl.className = "muted";
  el.appendChild(statusEl);

  // Reuses index.html's #grid/#project-grid id so the flat, seamless card
  // styling (style.css) applies without repeating it here -- only one of
  // these ids is ever in the document at a time, since a page replaces the
  // one before it rather than stacking.
  const gridEl = document.createElement("div");
  gridEl.id = "project-grid";
  gridEl.className = "grid";
  el.appendChild(gridEl);

  const emptyEl = document.createElement("p");
  emptyEl.className = "muted";
  emptyEl.hidden = true;
  emptyEl.textContent = emptyMessage;
  el.appendChild(emptyEl);

  // --- delete/remove confirmation ------------------------------------------

  const confirmOverlay = document.createElement("div");
  confirmOverlay.className = "modal-overlay";
  confirmOverlay.hidden = true;
  confirmOverlay.innerHTML = `
    <div class="modal-box">
      <h3></h3>
      <p class="confirm-text"></p>
      <p class="muted confirm-note"></p>
      <p class="muted confirm-status"></p>
      <div class="modal-actions">
        <button type="button" class="btn cancel-btn">Cancel</button>
        <button type="button" class="btn danger confirm-btn"></button>
      </div>
    </div>
  `;
  document.body.appendChild(confirmOverlay);
  confirmOverlay.querySelector("h3").textContent = deleteBehaviour.confirmHeading;
  confirmOverlay.querySelector(".confirm-note").textContent = deleteBehaviour.note || "";
  confirmOverlay.querySelector(".confirm-btn").textContent = deleteBehaviour.label;
  confirmOverlay.querySelector(".cancel-btn").addEventListener("click", () => {
    confirmOverlay.hidden = true;
  });
  confirmOverlay.addEventListener("click", (e) => {
    if (e.target === confirmOverlay) confirmOverlay.hidden = true;
  });

  // --- Analyze / Colour Similarity panels -----------------------------------

  const analysisPanel = createAnalysisPanel({ project, getReferences: () => references });
  const colourPanel = createColourPanel({
    project,
    getReferences: () => references,
    onReferenceAdded: reload,
  });

  // --- rendering -------------------------------------------------------------

  function renderGrid() {
    gridEl.innerHTML = "";
    emptyEl.hidden = references.length > 0;
    references.forEach((ref, idx) => {
      const card = makeCard(
        ref,
        selectionMode ? () => toggleSelection(ref.id) : () => carousel.open(references, idx)
      );
      if (selectionMode) markSelectable(card, selectedIds.has(ref.id));
      gridEl.appendChild(card);
    });
  }

  async function reload() {
    references = await load();
    // A reference that dropped out of the list (deleted, moved) shouldn't
    // stay silently selected behind the scenes.
    const visible = new Set(references.map((r) => r.id));
    for (const id of [...selectedIds]) {
      if (!visible.has(id)) selectedIds.delete(id);
    }
    setActiveReferences(references);
    renderGrid();
    updateToolbar();
  }

  // --- selection -----------------------------------------------------------

  const selectBtn = header.querySelector(".select-btn");
  const countEl = toolbar.querySelector(".selection-count");
  const folderSelect = toolbar.querySelector(".folder-select");
  const deleteBtn = toolbar.querySelector(".delete-btn");
  const colourBtn = toolbar.querySelector(".colour-btn");
  const analyzeBtn = toolbar.querySelector(".analyze-btn");

  function setSelectionMode(on) {
    selectionMode = on;
    selectedIds.clear();
    selectBtn.textContent = on ? "Cancel" : "Select";
    toolbar.hidden = !on;
    statusEl.textContent = "";
    if (on) populateFolderSelect();
    updateToolbar();
    renderGrid();
  }

  function toggleSelection(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    renderGrid();
    updateToolbar();
  }

  function updateToolbar() {
    const n = selectedIds.size;
    countEl.textContent = `${n} selected`;
    deleteBtn.disabled = n === 0;
    colourBtn.disabled = n === 0;
    analyzeBtn.disabled = n === 0;
    folderSelect.disabled = n === 0;
    colourPanel.syncSelection([...selectedIds]);
  }

  selectBtn.addEventListener("click", () => setSelectionMode(!selectionMode));

  // --- move to folder ----------------------------------------------------
  //
  // Additive, like the archive's "Add to project…": choosing a folder files
  // every selected reference into it without touching this page's own
  // membership, so the selection is deliberately left active afterwards --
  // filing the same selection into a second folder is a normal thing to
  // want to do next. Always this project's folders, regardless of which
  // page (the full grid or a specific folder) is hosting the toolbar.

  async function populateFolderSelect() {
    const rows = await folders.listFolders(project.id);
    folderSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Move to folder…";
    folderSelect.appendChild(placeholder);
    rows.forEach((folder) => {
      const opt = document.createElement("option");
      opt.value = folder.id;
      opt.textContent = folder.name;
      folderSelect.appendChild(opt);
    });
  }

  folderSelect.addEventListener("change", async () => {
    const folderId = folderSelect.value;
    if (!folderId || selectedIds.size === 0) return;
    const label = folderSelect.options[folderSelect.selectedIndex].textContent;
    const ids = [...selectedIds];
    statusEl.textContent = `Adding ${ids.length} reference${ids.length === 1 ? "" : "s"} to "${label}"...`;
    try {
      await folders.addReferencesToFolder(folderId, ids);
      statusEl.textContent =
        `Added ${ids.length} reference${ids.length === 1 ? "" : "s"} to "${label}". ` +
        "A reference can sit in several folders at once -- this doesn't remove it from any other.";
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
    folderSelect.value = "";
  });

  // --- delete/remove -------------------------------------------------------

  deleteBtn.addEventListener("click", () => {
    const n = selectedIds.size;
    if (n === 0) return;
    confirmOverlay.querySelector(".confirm-text").textContent = deleteBehaviour.confirmText(n);
    confirmOverlay.querySelector(".confirm-status").textContent = "";
    confirmOverlay.querySelector(".confirm-btn").disabled = false;
    confirmOverlay.hidden = false;
  });

  confirmOverlay.querySelector(".confirm-btn").addEventListener("click", async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const confirmBtn = confirmOverlay.querySelector(".confirm-btn");
    const confirmStatus = confirmOverlay.querySelector(".confirm-status");
    confirmBtn.disabled = true;
    confirmStatus.textContent = "Removing...";

    const result = await deleteBehaviour.perform(ids);

    confirmOverlay.hidden = true;
    setSelectionMode(false); // clears the status line, so set it afterwards
    await reload();
    statusEl.textContent =
      `Removed ${result.deleted} reference${result.deleted === 1 ? "" : "s"}.` +
      (result.failed ? ` ${result.failed} could not be removed.` : "");
  });

  // --- Analyze / Colour Similarity toolbar buttons --------------------------

  header.querySelector(".analysis-sidebar-btn").addEventListener("click", () => analysisPanel.openSidebar());
  analyzeBtn.addEventListener("click", () => analysisPanel.startAnalysis([...selectedIds]));
  colourBtn.addEventListener("click", () => {
    if (selectedIds.size === 0) return;
    colourPanel.open([...selectedIds]);
  });

  // --- init ------------------------------------------------------------------

  reload();

  return {
    destroy() {
      analysisPanel.destroy();
      colourPanel.destroy();
      confirmOverlay.remove();
      el.innerHTML = "";
    },
  };
}
