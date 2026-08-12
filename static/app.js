import { makeCard, markSelectable, makeBarThumb } from "./shared/cards.js";
import * as carousel from "./shared/carousel.js";
import * as folders from "./project/folders.js";

const SUPPORTED_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".txt", ".md", ".pdf"];

let currentList = [];

// --- Tabs ---

function activateTab(name) {
  const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (!btn) return false;

  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(`tab-${name}`).classList.add("active");

  if (name === "archive") refreshArchive();
  if (name === "projects") showProjectsList();
  if (name === "settings") refreshSimilarityStatus();
  return true;
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

// Deep links, so the graph pages can point at a specific tab: /index.html#archive.
// #ref=<id> goes one step further and opens that reference in the viewer --
// which is how the colour map's results open a reference without building a
// second viewer of their own.
async function activateTabFromHash() {
  const hash = location.hash.replace("#", "");
  const refMatch = hash.match(/^ref=(.+)$/);
  if (!refMatch) return activateTab(hash);

  const id = decodeURIComponent(refMatch[1]);
  activateTab("archive");
  await refreshArchive();
  const index = currentList.findIndex((r) => r.id === id);
  if (index >= 0) carousel.open(currentList, index);
  return true;
}
window.addEventListener("hashchange", activateTabFromHash);

// --- Drag & drop / file pickers ---

const dropzone = document.getElementById("dropzone");

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  })
);

["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
  })
);

dropzone.addEventListener("drop", async (e) => {
  const items = e.dataTransfer.items;
  let files;
  if (items && items.length && items[0].webkitGetAsEntry) {
    files = await filesFromDataTransferItems(Array.from(items));
  } else {
    files = Array.from(e.dataTransfer.files);
  }
  uploadFiles(files);
});

document.getElementById("file-input").addEventListener("change", (e) => {
  uploadFiles(Array.from(e.target.files));
  e.target.value = "";
});

document.getElementById("folder-input").addEventListener("change", (e) => {
  uploadFiles(Array.from(e.target.files));
  e.target.value = "";
});

function filesFromDataTransferItems(items) {
  const files = [];

  function readAllEntries(reader) {
    return new Promise((resolve, reject) => {
      let all = [];
      function readBatch() {
        reader.readEntries((batch) => {
          if (!batch.length) {
            resolve(all);
            return;
          }
          all = all.concat(batch);
          readBatch();
        }, reject);
      }
      readBatch();
    });
  }

  async function traverse(entry) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push(file);
    } else if (entry.isDirectory) {
      const entries = await readAllEntries(entry.createReader());
      for (const child of entries) await traverse(child);
    }
  }

  const entries = items.map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
  return Promise.all(entries.map(traverse)).then(() => files);
}

// --- Uploading ---

async function uploadFiles(files) {
  if (!files.length) return;
  const log = document.getElementById("upload-log");
  const source = document.getElementById("file-source").value.trim();
  const ownWork = document.getElementById("file-own-work").checked;

  for (const file of files) {
    const dot = file.name.lastIndexOf(".");
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
    if (file.name === ".DS_Store" || !SUPPORTED_EXTS.includes(ext)) continue;

    const row = document.createElement("div");
    row.className = "log-row";
    row.textContent = `${file.name} — uploading...`;
    log.prepend(row);

    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      if (source) fd.append("source", source);
      fd.append("own_work", ownWork ? "true" : "false");
      const res = await fetch("/api/add-file", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        row.classList.add(data.duplicate ? "warn" : "error");
        row.textContent = data.duplicate
          ? `${file.name} — skipped (already in the library)`
          : `${file.name} — failed: ${data.error}`;
      } else {
        row.classList.add("ok");
        row.textContent = `${file.name} — added${data.tags.length ? " (" + data.tags.slice(0, 3).join(", ") + ")" : ""}`;
      }
    } catch (err) {
      row.classList.add("error");
      row.textContent = `${file.name} — failed: ${err}`;
    }
  }

  refreshArchive();
}

