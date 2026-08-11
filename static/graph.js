/* The 3D similarity graph at /graph.html -- the archive's homepage.
 *
 * This module is the page, not the picture: the choreography (a drifting
 * opening shot, the scroll-triggered move to the isometric view, the fold
 * down into the flat Connections canvas), the chrome, and the mode switch
 * between the similarity layout and the colour cylinder. What those two
 * layouts are made of lives in similarity-map.js and colour-map.js, which
 * build into a scene handed to them and know nothing about this page -- which
 * is what lets a project widget put the same layouts in a box a few grid
 * cells wide (static/project/widgets/).
 *
 * The renderer, camera and orbit controls come from shared/scene-host.js for
 * the same reason. Everything below still drives them directly; the host just
 * owns creating, sizing and disposing them.
 */
import * as THREE from "three";
import {
  COLOUR_FLAT_MARGIN,
  COLOUR_THUMB_BUDGET,
  FIELD_OF_VIEW,
  HANDOFF_IMAGE_KEY,
  HANDOFF_KEY,
  THUMBNAIL_DISTANCE,
  currentTheme,
  dotTexture,
  easeInOutCubic,
  easeOutCubic,
  loadThumbnail,
  revertToDot,
} from "./graph-common.js";
import { createSceneHost } from "./shared/scene-host.js";
import { createSimilarityMap } from "./similarity-map.js";
import { createColourMap } from "./colour-map.js";
import { createColourPanel } from "./colour-panel.js";

const TRANSITION_DURATION_MS = 2200; // scroll-triggered camera move to the isometric view
const START_DISTANCE_RATIO = 0.9; // how far in front of the first plane the static opening shot sits, relative to the stack's total depth

// The fold down into the flat Archive Connections view: first the camera
// returns to the head-on opening shot, then the stack unfolds into the flat
// layout while the projection flattens out with it.
const FOLD_TO_FRONT_MS = 1700;
const FOLD_FLATTEN_MS = 2600;
const START_FOV = FIELD_OF_VIEW;
// Narrow enough that the projection is orthographic for all practical
// purposes by the end (the camera dollies back to compensate, holding the
// framing steady), so the flat page can pick it up with a real orthographic
// camera and look identical.
const FLAT_FOV = 6;

const loadState = document.getElementById("load-state");
const errorState = document.getElementById("error-state");
const errorText = document.getElementById("error-text");
const statusLine = document.getElementById("status-line");
const nodeLabel = document.getElementById("node-label");
const nodeLabelTitle = document.getElementById("node-label-title");
const nodeLabelMeta = document.getElementById("node-label-meta");

init();

async function init() {
  let data;
  try {
    const res = await fetch("/api/similarity/graph");
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load graph data.");
  } catch (err) {
    loadState.style.display = "none";
    errorState.style.display = "flex";
    errorText.textContent = err.message || String(err);
    return;
  }

  if (!data.nodes.length) {
    loadState.style.display = "none";
    errorState.style.display = "flex";
    errorText.textContent = "Not enough references yet to build a graph.";
    return;
  }

  loadState.style.display = "none";
  statusLine.textContent =
    `${data.nodes.length} references · ${data.cluster_count} clusters · ${data.edges.length} threads`;

  buildScene(data);
}

