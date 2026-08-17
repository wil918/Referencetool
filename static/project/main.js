// Entry point for the standalone project page (/project.html?id=<uuid>),
// same shape as graph.js is for graph.html.
//
// The page *is* the widget grid. This module owns the two things the grid
// deliberately doesn't: what each widget contains (through the registry) and
// when the layout is written back (only on an explicit Save).

import { createGrid } from "./grid.js";
import { all as allWidgetDefinitions, definitionFor, mountWidget } from "./registry.js";
import { createWidgetDock } from "./widget-dock.js";
import { createAppearancePanel } from "./appearance-panel.js";
import { onActiveWidgetChange } from "./format-toolbar.js";
import { createGridPage } from "./pages/grid-page.js";
import { createCanvasPage } from "./pages/canvas-page.js";
import * as folders from "./folders.js";

const statusEl = document.getElementById("project-shell-status");
const bodyEl = document.getElementById("project-shell-body");
const gridEl = document.getElementById("widget-grid");
const pageContainerEl = document.getElementById("project-page-container");

let projectId = null;
let project = null;
let grid = null;
// This project's folders, fetched once at boot -- the dock's one-card-per-
// -folder expansion (shell.addableTypes below) reads it synchronously, so it
// has to already be in hand by the time the dock is built, not fetched on
// demand per open.
let folderRows = [];

// Every widget row as the server last returned it. The grid only carries
// layout, so this is where type, parent_id, position and config live.
const rows = new Map();
// id -> the handle mountWidget gave back, so it can be told about resizes and
// torn down properly.
const mounted = new Map();

function showMissing(message) {
  statusEl.textContent = "";
  bodyEl.innerHTML = "";

  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = message;
  bodyEl.appendChild(p);

  const link = document.createElement("a");
  link.className = "nav-link";
  link.href = "/index.html#projects";
  link.textContent = "← Back to projects";
  bodyEl.appendChild(link);
}

// --- persistence -------------------------------------------------------------

// { ok: true, saved } on success, { ok: false, error } on rejection -- the
// nesting rules can reject a bulk save (app.py's _layout_nesting_error), and
// that message is worth showing rather than swallowing into a generic
// failure, both for the ordinary Save/Cancel flow and for a sidebar's
// reparenting calls below.
async function putWidgets(entries) {
  const res = await fetch(`/api/projects/${projectId}/widgets`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ widgets: entries }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: body?.error || "Couldn't save." };
  body.forEach((row) => rows.set(row.id, row));
  return { ok: true, saved: body };
}

function layoutEntry(row, position = row.position) {
  return {
    id: row.id,
    parent_id: row.parent_id,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    locked: row.locked,
    position,
  };
}

/* One widget's config, written as it is edited.
 *
 * The bulk route is also the only way to write a single widget's config, so
 * this sends that widget's *saved* box beside it -- never the boxes the user
 * is currently dragging around, which they haven't committed yet.
 */
async function persistConfig(id, config) {
  const row = rows.get(id);
  if (row) await putWidgets([{ ...layoutEntry(row), config }]);
}

// --- grid --------------------------------------------------------------------

function toItem(row) {
  const definition = definitionFor(row.type);
  return {
    id: row.id,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    locked: row.locked,
    removable: !definition.permanent,
    shadow: Boolean(row.config?.shadow),
    minW: definition.minSize.w,
    minH: definition.minSize.h,
  };
}

// Only widgets that sit on the grid itself. A widget with a parent_id lives
// inside that container and is laid out by it, not here.
const gridRows = () => [...rows.values()].filter((row) => !row.parent_id);

// Every widget parented to one container, in display order. Used both to
// render a container's contents and to work out the next position when
// something is added or reparented into it.
const childRows = (parentId) =>
  [...rows.values()]
    .filter((row) => row.parent_id === parentId)
    .sort((a, b) => a.position - b.position);

/* Fires whenever a widget is created, deleted, or reparented/reordered --
 * never on an ordinary config edit (persistConfig below deliberately doesn't
 * call this). A container widget's rendered list is the one thing that needs
 * to react to *other* widgets' existence changing; re-running that on every
 * keystroke elsewhere in the project would tear down and reinsert its
 * children's DOM -- including whatever the user is mid-edit inside -- for no
 * reason. Structural changes are comparatively rare user actions, so a full
 * re-render in response to them is cheap and expected.
 */