document.getElementById("text-save-btn").addEventListener("click", async () => {
  const titleEl = document.getElementById("text-title");
  const bodyEl = document.getElementById("text-body");
  const sourceEl = document.getElementById("text-source");
  const ownWorkEl = document.getElementById("text-own-work");
  const status = document.getElementById("text-add-status");
  const text = bodyEl.value;

  if (!text.trim()) {
    status.textContent = "Write something first.";
    return;
  }

  status.textContent = "Saving...";
  try {
    const res = await fetch("/api/add-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: titleEl.value.trim(),
        text,
        source: sourceEl.value.trim(),
        own_work: ownWorkEl.checked,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      status.textContent = data.duplicate ? "Skipped: identical text already saved." : `Error: ${data.error}`;
    } else {
      status.textContent = `Saved as "${data.title}".`;
      titleEl.value = "";
      bodyEl.value = "";
      sourceEl.value = "";
      ownWorkEl.checked = false;
      refreshArchive();
    }
  } catch (err) {
    status.textContent = `Error: ${err}`;
  }
});

// --- Archive grid: search + filters ---

const searchInput = document.getElementById("search-input");
const filterOwnWork = document.getElementById("filter-own-work");
const typeCheckboxes = Array.from(document.querySelectorAll(".type-checkbox"));
const searchMethodCheckboxes = Array.from(document.querySelectorAll(".search-method-checkbox"));
let searchDebounce = null;

searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(refreshArchive, 300);
});
filterOwnWork.addEventListener("change", refreshArchive);
typeCheckboxes.forEach((cb) => cb.addEventListener("change", refreshArchive));
searchMethodCheckboxes.forEach((cb) => cb.addEventListener("change", refreshArchive));

// --- Cross-project folder roll-up ---
//
// A gradual narrowing that composes with the filters above rather than
// replacing them: refreshArchive always fetches the search/type/own-work
// filtered list first, then -- only if a roll-up chip is selected --
// intersects it with that folder name's references. Clearing the chip drops
// the intersection and the full (still search/type/own-work-filtered) list
// comes back. A folder never removes anything from the archive itself.

const folderChipsEl = document.getElementById("archive-folder-chips");
const folderNoteEl = document.getElementById("archive-folder-note");
const folderNoteNameEl = document.getElementById("archive-folder-note-name");
let archiveFolderFilter = null; // folder name (string) or null

async function refreshFolderChips() {
  const rollup = await folders.listFolderRollup();
  folderChipsEl.innerHTML = "";
  if (archiveFolderFilter && !rollup.some((f) => f.name === archiveFolderFilter)) {
    archiveFolderFilter = null;
  }
  rollup.forEach((entry) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "btn folder-chip";
    if (entry.name === archiveFolderFilter) chip.classList.add("active");
    const projectNames = entry.projects.map((p) => p.title).join(", ");
    chip.textContent = `${entry.name} (${entry.reference_count})`;
    chip.title = `In: ${projectNames}`;
    chip.addEventListener("click", () => {
      archiveFolderFilter = archiveFolderFilter === entry.name ? null : entry.name;
      refreshArchive();
    });
    folderChipsEl.appendChild(chip);
  });
  folderNoteEl.hidden = !archiveFolderFilter;
  if (archiveFolderFilter) folderNoteNameEl.textContent = archiveFolderFilter;
}

