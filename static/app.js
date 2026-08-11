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

async function refreshArchive() {
  const params = new URLSearchParams();
  const q = searchInput.value.trim();
  const checkedTypes = typeCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
  const checkedMethods = searchMethodCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
  if (q) params.set("q", q);
  if (filterOwnWork.value !== "any") params.set("own_work", filterOwnWork.value);
  if (checkedTypes.length) params.set("type", checkedTypes.join(","));
  if (checkedMethods.length) params.set("search_by", checkedMethods.join(","));

  const res = await fetch(`/api/references?${params.toString()}`);
  currentList = await res.json();
  archiveFiltersActive = Boolean(q) || filterOwnWork.value !== "any" || checkedTypes.length > 0;
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
const projectDetailView = document.getElementById("project-detail-view");
const selectionToolbar = document.getElementById("project-selection-toolbar");
const selectBtn = document.getElementById("project-select-btn");
let currentProject = null;
let selectionMode = false;
let selectedRefIds = new Set();

function showProjectsList() {
  projectDetailView.hidden = true;
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

async function openProjectDetail(projectId) {
  const res = await fetch(`/api/projects/${projectId}`);
  if (!res.ok) return;
  const project = await res.json();

  currentProject = project;
  currentList = project.references;
  setSelectionMode(false);
  analysisSidebar.hidden = true;
  document.getElementById("colour-sidebar").hidden = true;

  document.getElementById("project-detail-title").textContent = project.title;
  document.getElementById("project-detail-description").textContent = project.description || "";

  renderProjectGrid();

  projectsListView.hidden = true;
  projectDetailView.hidden = false;
}

function renderProjectGrid() {
  const grid = document.getElementById("project-grid");
  const emptyMsg = document.getElementById("project-empty-msg");
  grid.innerHTML = "";
  emptyMsg.hidden = currentList.length > 0;
  currentList.forEach((ref, idx) => {
    const card = makeCard(ref, selectionMode ? () => toggleSelection(ref.id) : () => carousel.open(currentList, idx));
    if (selectionMode) markSelectable(card, selectedRefIds.has(ref.id));
    grid.appendChild(card);
  });
}

function setSelectionMode(on) {
  selectionMode = on;
  selectedRefIds.clear();
  selectBtn.textContent = on ? "Cancel" : "Select";
  selectionToolbar.hidden = !on;
  selectionStatus.textContent = "";
  if (on) populateSelectionFolderSelect();
  updateSelectionToolbar();
}

function toggleSelection(refId) {
  if (selectedRefIds.has(refId)) {
    selectedRefIds.delete(refId);
  } else {
    selectedRefIds.add(refId);
  }
  renderProjectGrid();
  updateSelectionToolbar();
}

function updateSelectionToolbar() {
  const n = selectedRefIds.size;
  document.getElementById("selection-count").textContent = `${n} selected`;
  document.getElementById("selection-delete-btn").disabled = n === 0;
  document.getElementById("selection-analyze-btn").disabled = n === 0;
  selectionFolderSelect.disabled = n === 0;
  syncColourSidebarToSelection();
}

// --- Move to folder (project detail selection toolbar) ---
//
// Additive, like the archive's "Add to project…": choosing a folder files
// every selected reference into it without touching the project or any
// folder a reference already sits in, so the selection is deliberately left
// active afterwards -- filing the same selection into a second folder is a
// normal thing to want to do next.

const selectionFolderSelect = document.getElementById("selection-folder-select");
const selectionStatus = document.getElementById("selection-status");

async function populateSelectionFolderSelect() {
  if (!currentProject) return;
  const rows = await folders.listFolders(currentProject.id);
  selectionFolderSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Move to folder…";
  selectionFolderSelect.appendChild(placeholder);
  rows.forEach((folder) => {
    const opt = document.createElement("option");
    opt.value = folder.id;
    opt.textContent = folder.name;
    selectionFolderSelect.appendChild(opt);
  });
}

selectionFolderSelect.addEventListener("change", async () => {
  const folderId = selectionFolderSelect.value;
  if (!folderId || selectedRefIds.size === 0) return;
  const label = selectionFolderSelect.options[selectionFolderSelect.selectedIndex].textContent;
  const ids = Array.from(selectedRefIds);
  selectionStatus.textContent = `Adding ${ids.length} reference${ids.length === 1 ? "" : "s"} to "${label}"...`;
  try {
    await folders.addReferencesToFolder(folderId, ids);
    selectionStatus.textContent =
      `Added ${ids.length} reference${ids.length === 1 ? "" : "s"} to "${label}". ` +
      "A reference can sit in several folders at once -- this doesn't remove it from any other.";
  } catch (err) {
    selectionStatus.textContent = `Error: ${err.message}`;
  }
  selectionFolderSelect.value = "";
});

document.getElementById("project-back-btn").addEventListener("click", showProjectsList);

document.getElementById("new-project-btn").addEventListener("click", () => {
  openNewProjectModal((project) => openProjectDetail(project.id));
});

document.getElementById("project-edit-btn").addEventListener("click", () => {
  if (currentProject) openEditProjectModal(currentProject);
});

selectBtn.addEventListener("click", () => {
  setSelectionMode(!selectionMode);
  renderProjectGrid();
});

document.getElementById("selection-delete-btn").addEventListener("click", async () => {
  if (!currentProject || selectedRefIds.size === 0) return;
  const ids = Array.from(selectedRefIds);
  await Promise.all(
    ids.map((id) =>
      fetch(`/api/projects/${currentProject.id}/references/${id}`, { method: "DELETE" })
    )
  );
  openProjectDetail(currentProject.id);
});

document.getElementById("selection-analyze-btn").addEventListener("click", () => {
  if (selectedRefIds.size === 0) return;
  document.getElementById("analyze-mode-overlay").hidden = false;
});

// --- Project create/edit modal (shared by the Projects page, the carousel's
// "add to project" control, and the project detail page's Edit button) ---

const newProjectOverlay = document.getElementById("new-project-overlay");
const newProjectHeading = document.getElementById("project-modal-heading");
const newProjectTitle = document.getElementById("new-project-title");
const newProjectDescription = document.getElementById("new-project-description");
const newProjectStatus = document.getElementById("new-project-status");
const newProjectSubmitBtn = document.getElementById("new-project-create");
let onProjectCreated = null;
let projectModalMode = "create"; // "create" | "edit"
let editingProjectId = null;

function openNewProjectModal(onCreated) {
  projectModalMode = "create";
  editingProjectId = null;
  onProjectCreated = onCreated;
  newProjectHeading.textContent = "New project";
  newProjectSubmitBtn.textContent = "Create";
  newProjectTitle.value = "";
  newProjectDescription.value = "";
  newProjectStatus.textContent = "";
  newProjectOverlay.hidden = false;
  newProjectTitle.focus();
}

function openEditProjectModal(project) {
  projectModalMode = "edit";
  editingProjectId = project.id;
  onProjectCreated = null;
  newProjectHeading.textContent = "Edit project";
  newProjectSubmitBtn.textContent = "Save";
  newProjectTitle.value = project.title;
  newProjectDescription.value = project.description || "";
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
  const editing = projectModalMode === "edit";
  newProjectStatus.textContent = editing ? "Saving..." : "Creating...";
  try {
    const url = editing ? `/api/projects/${editingProjectId}` : "/api/projects";
    const res = await fetch(url, {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description: newProjectDescription.value.trim() }),
    });
    const project = await res.json();
    if (!res.ok) {
      newProjectStatus.textContent = `Error: ${project.error}`;
      return;
    }
    newProjectOverlay.hidden = true;
    if (editing) {
      openProjectDetail(project.id);
    } else {
      const callback = onProjectCreated;
      onProjectCreated = null;
      if (callback) callback(project);
    }
  } catch (err) {
    newProjectStatus.textContent = `Error: ${err}`;
  }
});