function buildScene(data) {
  const container = document.getElementById("scene");
  const theme = currentTheme();
  const dotTex = dotTexture(theme.dot);
  const hubTex = dotTexture(theme.hub);

  // Renderer, camera, orbit controls, lighting and environment (clearcoat
  // still benefits from something to reflect, even without full
  // transmission). #scene is fixed to the viewport, so sizing to the element
  // is sizing to the window, as it always was.
  const host = createSceneHost(container, { theme });
  const { scene, camera, renderer, controls } = host;

  // --- The similarity layout: one translucent plane per cluster, a billboard
  // per reference, floating tag captions and the threads between them. ---
  const map = createSimilarityMap(scene, theme);
  const spriteList = map.setData(data, dotTex, hubTex);
  const { zFirst, span: finalSpan, boundingSize } = map.metrics;

  const isoRadius = boundingSize * 1.15;
  const isoPosition = new THREE.Vector3(1, 1, 1).normalize().multiplyScalar(isoRadius);
  const isoTarget = new THREE.Vector3(0, 0, 0);

  // Six isometric-style vantage points around the whole stack -- each keeps
  // a diagonal, "3/4" feel (never a flat axis-aligned view) while leaning
  // toward one side. Used for the idle animation below; all at the same
  // radius as the final resting view so they read as the same family of shot.
  const ISO_DIRECTIONS = {
    front: new THREE.Vector3(1, 1, -2),
    back: new THREE.Vector3(1, 1, 2),
    top: new THREE.Vector3(1, 2, 1),
    bottom: new THREE.Vector3(1, -2, 1),
    left: new THREE.Vector3(-2, 1, 1),
    right: new THREE.Vector3(2, 1, 1),
  };
  const isoViewpoints = {};
  Object.entries(ISO_DIRECTIONS).forEach(([key, dir]) => {
    isoViewpoints[key] = dir.clone().normalize().multiplyScalar(isoRadius);
  });

  function closestIsoKey(fromDirection) {
    const from = fromDirection.clone().normalize();
    let bestKey = null;
    let bestDot = -Infinity;
    for (const [key, dir] of Object.entries(ISO_DIRECTIONS)) {
      const dot = from.dot(dir.clone().normalize());
      if (dot > bestDot) {
        bestDot = dot;
        bestKey = key;
      }
    }
    return bestKey;
  }

  function shuffled(array) {
    const copy = array.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // Static opening shot: further back from the first plane than a snug
  // close-up, so several planes are visible receding into the stack behind
  // it. The idle animation (below) starts drifting from here once the scene
  // is up, and the scroll trigger interrupts it whenever it fires.
  const startDistance = Math.max(10, finalSpan * START_DISTANCE_RATIO);
  const startPosition = new THREE.Vector3(0, 0, zFirst - startDistance);
  const startTarget = new THREE.Vector3(0, 0, zFirst);
  camera.position.copy(startPosition);
  camera.lookAt(startTarget);

  // How much of the world the opening shot sees, measured on the first
  // plane. The fold holds this constant while the field of view narrows, and
  // hands it to the flat page as its orthographic frustum height.
  const frameHeight = 2 * startDistance * Math.tan(THREE.MathUtils.degToRad(START_FOV / 2));
  // How far back the camera must sit for `height` of world to fill the frame
  // at `fov`. Both folds dolly along this curve as their field of view
  // narrows, which is what holds the framing steady while the projection
  // turns orthographic.
  const distanceFor = (fov, height) => height / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
  const distanceForFov = (fov) => distanceFor(fov, frameHeight);

  controls.target.set(0, 0, 0);
  controls.minDistance = 2;
  controls.maxDistance = boundingSize * 3;
  controls.enabled = false; // re-enabled once the scroll-triggered transition finishes

  const introTitle = document.getElementById("intro-title");
  const hint = document.getElementById("hint");

  // --- Colour mode ---------------------------------------------------------
  //
  // A second layout inside this same scene: same renderer, same camera, same
  // OrbitControls, same hover label and the same thumbnail loading below.

  const colourMap = createColourMap(scene, theme);
  const colourPanel = createColourPanel({
    onMatches: (scoreById) => colourMap.setMatches(scoreById),
    onFocus: (id) => focusColourNode(id),
  });
  colourPanel.onClear(() => setColourSelection(new Set()));

  const colourNodesById = new Map();
  let colourSprites = [];
  let colourSelection = new Set();
  let colourLoaded = false;
  let mode = "visual";
  let colourRadius = 7;
  let colourHeight = 12;
  let colourData = null; // handed to the flat view so it can draw without refetching

  const modeButtons = [...document.querySelectorAll("[data-mode]")];
  const bwToggle = document.getElementById("cm-bw");
  const colourStatus = document.getElementById("cm-status");

  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  bwToggle.addEventListener("change", async () => {
    colourPanel.setExcludeBlackWhite(bwToggle.checked);
    // Positions are derived from the same filtered profiles the search uses,
    // so the map has to be rebuilt for the toggle to mean the same thing here
    // as it does in the results.
    await loadColourMap(true);
  });

  async function loadColourMap(force = false) {
    if (colourLoaded && !force) return true;
    colourStatus.textContent = "Reading colour profiles…";
    let data;
    try {
      const res = await fetch(`/api/colour/map?exclude_black_white=${bwToggle.checked ? 1 : 0}`);
      data = await res.json();
      if (!res.ok) throw new Error(data.error || `failed to load (${res.status})`);
    } catch (err) {
      colourStatus.textContent = `Colour map unavailable — ${err.message}`;
      return false;
    }

    if (!data.nodes.length) {
      const pending = data.coverage?.pending || 0;
      colourStatus.textContent = pending
        ? `${pending} images still to analyse — run Colour backfill first.`
        : "No analysed images to place yet.";
      return false;
    }

    colourNodesById.clear();
    data.nodes.forEach((n) => colourNodesById.set(n.id, n));
    colourSprites = colourMap.setData(data, dotTex);
    colourRadius = data.radius;
    colourHeight = data.height;
    colourData = data;
    colourLoaded = true;
    colourStatus.textContent = `${data.nodes.length} references placed by lightness, chroma and hue.`;
    setColourSelection(colourSelection); // survives a rebuild
    return true;
  }

  function setColourSelection(ids) {
    colourSelection = new Set([...ids].filter((id) => colourNodesById.has(id)));
    colourMap.setSelection(colourSelection);
    colourPanel.setSelection(colourSelection, colourNodesById);
  }

  function focusColourNode(id) {
    const sprite = colourSprites.find((s) => s.userData.ref.id === id);
    if (!sprite) return;
    // Keep the camera's current direction and distance, just re-aim it: the
    // user's chosen viewpoint is preserved while the reference comes to centre.
    const offset = camera.position.clone().sub(controls.target);
    controls.target.copy(sprite.position);
    camera.position.copy(sprite.position.clone().add(offset));
    controls.update();
  }

  async function setMode(next) {
    if (next === mode) return;
    if (next === "colour" && !(await loadColourMap())) return;

    mode = next;
    modeButtons.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    document.body.classList.toggle("colour-mode", mode === "colour");

    // Switching modes is a visibility flip on the two layouts' groups rather
    // than a teardown and rebuild -- the scene, camera and controls are
    // shared and never re-created.
    const showColour = mode === "colour";
    map.group.visible = !showColour;
    colourMap.group.visible = showColour;
    if (showColour) colourPanel.setSelection(colourSelection, colourNodesById);
    else colourPanel.hide();

    nodeLabel.classList.remove("visible");

    // The similarity view opens on a scripted intro; the colour map has no
    // such story to tell, so it hands straight over to the orbit controls.
    introTitle.classList.add("hidden");
    scrollTriggered = true;
    phase = "done";
    controls.enabled = true;
    hint.textContent = showColour
      ? "Drag to orbit · scroll to zoom · click a reference to select · shift-click to add"
      : "Drag to rotate · scroll to zoom · right-drag to pan · move closer for thumbnails";

    if (showColour) {
      controls.target.set(0, 0, 0);
      camera.position.set(colourRadius * 1.6, colourHeight * 0.5, colourRadius * 1.6);
      controls.minDistance = 2;
      controls.maxDistance = Math.max(colourRadius, colourHeight) * 4;
    } else {
      controls.target.set(0, 0, 0);
      camera.position.copy(isoPosition);
      controls.maxDistance = boundingSize * 3;
    }
    camera.fov = START_FOV;
    camera.updateProjectionMatrix();
    controls.update();
  }

  // --- Hover label ---
  const activeSprites = () => (mode === "colour" ? colourSprites : spriteList);

  window.addEventListener("pointermove", (e) => {
    if (folding) return;
    const hit = host.pick(e, activeSprites());
    if (hit) {
      const ref = hit.object.userData.ref;
      nodeLabelTitle.textContent = ref.title;
      nodeLabelMeta.textContent = mode === "colour"
        ? `L ${Math.round(ref.lightness * 100)} · C ${Math.round(ref.chroma)} · h ${Math.round(ref.hue)}°`
        : `${ref.type}${ref.is_own_work ? " · own work" : ""}`;
      nodeLabel.classList.add("visible");
      renderer.domElement.style.cursor = mode === "colour" ? "pointer" : "";
    } else {
      nodeLabel.classList.remove("visible");
      renderer.domElement.style.cursor = "";
    }
  });

  // Click to select in colour mode. Tracked against the pointerdown position
  // so a drag that ends on a node orbits the camera instead of selecting it.
  let downAt = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    downAt = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (mode !== "colour" || !downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 4) return;

    const hit = host.pick(e, colourSprites);
    if (!hit) {
      if (!e.shiftKey) setColourSelection(new Set());
      return;
    }
    const id = hit.object.userData.ref.id;
    // Shift extends the selection, plain click replaces it -- the same
    // multi-select convention the archive grid uses.
    const next = e.shiftKey ? new Set(colourSelection) : new Set();
    if (e.shiftKey && colourSelection.has(id)) next.delete(id);
    else next.add(id);
    setColourSelection(next);
  });

  // Resizing is the scene host's ResizeObserver on #scene -- which is fixed
  // to the viewport, so it hears about a window resize the same way the
  // listener that used to live here did.

  const cameraWorldPos = new THREE.Vector3();
  let frame = 0;
  // "idle" (camera drifts between isometric-style vantage points -- front,
  // back, top, bottom, left, right -- starting with whichever is closest to
  // the opening shot, then cycling the rest in shuffled order, title card on
  // screen, until the user scrolls) -> "transition" (scroll-triggered:
  // camera eases from wherever idle left it to the final isometric view
  // while the title fades) -> "done" (orbit controls take over).
  //
  // The Archive Connections link can interrupt any of those, switching to
  // "toFront" -> "flatten" -> "handoff", which folds the stack flat and hands
  // the framing to /connections.html.
  let phase = "idle";
  let phaseStart = performance.now();
  let scrollTriggered = false;
  let folding = false;

  const IDLE_TRANSITION_MS = 3200;
  const IDLE_HOLD_MS = 1800;
  let idleQueue = shuffled(Object.keys(ISO_DIRECTIONS));
  let idleFromPos = startPosition.clone();
  let idleFromTarget = startTarget.clone();
  let idleToKey = closestIsoKey(startPosition);
  let idleToPos = isoViewpoints[idleToKey].clone();
  let idleToTarget = isoTarget.clone();
  idleQueue = idleQueue.filter((k) => k !== idleToKey);
  let idleSegmentStart = performance.now();
  let idleHolding = false;
  let idleHoldStart = 0;
  const idleCurrentPos = startPosition.clone();
  const idleCurrentTarget = startTarget.clone();

  function advanceIdleTarget() {
    if (idleQueue.length === 0) {
      idleQueue = shuffled(Object.keys(ISO_DIRECTIONS).filter((k) => k !== idleToKey));
    }
    idleFromPos = idleToPos.clone();
    idleFromTarget = idleToTarget.clone();
    idleToKey = idleQueue.shift();
    idleToPos = isoViewpoints[idleToKey].clone();
    idleToTarget = isoTarget.clone();
    idleSegmentStart = performance.now();
    idleHolding = false;
  }

  let transitionFromPos = null;
  let transitionFromTarget = null;

  window.addEventListener(
    "wheel",
    () => {
      if (scrollTriggered || folding) return;
      scrollTriggered = true;
      phase = "transition";
      phaseStart = performance.now();
      transitionFromPos = idleCurrentPos.clone();
      transitionFromTarget = idleCurrentTarget.clone();
      introTitle.classList.add("hidden");
    },
    { passive: true }
  );

  // --- Fold down into the flat Archive Connections canvas ---

  const foldFromPos = new THREE.Vector3();
  const foldFromTarget = new THREE.Vector3();
  const frontPosition = startPosition.clone();
  const frontTarget = startTarget.clone();

  // Colour mode folds to its own head-on shot, square to the disc the cylinder
  // is about to become, rather than to the plane stack's opening shot.
  const colourFoldFront = new THREE.Vector3();
  const colourFoldTarget = new THREE.Vector3(0, 0, 0);
  let colourFoldHeight = 0;

  const foldSprites = () => (mode === "colour" ? colourSprites : spriteList);
  const foldFront = () => (mode === "colour" ? colourFoldFront : frontPosition);
  const foldTarget = () => (mode === "colour" ? colourFoldTarget : frontTarget);

  function startFold() {
    if (folding) return;
    folding = true;
    scrollTriggered = true; // the wheel intro can't fire on top of this any more
    controls.enabled = false;
    phase = "toFront";
    phaseStart = performance.now();

    foldFromPos.copy(camera.position);
    // OrbitControls steers by target, the intro phases by lookAt -- reading
    // the direction back off the camera itself covers both.
    foldFromTarget.copy(
      camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(startDistance))
    );

    introTitle.classList.add("hidden");
    nodeLabel.classList.remove("visible");
    hint.style.opacity = "0";

    if (mode === "colour") {
      // Framing is worked out once, at the top of the fold, and then held: the
      // flatten phase narrows the field of view and dollies back to keep it,
      // and hands the same number to the flat page as its frustum height.
      colourFoldHeight = colourFlatFrameHeight();
      colourFoldFront.set(0, 0, -distanceFor(START_FOV, colourFoldHeight));
      colourPanel.hide();
      colourMap.hideChrome();
    }

    // The flat page opens on dots and floating tags, then fades thumbnails in
    // itself -- so anything already swapped to a thumbnail goes back to a dot
    // here, exactly as it would if the camera had simply moved away.
    foldSprites().forEach((sprite) => {
      if (sprite.userData.thumbState === "loaded") revertToDot(sprite, dotTex, hubTex);
    });
  }

  /** The height of world the flat colour view has to show: the disc, plus room
   *  for the hue swatches sitting just outside it. Widened on a portrait
   *  window, where the width is what runs out first. */
  function colourFlatFrameHeight() {
    const span = 2 * (colourRadius + 1.2);
    return Math.max(span, span / camera.aspect) * COLOUR_FLAT_MARGIN;
  }

  function finishFold() {
    phase = "handoff";
    const colour = mode === "colour";
    try {
      sessionStorage.setItem(
        HANDOFF_KEY,
        JSON.stringify(
          colour
            ? {
                mode: "colour",
                viewHeight: colourFoldHeight,
                centerX: 0,
                centerY: 0,
                data: colourData,
                // Carried as state rather than pixels, so the flat view opens
                // on the same selection the user built in three dimensions.
                selection: [...colourSelection],
                excludeBlackWhite: bwToggle.checked,
              }
            : { viewHeight: frameHeight, centerX: 0, centerY: 0, data }
        )
      );
      // Rendered and read back in the same tick, so the drawing buffer is
      // still intact without asking the renderer to preserve it every frame.
      renderer.render(scene, camera);
      sessionStorage.setItem(HANDOFF_IMAGE_KEY, renderer.domElement.toDataURL("image/jpeg", 0.82));
    } catch (err) {
      // Storage full, or the canvas wouldn't export -- the flat page just
      // builds itself from scratch instead of resuming.
    }
    window.location.href = colour ? "/colour-connections.html" : "/connections.html";
  }

  const backLink = document.getElementById("back-link");
  backLink.addEventListener("click", (e) => {
    e.preventDefault();
    startFold();
  });

  // The choreography runs as a per-frame callback on the scene host, which
  // owns the loop and the render itself.
  host.onFrame(animate);
  host.start();

  function animate() {
    frame++;

    if (phase === "idle") {
      const now = performance.now();
      if (idleHolding) {
        if (now - idleHoldStart >= IDLE_HOLD_MS) {
          advanceIdleTarget();
        }
      } else {
        const t = Math.min(1, (now - idleSegmentStart) / IDLE_TRANSITION_MS);
        const eased = easeInOutCubic(t);
        idleCurrentPos.lerpVectors(idleFromPos, idleToPos, eased);
        idleCurrentTarget.lerpVectors(idleFromTarget, idleToTarget, eased);
        camera.position.copy(idleCurrentPos);
        camera.lookAt(idleCurrentTarget);
        if (t >= 1) {
          idleHolding = true;
          idleHoldStart = now;
        }
      }
    } else if (phase === "transition") {
      const t = Math.min(1, (performance.now() - phaseStart) / TRANSITION_DURATION_MS);
      const eased = easeOutCubic(t);
      camera.position.lerpVectors(transitionFromPos, isoPosition, eased);
      const target = new THREE.Vector3().lerpVectors(transitionFromTarget, isoTarget, eased);
      camera.lookAt(target);

      if (t >= 1) {
        phase = "done";
        controls.target.set(0, 0, 0);
        controls.update();
        controls.enabled = true;
      }
    } else if (phase === "toFront") {
      const t = Math.min(1, (performance.now() - phaseStart) / FOLD_TO_FRONT_MS);
      const eased = easeInOutCubic(t);
      camera.position.lerpVectors(foldFromPos, foldFront(), eased);
      camera.lookAt(new THREE.Vector3().lerpVectors(foldFromTarget, foldTarget(), eased));

      if (t >= 1) {
        phase = "flatten";
        phaseStart = performance.now();
      }
    } else if (phase === "flatten" && mode === "colour") {
      const t = Math.min(1, (performance.now() - phaseStart) / FOLD_FLATTEN_MS);
      const eased = easeInOutCubic(t);

      // The cylinder tips over a quarter turn until the camera is looking
      // straight at its footprint -- hue still the angle, chroma still the
      // radius -- while the projection flattens out underneath it. What the
      // last frame shows is a disc, which is exactly what the flat page draws.
      colourMap.setFoldProgress(eased);

      camera.fov = START_FOV + (FLAT_FOV - START_FOV) * eased;
      camera.position.set(0, 0, -distanceFor(camera.fov, colourFoldHeight));
      camera.updateProjectionMatrix();
      camera.lookAt(colourFoldTarget);

      if (t >= 1) {
        finishFold();
        return;
      }
    } else if (phase === "flatten") {
      const t = Math.min(1, (performance.now() - phaseStart) / FOLD_FLATTEN_MS);
      const eased = easeInOutCubic(t);

      // The panes slide out to their flat positions and come forward onto the
      // first plane's depth, holding the framing while everything unfolds
      // from behind the one the camera is looking at.
      map.setFoldProgress(eased);

      // Dolly out while narrowing the field of view, which keeps what's on
      // the first plane exactly the same size while the projection loses its
      // perspective -- by the end it's orthographic in all but name.
      camera.fov = START_FOV + (FLAT_FOV - START_FOV) * eased;
      camera.position.set(0, 0, zFirst - distanceForFov(camera.fov));
      camera.updateProjectionMatrix();
      camera.lookAt(frontTarget);

      if (t >= 1) {
        finishFold();
        return;
      }
    }
    // "done" needs nothing here: the scene host calls controls.update() for
    // every frame the controls are enabled, which they only are in that phase.

    // Distance checks are cheap but texture swaps aren't worth doing every
    // single frame -- every few frames is plenty responsive. Paused during
    // the fold so the last 3D frame and the flat page's first frame agree.
    if (frame % 6 === 0 && !folding) {
      if (mode === "colour") {
        // Every reference is meant to read as its own image here, so these
        // load regardless of distance -- nearest first, a few at a time, so
        // opening the map doesn't fire one request per reference at once.
        camera.getWorldPosition(cameraWorldPos);
        colourSprites
          .filter((s) => s.userData.thumbState === "none")
          .sort((a, b) => a.position.distanceTo(cameraWorldPos) - b.position.distanceTo(cameraWorldPos))
          .slice(0, COLOUR_THUMB_BUDGET)
          // The colour map sizes its own sprites -- a selected node is drawn
          // larger than the rest -- so it re-applies that once one grows.
          .forEach((sprite) => loadThumbnail(sprite, () => colourMap.refresh()));
      } else {
        camera.getWorldPosition(cameraWorldPos);
        for (const sprite of spriteList) {
          const dist = sprite.position.distanceTo(cameraWorldPos);
          const state = sprite.userData.thumbState;
          if (dist < THUMBNAIL_DISTANCE && state === "none") {
            loadThumbnail(sprite);
          } else if (dist >= THUMBNAIL_DISTANCE && state === "loaded") {
            revertToDot(sprite, dotTex, hubTex);
          }
        }
      }
    }
    // The render itself is the scene host's, at the end of every frame.
  }
}
