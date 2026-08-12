/* The infinite canvas's coordinate system.
 *
 * There is exactly one transform on the page: `translate(tx, ty) scale(k)`
 * applied to a single absolutely-positioned world layer. Every node is a
 * child of that layer, positioned in world units and never touched again by a
 * pan or a zoom -- moving one element is what keeps panning smooth with a few
 * hundred nodes on screen, and it is why nothing here ever asks a node to
 * redraw itself.
 *
 * World coordinates are the only positions that get stored. A screen position
 * is a fact about where the viewport happens to be pointed right now and stops
 * meaning anything the moment it moves (db.py's canvas_nodes schema says the
 * same thing from the other end), so screenToWorld/worldToScreen below are the
 * only sanctioned crossing between the two, and everything else -- dragging,
 * dropping, connecting -- goes through them.
 *
 * "Screen" here always means client coordinates: the numbers a PointerEvent
 * hands over in clientX/clientY, measured from the browser viewport's top-left
 * corner. Not page coordinates, not offsets into the container. Both helpers
 * speak that same space in and out so a caller can hand a pointer event
 * straight to one and get a world point back.
 *
 * The maths, once, so the rest of this file can just refer to it:
 *
 *   screen = world * k + t + origin      (origin = the container's own corner)
 *   world  = (screen - origin - t) / k
 *
 * Zooming toward a point is that identity solved for t: the world point under
 * the pointer must land on the same screen pixel after the scale changes, so
 * t' = (screen - origin) - world * k'. Recomputing t from the invariant on
 * every wheel tick, rather than nudging it by a delta, is what keeps a long
 * run of zooms from drifting.
 */

// Roughly a hundredth to four times life size. The floor is far enough out to
// see a whole board's shape; the ceiling is where a reference's own thumbnail
// runs out of pixels and there is nothing more to magnify.
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

// One wheel notch. Browsers disagree wildly about deltaY's magnitude, so the
// delta is normalised to "lines" below and this is the zoom per line.
const ZOOM_PER_LINE = 0.12;
// A pointer has to travel this far before a press on empty space is treated
// as a pan rather than a click that happened to wobble -- the same threshold
// grid.js uses, for the same reason.
const PAN_THRESHOLD = 3;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/* Firefox reports wheel deltas in lines (deltaMode 1) and pages (2) where
 * every other browser reports pixels (0); a trackpad pinch arrives as a
 * pixel-mode event with ctrlKey set and very small deltas. Normalising to
 * "lines" first means one zoom rule covers all of them instead of a per-
 * browser fudge factor. */
function wheelLines(event) {
  if (event.deltaMode === 1) return event.deltaY;
  if (event.deltaMode === 2) return event.deltaY * 10;
  return event.deltaY / 53; // Chrome/Safari's own px-per-line for a mouse notch
}

/* Build the viewport inside `container`.
 *
 * Returns the world layer to mount things into, the two conversions, and the
 * pan/zoom controls. The caller owns what goes in the layer; this module owns
 * only where the layer sits.
 *
 * options:
 *   onChange(transform) -- the transform moved. For chrome that needs to
 *     follow it. Never used to reposition nodes: they are already in the
 *     layer that moved.
 */