// --- Analysis modal ---

const analyzeModeOverlay = document.getElementById("analyze-mode-overlay");
const analyzeOverlay = document.getElementById("analyze-overlay");
const analyzeTranscript = document.getElementById("analyze-transcript");
const analyzeInput = document.getElementById("analyze-followup-input");
const analyzeSaveBtn = document.getElementById("analyze-save-btn");
let analyzeSessionId = null;
let analyzeReferenceIds = [];
let analyzeTurns = []; // {kind, text}, mirrors the transcript for saving -- "status" turns excluded
let analyzeRefMap = {}; // title -> reference id, for linkifying mentions in Claude's replies

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Wraps every mention of a known reference title in `text` with a hyperlink
// back to that reference. Longest titles are matched first so a short title
// that happens to be a substring of a longer one doesn't steal the match.
// `refMap` defaults to the live analysis session's map, but callers viewing
// a saved analysis (built from its own stored references) pass their own.
function linkifyReferences(text, refMap = analyzeRefMap) {
  const titles = Object.keys(refMap)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!titles.length) return escapeHtml(text);

  const pattern = new RegExp(titles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");

  let html = "";
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    html += escapeHtml(text.slice(lastIndex, match.index));
    html += `<a href="#" class="ref-link" data-ref-id="${refMap[match[0]]}">${escapeHtml(match[0])}</a>`;
    lastIndex = match.index + match[0].length;
  }
  html += escapeHtml(text.slice(lastIndex));
  return html;
}

