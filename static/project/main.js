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

const statusEl = document.getElementById("project-shell-status");
const bodyEl = document.getElementById("project-shell-body");
const gridEl = document.getElementById("widget-grid");

let projectId = null;
let project = null;
let grid = null;

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

async function putWidgets(entries) {
  const res = await fetch(`/api/projects/${projectId}/widgets`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ widgets: entries }),
  });
  if (!res.ok) return null;
  const saved = await res.json();
  saved.forEach((row) => rows.set(row.id, row));
  return saved;
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

function buildGrid() {
  grid = createGrid(gridEl, {
    mount(item, el) {
      const row = rows.get(item.id);
      mounted.set(
        item.id,
        mountWidget(definitionFor(row.type), el, {
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

  const saved = await putWidgets(entries);
  if (!saved) {
    statusEl.textContent = "Couldn't save the layout.";
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
 * appended below everything else, same as before the dock existed.
 */
async function addWidget(type, position = null) {
  const definition = definitionFor(type);
  const bottom = gridRows().reduce((max, row) => Math.max(max, row.y + row.h), 0);
  const { x, y } = position || { x: 0, y: bottom };
  const res = await fetch(`/api/projects/${projectId}/widgets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type,
      x,
      y,
      w: definition.defaultSize.w,
      h: definition.defaultSize.h,
    }),
  });
  if (!res.ok) return false;
  const row = await res.json();
  rows.set(row.id, row);
  grid.setItems(gridRows().map(toItem));
  return true;
}

async function removeWidget(id) {
  const res = await fetch(`/api/widgets/${id}`, { method: "DELETE" });
  if (!res.ok) return false;
  rows.delete(id);
  grid.setItems(gridRows().map(toItem));
  return true;
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
  addableTypes: () =>
    allWidgetDefinitions()
      .filter((definition) => !definition.permanent)
      .map((definition) => ({
        type: definition.type,
        label: definition.label,
        defaultSize: definition.defaultSize,
        thumbnail: definition.thumbnail,
      })),
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
  const [projectRes, widgetsRes] = await Promise.all([
    fetch(`/api/projects/${projectId}`),
    fetch(`/api/projects/${projectId}/widgets`),
  ]);

  if (!projectRes.ok) {
    showMissing("This project doesn't exist, or may have been deleted.");
    return;
  }

  project = await projectRes.json();
  const widgets = widgetsRes.ok ? await widgetsRes.json() : [];

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
  const appearancePanel = createAppearancePanel({ projectId });
  editMode.subscribe((editing) => {
    dock.setVisible(editing);
    if (editing) appearancePanel.show();
    else appearancePanel.hide();
  });
}

init();
