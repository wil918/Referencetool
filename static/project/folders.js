/* Thin wrapper over the folders API (app.py's "Project space: folders"
 * routes). No DOM here -- every folder feature (the management modal, the
 * move-to-folder selects on the two selection toolbars) imports this rather
 * than calling fetch directly, so the request shapes live in one place.
 */

async function asJson(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

/** A project's folders, in display order, each with its reference_count. */
export function listFolders(projectId) {
  return fetch(`/api/projects/${projectId}/folders`).then(asJson);
}

export function getFolder(folderId) {
  return fetch(`/api/folders/${folderId}`).then(asJson);
}

export function createFolder(projectId, name) {
  return fetch(`/api/projects/${projectId}/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(asJson);
}

export function renameFolder(folderId, name) {
  return fetch(`/api/folders/${folderId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(asJson);
}

/** Move a folder to `position` among its siblings (0-based). */
export function reorderFolder(folderId, position) {
  return fetch(`/api/folders/${folderId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ position }),
  }).then(asJson);
}

/** Delete a folder. What was filed in it stays in the project untouched. */
export function deleteFolder(folderId) {
  return fetch(`/api/folders/${folderId}`, { method: "DELETE" }).then(asJson);
}

export function listFolderReferences(folderId) {
  return fetch(`/api/folders/${folderId}/references`).then(asJson);
}

/** File one or many references into a folder. Anything not already in the
 * folder's project is added to the project too (see app.py's route doc). */
export function addReferencesToFolder(folderId, referenceIds) {
  return fetch(`/api/folders/${folderId}/references`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reference_ids: referenceIds }),
  }).then(asJson);
}

/** Unfile one reference. It keeps its place in the project, the archive, and
 * any other folder it was filed in. */
export function removeReferenceFromFolder(folderId, referenceId) {
  return fetch(`/api/folders/${folderId}/references/${referenceId}`, {
    method: "DELETE",
  }).then(asJson);
}

/** Folder names rolled up across every project, each with a total reference
 * count and which projects contribute -- backs the Archive's folder strip. */
export function listFolderRollup() {
  return fetch("/api/folders/rollup").then(asJson);
}

/** Every reference filed under this folder name in any project, de-duplicated. */
export function listFolderRollupReferences(name) {
  return fetch(`/api/folders/rollup/${encodeURIComponent(name)}/references`).then(asJson);
}