function appendAnalyzeTurn(text, kind) {
  const div = document.createElement("div");
  div.className = `analyze-turn analyze-${kind}`;
  if (kind === "writeup" || kind === "reply") {
    div.innerHTML = linkifyReferences(text);
  } else {
    div.textContent = text;
  }
  analyzeTranscript.appendChild(div);
  div.scrollIntoView({ block: "end" });
  if (kind !== "status") analyzeTurns.push({ kind, text });
  return div;
}

document.getElementById("analyze-mode-summary").addEventListener("click", () => {
  analyzeModeOverlay.hidden = true;
  openAnalyzeModal(Array.from(selectedRefIds), "summary");
});

document.getElementById("analyze-mode-full").addEventListener("click", () => {
  analyzeModeOverlay.hidden = true;
  openAnalyzeModal(Array.from(selectedRefIds), "full");
});

analyzeModeOverlay.addEventListener("click", (e) => {
  if (e.target === analyzeModeOverlay) analyzeModeOverlay.hidden = true;
});

async function openAnalyzeModal(referenceIds, mode) {
  analyzeSessionId = null;
  analyzeReferenceIds = referenceIds;
  analyzeTurns = [];
  analyzeRefMap = {};
  analyzeTranscript.innerHTML = "";
  analyzeInput.value = "";
  analyzeSaveBtn.disabled = true;
  analyzeSaveBtn.textContent = "Save conversation";
  analyzeOverlay.hidden = false;
  appendAnalyzeTurn(`Analyzing ${referenceIds.length} reference${referenceIds.length === 1 ? "" : "s"}...`, "status");

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference_ids: referenceIds, mode }),
    });
    const data = await res.json();
    analyzeTranscript.innerHTML = "";
    if (!res.ok) {
      appendAnalyzeTurn(`Error: ${data.error}`, "status");
      return;
    }
    analyzeSessionId = data.analysis_id;
    analyzeRefMap = data.references || {};
    appendAnalyzeTurn(data.writeup, "writeup");
    analyzeSaveBtn.disabled = false;
  } catch (err) {
    analyzeTranscript.innerHTML = "";
    appendAnalyzeTurn(`Error: ${err}`, "status");
  }
}