async function refreshArchive() {
  const params = new URLSearchParams();
  const q = searchInput.value.trim();
  const checkedTypes = typeCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
  const checkedMethods = searchMethodCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
  if (q) params.set("q", q);
  if (filterOwnWork.value !== "any") params.set("own_work", filterOwnWork.value);
  if (checkedTypes.length) params.set("type", checkedTypes.join(","));
  if (checkedMethods.length) params.set("search_by", checkedMethods.join(","));

  const [res] = await Promise.all([fetch(`/api/references?${params.toString()}`), refreshFolderChips()]);
  let refs = await res.json();
  if (archiveFolderFilter) {
    const folderRefs = await folders.listFolderRollupReferences(archiveFolderFilter);
    const ids = new Set(folderRefs.map((r) => r.id));
    refs = refs.filter((r) => ids.has(r.id));
  }
  currentList = refs;
  archiveFiltersActive =
    Boolean(q) || filterOwnWork.value !== "any" || checkedTypes.length > 0 || Boolean(archiveFolderFilter);
  // A reference that's no longer in the list (deleted, or filtered out)
  // shouldn't stay silently selected behind the scenes.
  const visible = new Set(currentList.map((r) => r.id));
  archiveSelectedIds.forEach((id) => {
    if (!visible.has(id)) archiveSelectedIds.delete(id);
  });
  renderGrid();
  updateArchiveSelectionToolbar();
}

function renderGrid() {
  const grid = document.getElementById("grid");
  const emptyMsg = document.getElementById("empty-msg");
  grid.innerHTML = "";
  emptyMsg.hidden = currentList.length > 0;
  emptyMsg.textContent = archiveFiltersActive
    ? "No references match that search and those filters."
    : "No references yet. Add some from the Add tab.";
  currentList.forEach((ref, idx) => {
    const card = makeCard(
      ref,
      archiveSelectionMode ? () => toggleArchiveSelection(ref.id) : () => carousel.open(currentList, idx)
    );
    if (archiveSelectionMode) markSelectable(card, archiveSelectedIds.has(ref.id));
    grid.appendChild(card);
  });
}

// --- Archive selection (bulk add-to-project / delete) ---
//
// Deliberately kept separate from the project detail page's selection state:
// the two grids are different lists, and their Delete actions mean different
// things (remove from this project vs. remove from the library entirely).

const archiveSelectBtn = document.getElementById("archive-select-btn");
const archiveSelectionToolbar = document.getElementById("archive-selection-toolbar");
const archiveProjectSelect = document.getElementById("archive-project-select");
const archiveSelectionStatus = document.getElementById("archive-selection-status");
const archiveDeleteBtn = document.getElementById("archive-selection-delete-btn");
let archiveSelectionMode = false;
let archiveSelectedIds = new Set();
let archiveFiltersActive = false;

function setArchiveSelectionMode(on) {
  archiveSelectionMode = on;
  archiveSelectedIds.clear();
  archiveSelectBtn.textContent = on ? "Cancel" : "Select";
  archiveSelectionToolbar.hidden = !on;
  archiveSelectionStatus.textContent = "";
  if (on) populateArchiveProjectSelect();
  updateArchiveSelectionToolbar();
  renderGrid();
}

function toggleArchiveSelection(refId) {
  if (archiveSelectedIds.has(refId)) {
    archiveSelectedIds.delete(refId);
  } else {
    archiveSelectedIds.add(refId);
  }
  renderGrid();
  updateArchiveSelectionToolbar();
}

function updateArchiveSelectionToolbar() {
  const n = archiveSelectedIds.size;
  document.getElementById("archive-selection-count").textContent = `${n} selected`;
  archiveDeleteBtn.disabled = n === 0;
  archiveProjectSelect.disabled = n === 0;
  archiveFolderProjectSelect.disabled = n === 0;
  if (!archiveFolderSelect.hidden) archiveFolderSelect.disabled = n === 0;
}

archiveSelectBtn.addEventListener("click", () => setArchiveSelectionMode(!archiveSelectionMode));

archiveProjectSelect.addEventListener("change", () => {
  const value = archiveProjectSelect.value;
  if (!value || archiveSelectedIds.size === 0) return;

  if (value === "__new__") {
    archiveProjectSelect.value = "";
    openNewProjectModal((project) => addSelectionToProject(project.id, project.title));
    return;
  }

  const label = archiveProjectSelect.options[archiveProjectSelect.selectedIndex].textContent;
  addSelectionToProject(value, label);
});

