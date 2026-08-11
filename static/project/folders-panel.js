/* The folder management modal: list a project's folders, create, rename
 * inline, reorder by drag, delete with a confirmation.
 *
 * Opened from the settings widget (widgets/settings.js) alongside the gear
 * that jumps into edit mode -- folders are project data, not layout, so this
 * stays a modal rather than living in the top bar the way appearance and
 * format controls do.
 *
 * A singleton overlay appended to <body> once and reused on every open,
 * same reasoning as the sidebar panels in widgets/sidebar.js: it isn't any
 * one widget's DOM to own.
 */

import * as folders from "./folders.js";

let overlay = null;
let listEl = null;
let nameInput = null;
let createBtn = null;
let statusEl = null;
let currentProjectId = null;
let draggingId = null;

function ensureModal() {
  if (overlay) return;

  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.hidden = true;

  const box = document.createElement("div");
  box.className = "modal-box folders-modal-box";

  const heading = document.createElement("h3");
  heading.textContent = "Folders";
  box.appendChild(heading);

  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent =
    "Folders group references within this project. Deleting a folder never deletes a reference -- it only removes the grouping.";
  box.appendChild(hint);

  listEl = document.createElement("div");
  listEl.className = "folders-list";
  box.appendChild(listEl);

  statusEl = document.createElement("p");
  statusEl.className = "muted";
  box.appendChild(statusEl);

  const createRow = document.createElement("div");
  createRow.className = "folders-create-row";
  nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "New folder name";
  createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.className = "btn";
  createBtn.textContent = "Create";
  createRow.appendChild(nameInput);
  createRow.appendChild(createBtn);
  box.appendChild(createRow);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", closeFoldersModal);
  actions.appendChild(closeBtn);
  box.appendChild(actions);

  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeFoldersModal();
  });

  document.body.appendChild(overlay);

  createBtn.addEventListener("click", submitCreate);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitCreate();
  });
}

async function submitCreate() {
  const name = nameInput.value.trim();
  if (!name || !currentProjectId) return;
  createBtn.disabled = true;
  try {
    await folders.createFolder(currentProjectId, name);
    nameInput.value = "";
    await refresh();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    createBtn.disabled = false;
  }
}

async function refresh() {
  statusEl.textContent = "";
  const rows = await folders.listFolders(currentProjectId);
  renderList(rows);
}

function renderList(rows) {
  listEl.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No folders yet.";
    listEl.appendChild(empty);
    return;
  }
  rows.forEach((folder) => listEl.appendChild(makeFolderRow(folder)));
}

function makeFolderRow(folder) {
  const row = document.createElement("div");
  row.className = "folders-row";
  row.draggable = true;
  row.dataset.id = folder.id;

  const handle = document.createElement("span");
  handle.className = "folders-row-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder";
  row.appendChild(handle);

  const nameSpan = document.createElement("span");
  nameSpan.className = "folders-row-name";
  nameSpan.textContent = folder.name;
  nameSpan.title = "Click to rename";
  nameSpan.addEventListener("click", () => startRename(row, folder));
  row.appendChild(nameSpan);

  const count = document.createElement("span");
  count.className = "muted folders-row-count";
  count.textContent = `${folder.reference_count} reference${folder.reference_count === 1 ? "" : "s"}`;
  row.appendChild(count);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn danger folders-row-delete";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => confirmDelete(row, folder));
  row.appendChild(deleteBtn);

  row.addEventListener("dragstart", (e) => {
    draggingId = folder.id;
    row.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => {
    draggingId = null;
    row.classList.remove("is-dragging");
  });
  row.addEventListener("dragover", (e) => {
    if (!draggingId || draggingId === folder.id) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const dragged = listEl.querySelector(`[data-id="${draggingId}"]`);
    if (!dragged) return;
    row.parentNode.insertBefore(dragged, before ? row : row.nextSibling);
  });
  row.addEventListener("drop", async (e) => {
    e.preventDefault();
    const id = draggingId;
    draggingId = null;
    if (!id) return;
    const position = Array.from(listEl.children).findIndex((el) => el.dataset.id === id);
    if (position < 0) return;
    try {
      await folders.reorderFolder(id, position);
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      await refresh();
    }
  });

  return row;
}

function startRename(row, folder) {
  if (row.querySelector("input")) return; // already editing
  const nameSpan = row.querySelector(".folders-row-name");
  const input = document.createElement("input");
  input.type = "text";
  input.value = folder.name;
  input.className = "folders-row-rename-input";
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  async function commit() {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (name && name !== folder.name) {
      try {
        await folders.renameFolder(folder.id, name);
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
      }
    }
    await refresh();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      done = true;
      refresh();
    }
  });
  input.addEventListener("blur", commit);
}

function confirmDelete(row, folder) {
  row.innerHTML = "";
  row.classList.add("folders-row-confirm");

  const text = document.createElement("span");
  text.className = "folders-row-confirm-text";
  text.textContent = `Delete "${folder.name}"? Its references stay in the project -- only the grouping goes.`;
  row.appendChild(text);

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "btn danger";
  confirmBtn.textContent = "Delete";
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    try {
      await folders.deleteFolder(folder.id);
      await refresh();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      await refresh();
    }
  });
  row.appendChild(confirmBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", refresh);
  row.appendChild(cancelBtn);
}

export async function openFoldersModal(projectId) {
  ensureModal();
  currentProjectId = projectId;
  nameInput.value = "";
  overlay.hidden = false;
  statusEl.textContent = "Loading…";
  try {
    await refresh();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

export function closeFoldersModal() {
  if (overlay) overlay.hidden = true;
}