analyzeSaveBtn.addEventListener("click", async () => {
  if (!analyzeSessionId || !currentProject) return;
  analyzeSaveBtn.disabled = true;
  analyzeSaveBtn.textContent = "Saving...";
  try {
    const res = await fetch(`/api/analyses/${analyzeSessionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: currentProject.id,
        reference_ids: analyzeReferenceIds,
        transcript: analyzeTurns,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      analyzeSaveBtn.textContent = `Error: ${data.error}`;
      analyzeSaveBtn.disabled = false;
      return;
    }
    // Saved -- the transcript now lives in the Previous Analysis sidebar,
    // so there's nothing left to do here but close.
    analyzeOverlay.hidden = true;
  } catch (err) {
    analyzeSaveBtn.textContent = "Error saving";
    analyzeSaveBtn.disabled = false;
  }
});

async function sendAnalyzeFollowup() {
  const message = analyzeInput.value.trim();
  if (!message || !analyzeSessionId) return;
  analyzeInput.value = "";
  appendAnalyzeTurn(message, "question");
  const thinking = appendAnalyzeTurn("Thinking...", "status");

  try {
    const res = await fetch(`/api/analyze/${analyzeSessionId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    thinking.remove();
    if (!res.ok) {
      appendAnalyzeTurn(`Error: ${data.error}`, "status");
      return;
    }
    appendAnalyzeTurn(data.reply, "reply");
  } catch (err) {
    thinking.remove();
    appendAnalyzeTurn(`Error: ${err}`, "status");
  }
}

document.getElementById("analyze-followup-send").addEventListener("click", sendAnalyzeFollowup);
analyzeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendAnalyzeFollowup();
});

document.getElementById("analyze-close-btn").addEventListener("click", () => {
  analyzeOverlay.hidden = true;
});

analyzeOverlay.addEventListener("click", (e) => {
  if (e.target === analyzeOverlay) analyzeOverlay.hidden = true;
});

// Clicking a linked reference jumps to it in the carousel (only possible
// when it's part of the list currently loaded -- e.g. a related item pulled
// in purely for context won't be, and the click is just a no-op there).
// Delegated on the document so it covers both the live analysis modal's
// transcript and the "Previous Analysis" sidebar's saved-transcript view.
document.addEventListener("click", (e) => {
  const link = e.target.closest(".ref-link");
  if (!link) return;
  e.preventDefault();
  const idx = currentList.findIndex((r) => r.id === link.dataset.refId);
  if (idx === -1) return;
  analyzeOverlay.hidden = true;
  carousel.open(currentList, idx);
});

// --- Reference hover preview (used by any rendered analysis transcript) ---

const refPreviewPopup = document.getElementById("ref-preview-popup");
const refPreviewMedia = document.getElementById("ref-preview-media");
const refPreviewTitle = document.getElementById("ref-preview-title");

document.addEventListener("mouseover", (e) => {
  const link = e.target.closest(".ref-link");
  if (!link) return;
  refPreviewMedia.innerHTML = "";
  const img = document.createElement("img");
  img.src = `/media/${link.dataset.refId}/thumb`;
  img.onerror = () => img.remove();
  refPreviewMedia.appendChild(img);
  refPreviewTitle.textContent = link.textContent;
  refPreviewPopup.hidden = false;
});

document.addEventListener("mouseout", (e) => {
  if (e.target.closest(".ref-link")) refPreviewPopup.hidden = true;
});

document.addEventListener("mousemove", (e) => {
  if (refPreviewPopup.hidden) return;
  const offset = 16;
  let x = e.clientX + offset;
  let y = e.clientY + offset;
  if (x + 170 > window.innerWidth) x = e.clientX - 170 - offset;
  if (y + 190 > window.innerHeight) y = e.clientY - 190 - offset;
  refPreviewPopup.style.left = `${x}px`;
  refPreviewPopup.style.top = `${y}px`;
});

// --- Previous Analysis sidebar ---

const analysisSidebar = document.getElementById("analysis-sidebar");
const analysisSidebarListView = document.getElementById("analysis-sidebar-list-view");
const analysisSidebarList = document.getElementById("analysis-sidebar-list");
const analysisSidebarEmpty = document.getElementById("analysis-sidebar-empty");
const analysisSidebarDetail = document.getElementById("analysis-sidebar-detail");

document.getElementById("analysis-sidebar-btn").addEventListener("click", () => {
  analysisSidebar.hidden = false;
  showAnalysisList();
});

document.getElementById("analysis-sidebar-close").addEventListener("click", () => {
  analysisSidebar.hidden = true;
});

async function showAnalysisList() {
  analysisSidebarDetail.hidden = true;
  analysisSidebarListView.hidden = false;
  if (!currentProject) return;

  const res = await fetch(`/api/projects/${currentProject.id}/analyses`);
  const analyses = await res.json();
  analysisSidebarList.innerHTML = "";
  analysisSidebarEmpty.hidden = analyses.length > 0;
  analyses.forEach((a) => analysisSidebarList.appendChild(makeAnalysisListItem(a)));
}

function makeAnalysisListItem(a) {
  const item = document.createElement("div");
  item.className = "analysis-list-item";
  item.addEventListener("click", () => openAnalysisDetail(a.id));

  const date = document.createElement("div");
  date.className = "analysis-list-date";
  date.textContent = new Date(a.date_created).toLocaleString();
  item.appendChild(date);

  const count = document.createElement("div");
  count.className = "muted";
  count.textContent = `${a.reference_count} reference${a.reference_count === 1 ? "" : "s"}`;
  item.appendChild(count);

  const refsRow = document.createElement("div");
  refsRow.className = "analysis-list-refs";
  a.preview.forEach((ref) => refsRow.appendChild(makeAnalysisThumb(ref)));
  item.appendChild(refsRow);

  return item;
}

function makeAnalysisThumb(ref) {
  const thumb = document.createElement("div");
  thumb.className = "analysis-thumb";
  const img = document.createElement("img");
  img.src = `/media/${ref.id}/thumb`;
  img.alt = ref.title;
  img.onerror = () => img.remove();
  thumb.appendChild(img);
  return thumb;
}

async function openAnalysisDetail(analysisId) {
  const res = await fetch(`/api/analyses/${analysisId}`);
  if (!res.ok) return;
  const data = await res.json();

  analysisSidebarListView.hidden = true;
  analysisSidebarDetail.hidden = false;

  document.getElementById("analysis-detail-date").textContent = new Date(data.date_created).toLocaleString();

  const refsEl = document.getElementById("analysis-detail-refs");
  refsEl.innerHTML = "";
  data.references.forEach((ref) => {
    refsEl.appendChild(
      makeCard(ref, () => {
        const idx = currentList.findIndex((r) => r.id === ref.id);
        if (idx !== -1) carousel.open(currentList, idx);
      })
    );
  });

  const refMap = {};
  data.references.forEach((r) => {
    refMap[r.title] = r.id;
  });

  const transcriptEl = document.getElementById("analysis-detail-transcript");
  transcriptEl.innerHTML = "";
  data.transcript.forEach((turn) => {
    const div = document.createElement("div");
    div.className = `analyze-turn analyze-${turn.kind}`;
    div.innerHTML = linkifyReferences(turn.text, refMap);
    transcriptEl.appendChild(div);
  });
}

document.getElementById("analysis-detail-back").addEventListener("click", showAnalysisList);

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

// --- Colour Similarity sidebar ---
//
// Searches the archive for references whose colour character resembles the
// ones currently selected in this project. It reuses the existing selection
// mode rather than introducing its own, and adds results through the
// existing project-reference endpoint -- nothing here is a second way of
// doing something the app already does.
//
// Ranking is colour only. The CLIP embeddings behind "similar items" rank by
// shape and semantics, so blending them in would break the promise that the
// four sliders explain the ordering.

const colourSidebar = document.getElementById("colour-sidebar");
const colourEmpty = document.getElementById("colour-empty");
const colourBody = document.getElementById("colour-body");
const colourSelected = document.getElementById("colour-selected");
const colourCombinedPalette = document.getElementById("colour-combined-palette");
const colourResults = document.getElementById("colour-results");
const colourStatus = document.getElementById("colour-status");
const colourSliders = [...document.querySelectorAll("[data-weight]")];
const colourExcludeBW = document.getElementById("colour-exclude-bw");

// Slider changes only re-rank precomputed profiles, but that's still a round
// trip -- debounced so dragging one doesn't fire a request per pixel.
const COLOUR_DEBOUNCE_MS = 250;
let colourSearchTimer = null;
let colourRequestId = 0;

document.getElementById("selection-colour-btn").addEventListener("click", () => {
  if (selectedRefIds.size === 0) return;
  colourSidebar.hidden = false;
  runColourSearch();
});

document.getElementById("colour-sidebar-close").addEventListener("click", () => {
  colourSidebar.hidden = true;
});

for (const slider of colourSliders) {
  slider.addEventListener("input", () => {
    clearTimeout(colourSearchTimer);
    colourSearchTimer = setTimeout(runColourSearch, COLOUR_DEBOUNCE_MS);
  });
}

colourExcludeBW.addEventListener("change", () => {
  clearTimeout(colourSearchTimer);
  runColourSearch(); // a checkbox click isn't a drag -- no need to debounce
});

function colourWeights() {
  const weights = {};
  for (const slider of colourSliders) weights[slider.dataset.weight] = Number(slider.value) / 50;
  return weights;
}

async function runColourSearch() {
  if (!currentProject) return;

  const ids = [...selectedRefIds];
  if (ids.length === 0) {
    colourEmpty.hidden = false;
    colourBody.hidden = true;
    return;
  }
  colourEmpty.hidden = true;
  colourBody.hidden = false;

  renderColourSelected(ids);
  colourStatus.textContent = "Searching…";

  // Only the newest request may paint: dragging a slider can leave an
  // earlier, slower response arriving after a later one.
  const requestId = ++colourRequestId;

  let data;
  try {
    const res = await fetch("/api/colour/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reference_ids: ids,
        project_id: currentProject.id,
        weights: colourWeights(),
        exclude_black_white: colourExcludeBW.checked,
      }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `search failed (${res.status})`);
  } catch (err) {
    if (requestId !== colourRequestId) return;
    colourStatus.textContent = `Colour search unavailable — ${err.message}`;
    return;
  }
  if (requestId !== colourRequestId) return;

  renderColourCombinedPalette(data.profile);
  renderColourResults(data);
}