export function createViewport(container, options = {}) {
  // More than one listener can care when the transform moves -- the zoom
  // readout (the constructor's own onChange) and, independently, anything
  // anchored to a world point on screen (the edge style panel repositioning
  // itself to stay over its line). A Set rather than a second callback slot
  // means a future caller doesn't have to chain its own onChange with
  // whatever the previous one already needed.
  const listeners = new Set();
  if (options.onChange) listeners.add(options.onChange);

  container.classList.add("canvas-viewport");

  const world = document.createElement("div");
  world.className = "canvas-world";
  container.appendChild(world);

  let tx = 0;
  let ty = 0;
  let scale = 1;

  // A pan gesture in flight: either a drag on empty space, or a drag anywhere
  // with the pan key held.
  let pan = null;
  // Space is a modifier here, not a key press with its own meaning -- while it
  // is down, a drag anywhere on the canvas pans, including one that starts on
  // top of a node.
  let panKeyDown = false;

  function applyTransform() {
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    // Read by the nodes' own chrome (style.css) to cancel the world scale out
    // of the controls, so a lock button stays the same size on screen at any
    // zoom. Written here, on one element, rather than by touching every node:
    // the browser recomputes the affected calc()s itself and no node is
    // re-rendered, which is the whole point of the single-transform design.
    world.style.setProperty("--canvas-scale", String(scale));
    world.style.setProperty("--canvas-inv-scale", String(1 / scale));
    const transform = getTransform();
    for (const fn of listeners) fn(transform);
  }

  const getTransform = () => ({ x: tx, y: ty, scale });

  // --- conversions ---------------------------------------------------------

  /** Client (pointer) coordinates -> world coordinates. */
  function screenToWorld(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    return {
      x: (clientX - rect.left - tx) / scale,
      y: (clientY - rect.top - ty) / scale,
    };
  }

  /** World coordinates -> client coordinates. */
  function worldToScreen(x, y) {
    const rect = container.getBoundingClientRect();
    return {
      x: x * scale + tx + rect.left,
      y: y * scale + ty + rect.top,
    };
  }

  // --- pan and zoom --------------------------------------------------------

  function panBy(dx, dy) {
    tx += dx;
    ty += dy;
    applyTransform();
  }

  /* Zoom so that whatever world point sits under (clientX, clientY) is still
   * under it afterwards. `factor` multiplies the current scale; clamping the
   * result rather than the factor means a zoom that runs into a limit simply
   * stops there instead of also sliding the view sideways. */
  function zoomAt(clientX, clientY, factor) {
    const next = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
    if (next === scale) return;

    const rect = container.getBoundingClientRect();
    const anchor = screenToWorld(clientX, clientY);
    scale = next;
    tx = clientX - rect.left - anchor.x * scale;
    ty = clientY - rect.top - anchor.y * scale;
    applyTransform();
  }

  /** Zoom about the centre of the viewport -- what a zoom button means, as
   *  opposed to a wheel tick, which has a pointer to zoom toward. */
  function zoomBy(factor) {
    const rect = container.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  function setTransform({ x = tx, y = ty, scale: k = scale } = {}) {
    tx = x;
    ty = y;
    scale = clamp(k, MIN_SCALE, MAX_SCALE);
    applyTransform();
  }

  /* Park the view over a world box -- used on load so that content added far
   * from the origin is on screen rather than somewhere off to the side.
   *
   * Deliberately not a fit-to-screen: scale is left exactly as it is (1, on
   * load) so a reference is the size it was drawn at, and the box is simply
   * placed near the top-left with a margin. Zoom is the user's to choose.
   */
  function showBounds(bounds, margin = 60) {
    if (!bounds) return;
    tx = margin - bounds.x * scale;
    ty = margin - bounds.y * scale;
    applyTransform();
  }

  // --- gestures ------------------------------------------------------------

  /* A press counts as "on empty space" only when it lands on the world layer
   * itself or on the container behind it. Every node is a child of the world
   * layer and so is the deepest element under the pointer whenever the press
   * is on one -- which makes this identity check the whole test, with no list
   * of node selectors to keep in step. */
  const isEmptySpace = (target) => target === world || target === container;

  function onPointerDown(event) {
    if (!event.isPrimary || pan) return;
    // Middle-click pans in every canvas tool there has ever been; left-click
    // only pans on empty space, or with the pan key held.
    const wantsPan =
      event.button === 1 || (event.button === 0 && (panKeyDown || isEmptySpace(event.target)));
    if (!wantsPan) return;

    pan = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
    };
    container.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (!pan || event.pointerId !== pan.pointerId) return;
    if (!pan.active) {
      const moved =
        Math.abs(event.clientX - pan.startX) >= PAN_THRESHOLD ||
        Math.abs(event.clientY - pan.startY) >= PAN_THRESHOLD;
      if (!moved) return;
      pan.active = true;
      container.classList.add("is-panning");
    }
    trackPan(event);
  }

  // Frame-to-frame deltas in screen pixels: a pan is a translation of the
  // whole layer, so it is the one thing here that never divides by scale.
  function trackPan(event) {
    const dx = event.clientX - pan.lastX;
    const dy = event.clientY - pan.lastY;
    if (!dx && !dy) return;
    panBy(dx, dy);
    pan.lastX = event.clientX;
    pan.lastY = event.clientY;
  }

  function endPan(event) {
    if (!pan || event.pointerId !== pan.pointerId) return;
    // The release point is the last thing the pointer said, and it is not
    // always where the last pointermove left off -- a fast flick can end
    // between frames. Without this the view settles short of where the hand
    // actually stopped.
    if (pan.active) trackPan(event);
    if (container.hasPointerCapture(pan.pointerId)) {
      container.releasePointerCapture(pan.pointerId);
    }
    pan = null;
    container.classList.remove("is-panning");
  }

  function onWheel(event) {
    // Without this the page scrolls behind the canvas (and a trackpad pinch
    // triggers the browser's own page zoom), so the listener is registered
    // non-passive below.
    event.preventDefault();
    const lines = wheelLines(event);
    if (!lines) return;
    // A trackpad pinch (ctrlKey) arrives as a stream of tiny deltas; the
    // exponential keeps every source's feel proportional rather than making
    // one of them crawl and the other jump.
    zoomAt(event.clientX, event.clientY, Math.exp(-lines * ZOOM_PER_LINE));
  }

  /* Space held = pan mode. Intercepted in the capture phase so a node never
   * sees the press at all: without that, a drag with space held would start a
   * node move and a pan at the same time, and nodes would each need to know
   * about this modifier. */
  function onCapturePointerDown(event) {
    if (!panKeyDown || event.button !== 0) return;
    event.stopPropagation();
    onPointerDown(event);
  }

  function onKeyDown(event) {
    if (event.code !== "Space" || event.repeat) return;
    // Space is a character before it is a modifier: a text node being typed
    // into, or any other editable, keeps it.
    if (isTypingTarget(event.target)) return;
    // Otherwise it would scroll the page under the canvas.
    event.preventDefault();
    panKeyDown = true;
    container.classList.add("is-pan-ready");
  }

  function onKeyUp(event) {
    if (event.code !== "Space") return;
    panKeyDown = false;
    container.classList.remove("is-pan-ready");
  }

  // A held key with no keyup because focus left the window entirely -- without
  // this the canvas would still think space was down on the way back.
  function onBlur() {
    panKeyDown = false;
    container.classList.remove("is-pan-ready");
  }

  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
  }

  container.addEventListener("pointerdown", onCapturePointerDown, true);
  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", endPan);
  container.addEventListener("pointercancel", endPan);
  container.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  applyTransform();

  return {
    el: world,
    container,
    screenToWorld,
    worldToScreen,
    getScale: () => scale,
    getTransform,
    setTransform,
    panBy,
    zoomAt,
    zoomBy,
    showBounds,
    /** True while a pan is actually moving the view -- lets a click handler
     *  tell "released after panning" from "clicked on empty space". */
    isPanning: () => Boolean(pan && pan.active),
    /** Notify `fn` on every pan/zoom, starting with the current transform
     *  immediately (so a caller that shows something anchored to a world
     *  point doesn't need a separate first positioning call). Returns an
     *  unsubscribe function. */
    subscribe(fn) {
      listeners.add(fn);
      fn(getTransform());
      return () => listeners.delete(fn);
    },

    destroy() {
      container.removeEventListener("pointerdown", onCapturePointerDown, true);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", endPan);
      container.removeEventListener("pointercancel", endPan);
      container.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      world.remove();
      container.classList.remove("canvas-viewport", "is-panning", "is-pan-ready");
    },
  };
}
