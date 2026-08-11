/* The project homepage's layout engine.
 *
 * Twelve columns, a fixed row height, and snapping that is always to whole
 * cells. The homepage is meant to read as deliberately gridlike, in contrast
 * to the infinite canvas, which is free positioning with no snapping at all;
 * the two are not supposed to feel the same, so nothing here should be made
 * to behave like the canvas later.
 *
 * Placement is free: dropping a widget never moves any other widget, and
 * there is no compaction pass closing gaps afterwards -- a gap the user left
 * on purpose stays exactly as left. The only rule is that two widgets may
 * never occupy the same cells; a drop that would overlap another widget is
 * refused and the dragged widget returns to where it started.
 *
 * Pure layout. Everything the engine needs about a widget arrives as data --
 * id, cell box, locked, minimum size -- so it never learns what any of them
 * contain, and the caller mounts the contents through `mount`.
 */

export const COLUMNS = 24;

const ROW_HEIGHT = 52;
const GAP = 10;

// A press only becomes a gesture after this much movement, so a click that
// wobbles a pixel or two doesn't quietly rearrange the homepage.
const DRAG_THRESHOLD = 4;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Top to bottom, then left to right, with the id as a final tie-break so the
// order is total. Used only to keep the saved layout's position field stable,
// not to resolve conflicts -- placement is free, so there is nothing to
// resolve.
function readingOrder(a, b) {
  return a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// True if `box` would land on top of any other widget. Placement is free --
// nothing pushes, nothing compacts -- so this is the only check a drop has to
// pass: does it collide with something already there.
function collides(box, others, ignoreId) {
  return others.some((other) => other.id !== ignoreId && overlaps(box, other));
}

/* Build a grid inside `container`.
 *
 * options:
 *   mount(item, el)    -- put this widget's contents in el, once, on creation
 *   unmount(item, el)  -- tear them down again
 *   resized(item, el)  -- el's box changed size (also fires once on mount)
 *   onLayoutChange(rows) -- a gesture finished and the layout is now unsaved
 */
export function createGrid(container, options = {}) {
  const mount = options.mount || (() => {});
  const unmount = options.unmount || (() => {});
  const resized = options.resized || (() => {});
  const onLayoutChange = options.onLayoutChange || (() => {});
  // Removal is immediate (there's no bulk-delete route to stage it against),
  // unlike drag/resize which only ever changes the in-memory layout until
  // Save. The grid just asks; the caller owns deciding what happens next.
  const onRemove = options.onRemove || (() => {});
  // Same immediacy as removal: config.shadow is the widget's own persisted
  // state, not part of the layout snapshot Cancel can revert, so a toggle is
  // written as soon as it happens rather than staged behind Save.
  const onToggleShadow = options.onToggleShadow || (() => {});

  container.classList.add("widget-grid");

  const entries = new Map(); // id -> { item, el, body }
  let items = []; // the same item objects the entries hold, in reading order
  let editing = false;
  let gesture = null;
  let placeholder = null;
  let lastWidth = 0;

  // One observer for every widget body rather than one each: a box changing
  // size is the only layout fact a widget's contents care about, and the
  // Three.js widgets need it promptly (see host.onResize in registry.js).
  const bodyObserver = new ResizeObserver((records) => {
    for (const record of records) {
      const entry = entries.get(record.target.dataset.id);
      if (entry) resized(entry.item, entry.body);
    }
  });

  // Width is the only thing that changes the pixel geometry -- rows are a
  // fixed height. Guarded on width because render() writes the container's
  // own height, which would otherwise come straight back through here.
  const widthObserver = new ResizeObserver(() => {
    if (container.clientWidth === lastWidth) return;
    lastWidth = container.clientWidth;
    render();
  });

  // --- geometry ------------------------------------------------------------

  function columnWidth() {
    return (container.clientWidth - GAP * (COLUMNS - 1)) / COLUMNS;
  }

  // Position is a transform and size is width/height, kept separate on
  // purpose: a move then animates on the compositor, and a widget's pixel
  // size only changes when it is genuinely resized, which is what the body
  // observer above is watching for.
  function place(el, box, cw) {
    el.style.width = `${box.w * cw + (box.w - 1) * GAP}px`;
    el.style.height = `${box.h * ROW_HEIGHT + (box.h - 1) * GAP}px`;
    const x = box.x * (cw + GAP);
    const y = box.y * (ROW_HEIGHT + GAP);
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  // The widget under the pointer is positioned live by the gesture, not by
  // this pass -- see updatePreview -- so render() only ever touches the
  // committed items, and a drag or resize in progress renders on top of it.
  function render() {
    const cw = columnWidth();
    // No width yet -- a page that hasn't been laid out, or a tab loaded in the
    // background. Placing widgets against a zero-width grid would put every
    // one of them at nonsense coordinates, and leaving lastWidth alone is what
    // lets the observer below run this again the moment there is a width.
    if (cw <= 0) return;

    let bottom = 1;
    for (const item of items) {
      bottom = Math.max(bottom, item.y + item.h);
      const entry = entries.get(item.id);
      if (entry) place(entry.el, item, cw);
    }
    container.style.height = `${bottom * (ROW_HEIGHT + GAP) - GAP}px`;
    lastWidth = container.clientWidth;
  }

  // --- items ---------------------------------------------------------------

  const snapshot = () => items.map((item) => ({ ...item }));

  function normalise(raw) {
    const minW = clamp(Math.round(raw.minW || 1), 1, COLUMNS);
    const minH = Math.max(1, Math.round(raw.minH || 1));
    const w = clamp(Math.round(raw.w || minW), minW, COLUMNS);
    return {
      id: raw.id,
      x: clamp(Math.round(raw.x || 0), 0, COLUMNS - w),
      y: Math.max(0, Math.round(raw.y || 0)),
      w,
      h: Math.max(minH, Math.round(raw.h || minH)),
      locked: Boolean(raw.locked),
      removable: Boolean(raw.removable),
      shadow: Boolean(raw.shadow),
      minW,
      minH,
    };
  }

  // Write resolved boxes back onto the canonical items. The entries hold the
  // same objects, so there is only ever one copy of a widget's position.
  function apply(rows) {
    for (const row of rows) {
      const entry = entries.get(row.id);
      if (entry) Object.assign(entry.item, { x: row.x, y: row.y, w: row.w, h: row.h });
    }
    items.sort(readingOrder);
  }

  function createEntry(item) {
    const el = document.createElement("div");
    el.className = "widget";
    el.dataset.id = item.id;
    el.classList.toggle("is-locked", item.locked);
    el.classList.toggle("is-removable", item.removable);
    el.classList.toggle("has-shadow", item.shadow);

    const body = document.createElement("div");
    body.className = "widget-body";
    body.dataset.id = item.id;
    el.appendChild(body);

    // A pointer affordance and nothing else, so it stays out of the a11y tree
    // rather than being announced as an empty element.
    const handle = document.createElement("div");
    handle.className = "widget-resize";
    handle.setAttribute("aria-hidden", "true");
    el.appendChild(handle);

    // A real button, not a bare affordance: removal needs a click target the
    // a11y tree and keyboard can reach, unlike the resize nub above.
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "widget-remove";
    remove.setAttribute("aria-label", "Remove widget");
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      onRemove(entries.get(item.id)?.item || item);
    });
    el.appendChild(remove);

    // Only visible while editing (style.css), same as the resize nub -- the
    // shadow is otherwise config-driven and not something to fiddle with
    // while just looking at the page.
    const shadowToggle = document.createElement("button");
    shadowToggle.type = "button";
    shadowToggle.className = "widget-shadow-toggle";
    shadowToggle.setAttribute("aria-label", "Toggle shadow");
    shadowToggle.title = "Toggle shadow";
    shadowToggle.textContent = "◐";
    shadowToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const entry = entries.get(item.id);
      if (!entry) return;
      entry.item.shadow = !entry.item.shadow;
      entry.el.classList.toggle("has-shadow", entry.item.shadow);
      entry.el.classList.toggle("is-shadow-on", entry.item.shadow);
      onToggleShadow(entry.item, entry.item.shadow);
    });
    el.appendChild(shadowToggle);
    el.classList.toggle("is-shadow-on", item.shadow);

    // A native HTML5 drag source, deliberately separate from the pointer-based
    // gesture the rest of this file implements -- that gesture only ever
    // moves a widget within this one container, and has no way to know when
    // the pointer is over a sidebar's slide-in panel, which lives outside
    // .widget-grid entirely (see widgets/sidebar.js for why). A native drag
    // still fires dragover/drop on whatever element the pointer is over
    // regardless of container boundaries, so it's the one mechanism that can
    // carry a widget out of the grid. Only offered on removable widgets --
    // the permanent controls (settings/exit/canvas) stay on the homepage.
    const moveHandle = document.createElement("button");
    moveHandle.type = "button";
    moveHandle.className = "widget-move-handle";
    moveHandle.setAttribute("aria-label", "Drag into a sidebar");
    moveHandle.title = "Drag into a sidebar";
    moveHandle.textContent = "⠿";
    moveHandle.draggable = true;
    moveHandle.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-widget-id", item.id);
      event.dataTransfer.setData("text/plain", item.id);
    });
    el.appendChild(moveHandle);

    container.appendChild(el);
    entries.set(item.id, { item, el, body });
    mount(item, body);
    bodyObserver.observe(body);
  }

  function removeEntry(id) {
    const entry = entries.get(id);
    if (!entry) return;
    bodyObserver.unobserve(entry.body);
    unmount(entry.item, entry.body);
    entry.el.remove();
    entries.delete(id);
  }

  function setItems(raw) {
    const wanted = new Set(raw.map((row) => row.id));
    for (const id of [...entries.keys()]) if (!wanted.has(id)) removeEntry(id);

    items = raw.map((row) => {
      const item = normalise(row);
      const entry = entries.get(item.id);
      if (!entry) {
        createEntry(item);
        return item;
      }
      Object.assign(entry.item, item);
      entry.el.classList.toggle("is-locked", item.locked);
      entry.el.classList.toggle("is-removable", item.removable);
      entry.el.classList.toggle("has-shadow", item.shadow);
      entry.el.classList.toggle("is-shadow-on", item.shadow);
      return entry.item;
    });

    items.sort(readingOrder);
    render();
  }

  // --- gestures ------------------------------------------------------------

  function beginGesture() {
    gesture.active = true;
    const entry = entries.get(gesture.id);
    entry.el.classList.add("is-active");
    container.classList.add("is-gesturing");

    // Only a drag needs a placeholder. A resize snaps the widget itself to
    // whole cells as it goes, so a placeholder would sit exactly underneath
    // it and say nothing.
    if (gesture.mode === "drag") {
      placeholder = document.createElement("div");
      placeholder.className = "widget-placeholder";
      // Placed *before* it enters the DOM: .widget-placeholder has a
      // transform transition for the moves that follow during the drag, and
      // appending it first with no transform would animate the first frame
      // in from 0,0 -- a visible flight from the top-left corner. Setting
      // the transform before append means there is no prior state to
      // transition from, so it just appears where it belongs.
      place(placeholder, entry.item, columnWidth());
      container.appendChild(placeholder);
    }
  }

  // Checked against the layout as it stood when the gesture started, never
  // against the previous preview -- the result then depends only on where the
  // widget is now, not on the route the pointer took to get there. Nothing
  // else in the layout ever moves in response; the only question a move asks
  // is whether its own candidate box is free.
  function updatePreview(box) {
    const cw = columnWidth();
    const item = entries.get(gesture.id).item;
    const candidate = { ...item, ...box };
    const blocked = collides(candidate, gesture.origin, gesture.id);

    gesture.valid = !blocked;
    gesture.candidate = candidate;

    if (gesture.mode === "resize") {
      // Refused live, not just at drop -- a resize can never grow into a
      // neighbour in the first place, so there is nothing to snap back from
      // when the pointer is released.
      if (!blocked) place(gesture.el, candidate, cw);
    } else if (placeholder) {
      place(placeholder, candidate, cw);
      placeholder.classList.toggle("is-invalid", blocked);
    }
  }

  function endGesture() {
    if (!gesture) return;
    const entry = entries.get(gesture.id);
    if (entry) entry.el.classList.remove("is-active");
    if (gesture.el.hasPointerCapture(gesture.pointerId)) {
      gesture.el.releasePointerCapture(gesture.pointerId);
    }
    container.classList.remove("is-gesturing");
    placeholder?.remove();
    placeholder = null;
    gesture = null;
    window.removeEventListener("keydown", onKeyDown);
  }

  function onPointerDown(event) {
    if (!editing || gesture || !event.isPrimary || event.button !== 0) return;
    // The remove and shadow-toggle buttons are click targets, not drag
    // handles -- capturing the pointer here would swallow their click before
    // it fires. The move handle is its own native drag source (see
    // createEntry) and must never also start this pointer gesture. Text/
    // Title/Notepad's own editable content joins them: it stays hit-testable
    // while editing (style.css's :has(.widget-editable-text) exemption) so it
    // can be clicked into and typed in, and needs the same exclusion so that
    // placing a cursor or drag-selecting text isn't instead read as the start
    // of a widget-move gesture. The sidebar's own open/close button needs the
    // same treatment -- unlike settings/exit, a sidebar is meant to be usable
    // *while* editing (that's how its contents get arranged at all), so its
    // click can't be swallowed by pointer capture either.
    if (event.target.closest(".widget-remove, .widget-shadow-toggle, .widget-editable-text, .widget-move-handle, .widget-sidebar-btn")) return;

    const el = event.target.closest(".widget");
    if (!el) return;
    const entry = entries.get(el.dataset.id);
    if (!entry || entry.item.locked) return;

    const cw = columnWidth();
    gesture = {
      mode: event.target.closest(".widget-resize") ? "resize" : "drag",
      id: entry.item.id,
      pointerId: event.pointerId,
      el,
      startX: event.clientX,
      startY: event.clientY,
      left: entry.item.x * (cw + GAP),
      top: entry.item.y * (ROW_HEIGHT + GAP),
      width: entry.item.w * cw + (entry.item.w - 1) * GAP,
      height: entry.item.h * ROW_HEIGHT + (entry.item.h - 1) * GAP,
      origin: snapshot(),
      valid: true,
      candidate: null,
      active: false,
    };
    el.setPointerCapture(event.pointerId);
    window.addEventListener("keydown", onKeyDown);
  }

  function onPointerMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.active) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      beginGesture();
    }
    event.preventDefault();

    const cw = columnWidth();
    const item = entries.get(gesture.id).item;

    if (gesture.mode === "drag") {
      // The widget follows the pointer in raw pixels; the cell it would land
      // in is read back off that position, so it snaps to whichever cell it
      // is nearest rather than to wherever the pointer happens to be.
      const left = gesture.left + dx;
      const top = gesture.top + dy;
      gesture.el.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      updatePreview({
        x: clamp(Math.round(left / (cw + GAP)), 0, COLUMNS - item.w),
        y: Math.max(0, Math.round(top / (ROW_HEIGHT + GAP))),
      });
    } else {
      updatePreview({
        w: clamp(Math.round((gesture.width + dx + GAP) / (cw + GAP)), item.minW, COLUMNS - item.x),
        h: Math.max(item.minH, Math.round((gesture.height + dy + GAP) / (ROW_HEIGHT + GAP))),
      });
    }
  }

  function onPointerUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    // Only the box under the pointer at release matters -- a widget that
    // passed over a legal spot mid-drag and ended somewhere occupied still
    // gets refused, back to exactly where it started.
    const dropped = gesture.active && gesture.valid && gesture.candidate;
    if (dropped) apply([gesture.candidate]);
    endGesture();
    render();
    // The layout is now unsaved. Writing it is the caller's explicit Save,
    // never a side effect of letting go of the pointer.
    if (dropped) onLayoutChange(getLayout());
  }

  function onPointerCancel(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    endGesture();
    render();
  }

  function onKeyDown(event) {
    if (event.key !== "Escape" || !gesture) return;
    endGesture();
    render();
  }

  // A pointer drag that starts on a link or an image inside a widget must not
  // also become a native HTML5 drag, which would swallow the gesture.
  function onDragStart(event) {
    if (gesture) event.preventDefault();
  }

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", onPointerCancel);
  container.addEventListener("dragstart", onDragStart);
  widthObserver.observe(container);

  // --- public --------------------------------------------------------------

  /** The layout as it stands, in reading order. What Save writes. */
  function getLayout() {
    return items.map((item) => ({
      id: item.id,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      locked: item.locked,
    }));
  }

  /** Put a layout back -- a saved one, or the committed one after a cancel. */
  function setLayout(rows) {
    for (const row of rows) {
      const entry = entries.get(row.id);
      if (entry) Object.assign(entry.item, normalise({ ...entry.item, ...row }));
    }
    items.sort(readingOrder);
    render();
  }

  /* Where a widget dropped from the Add Widget dock at this viewport point
   * would land, in cells -- the same pointer-to-cell math onPointerMove uses
   * for a drag, just computed from a single point instead of a delta. */
  function cellFromPoint(clientX, clientY, w, h) {
    const cw = columnWidth();
    const rect = container.getBoundingClientRect();
    return {
      x: clamp(Math.round((clientX - rect.left) / (cw + GAP)), 0, COLUMNS - w),
      y: Math.max(0, Math.round((clientY - rect.top) / (ROW_HEIGHT + GAP))),
    };
  }

  /** Whether `box` (a candidate new widget, not one already on the grid)
   * would land on top of anything already there. */
  function wouldFit(box) {
    return !collides(box, items);
  }

  function setEditing(next) {
    editing = Boolean(next);
    if (!editing && gesture) {
      endGesture();
      render();
    }
    container.classList.toggle("is-editing", editing);
  }

  function destroy() {
    endGesture();
    widthObserver.disconnect();
    bodyObserver.disconnect();
    container.removeEventListener("pointerdown", onPointerDown);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", onPointerUp);
    container.removeEventListener("pointercancel", onPointerCancel);
    container.removeEventListener("dragstart", onDragStart);
    for (const id of [...entries.keys()]) removeEntry(id);
    container.classList.remove("widget-grid", "is-editing", "is-gesturing");
    container.style.height = "";
  }

  return {
    setItems,
    getLayout,
    setLayout,
    setEditing,
    isEditing: () => editing,
    cellFromPoint,
    wouldFit,
    refresh: () => render(),
    destroy,
  };
}