const structureSubscribers = new Set();
function notifyStructureChange() {
  for (const fn of structureSubscribers) fn();
}

/* The host.children controller handed to a container widget (registry.js).
 * Bound to one container id -- the container reaches its own contents
 * through this rather than main.js's rows map directly, the same arm's-length
 * relationship host.shell gives the settings widget to the grid.
 */
function containerHost(containerId) {
  return {
    list: () => childRows(containerId),
    subscribe(fn) {
      structureSubscribers.add(fn);
      return () => structureSubscribers.delete(fn);
    },
    add: (type) => addWidget(type, null, containerId),
    remove: (id) => removeWidget(id),
    persistConfig: (id, config) => persistConfig(id, config),

    // Reordering is the container's own business -- position among its
    // siblings, nothing to do with grid cells -- so it writes position
    // directly rather than going through the grid's getLayout/setLayout.
    async reorder(orderedIds) {
      const entries = orderedIds.map((id, index) => ({
        ...layoutEntry(rows.get(id), index),
      }));
      const result = await putWidgets(entries);
      if (result.ok) notifyStructureChange();
      return result;
    },

    // Reparents an existing widget (dragged out of the grid, or out of a
    // different container) into this one, appended after its current
    // children. The API re-checks every nesting rule against the layout's
    // final state, so a stale or otherwise-invalid source id surfaces as its
    // rejection message rather than a silent no-op.
    async moveIn(widgetId) {
      const source = rows.get(widgetId);
      if (!source) return { ok: false, error: "That widget no longer exists." };
      if (source.id === containerId) return { ok: false, error: "A sidebar can't hold itself." };
      if (source.parent_id === containerId) return { ok: true };
      const definition = definitionFor(source.type);
      if (definition.permanent) {
        return { ok: false, error: `The ${definition.label} widget can't be moved.` };
      }
      const entry = {
        ...layoutEntry(source, childRows(containerId).length),
        parent_id: containerId,
      };
      const result = await putWidgets([entry]);
      if (result.ok) {
        // Only this one widget leaves the grid -- removeItem, never setItems,
        // so nobody else's unsaved drag position gets pulled back to what the
        // server last knew about it.
        grid.removeItem(widgetId);
        notifyStructureChange();
      }
      return result;
    },
  };
}

/* Where grid.js's move-to-sidebar button (onMoveToSidebar below) actually
 * sends a widget. grid.js only reports the click; it has no notion of what a
 * sidebar is, so that decision lives here.
 *
 * Picks the first sidebar in reading order and moves straight in, with no
 * picker -- today's projects have at most one or two sidebars, and a click
 * that goes to the "wrong" one still leaves the widget one drag away inside
 * containerHost.reorder/moveIn's normal editing flow. A project with no
 * sidebar at all is a silent no-op, same as the old native drag was when
 * dropped with no panel open to catch it.
 */
function moveToSidebar(item) {
  const target = gridRows().find((row) => row.type === "sidebar" && row.id !== item.id);
  if (!target) return;
  containerHost(target.id).moveIn(item.id);
}

function buildGrid() {
  grid = createGrid(gridEl, {
    mount(item, el) {
      const row = rows.get(item.id);
      const definition = definitionFor(row.type);
      mounted.set(
        item.id,
        mountWidget(definition, el, {
          project,
          config: row.config,
          persist: (config) => persistConfig(item.id, config),
          // Only the settings widget gets a handle on the page-level edit
          // state -- see registry.js's host.shell and the block below.
          shell: row.type === "settings" ? shell : null,
          // Every widget gets this, unlike shell -- Text/Title/Notepad all
          // need to know whether the grid is being edited (see the block
          // below, and registry.js's host.editMode).
          editMode,
          // Only a container widget gets a handle on its own contents --
          // see registry.js's host.children.
          children: definition.container ? containerHost(item.id) : null,
        })
      );
    },

    unmount(item) {
      mounted.get(item.id)?.destroy();
      mounted.delete(item.id);
    },

    resized(item, el) {
      mounted.get(item.id)?.notifyResize(el.clientWidth, el.clientHeight);
    },

    onLayoutChange() {
      dirty = true;
      notifyShell();
    },

    onRemove(item) {
      removeWidget(item.id);
    },

    onMoveToSidebar(item) {
      moveToSidebar(item);
    },

    onToggleShadow(item, shadow) {
      const row = rows.get(item.id);
      if (row) persistConfig(item.id, { ...row.config, shadow });
    },
  });

  grid.setItems(gridRows().map(toItem));
}