async function populateArchiveProjectSelect() {
  const res = await fetch("/api/projects");
  const projects = await res.json();

  archiveProjectSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Add to project…";
  archiveProjectSelect.appendChild(placeholder);

  projects.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.title;
    archiveProjectSelect.appendChild(opt);
  });

  const newOpt = document.createElement("option");
  newOpt.value = "__new__";
  newOpt.textContent = "+ New project…";
  archiveProjectSelect.appendChild(newOpt);
  archiveProjectSelect.value = "";

  // Same project list, reused rather than fetched twice: the folder move
  // picks a project first (to know whose folders to offer), then its
  // folders -- no "+ New project…" here since a folder needs a project that
  // already exists.
  archiveFolderProjectSelect.innerHTML = "";
  const folderPlaceholder = document.createElement("option");
  folderPlaceholder.value = "";
  folderPlaceholder.textContent = "Move to folder…";
  archiveFolderProjectSelect.appendChild(folderPlaceholder);
  projects.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.title;
    archiveFolderProjectSelect.appendChild(opt);
  });
  archiveFolderProjectSelect.value = "";
  resetArchiveFolderSelect();
}

// --- Move to folder (archive selection toolbar) ---
//
// Two-step because a folder belongs to one project: pick the project whose
// folders to browse, then the folder itself. Filing into it adds the
// reference to that project too if it wasn't already a member (see
// app.py's POST /api/folders/<id>/references).

const archiveFolderProjectSelect = document.getElementById("archive-folder-project-select");
const archiveFolderSelect = document.getElementById("archive-folder-select");

function resetArchiveFolderSelect() {
  archiveFolderSelect.hidden = true;
  archiveFolderSelect.disabled = true;
  archiveFolderSelect.innerHTML = '<option value="" selected>Choose a folder…</option>';
}

archiveFolderProjectSelect.addEventListener("change", async () => {
  const projectId = archiveFolderProjectSelect.value;
  resetArchiveFolderSelect();
  if (!projectId) return;

  const rows = await folders.listFolders(projectId);
  archiveFolderSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a folder…";
  archiveFolderSelect.appendChild(placeholder);
  rows.forEach((folder) => {
    const opt = document.createElement("option");
    opt.value = folder.id;
    opt.textContent = folder.name;
    archiveFolderSelect.appendChild(opt);
  });
  archiveFolderSelect.hidden = false;
  archiveFolderSelect.disabled = archiveSelectedIds.size === 0;
});

archiveFolderSelect.addEventListener("change", async () => {
  const folderId = archiveFolderSelect.value;
  if (!folderId || archiveSelectedIds.size === 0) return;
  const label = archiveFolderSelect.options[archiveFolderSelect.selectedIndex].textContent;
  const ids = Array.from(archiveSelectedIds);
  archiveSelectionStatus.textContent = `Adding ${ids.length} reference${ids.length === 1 ? "" : "s"} to "${label}"...`;
  try {
    await folders.addReferencesToFolder(folderId, ids);
    const message =
      `Added ${ids.length} reference${ids.length === 1 ? "" : "s"} to "${label}". ` +
      "A reference can sit in several folders at once -- this doesn't remove it from any project or other folder.";
    archiveFolderProjectSelect.value = "";
    resetArchiveFolderSelect();
    setArchiveSelectionMode(false); // clears the status line, so set it afterwards
    archiveSelectionStatus.textContent = message;
  } catch (err) {
    archiveSelectionStatus.textContent = `Error: ${err.message}`;
  }
});

async function addSelectionToProject(projectId, projectTitle) {
  const ids = Array.from(archiveSelectedIds);
  if (!ids.length) return;
  archiveSelectionStatus.textContent = `Adding ${ids.length} reference${ids.length === 1 ? "" : "s"}...`;

  const results = await Promise.all(
    ids.map((id) =>
      fetch(`/api/projects/${projectId}/references`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference_id: id }),
      }).then((r) => r.ok)
    )
  );

  const added = results.filter(Boolean).length;
  const failed = results.length - added;
  const message =
    `Added ${added} reference${added === 1 ? "" : "s"} to "${projectTitle}".` +
    (failed ? ` ${failed} could not be added.` : "");

  archiveProjectSelect.value = "";
  setArchiveSelectionMode(false); // clears the status line, so set it afterwards
  archiveSelectionStatus.textContent = message;
}

