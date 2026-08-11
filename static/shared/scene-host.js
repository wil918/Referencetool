/* A Three.js scene sized to an element rather than to the window.
 *
 * The renderer, camera, orbit controls and render loop that /graph.html used
 * to own privately, lifted out so the same scenes can be drawn inside a
 * project widget's box. What goes *in* the scene is nobody's business here --
 * colour-map.js and similarity-map.js both build into a scene handed to them,
 * and this module never learns which one it is holding.
 *
 * Everything visual comes from graph-common.js: the same lens, the same
 * background, the same lighting and environment as the full-page views, so an
 * embedded scene reads as the same picture at a different size.
 *
 * Two things it does that a full-page view never had to:
 *
 *   - It sizes to its container through a ResizeObserver rather than to the
 *     window through a resize listener. A widget's box changes size when the
 *     grid is edited, when a sidebar opens, when the page reflows -- none of
 *     which the window ever hears about.
 *
 *   - It stops rendering when its element is off screen (IntersectionObserver).
 *     A project homepage can hold several 3D widgets, and a scrolled-past one
 *     rendering sixty times a second is spending a GPU the visible ones need.
 *
 * dispose() is not optional for a widget: browsers cap live WebGL contexts at
 * around sixteen, and a page that leaks one per add/remove cycle stops being
 * able to draw anything at all after a handful of them.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  CAMERA_FAR,
  CAMERA_NEAR,
  FIELD_OF_VIEW,
  currentTheme,
  setupEnvironment,
} from "../graph-common.js";

// Retina is worth it up to a point; past 2 it is a lot of fragments for no
// visible gain, which matters more with several scenes sharing one GPU.
const MAX_PIXEL_RATIO = 2;

export function createSceneHost(el, options = {}) {
  const theme = options.theme || currentTheme();

  /* `background: null` leaves the canvas transparent, so the scene sits on
   * whatever the page behind it is -- which is what an embedded widget wants,
   * since a project may have set its own background colour and a pane of the
   * graph theme's grey laid over it would read as a card. Left out, the
   * theme's own background is used, as the full-page views always have. */
  const transparent = options.background === null;

  const scene = new THREE.Scene();
  if (!transparent) scene.background = new THREE.Color(theme.background);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: transparent });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  // The canvas fills its host and takes its size from CSS, never the other way
  // round -- setSize below is told not to write pixel dimensions into the
  // style, so resizing the drawing buffer can't feed back into the layout the
  // ResizeObserver is watching.
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  el.appendChild(renderer.domElement);

  const environment = setupEnvironment(scene, renderer);

  const camera = new THREE.PerspectiveCamera(
    options.fov ?? FIELD_OF_VIEW,
    1, // replaced by the first resize(), below, before anything is drawn
    options.near ?? CAMERA_NEAR,
    options.far ?? CAMERA_FAR
  );

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const frameCallbacks = new Set();

  let running = false;
  let visible = true;
  let rafId = null;
  let disposed = false;

  /* Both halves, always together: a WebGL canvas has a fixed drawing-buffer
   * size that CSS cannot stretch sensibly, so the buffer and the projection
   * have to be told the same thing or the scene renders at the wrong
   * resolution and the wrong aspect (registry.js's host.onResize says the
   * same thing from the widget's side).
   *
   * A zero-sized box -- a widget mounted while its page is hidden, or before
   * the grid has laid it out -- is left alone rather than baked into the
   * projection matrix as a division by zero; the observer below runs this
   * again as soon as there is a box. */
  function resize() {
    if (disposed) return;
    const width = el.clientWidth;
    const height = el.clientHeight;
    if (width <= 0 || height <= 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(el);

  // rootMargin so a widget just below the fold is already drawing by the time
  // it scrolls into view, rather than showing a blank canvas for a frame.
  const visibilityObserver = new IntersectionObserver(
    (entries) => {
      const next = entries.some((entry) => entry.isIntersecting);
      if (next === visible) return;
      visible = next;
      // start()/stop() is the caller's intent; this only decides whether that
      // intent currently costs anything.
      if (running) (visible ? schedule : cancel)();
    },
    { rootMargin: "200px" }
  );
  visibilityObserver.observe(el);

  function frame() {
    rafId = requestAnimationFrame(frame);
    // Only when the caller has handed control over: OrbitControls.update()
    // ends by pointing the camera at its own target, which would fight a
    // scripted camera move (the full-page graph's intro does exactly that).
    if (controls.enabled) controls.update();
    for (const callback of frameCallbacks) callback();
    renderer.render(scene, camera);
  }

  function schedule() {
    if (rafId === null) rafId = requestAnimationFrame(frame);
  }

  function cancel() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  return {
    el,
    scene,
    camera,
    renderer,
    controls,
    theme,

    start() {
      if (disposed || running) return;
      running = true;
      resize(); // the box may have had no size when the observer first ran
      if (visible) schedule();
    },

    stop() {
      running = false;
      cancel();
    },

    resize,

    /** Called once per rendered frame, before the draw. */
    onFrame(callback) {
      frameCallbacks.add(callback);
      return () => frameCallbacks.delete(callback);
    },

    /* What a pointer event is over, in element coordinates.
     *
     * Not window coordinates: a widget's canvas is a box somewhere on a
     * scrollable page, so the full-page views' clientX/innerWidth maths would
     * be wrong for everything except a canvas that fills the viewport. */
    pick(event, objects) {
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(objects)[0] || null;
    },

    /* Orbiting off, and the canvas out of the way of the pointer entirely.
     *
     * Edit mode makes a widget's whole body inert (style.css) so boxes can be
     * dragged around; a canvas that still captured the pointer for orbiting
     * would be a hole in that. */
    setInteractive(on) {
      controls.enabled = Boolean(on);
      renderer.domElement.style.pointerEvents = on ? "" : "none";
    },

    /* Give the GPU everything back. Whatever was built into the scene is the
     * builder's to release first (each map module has its own dispose); this
     * covers what the host itself made, and then throws the context away
     * rather than waiting for the browser to notice the canvas is unreachable
     * -- which it may not do before the sixteen-context cap is hit. */
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      cancel();
      frameCallbacks.clear();
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      controls.dispose();
      environment.dispose();
      scene.environment = null;
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