/* Edit mode, and the shell handed to the settings widget.
 *
 * The homepage doesn't move until the user says so, and a rearrangement is
 * only kept if they save it -- so these are what actually commit anything,
 * not the pointer. The controls for all of this live in the settings widget's
 * panel (static/project/widgets/settings.js), which is a normal widget module
 * confined to its own element -- it reaches the grid only through this narrow
 * surface, passed in as host.shell, rather than main.js's internals directly.
 */
let dirty = false;
const shellSubscribers = new Set();

function shellState() {
  return { editing: grid.isEditing(), dirty };
}

function notifyShell() {
  const state = shellState();
  for (const fn of shellSubscribers) fn(state);
}

function setEditing(on) {
  grid.setEditing(on);
  dirty = false;
  notifyShell();
}

function cancelEditing() {
  grid.setLayout(gridRows().map(toItem));
  setEditing(false);
}

/* The whole layout, in one commit, and only when asked.
 *
 * config is left out of the payload entirely: the API only touches a widget's
 * config when the entry carries one, so a layout save can't overwrite a config
 * edit made since the page loaded.
 */
async function saveLayout() {
  const entries = grid.getLayout().map((box, index) => {
    const row = rows.get(box.id);
    return { ...layoutEntry(row, index), x: box.x, y: box.y, w: box.w, h: box.h, locked: box.locked };
  });

  const result = await putWidgets(entries);
  if (!result.ok) {
    statusEl.textContent = result.error || "Couldn't save the layout.";
    return false;
  }
  statusEl.textContent = "";
  setEditing(false);
  return true;
}

/* Adding and removing widgets is immediate, not staged behind Save/Cancel --
 * there is no bulk create/delete route to hold them against (db.py's
 * save_widget_layout comment is explicit: widgets are created and deleted
 * through their own routes). Only position and size are part of the layout
 * snapshot Cancel can revert.
 *
 * `position` is the dock's drop cell (widget-dock.js); omitted, a widget is
 * appended below everything else, same as before the dock existed. Passing
 * `parentId` is how a container widget (registry.js's host.children.add)
 * creates a widget as its own child instead of a grid tile -- x/y are then
 * meaningless (the container lays its children out itself) and left at 0.
 *
 * Returns { ok: true, row } or { ok: false, error } -- the API's nesting
 * rejection (app.py's _nesting_error) is worth surfacing verbatim rather than
 * failing silently, which matters most for the parentId path.
 *
 * `config` seeds the widget's config at creation time -- every other addable
 * type starts from nothing, but a folder widget (widgets/folder.js) is
 * meaningless without a folder_id, and the dock's per-folder cards
 * (shell.addableTypes below) carry one to seed here.
 *
 * `size` overrides the definition's defaultSize -- used only by loadLayout,
 * which is recreating widgets at the exact w/h a saved layout captured them
 * at, not whatever a fresh widget of that type would normally start at.
 */