// --- Archive delete confirmation ---

const deleteRefsOverlay = document.getElementById("delete-refs-overlay");
const deleteRefsStatus = document.getElementById("delete-refs-status");
const deleteRefsConfirm = document.getElementById("delete-refs-confirm");

archiveDeleteBtn.addEventListener("click", () => {
  const n = archiveSelectedIds.size;
  if (n === 0) return;
  document.getElementById("delete-refs-text").textContent =
    `Permanently remove ${n} reference${n === 1 ? "" : "s"} from the archive?`;
  deleteRefsStatus.textContent = "";
  deleteRefsConfirm.disabled = false;
  deleteRefsOverlay.hidden = false;
});

document.getElementById("delete-refs-cancel").addEventListener("click", () => {
  deleteRefsOverlay.hidden = true;
});

deleteRefsConfirm.addEventListener("click", async () => {
  const ids = Array.from(archiveSelectedIds);
  if (!ids.length) return;
  deleteRefsConfirm.disabled = true;
  deleteRefsStatus.textContent = "Deleting...";

  const results = await Promise.all(
    ids.map((id) => fetch(`/api/references/${id}`, { method: "DELETE" }).then((r) => r.ok))
  );
  const deleted = results.filter(Boolean).length;
  const failed = results.length - deleted;

  deleteRefsOverlay.hidden = true;
  setArchiveSelectionMode(false);
  await refreshArchive();
  archiveSelectionStatus.textContent =
    `Deleted ${deleted} reference${deleted === 1 ? "" : "s"}.` +
    (failed ? ` ${failed} could not be deleted.` : "") +
    " Re-run Calculate Similarity Scores in Settings to update the 3D graph.";
});

// --- Projects ---

const projectsListView = document.getElementById("projects-list-view");

function showProjectsList() {
  projectsListView.hidden = false;
  refreshProjectsList();
}

async function refreshProjectsList() {
  const res = await fetch("/api/projects");
  const projects = await res.json();
  const list = document.getElementById("projects-list");
  const emptyMsg = document.getElementById("projects-empty-msg");
  list.innerHTML = "";
  emptyMsg.hidden = projects.length > 0;
  const existing = new Set(projects.map((p) => p.id));
  selectedProjectIds.forEach((id) => {
    if (!existing.has(id)) selectedProjectIds.delete(id);
  });
  projects.forEach((project) => list.appendChild(makeProjectBar(project)));
  updateProjectsSelectionToolbar();
}

// --- Projects list selection (delete projects) ---

const projectsSelectBtn = document.getElementById("projects-select-btn");
const projectsSelectionToolbar = document.getElementById("projects-selection-toolbar");
const projectsSelectionStatus = document.getElementById("projects-selection-status");
const projectsDeleteBtn = document.getElementById("projects-delete-btn");
let projectsSelectionMode = false;
let selectedProjectIds = new Set();

function setProjectsSelectionMode(on) {
  projectsSelectionMode = on;
  selectedProjectIds.clear();
  projectsSelectBtn.textContent = on ? "Cancel" : "Select";
  projectsSelectionToolbar.hidden = !on;
  projectsSelectionStatus.textContent = "";
  refreshProjectsList();
}

function toggleProjectSelection(projectId) {
  if (selectedProjectIds.has(projectId)) {
    selectedProjectIds.delete(projectId);
  } else {
    selectedProjectIds.add(projectId);
  }
  refreshProjectsList();
}

function updateProjectsSelectionToolbar() {
  const n = selectedProjectIds.size;
  document.getElementById("projects-selection-count").textContent = `${n} selected`;
  projectsDeleteBtn.disabled = n === 0;
}

projectsSelectBtn.addEventListener("click", () => setProjectsSelectionMode(!projectsSelectionMode));

