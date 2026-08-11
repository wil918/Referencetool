/* What is on the canvas, and what you can do to it.
 *
 * Three kinds of node share one table and one set of gestures (db.py's
 * canvas_nodes schema says why): a reference from this project, a simple
 * text node, or a widget instance. They are dragged, locked, deleted,
 * connected and resized identically; only what is drawn inside the box
 * differs, which is the one thing buildBody() below branches on.
 *
 * Two rules shape the whole file:
 *
 *   1. Positions are world coordinates, always. Every gesture converts the
 *      pointer through viewport.screenToWorld and works from the result, so a
 *      drag is correct no matter where the view is pointed or how far it is
 *      zoomed -- and stays correct if the view moves mid-drag.
 *
 *   2. A node's DOM is built once. Moving one writes a transform, resizing
 *      one writes a width and a height, and nothing else re-renders -- least
 *      of all a pan or a zoom, which never reach this module at all (they
 *      move the world layer these nodes are already sitting in).
 *
 * Editing is immediate throughout: there is no edit mode to enter and no Save
 * to press. That is the deliberate opposite of the homepage grid, where
 * nothing moves until asked and nothing is written until saved. The two are
 * not supposed to feel the same.
 */

import { makeCard } from "../../shared/cards.js";
import * as carousel from "../../shared/carousel.js";
import { definitionFor, mountWidget } from "../registry.js";
import { insertPlainText } from "../text-utils.js";
import { createEdgeLayer } from "./edges.js";

// How big a node is when nothing says otherwise. Sizes are world units, which
// at scale 1 are CSS pixels -- so these are simply "how big it looks when you
// drop it in".
const DEFAULT_SIZE = {
  reference: { w: 200, h: 236 }, // a square thumbnail plus its caption
  text: { w: 240, h: 120 },
};
// A widget's own defaultSize is in homepage grid cells, so it needs
// converting. These are that grid's own metrics (grid.js's ROW_HEIGHT + GAP,
// and a column at a typical page width), which keeps a widget dropped on the
// canvas roughly the size it is on the homepage.
const CELL_W = 56;
const CELL_H = 62;
const CELL_GAP = 10;

const MIN_W = 80;
const MIN_H = 60;

// A press has to travel this far before it moves anything, so clicking a node
// to select it -- or into a text node to place a caret -- never nudges it.
const DRAG_THRESHOLD = 3;

const ICON = {
  grip: "⠿",
  remove: "×",
  connect:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M8.5 12h7"/></svg>',
  locked:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlocked:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0"/></svg>',
};

/* A widget mounted on the canvas is never "being edited" the way one on the
 * homepage grid can be.
 *
 * Edit mode is the homepage's idea: it is what makes arranging boxes possible
 * there, and every widget that reads it treats "editing" as "stop being
 * interactive". The canvas has no such mode -- widgets on it are live, and
 * that is what makes a similarity map dropped next to three references
 * something you can actually orbit. The corollary is that widgets which are
 * only editable in edit mode (Text, Title) are read-only here; the text node
 * kind is the canvas's own editable text, which is why the schema has one.
 */
const CANVAS_EDIT_MODE = {
  isEditing: () => false,
  subscribe(fn) {
    fn(false);
    return () => {};
  },
};

const centreOf = (node) => ({ x: node.x + node.w / 2, y: node.y + node.h / 2 });

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

/* Build the node layer.
 *
 * options:
 *   viewport   -- createViewport()'s handle; the source of every conversion
 *   store      -- createStore()'s handle; every write goes through it
 *   project    -- { id, title, ... }, handed to widget nodes as host.project
 *   references -- this project's references, for reference nodes to draw from
 *   onStatus(message) -- something went wrong and is worth saying out loud
 *   onCountChange(n)  -- a node was added or removed; the page's empty state
 *     is the only thing that cares, so this is a count and not a diff
 */