function renderColourSelected(ids) {
  colourSelected.innerHTML = "";
  for (const id of ids) {
    const ref = currentList.find((r) => r.id === id);
    if (ref) colourSelected.appendChild(makeBarThumb(ref));
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

function renderColourCombinedPalette(profile) {
  // Refilled in place rather than replaced: the element is captured in a
  // const above, so swapping the node out would leave that reference
  // pointing at a detached element from the second render onward.
  colourCombinedPalette.innerHTML = "";
  for (const block of makePaletteStrip(profile?.palette).children) {
    colourCombinedPalette.appendChild(block.cloneNode(true));
  }
}

function renderColourResults(data) {
  const results = data.results || [];
  colourResults.innerHTML = "";

  if (!results.length) {
    const coverage = data.coverage || {};
    if (coverage.pending > 0) {
      // Genuinely still working through the archive.
      colourStatus.textContent =
        `Colour analysis is being prepared — ${coverage.pending} image(s) left.`;
    } else if (data.reason === "no_colour_data") {
      // Nothing pending, but nothing in the selection has a palette either --
      // a text or PDF reference. Saying "being prepared" here would imply a
      // wait that is never going to end.
      colourStatus.textContent = "Selected references have no image to analyse.";
    } else {
      colourStatus.textContent = "No close colour matches found.";
    }
    return;
  }

  const selectedCount = (data.used_ids || []).length;
  colourStatus.textContent =
    selectedCount > 1
      ? `${results.length} matches for the combined colour of ${selectedCount} references.`
      : `${results.length} matches.`;

  for (const result of results) colourResults.appendChild(makeColourResult(result));
}

function makeColourResult(result) {
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
  addBtn.className = "btn colour-add-btn";
  addBtn.textContent = "+ Add";
  addBtn.addEventListener("click", () => addColourResultToProject(result.id, addBtn));
  row.appendChild(addBtn);

  return row;
}

async function addColourResultToProject(referenceId, button) {
  if (!currentProject) return;
  button.disabled = true;
  button.textContent = "Adding…";

  try {
    // The same endpoint the archive grid and carousel use -- adding here
    // creates no second kind of project membership, and the backend's
    // INSERT OR IGNORE means a repeat can't duplicate the relationship.
    const res = await fetch(`/api/projects/${currentProject.id}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference_id: referenceId }),
    });
    if (!res.ok) throw new Error("could not add");

    button.textContent = "Added";
    button.classList.add("is-added");

    // Refresh the project behind the sidebar so the grid shows it straight
    // away, without disturbing the current selection or search results.
    const refreshed = await fetch(`/api/projects/${currentProject.id}`);
    if (refreshed.ok) {
      currentProject = await refreshed.json();
      currentList = currentProject.references;
      renderProjectGrid();
    }
  } catch {
    button.disabled = false;
    button.textContent = "+ Add";
  }
}

/** Keep an open sidebar in step with the selection. Called from
 *  updateSelectionToolbar, so changing the selection re-searches rather than
 *  leaving stale results next to a selection that no longer produced them. */
function syncColourSidebarToSelection() {
  // Elements looked up here rather than closed over: this is called from
  // updateSelectionToolbar, which is defined far earlier in the file, so
  // reaching for the consts declared just above would be a temporal-dead-zone
  // error the moment anything calls it during initial load.
  const sidebar = document.getElementById("colour-sidebar");
  const n = selectedRefIds.size;
  document.getElementById("selection-colour-btn").disabled = n === 0;
  if (!sidebar || sidebar.hidden) return;

  if (n === 0) {
    document.getElementById("colour-empty").hidden = false;
    document.getElementById("colour-body").hidden = true;
    document.getElementById("colour-results").innerHTML = "";
  } else {
    clearTimeout(colourSearchTimer);
    colourSearchTimer = setTimeout(runColourSearch, COLOUR_DEBOUNCE_MS);
  }
}

// A hash deep link picks its own tab and loads whatever that tab needs;
// failing that, prime the archive grid so switching to it is instant. Run
// last, once every element the tabs touch has been wired up.
activateTabFromHash().then((handled) => {
  if (!handled) refreshArchive();
});