const deleteProjectsOverlay = document.getElementById("delete-projects-overlay");
const deleteProjectsStatus = document.getElementById("delete-projects-status");
const deleteProjectsConfirm = document.getElementById("delete-projects-confirm");

projectsDeleteBtn.addEventListener("click", () => {
  const n = selectedProjectIds.size;
  if (n === 0) return;
  document.getElementById("delete-projects-text").textContent =
    `Delete ${n} project${n === 1 ? "" : "s"}?`;
  deleteProjectsStatus.textContent = "";
  deleteProjectsConfirm.disabled = false;
  deleteProjectsOverlay.hidden = false;
});

document.getElementById("delete-projects-cancel").addEventListener("click", () => {
  deleteProjectsOverlay.hidden = true;
});

deleteProjectsConfirm.addEventListener("click", async () => {
  const ids = Array.from(selectedProjectIds);
  if (!ids.length) return;
  deleteProjectsConfirm.disabled = true;
  deleteProjectsStatus.textContent = "Deleting...";

  const results = await Promise.all(
    ids.map((id) => fetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => r.ok))
  );
  const deleted = results.filter(Boolean).length;
  const failed = results.length - deleted;

  deleteProjectsOverlay.hidden = true;
  setProjectsSelectionMode(false);
  projectsSelectionStatus.textContent =
    `Deleted ${deleted} project${deleted === 1 ? "" : "s"}.` +
    (failed ? ` ${failed} could not be deleted.` : "");
});

function makeProjectBar(project) {
  const bar = document.createElement("div");
  bar.className = "project-bar";
  bar.addEventListener(
    "click",
    projectsSelectionMode
      ? () => toggleProjectSelection(project.id)
      : () => (location.href = `/project.html?id=${project.id}`)
  );
  if (projectsSelectionMode) markSelectable(bar, selectedProjectIds.has(project.id));

  const header = document.createElement("div");
  header.className = "project-bar-header";
  const title = document.createElement("h3");
  title.textContent = project.title;
  const count = document.createElement("span");
  count.className = "muted";
  count.textContent = `${project.reference_count} reference${project.reference_count === 1 ? "" : "s"}`;
  header.appendChild(title);
  header.appendChild(count);
  bar.appendChild(header);

  if (project.description) {
    const desc = document.createElement("p");
    desc.className = "muted project-bar-description";
    desc.textContent = project.description;
    bar.appendChild(desc);
  }

  const row = document.createElement("div");
  row.className = "project-bar-row";
  if (project.preview.length) {
    project.preview.forEach((ref) => row.appendChild(makeBarThumb(ref)));
  } else {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No references yet.";
    row.appendChild(empty);
  }
  bar.appendChild(row);

  return bar;
}

// Creating a project from the Projects list lands straight on its page --
// project.html's shell is the only place a project's contents are shown now,
// the same way clicking a project bar (makeProjectBar above) does.
document.getElementById("new-project-btn").addEventListener("click", () => {
  openNewProjectModal((project) => {
    location.href = `/project.html?id=${project.id}`;
  });
});

// --- New project modal (shared by the Projects page and the carousel's
// "add to project" control) ---

const newProjectOverlay = document.getElementById("new-project-overlay");
const newProjectTitle = document.getElementById("new-project-title");
const newProjectDescription = document.getElementById("new-project-description");
const newProjectStatus = document.getElementById("new-project-status");
const newProjectSubmitBtn = document.getElementById("new-project-create");
let onProjectCreated = null;

function openNewProjectModal(onCreated) {
  onProjectCreated = onCreated;
  newProjectTitle.value = "";
  newProjectDescription.value = "";
  newProjectStatus.textContent = "";
  newProjectOverlay.hidden = false;
  newProjectTitle.focus();
}

function closeNewProjectModal() {
  newProjectOverlay.hidden = true;
  onProjectCreated = null;
}

document.getElementById("new-project-cancel").addEventListener("click", closeNewProjectModal);

newProjectOverlay.addEventListener("click", (e) => {
  if (e.target === newProjectOverlay) closeNewProjectModal();
});