export function createNodes({
  viewport,
  store,
  project,
  references = [],
  onStatus = () => {},
  onCountChange = () => {},
}) {
  const world = viewport.el;
  const edges = createEdgeLayer(world, { onSelect: selectEdge });

  const entries = new Map(); // node id -> { node, el, body, mounted, text }
  const edgesByNode = new Map(); // node id -> Set of edge ids touching it
  const referencesById = new Map(references.map((ref) => [ref.id, ref]));

  let selectedNodeId = null;
  let selectedEdgeId = null;
  // The highest z_index in play, and who holds it -- so bringing a node to
  // the front is one comparison rather than a scan, and re-grabbing the node
  // that is already on top writes nothing.
  let topZ = 0;
  let topNodeId = null;

  // The one gesture in flight, if any: a drag, a resize, or a connection
  // being drawn. Only ever one, since all three start from a pointerdown that
  // captures the pointer.
  let gesture = null;

  /* Undo, for structural changes only: add node, delete node, connect,
   * disconnect. Not a drag, a resize, a lock, or a text edit -- a drag or
   * resize is a continuous gesture with no single "before" to jump back to
   * (and grid.js/this module already treat moves and sizes as fire-and-forget
   * writes, never something to step backward through), and contenteditable
   * already has its own native undo for text, which fighting over would
   * behave worse than doing nothing (see onKeyDown below).
   *
   * In-memory only, capped so a long session doesn't grow this unboundedly --
   * an undo stack is a convenience for the last few actions, not a durable
   * history, and nothing here is persisted or expected to survive a reload.
   */
  const UNDO_LIMIT = 50;
  const undoStack = [];

  function pushUndo(action) {
    undoStack.push(action);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  // --- geometry ------------------------------------------------------------

  /* Position and size are written separately, and by different gestures.
   *
   * Transform for position, width/height for size -- the same split grid.js
   * uses, and for the same reason: a move then runs on the compositor and
   * never invalidates layout, which is what a drag needs, while a resize
   * genuinely does change the box. Writing both on every pointermove of a
   * drag would throw that away for nothing. */
  function place(entry) {
    entry.el.style.transform = `translate3d(${entry.node.x}px, ${entry.node.y}px, 0)`;
  }

  function size(entry) {
    entry.el.style.width = `${entry.node.w}px`;
    entry.el.style.height = `${entry.node.h}px`;
  }

  /** Redraw only the connections touching this node. */
  function refreshEdges(nodeId) {
    const ids = edgesByNode.get(nodeId);
    if (!ids) return;
    for (const edgeId of ids) {
      const edge = edges.get(edgeId);
      const source = entries.get(edge.source_node_id);
      const target = entries.get(edge.target_node_id);
      if (source && target) edges.update(edgeId, centreOf(source.node), centreOf(target.node));
    }
  }

  // --- selection and z-order -----------------------------------------------

  function selectNode(nodeId) {
    if (selectedEdgeId) {
      edges.select(null);
      selectedEdgeId = null;
    }
    if (selectedNodeId === nodeId) return;
    entries.get(selectedNodeId)?.el.classList.remove("is-selected");
    selectedNodeId = nodeId;
    entries.get(selectedNodeId)?.el.classList.add("is-selected");
  }

  function selectEdge(edgeId) {
    selectNode(null);
    selectedEdgeId = edgeId;
    edges.select(edgeId);
  }

  function clearSelection() {
    selectNode(null);
    if (selectedEdgeId) {
      edges.select(null);
      selectedEdgeId = null;
    }
  }

  /* Whatever is grabbed comes to the front and stays there.
   *
   * z_index is persisted like any other field, so a board keeps its stacking
   * across reloads; re-grabbing the node that is already on top is a no-op
   * rather than a write, which is what stops a fidget from filling the queue.
   */
  function bringToFront(entry) {
    if (topNodeId === entry.node.id) return;
    topZ += 1;
    topNodeId = entry.node.id;
    entry.node.z_index = topZ;
    entry.el.style.zIndex = String(topZ + 1); // 0 belongs to the edge layer
    store.patchNode(entry.node.id, { z_index: topZ });
  }

  // --- building a node -----------------------------------------------------

  function control(className, label, html) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `canvas-node-control ${className}`;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = html;
    return btn;
  }

  function buildChrome(entry) {
    const chrome = document.createElement("div");
    chrome.className = "canvas-node-chrome";

    // Not a .canvas-node-btn: this one is a drag surface, and the pointerdown
    // handler below relies on that distinction to know whether a press on the
    // chrome should start a move or be left to a click handler.
    const grip = control("canvas-node-grip", "Move", ICON.grip);
    chrome.appendChild(grip);

    const link = control("canvas-node-btn canvas-node-link", "Connect to another node", ICON.connect);
    link.addEventListener("pointerdown", (event) => beginConnect(event, entry));
    chrome.appendChild(link);

    const lock = control("canvas-node-btn canvas-node-lock", "Lock", ICON.unlocked);
    lock.addEventListener("click", (event) => {
      event.stopPropagation();
      setLocked(entry, !entry.node.locked);
    });
    chrome.appendChild(lock);

    const remove = control("canvas-node-btn canvas-node-delete", "Delete", ICON.remove);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeNode(entry.node.id);
    });
    chrome.appendChild(remove);

    entry.lockBtn = lock;
    return chrome;
  }

  function buildReferenceBody(entry, body) {
    const ref = referencesById.get(entry.node.reference_id);
    if (!ref) {
      // The reference was removed from the project (or the archive) after
      // this node was made. Saying so beats an empty box with a dead id in it.
      const note = document.createElement("p");
      note.className = "muted canvas-node-missing";
      note.textContent = "This reference is no longer in the project.";
      body.appendChild(note);
      return;
    }
    // The card's own click does nothing here: a single click selects the node
    // (that is what a click means on a canvas), and the full viewer is a
    // double-click, wired on the node itself below.
    body.appendChild(makeCard(ref, () => {}));
    entry.el.addEventListener("dblclick", () => {
      // The whole project's references, not just this node's, so the
      // carousel's prev/next walks the project the same way it does from the
      // grid page.
      const index = references.findIndex((r) => r.id === ref.id);
      if (index !== -1) carousel.open(references, index);
    });
  }

  function buildTextBody(entry, body) {
    const text = document.createElement("div");
    // Not "canvas-node-text": that is the wrapper's own kind class
    // (canvas-node-<kind>), and sharing it would apply this element's padding
    // and scrolling to the node box as well.
    text.className = "canvas-node-editable";
    text.contentEditable = "false";
    text.spellcheck = false;
    text.dataset.placeholder = "Double-click to write…";
    // textContent both ways, never innerHTML: the element's own DOM is kept
    // as plain text nodes (paste and Enter below are what keep it that way),
    // so what is stored is exactly what is shown and there is no markup to
    // sanitise on the way back in.
    text.textContent = entry.node.content || "";
    body.appendChild(text);
    entry.text = text;

    // Click selects and drags; double-click is how you get the caret. Without
    // that split, every attempt to move a simple text node would land in its text.
    entry.el.addEventListener("dblclick", () => beginTextEdit(entry));

    text.addEventListener("paste", (event) => {
      event.preventDefault();
      insertPlainText(event.clipboardData.getData("text/plain"));
    });

    text.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        text.blur();
        return;
      }
      // Left alone, the browser answers Enter by splitting the element into
      // <div>s -- markup, in an element whose contents are meant to stay
      // plain text nodes.
      if (event.key !== "Enter") return;
      event.preventDefault();
      insertPlainText("\n");
    });

    text.addEventListener("blur", () => {
      text.contentEditable = "false";
      entry.el.classList.remove("is-editing");
      // Deleting a node while its text has focus blurs it on the way out.
      // Persisting then would queue a PATCH against a row that is already
      // gone, and surface its 404 as an error the user caused by nothing.
      if (!entries.has(entry.node.id)) return;
      const content = text.textContent;
      if (content === (entry.node.content || "")) return;
      entry.node.content = content;
      store.patchNode(entry.node.id, { content });
    });
  }

  function beginTextEdit(entry) {
    if (!entry.text) return;
    entry.text.contentEditable = "true";
    entry.el.classList.add("is-editing");
    entry.text.focus();
    // Caret at the end rather than wherever the double-click landed, which
    // for an empty box is nowhere at all.
    const range = document.createRange();
    range.selectNodeContents(entry.text);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function buildWidgetBody(entry, body) {
    const type = entry.node.config?.type;
    const definition = definitionFor(type);
    // Nesting and the permanent homepage controls have no meaning out here,
    // which is exactly what registry.js's canvasEligible already encodes --
    // the same container/permanent flags the grid uses, read rather than
    // restated as a second list that could drift out of step with it.
    if (!definition.canvasEligible) {
      const note = document.createElement("p");
      note.className = "muted canvas-node-missing";
      note.textContent = `${definition.label} can't sit on the canvas.`;
      body.appendChild(note);
      return;
    }

    // The widget's padding contract comes from .widget-body (style.css); the
    // canvas's own class is what positions and sizes the box around it.
    body.classList.add("widget-body");

    entry.mounted = mountWidget(definition, body, {
      project,
      // The widget's own config is nested rather than sharing the node's
      // config object with `type`: a widget that saves a fresh object instead
      // of spreading its old one would otherwise drop the very field that
      // says what kind of widget this node is.
      config: entry.node.config?.widget || null,
      persist(widgetConfig) {
        entry.node.config = { ...entry.node.config, widget: widgetConfig };
        store.patchNode(entry.node.id, { config: entry.node.config });
      },
      editMode: CANVAS_EDIT_MODE,
    });
  }

  function buildBody(entry) {
    const body = document.createElement("div");
    body.className = "canvas-node-body";
    if (entry.node.kind === "reference") buildReferenceBody(entry, body);
    else if (entry.node.kind === "text") buildTextBody(entry, body);
    else if (entry.node.kind === "widget") buildWidgetBody(entry, body);
    return body;
  }

  /* Fill in what the API is allowed to leave null.
   *
   * w/h are nullable in the schema (a node created by an import need not have
   * said how big it is), and a node with no size would be an invisible box
   * that can never be grabbed to give it one.
   */
  function normalise(raw) {
    const fallback =
      DEFAULT_SIZE[raw.kind] ||
      widgetDefaultSize(definitionFor(raw.config?.type)); // widget nodes
    return {
      ...raw,
      x: Number(raw.x) || 0,
      y: Number(raw.y) || 0,
      w: Math.max(MIN_W, Number(raw.w) || fallback.w),
      h: Math.max(MIN_H, Number(raw.h) || fallback.h),
      z_index: Number(raw.z_index) || 0,
      locked: Boolean(raw.locked),
    };
  }

  function addEntry(raw) {
    const node = normalise(raw);

    const el = document.createElement("div");
    el.className = `canvas-node canvas-node-${node.kind}`;
    el.dataset.id = node.id;
    el.style.zIndex = String(node.z_index + 1);

    const entry = { node, el, body: null, mounted: null, text: null, lockBtn: null };
    const body = buildBody(entry);
    entry.body = body;
    el.appendChild(body);
    el.appendChild(buildChrome(entry));

    // A pointer affordance, not a control -- same reasoning as the grid's
    // resize nub, so it stays out of the a11y tree.
    const resize = document.createElement("div");
    resize.className = "canvas-node-resize";
    resize.setAttribute("aria-hidden", "true");
    resize.addEventListener("pointerdown", (event) => beginResize(event, entry));
    el.appendChild(resize);

    el.addEventListener("pointerdown", (event) => onNodePointerDown(event, entry));

    place(entry);
    size(entry);
    applyLockClasses(entry);
    world.appendChild(el);
    entries.set(node.id, entry);
    // Same "fires once on mount" guarantee the grid's ResizeObserver gives
    // (registry.js's host.onResize): a 3D widget node has to be told its box
    // before it can size a renderer to it.
    entry.mounted?.notifyResize(node.w, node.h);

    if (node.z_index >= topZ) {
      topZ = node.z_index;
      topNodeId = node.id;
    }
    return entry;
  }

  function widgetDefaultSize(definition) {
    const cells = definition.defaultSize;
    return {
      w: cells.w * CELL_W - CELL_GAP,
      h: cells.h * CELL_H - CELL_GAP,
    };
  }

  // --- lock ----------------------------------------------------------------

  function applyLockClasses(entry) {
    entry.el.classList.toggle("is-locked", entry.node.locked);
    if (!entry.lockBtn) return;
    entry.lockBtn.innerHTML = entry.node.locked ? ICON.locked : ICON.unlocked;
    const label = entry.node.locked ? "Unlock" : "Lock";
    entry.lockBtn.title = label;
    entry.lockBtn.setAttribute("aria-label", label);
    entry.lockBtn.classList.toggle("is-on", entry.node.locked);
  }

  /* Locked means pinned, not inert: the node stops moving and stops resizing,
   * and goes on being connectable, editable and clickable. It is a way to
   * stop knocking a finished arrangement out of place, not a way to switch a
   * node off. */
  function setLocked(entry, locked) {
    entry.node.locked = locked;
    applyLockClasses(entry);
    store.patchNode(entry.node.id, { locked });
  }

  // --- gestures ------------------------------------------------------------

  /* Whether a press on this target should start moving this node.
   *
   * The grip exists because some node contents want the pointer for
   * themselves: a widget's 3D scene orbits on drag, and text with a caret in
   * it selects. Those nodes move by their grip; everything else moves from
   * anywhere on it, which is what makes dragging a reference around feel
   * direct.
   */
  function pressStartsDrag(node, target) {
    if (node.locked) return false;
    if (target.closest(".canvas-node-grip")) return true;
    if (node.kind === "widget") return false;
    if (target.closest('[contenteditable="true"]')) return false;
    return true;
  }

  function onNodePointerDown(event, entry) {
    if (!event.isPrimary || event.button !== 0 || gesture) return;
    // These have their own handlers; capturing the pointer here would swallow
    // the click before it ever fires.
    if (event.target.closest(".canvas-node-btn, .canvas-node-resize")) return;

    selectNode(entry.node.id);
    bringToFront(entry);

    if (!pressStartsDrag(entry.node, event.target)) return;

    const pointer = viewport.screenToWorld(event.clientX, event.clientY);
    gesture = {
      kind: "drag",
      entry,
      pointerId: event.pointerId,
      // Where the pointer sits relative to the node, in world units. Every
      // move re-derives the node's position from the pointer and this offset
      // rather than accumulating deltas, so nothing drifts over a long drag
      // and a zoom mid-drag keeps the node under the same part of the cursor.
      offsetX: entry.node.x - pointer.x,
      offsetY: entry.node.y - pointer.y,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      captureEl: entry.el,
    };
    entry.el.setPointerCapture(event.pointerId);
  }

  function beginResize(event, entry) {
    if (!event.isPrimary || event.button !== 0 || gesture || entry.node.locked) return;
    event.stopPropagation();
    selectNode(entry.node.id);
    bringToFront(entry);

    const pointer = viewport.screenToWorld(event.clientX, event.clientY);
    gesture = {
      kind: "resize",
      entry,
      pointerId: event.pointerId,
      // Same offset trick as the drag: the corner keeps its grip on the
      // pointer instead of jumping to it.
      offsetW: entry.node.w - (pointer.x - entry.node.x),
      offsetH: entry.node.h - (pointer.y - entry.node.y),
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      captureEl: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function beginConnect(event, entry) {
    if (!event.isPrimary || event.button !== 0 || gesture) return;
    event.stopPropagation();
    selectNode(entry.node.id);

    gesture = {
      kind: "connect",
      entry,
      pointerId: event.pointerId,
      active: true,
      captureEl: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    const pointer = viewport.screenToWorld(event.clientX, event.clientY);
    edges.showDraft(centreOf(entry.node), pointer);
    world.classList.add("is-connecting");
  }

  function onPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    if (!gesture.active) {
      const moved =
        Math.abs(event.clientX - gesture.startX) >= DRAG_THRESHOLD ||
        Math.abs(event.clientY - gesture.startY) >= DRAG_THRESHOLD;
      if (!moved) return;
      gesture.active = true;
      gesture.entry.el.classList.add("is-active");
    }
    trackGesture(event);
  }

  /* Put the node wherever the pointer is now.
   *
   * Called on every move and once more at the release point, which is not
   * always where the last move left off -- a quick flick can end between
   * frames, and a node that settled a few pixels short of where it was let go
   * is exactly the kind of imprecision a canvas with no snapping cannot
   * afford.
   */
  function trackGesture(event) {
    const pointer = viewport.screenToWorld(event.clientX, event.clientY);
    const { entry } = gesture;

    if (gesture.kind === "drag") {
      // No snapping, no grid, no gravity: the node goes exactly where the
      // pointer puts it. This is the canvas's whole character, and the reason
      // it reads as looser than the homepage.
      entry.node.x = pointer.x + gesture.offsetX;
      entry.node.y = pointer.y + gesture.offsetY;
      place(entry);
      refreshEdges(entry.node.id);
    } else if (gesture.kind === "resize") {
      entry.node.w = Math.max(MIN_W, pointer.x - entry.node.x + gesture.offsetW);
      entry.node.h = Math.max(MIN_H, pointer.y - entry.node.y + gesture.offsetH);
      size(entry);
      refreshEdges(entry.node.id);
      entry.mounted?.notifyResize(entry.node.w, entry.node.h);
    } else {
      edges.showDraft(centreOf(entry.node), pointer);
    }
  }

  function onPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const { kind, entry, active } = gesture;
    const target = kind === "connect" ? nodeUnder(event.clientX, event.clientY) : null;
    if (active && kind !== "connect") trackGesture(event);

    endGesture();

    if (!active) return;
    if (kind === "drag") {
      store.patchNode(entry.node.id, { x: entry.node.x, y: entry.node.y });
    } else if (kind === "resize") {
      store.patchNode(entry.node.id, { w: entry.node.w, h: entry.node.h });
    } else if (target && target !== entry.node.id) {
      connect(entry.node.id, target);
    }
  }

  function endGesture() {
    if (!gesture) return;
    const { entry, pointerId, captureEl } = gesture;
    entry.el.classList.remove("is-active");
    world.classList.remove("is-connecting");
    edges.hideDraft();
    gesture = null;
    // The capture sits on whichever element started the gesture -- the node
    // for a drag, the nub for a resize, the connector button for a connection
    // -- so it is released by the one that took it, not by guessing.
    if (captureEl.hasPointerCapture(pointerId)) captureEl.releasePointerCapture(pointerId);
  }

  function onPointerCancel(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    endGesture();
  }

  /** Which node is under this screen point, if any. Pointer capture changes
   *  where events are delivered, not what is actually under the cursor, so a
   *  connection has to ask the document directly. */
  function nodeUnder(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY)?.closest(".canvas-node");
    return el ? el.dataset.id : null;
  }

  // --- structure -----------------------------------------------------------

  function indexEdge(edge) {
    for (const nodeId of [edge.source_node_id, edge.target_node_id]) {
      if (!edgesByNode.has(nodeId)) edgesByNode.set(nodeId, new Set());
      edgesByNode.get(nodeId).add(edge.id);
    }
  }

  function addEdge(edge) {
    const source = entries.get(edge.source_node_id);
    const target = entries.get(edge.target_node_id);
    if (!source || !target) return;
    edges.add(edge, centreOf(source.node), centreOf(target.node));
    indexEdge(edge);
  }

  /** `record` is false only when this is undo() itself reversing a prior
   *  disconnect -- the reconnection it makes must not push a fresh "connect"
   *  entry, or a second Cmd/Ctrl+Z would just disconnect it again instead of
   *  undoing whatever came before the original disconnect. */
  async function connect(sourceId, targetId, { record = true } = {}) {
    const already = [...(edgesByNode.get(sourceId) || [])].some((edgeId) => {
      const edge = edges.get(edgeId);
      return edge.source_node_id === targetId || edge.target_node_id === targetId;
    });
    if (already) return;

    try {
      const edge = await store.createEdge(sourceId, targetId);
      addEdge(edge);
      if (record) pushUndo({ type: "connect", edgeId: edge.id });
    } catch (err) {
      onStatus(err.message);
    }
  }

  function dropEdge(edgeId) {
    const edge = edges.get(edgeId);
    if (!edge) return;
    for (const nodeId of [edge.source_node_id, edge.target_node_id]) {
      edgesByNode.get(nodeId)?.delete(edgeId);
    }
    edges.remove(edgeId);
  }

  /** `record` is false only when this is undo() reversing a prior connect. */
  async function removeEdge(edgeId, { record = true } = {}) {
    // Read before dropEdge -- edges.remove() (inside it) is what makes
    // edges.get() stop finding this row, so the source/target this undo
    // entry needs has to be captured first.
    const edge = edges.get(edgeId);
    dropEdge(edgeId);
    if (selectedEdgeId === edgeId) selectedEdgeId = null;
    if (record && edge) {
      pushUndo({
        type: "disconnect",
        edge: { source_node_id: edge.source_node_id, target_node_id: edge.target_node_id },
      });
    }
    try {
      await store.deleteEdge(edgeId);
    } catch (err) {
      onStatus(err.message);
    }
  }

  /** Create a node and put it on the canvas. `fields` is whatever the API
   *  needs beyond a position: kind, and reference_id or config. `record` is
   *  false only when this is undo() restoring a node a delete just removed --
   *  that restoration is itself the undo, and must not push a second "add"
   *  entry that a further Cmd/Ctrl+Z would just delete right back out. */
  async function addNode(fields, { record = true } = {}) {
    const kind = fields.kind;
    const size =
      DEFAULT_SIZE[kind] || widgetDefaultSize(definitionFor(fields.config?.type));
    // Claimed before the round trip, not after: two adds in quick succession
    // would otherwise both read the same top and land on the same layer.
    topZ += 1;
    try {
      const node = await store.createNode({
        w: size.w,
        h: size.h,
        z_index: topZ,
        ...fields,
      });
      const entry = addEntry(node);
      selectNode(node.id);
      onCountChange(entries.size);
      if (record) pushUndo({ type: "add", nodeId: entry.node.id });
      return entry.node;
    } catch (err) {
      onStatus(err.message);
      return null;
    }
  }

  /** `record` is false only when this is undo() reversing a prior add. */
  async function removeNode(nodeId, { record = true } = {}) {
    const entry = entries.get(nodeId);
    if (!entry) return;

    // Captured before dropEdge below removes them from the edge layer -- a
    // "delete node" undo entry has to carry who this node was connected to,
    // so undo can offer to reconnect the survivor once the node is back.
    const removedEdges = [];
    for (const edgeId of [...(edgesByNode.get(nodeId) || [])]) {
      const edge = edges.get(edgeId);
      if (edge) removedEdges.push({ source_node_id: edge.source_node_id, target_node_id: edge.target_node_id });
      // Mirrors db.py's delete_canvas_node, which drops the edges
      // server-side: an edge to a node that is gone is a line into empty
      // space.
      dropEdge(edgeId);
    }
    edgesByNode.delete(nodeId);

    // The full row, id included -- undo needs the old id to tell which edge
    // endpoints pointed at this node (see undo()'s "delete" branch below).
    // Harmless to send back to the create endpoint too: it always mints a
    // fresh id of its own and simply never reads one from the body.
    const snapshot = { ...entry.node };

    entry.mounted?.destroy();
    entry.el.remove();
    entries.delete(nodeId);
    if (selectedNodeId === nodeId) selectedNodeId = null;
    if (topNodeId === nodeId) topNodeId = null;
    onCountChange(entries.size);

    if (record) pushUndo({ type: "delete", node: snapshot, edges: removedEdges });

    try {
      await store.deleteNode(nodeId);
    } catch (err) {
      onStatus(err.message);
    }
  }

  /* Reverse the most recent structural change -- add, delete, connect or
   * disconnect -- if there is one. Each branch calls the same functions the
   * original gesture called ({ record: false } so the reversal doesn't push
   * its own undo entry, which would turn Cmd/Ctrl+Z into a toggle instead of
   * a walk backward through history).
   *
   * A restored node gets a new server id (see removeNode's snapshot comment
   * above), so reconnecting its former edges has to happen after the restore,
   * substituting that new id for whichever end used to be the deleted node --
   * and only for edges whose other end is still on the canvas, since undoing
   * a single node's deletion can't also resurrect a node deleted separately.
   */
  async function undo() {
    const action = undoStack.pop();
    if (!action) return;

    if (action.type === "add") {
      await removeNode(action.nodeId, { record: false });
    } else if (action.type === "delete") {
      const restored = await addNode({ ...action.node }, { record: false });
      if (!restored) return;
      for (const edge of action.edges) {
        const sourceId = edge.source_node_id === action.node.id ? restored.id : edge.source_node_id;
        const targetId = edge.target_node_id === action.node.id ? restored.id : edge.target_node_id;
        if (entries.has(sourceId) && entries.has(targetId)) {
          await connect(sourceId, targetId, { record: false });
        }
      }
    } else if (action.type === "connect") {
      await removeEdge(action.edgeId, { record: false });
    } else if (action.type === "disconnect") {
      const { source_node_id: sourceId, target_node_id: targetId } = action.edge;
      if (entries.has(sourceId) && entries.has(targetId)) {
        await connect(sourceId, targetId, { record: false });
      }
    }
  }

  // --- keyboard ------------------------------------------------------------

  function isUndoChord(event) {
    // Cmd on Mac, Ctrl elsewhere; not Shift, which is conventionally redo --
    // there is no redo stack here, so Shift+Z is left alone entirely rather
    // than silently doing the same thing as plain undo.
    return (event.key === "z" || event.key === "Z") && (event.metaKey || event.ctrlKey) && !event.shiftKey;
  }

  function onKeyDown(event) {
    if (isUndoChord(event)) {
      // Inside a contenteditable, this chord belongs to the browser's own
      // undo for the text just typed -- intercepting it here would fight
      // that native undo rather than improve on it (see the undoStack
      // comment above). Everywhere else on the canvas there is no other
      // consumer of Cmd/Ctrl+Z, so it's ours.
      if (isTypingTarget(document.activeElement)) return;
      event.preventDefault();
      undo();
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    // Backspace inside a text node is a backspace. So is Delete.
    if (isTypingTarget(document.activeElement)) return;
    if (selectedEdgeId) {
      event.preventDefault();
      removeEdge(selectedEdgeId);
    } else if (selectedNodeId) {
      event.preventDefault();
      removeNode(selectedNodeId);
    }
  }

  // A press that lands on empty space is the canvas's way of saying "nothing
  // selected" -- but only if it was a click, not the end of a pan.
  function onWorldPointerDown(event) {
    if (event.target === world || event.target === viewport.container) clearSelection();
  }

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("keydown", onKeyDown);
  viewport.container.addEventListener("pointerdown", onWorldPointerDown);

  // --- public --------------------------------------------------------------

  return {
    /** Render a whole canvas, as loaded from the API. */
    setData({ nodes = [], edges: edgeRows = [] } = {}) {
      for (const node of nodes) addEntry(node);
      for (const edge of edgeRows) addEdge(edge);
    },

    addNode,
    removeNode,

    /** The world-space box every node fits inside, or null on an empty
     *  canvas -- what the page uses to point the view at the content. */
    bounds() {
      if (entries.size === 0) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const { node } of entries.values()) {
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + node.w);
        maxY = Math.max(maxY, node.y + node.h);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    },

    count: () => entries.size,

    destroy() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown);
      viewport.container.removeEventListener("pointerdown", onWorldPointerDown);
      // Widget nodes hold Three.js contexts; a canvas left without disposing
      // them takes the page down after a handful of visits (registry.js's
      // destroy contract spells this out).
      for (const entry of entries.values()) {
        entry.mounted?.destroy();
        entry.el.remove();
      }
      entries.clear();
      edgesByNode.clear();
      edges.destroy();
    },
  };
}