async function addWidget(type, position = null, parentId = null, config = null, size = null) {
  const definition = definitionFor(type);
  const body = { type, w: size?.w ?? definition.defaultSize.w, h: size?.h ?? definition.defaultSize.h };
  if (config) body.config = config;
  if (parentId) {
    body.parent_id = parentId;
    body.x = 0;
    body.y = 0;
  } else {
    const bottom = gridRows().reduce((max, row) => Math.max(max, row.y + row.h), 0);
    ({ x: body.x, y: body.y } = position || { x: 0, y: bottom });
  }
  const res = await fetch(`/api/projects/${projectId}/widgets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: data?.error || "Couldn't add the widget." };
  rows.set(data.id, data);
  // addItem, never setItems: setItems rebuilds every item from `rows`, which
  // only ever holds the server's last-known x/y/w/h -- during an edit that's
  // stale the instant the user drags something, since a drag only ever
  // touches the grid's own in-memory item, not this map (only Save writes it
  // back here). Rebuilding from `rows` mid-edit would silently snap every
  // other widget back to its last-saved position. Edit mode owns the layout
  // until Save or Cancel; adding a widget must not reach past that.
  if (!parentId) grid.addItem(toItem(data));
  notifyStructureChange();
  return { ok: true, row: data };
}

async function removeWidget(id) {
  const res = await fetch(`/api/widgets/${id}`, { method: "DELETE" });
  const data = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: data?.error || "Couldn't remove the widget." };
  rows.delete(id);
  // Mirrors db.py's delete_widget: deleting a container takes its children
  // with it, so their rows are stale here too -- without this they'd sit
  // inert in memory (harmless, since nothing renders a row with a dead
  // parent_id) until the next reload fetched the server's actual state.
  for (const row of childRows(id)) rows.delete(row.id);
  // removeItem, not setItems -- see addWidget's comment above; the same
  // staleness would clobber unsaved positions here too.
  grid.removeItem(id);
  notifyStructureChange();
  return { ok: true };
}

// Strips a widget's project-scoped config keys (registry.js's
// projectScopedConfig -- folder_id, analysis_id, reference_ids, so far)
// before it lands as a fresh widget via loadLayout. Never applied at save
// time: a saved layout stays a faithful capture of the project it came from,
// and this only matters at the moment a widget is actually materialised
// somewhere.
function stripProjectScopedConfig(type, config) {
  if (!config) return config;
  const fields = definitionFor(type).projectScopedConfig;
  if (!fields.length) return config;
  const next = { ...config };
  for (const field of fields) delete next[field];
  return next;
}

/* Replace the grid's arrangement with a saved (or Default) layout -- the
 * appearance panel's Layout picker (appearance-panel.js), passed this
 * function at creation time. `entries` is a layout's `widgets` list (db.py's
 * capture_layout_widgets / DEFAULT_WIDGETS): portable type/geometry/config,
 * with `parent` an index into the same list rather than a widget id.
 *
 * Two things this has to get right that a plain "delete everything, create
 * everything" wouldn't:
 *
 * - Permanent widgets (settings/exit/canvas) can't be deleted or created
 *   through the API, and a project must never end up without one. So they're
 *   the one type of entry that reuses an existing widget's id instead of
 *   minting a new one -- repositioned to the entry's geometry if the layout
 *   has one, left exactly where it is if it doesn't.
 * - A child entry's `parent` only resolves once its parent has actually been
 *   created (or, for a permanent parent, identified) -- hence two passes:
 *   every top-level entry first, then everything parented to one of them.
 *   Nesting is one level deep by design, so two passes are always enough.
 */
async function loadLayout(entries) {
  const existingPermanentByType = new Map();
  for (const row of gridRows()) {
    if (definitionFor(row.type).permanent) existingPermanentByType.set(row.type, row);
  }

  // Snapshot first -- removeWidget mutates `rows` as it goes, and a
  // container's children come along with it (mirroring db.py's cascade), so
  // iterating gridRows() live here could skip or double-handle a row.
  const toRemove = gridRows().filter((row) => !definitionFor(row.type).permanent);
  for (const row of toRemove) {
    if (rows.has(row.id)) await removeWidget(row.id);
  }

  const idByIndex = new Map();

  // Pass 1: every entry with no parent. A permanent type resolves to its
  // existing widget's id without touching the API; everything else,
  // containers included, is created fresh at the entry's own geometry.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.parent != null) continue;
    const definition = definitionFor(entry.type);
    if (definition.permanent) {
      const existing = existingPermanentByType.get(entry.type);
      if (existing) idByIndex.set(i, existing.id);
      continue;
    }
    const result = await addWidget(
      entry.type,
      { x: entry.x, y: entry.y },
      null,
      stripProjectScopedConfig(entry.type, entry.config),
      { w: entry.w, h: entry.h }
    );
    if (result.ok) idByIndex.set(i, result.row.id);
  }

  // Pass 2: entries parented to something resolved in pass 1.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.parent == null) continue;
    const parentId = idByIndex.get(entry.parent);
    if (!parentId) continue; // parent's own creation failed or was skipped
    const result = await addWidget(
      entry.type,
      null,
      parentId,
      stripProjectScopedConfig(entry.type, entry.config),
      { w: entry.w, h: entry.h }
    );
    if (result.ok) idByIndex.set(i, result.row.id);
  }

  // One bulk commit for exact locking and ordering, and to reposition
  // whichever permanent widgets the layout had entries for -- addWidget's
  // POST has no notion of locked or position, and pass 1 above deliberately
  // never touches a permanent widget's row directly.
  const finalEntries = entries
    .map((entry, i) => {
      const id = idByIndex.get(i);
      const row = id ? rows.get(id) : null;
      if (!row) return null;
      return {
        id: row.id,
        parent_id: entry.parent != null ? idByIndex.get(entry.parent) ?? null : null,
        x: entry.x,
        y: entry.y,
        w: entry.w,
        h: entry.h,
        locked: Boolean(entry.locked),
        position: i,
      };
    })
    .filter(Boolean);
  if (finalEntries.length) await putWidgets(finalEntries);

  // A full resync rather than the incremental addItem/removeItem calls
  // above: this is a wholesale replace, not an edit in progress, so there is
  // no unsaved drag position anywhere worth preserving.
  grid.setItems(gridRows().map(toItem));
  notifyStructureChange();
}

/* The floating Save/Cancel control shown while the grid is being edited.
 *
 * Lives outside any widget -- edit mode is page-level state, not something
 * one widget owns -- and outside the settings panel too, since that panel is
 * a full overlay that would otherwise sit on top of the grid the user is
 * trying to drag. Pinned to the viewport so it never scrolls out of reach,
 * above the grid in z-index but not covering it (see style.css).
 */
const editBar = document.createElement("div");
editBar.className = "project-edit-bar";
editBar.hidden = true;

const editBarCancel = document.createElement("button");
editBarCancel.type = "button";
editBarCancel.className = "btn";
editBarCancel.textContent = "Cancel";
editBarCancel.addEventListener("click", () => cancelEditing());

const editBarSave = document.createElement("button");
editBarSave.type = "button";
editBarSave.className = "btn primary";
editBarSave.textContent = "Save Layout";
editBarSave.addEventListener("click", async () => {
  editBarSave.disabled = true;
  const ok = await saveLayout();
  editBarSave.disabled = false;
  if (!ok) statusEl.textContent = "Couldn't save the layout.";
});

editBar.appendChild(editBarCancel);
editBar.appendChild(editBarSave);
document.body.appendChild(editBar);

function renderEditBar(state) {
  editBar.hidden = !state.editing;
}

const shell = {
  getState: shellState,
  subscribe(fn) {
    shellSubscribers.add(fn);
    return () => shellSubscribers.delete(fn);
  },
  enterEdit: () => setEditing(true),
  save: saveLayout,
  cancel: cancelEditing,
  // defaultSize/thumbnail ride along for widget-dock.js's cards -- it needs
  // a box size to compute a drop cell, and an optional thumbnail is the
  // extension point for a future resource-heavy widget's card.
  //
  // "folder" is expanded rather than listed once: a folder widget is
  // meaningless without knowing which folder it opens, so instead of one
  // generic "Folder" card the dock gets one per folder this project actually
  // has, each seeding config.folder_id (addWidget above) at creation time.
  // A project with no folders simply contributes no folder cards -- not an
  // error, just nothing to expand.
  addableTypes: () => {
    const entries = [];
    for (const definition of allWidgetDefinitions()) {
      if (definition.permanent) continue;
      if (definition.type === "folder") {
        for (const folder of folderRows) {
          entries.push({
            type: definition.type,
            label: folder.name,
            defaultSize: definition.defaultSize,
            thumbnail: definition.thumbnail,
            config: { folder_id: folder.id },
          });
        }
        continue;
      }
      entries.push({
        type: definition.type,
        label: definition.label,
        defaultSize: definition.defaultSize,
        thumbnail: definition.thumbnail,
      });
    }
    return entries;
  },
  addWidget,
};

shell.subscribe(renderEditBar);

/* A narrow, read-only view of edit-mode for every widget's host.editMode
 * (registry.js) -- unlike shell, not restricted to the settings widget, and
 * edge-triggered: subscribers only fire when `editing` actually flips, not
 * on every shell notification (dragging a widget flips `dirty`, which
 * would otherwise re-fire every subscriber on every pointer move -- fine
 * for the editBar's idempotent hidden-toggle above, not fine for something
 * like the appearance panel re-filling its inputs mid-edit and clobbering
 * an unsaved pick).
 */
const editMode = {
  isEditing: () => grid.isEditing(),
  subscribe(fn) {
    let last = grid.isEditing();
    fn(last);
    return shell.subscribe((state) => {
      if (state.editing === last) return;
      last = state.editing;
      fn(last);
    });
  },
};

// A layout left mid-edit is easy to lose by accident (a stray back-button tap,
// a closed tab) -- warn only when there is actually something to lose.
window.addEventListener("beforeunload", (event) => {
  if (!grid || !grid.isEditing() || !dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

// --- pages: hash routes on this same document ---------------------------
//
// #page=grid and #page=folder&id=<fid> both mount project/pages/grid-page.js
// over #project-page-container, in place of the homepage grid -- real hash
// changes (not history.pushState) so the browser's own back button walks the
// same route history as the on-screen back arrow (below) does.

let currentPage = null;
let backBtn = null;
// Bumped on every routeFromHash call; an in-flight async page load (folder
// pages fetch the folder before mounting) checks its own snapshot against
// this before mounting, so a slow load that's since been navigated away from
// can't clobber whatever the user is looking at now.
let navToken = 0;

function ensureBackButton() {
  if (backBtn) return backBtn;
  backBtn = document.createElement("a");
  backBtn.className = "project-page-back";
  backBtn.href = "#";
  backBtn.hidden = true;
  backBtn.setAttribute("aria-label", "Back to project");
  backBtn.title = "Back to project";
  backBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M15 18l-6-6 6-6"/></svg>';
  document.body.appendChild(backBtn);
  return backBtn;
}

function teardownPage() {
  if (currentPage) {
    currentPage.destroy();
    currentPage = null;
  }
}

function showHomepage() {
  teardownPage();
  pageContainerEl.hidden = true;
  gridEl.hidden = false;
  if (backBtn) backBtn.hidden = true;
}

function enterPage() {
  teardownPage();
  gridEl.hidden = true;
  pageContainerEl.hidden = false;
  pageContainerEl.innerHTML = "";
  ensureBackButton().hidden = false;
}

// Delete means "remove from the project" here -- and, since a folder is only
// ever a view over its project's references (CLAUDE.md), that has to take
// the reference out of every one of this project's folders too, not just
// project_references (db.py's remove_reference_from_project does that
// cascade). The confirmation text says so, rather than leaving it to be
// discovered.
function projectGridDeleteBehaviour() {
  return {
    label: "Delete",
    confirmHeading: "Remove from project",
    confirmText: (n) => `Remove ${n} reference${n === 1 ? "" : "s"} from this project?`,
    note: "This takes them out of every folder in this project too. Their record in the archive is untouched.",
    async perform(ids) {
      const results = await Promise.all(
        ids.map((id) =>
          fetch(`/api/projects/${projectId}/references/${id}`, { method: "DELETE" }).then((r) => r.ok)
        )
      );
      const deleted = results.filter(Boolean).length;
      return { deleted, failed: results.length - deleted };
    },
  };
}

// Delete means "unfile from this folder" here -- the project membership and
// the archive record are untouched, which is exactly what makes this
// different from the grid page's Delete and worth saying in the confirm text.
function folderDeleteBehaviour(folder) {
  return {
    label: "Remove from folder",
    confirmHeading: `Remove from "${folder.name}"`,
    confirmText: (n) => `Remove ${n} reference${n === 1 ? "" : "s"} from "${folder.name}"?`,
    note: "They stay in the project and the archive -- only this folder's grouping is removed.",
    async perform(ids) {
      const results = await Promise.all(
        ids.map((id) =>
          fetch(`/api/folders/${folder.id}/references/${id}`, { method: "DELETE" }).then((r) => r.ok)
        )
      );
      const deleted = results.filter(Boolean).length;
      return { deleted, failed: results.length - deleted };
    },
  };
}

function showGridPage() {
  enterPage();
  currentPage = createGridPage(pageContainerEl, {
    project,
    heading: project.title,
    subheading: "All references in this project -- folders are just a view, nothing here is filtered by them.",
    emptyMessage: "No references in this project yet. Add some from the Archive page.",
    async load() {
      const res = await fetch(`/api/projects/${projectId}`);
      const data = await res.json();
      // Kept in step so a rename made elsewhere (the title widget, back on
      // the homepage) is reflected if the user returns to this page later.
      project.title = data.title;
      project.description = data.description;
      return data.references;
    },
    deleteBehaviour: projectGridDeleteBehaviour(),
  });
}

async function showFolderPage(folderId, token) {
  enterPage();
  let folder;
  try {
    folder = await folders.getFolder(folderId);
  } catch (err) {
    if (token !== navToken) return; // navigated elsewhere while this was in flight
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "This folder doesn't exist, or may have been deleted.";
    pageContainerEl.appendChild(p);
    return;
  }
  if (token !== navToken) return;
  currentPage = createGridPage(pageContainerEl, {
    project,
    heading: folder.name,
    subheading: `Folder in "${project.title}"`,
    emptyMessage: `No references in "${folder.name}" yet.`,
    load: () => folders.listFolderReferences(folderId),
    deleteBehaviour: folderDeleteBehaviour(folder),
  });
}

/* The infinite canvas, in place of the homepage grid.
 *
 * Same routing as the pages above, but the page it mounts is pinned to the
 * whole viewport rather than laid out inside the container -- see
 * pages/canvas-page.js. Everything it does persists as it happens, so unlike
 * the grid there is nothing to warn about on the way out.
 */
function showCanvasPage() {
  enterPage();
  currentPage = createCanvasPage(pageContainerEl, { project });
}

function routeFromHash() {
  navToken++;
  const params = new URLSearchParams(location.hash.slice(1));
  const page = params.get("page");
  if (page === "grid") {
    showGridPage();
  } else if (page === "canvas") {
    showCanvasPage();
  } else if (page === "folder" && params.get("id")) {
    showFolderPage(params.get("id"), navToken);
  } else {
    showHomepage();
  }
}

window.addEventListener("hashchange", routeFromHash);

// --- boot --------------------------------------------------------------------

async function init() {
  projectId = new URLSearchParams(location.search).get("id");
  if (!projectId) {
    showMissing("No project id was given.");
    return;
  }

  statusEl.textContent = "Loading project…";

  // Appearance settings are fetched separately, synchronously, by
  // project/appearance.js before this module even runs -- see that file for
  // why. The settings widget reads its own copy from window.projectAppearance.
  const [projectRes, widgetsRes, folderRes] = await Promise.all([
    fetch(`/api/projects/${projectId}`),
    fetch(`/api/projects/${projectId}/widgets`),
    fetch(`/api/projects/${projectId}/folders`),
  ]);

  if (!projectRes.ok) {
    showMissing("This project doesn't exist, or may have been deleted.");
    return;
  }

  project = await projectRes.json();
  const widgets = widgetsRes.ok ? await widgetsRes.json() : [];
  folderRows = folderRes.ok ? await folderRes.json() : [];

  // The project shell has no header -- the title widget is the only chrome
  // that carries the project's name, so the browser tab needs it set here.
  document.title = project.title;
  statusEl.textContent = "";
  widgets.forEach((row) => rows.set(row.id, row));

  buildGrid();

  const dock = createWidgetDock({
    gridEl,
    addableTypes: shell.addableTypes,
    addWidget,
    cellFromPoint: grid.cellFromPoint,
    wouldFit: grid.wouldFit,
  });
  const appearancePanel = createAppearancePanel({ projectId, loadLayout });

  // Appearance shows only while editing *and* no widget is pinned to the
  // format toolbar -- project-wide defaults aren't what you want while
  // formatting one widget (format-toolbar.js's own section handles that
  // case instead; top-bar.js already shows each section independently, so
  // this only has to decide when appearance's is one of them).
  let widgetActive = false;
  function syncAppearancePanel() {
    if (editMode.isEditing() && !widgetActive) appearancePanel.show();
    else appearancePanel.hide();
  }
  editMode.subscribe((editing) => {
    dock.setVisible(editing);
    syncAppearancePanel();
  });
  onActiveWidgetChange((isActive) => {
    widgetActive = isActive;
    syncAppearancePanel();
  });

  routeFromHash();
}

init();