newProjectSubmitBtn.addEventListener("click", async () => {
  const title = newProjectTitle.value.trim();
  if (!title) {
    newProjectStatus.textContent = "Give the project a title first.";
    return;
  }
  newProjectStatus.textContent = "Creating...";
  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: newProjectDescription.value.trim() }),
    });
    const project = await res.json();
    if (!res.ok) {
      newProjectStatus.textContent = `Error: ${project.error}`;
      return;
    }
    newProjectOverlay.hidden = true;
    const callback = onProjectCreated;
    onProjectCreated = null;
    if (callback) callback(project);
  } catch (err) {
    newProjectStatus.textContent = `Error: ${err}`;
  }
});

// --- Carousel ---
//
// The overlay itself lives in shared/carousel.js; this just wires it to the
// project-create modal so its "+ New project…" option can reuse the one
// modal implementation instead of growing a second.

carousel.configure({ onCreateProject: openNewProjectModal });

// --- Settings: appearance ---

const darkModeToggle = document.getElementById("dark-mode-toggle");
darkModeToggle.checked = window.themeControl.get() === "dark";
darkModeToggle.addEventListener("change", () => {
  window.themeControl.set(darkModeToggle.checked ? "dark" : "light");
});

// --- Settings: similarity scores ---

const similarityStatus = document.getElementById("similarity-status");
const similarityCalcBtn = document.getElementById("similarity-calculate-btn");
const similarityEstimateOverlay = document.getElementById("similarity-estimate-overlay");
const similarityEstimateText = document.getElementById("similarity-estimate-text");
const similarityEstimateStatus = document.getElementById("similarity-estimate-status");
const similarityEstimateConfirm = document.getElementById("similarity-estimate-confirm");

async function refreshSimilarityStatus() {
  const res = await fetch("/api/similarity/estimate");
  const data = await res.json();
  similarityStatus.textContent =
    data.saved_count > 0
      ? `${data.saved_count} score${data.saved_count === 1 ? "" : "s"} saved (last calculated ` +
        `${new Date(data.last_computed_at).toLocaleString()}). ${data.reference_count} references currently in the library.`
      : `No similarity scores saved yet. ${data.reference_count} references currently in the library.`;
  return data;
}

similarityCalcBtn.addEventListener("click", async () => {
  const data = await refreshSimilarityStatus();
  if (data.pair_count === 0) {
    similarityStatus.textContent = "Add at least 2 references to the library before calculating similarity.";
    return;
  }
  similarityEstimateText.textContent =
    `This will compute similarity for ${data.pair_count} pair${data.pair_count === 1 ? "" : "s"} ` +
    `across ${data.reference_count} references, using embeddings you already have stored. ` +
    `Estimated cost: $0.00 -- no Claude API calls are made.`;
  similarityEstimateStatus.textContent = "";
  similarityEstimateOverlay.hidden = false;
});

similarityEstimateConfirm.addEventListener("click", async () => {
  similarityEstimateConfirm.disabled = true;
  similarityEstimateStatus.textContent = "Calculating...";
  try {
    const res = await fetch("/api/similarity/calculate", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      similarityEstimateStatus.textContent = `Error: ${data.error}`;
      return;
    }
    similarityEstimateOverlay.hidden = true;
    await refreshSimilarityStatus();
  } catch (err) {
    similarityEstimateStatus.textContent = `Error: ${err}`;
  } finally {
    similarityEstimateConfirm.disabled = false;
  }
});

document.getElementById("similarity-estimate-cancel").addEventListener("click", () => {
  similarityEstimateOverlay.hidden = true;
});

similarityEstimateOverlay.addEventListener("click", (e) => {
  if (e.target === similarityEstimateOverlay) similarityEstimateOverlay.hidden = true;
});

// --- Init ---

// A hash deep link picks its own tab and loads whatever that tab needs;
// failing that, prime the archive grid so switching to it is instant. Run
// last, once every element the tabs touch has been wired up.
activateTabFromHash().then((handled) => {
  if (!handled) refreshArchive();
});
