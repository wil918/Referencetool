/* The widget contract, and the only place that knows which widgets exist.
 *
 * Every widget on a project homepage is a module in ./widgets/ with a single
 * default export:
 *
 *   {
 *     type, label,
 *     container,      // may hold other widgets (sidebar only, so far)
 *     permanent,      // may be moved but never deleted
 *     canvasEligible, // may also be dropped on the infinite canvas
 *     defaultSize: { w, h },
 *     minSize: { w, h },
 *     create(host) { ...; return { destroy() {} }; },
 *   }
 *
 * host also carries editMode -- { isEditing(), subscribe(fn) }, read-only,
 * given to every widget (see mountWidget below) -- and shell, the same shape
 * of thing but with page-level actions (add/save/cancel/etc.), given only to
 * the settings widget. editMode exists because more than one widget now
 * needs to know whether the grid is being edited without needing the
 * settings widget's actions to go with it.
 *
 * A container widget (sidebar, so far) also gets host.children -- undefined
 * for everyone else, the same pattern as host.shell -- a narrow controller
 * for the widgets parented to it: { list(), subscribe(fn), add(type),
 * remove(id), reorder(orderedIds), moveIn(widgetId), persistConfig(id, config) }.
 * A container's contents live in main.js's project-wide widget rows, not in
 * anything the container's own element holds, so it reaches them the same
 * indirect way settings.js reaches the grid.
 *
 * The imports below are static because there is no build step: the browser
 * resolves them itself, so a new widget is one file plus one line here.
 */

import titleWidget from "./widgets/title.js";
import exitWidget from "./widgets/exit.js";
import settingsWidget from "./widgets/settings.js";
import textWidget from "./widgets/text.js";
import notepadWidget from "./widgets/notepad.js";
import sidebarWidget from "./widgets/sidebar.js";

const MODULES = [titleWidget, exitWidget, settingsWidget, textWidget, notepadWidget, sidebarWidget];

// How long a widget's config sits before it is written. Config saves are the
// widget's own business and happen as the user edits, unlike the grid layout,
// which is only ever written by an explicit Save.
const CONFIG_SAVE_DELAY = 400;

function normalise(definition) {
  const container = Boolean(definition.container);
  const permanent = Boolean(definition.permanent);
  return {
    ...definition,
    container,
    permanent,
    // Derived rather than repeated in every module: nesting is a homepage
    // idea, so containers have no meaning on the canvas, and the permanent
    // controls belong to the homepage they control.
    canvasEligible: definition.canvasEligible ?? (!container && !permanent),
    defaultSize: { w: 3, h: 2, ...definition.defaultSize },
    minSize: { w: 1, h: 1, ...definition.minSize },
    isPlaceholder: false,
  };
}

const REGISTRY = new Map(MODULES.map((module) => [module.type, normalise(module)]));

/* Stand-in for a widget type that is in the database but has no module yet.
 *
 * A new project is seeded with a canvas and a settings widget, and those
 * modules arrive in later sessions -- until then the grid still has to lay
 * their boxes out, so an unknown type gets a labelled empty tile rather than
 * a page that fails to render.
 */
const PLACEHOLDERS = new Map();

// Mirrors app.py's PERMANENT_WIDGET_TYPES. A type with no module yet still
// needs to know whether it's deletable -- "canvas" is seeded on every project
// and the API's DELETE would 400 on it, so the placeholder has to refuse to
// offer a remove control rather than default to permissive.
const KNOWN_PERMANENT_TYPES = new Set(["settings", "exit", "canvas"]);

function placeholderFor(type) {
  if (!PLACEHOLDERS.has(type)) {
    PLACEHOLDERS.set(type, {
      ...normalise({
        type,
        label: type,
        permanent: KNOWN_PERMANENT_TYPES.has(type),
        minSize: { w: 2, h: 1 },
        create(host) {
          const note = document.createElement("p");
          note.className = "muted widget-missing";
          note.textContent = `${type} — not built yet`;
          host.el.appendChild(note);
          return { destroy: () => note.remove() };
        },
      }),
      isPlaceholder: true,
    });
  }
  return PLACEHOLDERS.get(type);
}

/** The definition for a type, or null if no module claims it. */
export function get(type) {
  return REGISTRY.get(type) || null;
}

/** Every real widget definition -- what an Add Widget list is built from. */
export function all() {
  return [...REGISTRY.values()];
}

/** The definition to render a stored widget row with, real or stand-in. */
export function definitionFor(type) {
  return get(type) || placeholderFor(type);
}

/* Instantiate one widget into an element, building the host it is given.
 *
 * `persist` is how this widget's config reaches the API; the debounce lives
 * here so no widget has to think about it.
 */
export function mountWidget(definition, el, { project, config = null, persist, shell = null, editMode = null, children = null }) {
  const resizeCallbacks = [];
  const destroyCallbacks = [];
  let saveTimer = null;

  const host = {
    // A widget only ever touches this element. Nothing above it in the DOM is
    // the widget's to read or change.
    el,
    project,
    config,

    // Undefined for every widget except settings.js. The grid, the edit-mode
    // flag and the widget layout all live in main.js, outside any one
    // widget's element, so the settings panel is handed a narrow controller
    // for the handful of page-level actions it triggers rather than reaching
    // out to main.js's internals itself.
    shell,

    // Unlike shell, every widget gets this -- Text, Title and Notepad all
    // need to know whether the grid is in edit mode (each reacts to it
    // differently: Text/Title are only editable while it's on, Notepad
    // never gates on it at all), so this is a narrow, read-only view of the
    // same state main.js already tracks for the floating edit bar, handed
    // out unconditionally rather than restricted the way host.shell is.
    editMode,

    // Undefined for every widget except a container's -- see the module
    // docblock. Only registry.js's caller (main.js) knows how to build one,
    // since it's the only place that holds every widget's row.
    children,

    save(next) {
      host.config = next;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        persist(next);
      }, CONFIG_SAVE_DELAY);
    },

    /* Called whenever the widget's box changes size, including once when it
     * first mounts.
     *
     * This exists for the Three.js widgets: a WebGL canvas has a fixed
     * drawing-buffer size that CSS cannot stretch sensibly, so those widgets
     * must subscribe here and, on every call, do both halves --
     *
     *   renderer.setSize(width, height);
     *   camera.aspect = width / height;
     *   camera.updateProjectionMatrix();
     *
     * -- or the scene renders at the wrong resolution and the wrong aspect
     * for the rest of the session.
     */
    onResize(callback) {
      resizeCallbacks.push(callback);
    },

    onDestroy(callback) {
      destroyCallbacks.push(callback);
    },
  };

  const instance = definition.create(host) || {};

  return {
    definition,
    host,

    notifyResize(width, height) {
      for (const callback of resizeCallbacks) callback(width, height);
    },

    destroy() {
      // A config edit made a moment before the page tears down is still an
      // edit the user made, so a pending save is flushed rather than dropped.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        persist(host.config);
      }
      instance.destroy?.();
      for (const callback of destroyCallbacks) callback();
    },
  };
}
