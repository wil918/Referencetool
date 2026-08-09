/* Colour Map, folded flat: the 3D LCh cylinder seen as its own footprint.
 *
 * Arriving from the graph's Colour mode, this page resumes the exact framing
 * that view ended on. The fold there is a quarter turn of the cylinder about
 * the x axis, so a node's flat position is just colourFlatPosition() -- the
 * one definition both sides read -- and the camera convention (orthographic,
 * on the negative z side looking back toward +z) is the same one
 * connections.html uses. Between them the last 3D frame and this page's first
 * frame are the same image, which is what makes the page change invisible.
 *
 * Hue is still the angle and chroma still the radius. Lightness is the axis
 * the flattening spends; it survives only as draw order.
 *
 * Selection, the combined profile and the colour search are not reimplemented
 * here: the panel is colour-panel.js, the same module the 3D map uses, posting
 * to the same /api/colour/search.
 */
import * as THREE from "three";
import {
  COLOUR_FLAT_MARGIN,
  HANDOFF_IMAGE_KEY,
  HANDOFF_KEY,
  bounds,
  colourFlatPosition,
  currentTheme,
  dotTexture,
  makeNodeSprite,
  makeTagSprite,
  rgbToThreeColor,
  ringTexture,
} from "./graph-common.js";
import { createColourPanel } from "./colour-panel.js";

const CAMERA_DISTANCE = 300; // arbitrary for an orthographic camera: only the frustum size matters
const MIN_VIEW_HEIGHT = 2.5;
const VISIBLE_MARGIN = 0.9;

// Time constants, not durations -- the same easing style connections.js uses,
// so a toggle reversed mid-fade turns around instead of restarting.
const THUMB_FADE_TAU_MS = 260;
const GUIDE_FADE_TAU_MS = 700;
const THUMB_LOAD_INTERVAL_MS = 120;
const THUMB_LOAD_BUDGET = 4;
const THUMB_LOAD_MARGIN = 1.3;

const THUMB_SIZE = 0.9; // matches the 3D colour map, not the similarity view's 1.3
const SELECTED_THUMB_SIZE = 1.35;
const RING_SIZE = 1.9;
const GUIDE_OPACITY = 0.3;
const HUE_TICK_SIZE = 0.34;
const DIMMED_OPACITY = 0.22;
const RELATION_OPACITY = 0.55;
const CIRCLE_SEGMENTS = 96;

const loadState = document.getElementById("load-state");
const errorState = document.getElementById("error-state");
const errorText = document.getElementById("error-text");
const statusLine = document.getElementById("status-line");
const nodeLabel = document.getElementById("node-label");
const nodeLabelTitle = document.getElementById("node-label-title");
const nodeLabelMeta = document.getElementById("node-label-meta");
const bridge = document.getElementById("bridge");
const panelEl = document.getElementById("colour-panel");

init();

async function init() {
  // Consumed on arrival: a later direct visit should frame the whole disc
  // rather than resume a stale camera.
  let handoff = null;
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (raw) handoff = JSON.parse(raw);
    sessionStorage.removeItem(HANDOFF_KEY);
    sessionStorage.removeItem(HANDOFF_IMAGE_KEY);
  } catch (err) {
    handoff = null;
  }
  if (handoff && handoff.mode !== "colour") handoff = null; // a similarity fold isn't ours to resume

  // From the fold when there is one, otherwise from the URL -- which is how
  // the toggle survives the reload it triggers.
  const excludeBlackWhite = handoff
    ? Boolean(handoff.excludeBlackWhite)
    : new URLSearchParams(window.location.search).get("bw") === "1";
  let data = handoff && handoff.data;
  if (!data) {
    loadState.style.display = "flex";
    try {
      const res = await fetch(`/api/colour/map?exclude_black_white=${excludeBlackWhite ? 1 : 0}`);
      data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load the colour map.");
    } catch (err) {
      loadState.style.display = "none";
      errorState.style.display = "flex";
      errorText.textContent = err.message || String(err);
      dismissBridge();
      return;
    }
  }

  if (!data.nodes.length) {
    loadState.style.display = "none";
    errorState.style.display = "flex";
    errorText.textContent = "No analysed images to place yet.";
    dismissBridge();
    return;
  }

  loadState.style.display = "none";
  statusLine.textContent = `${data.nodes.length} references by hue and chroma`;
  buildScene(data, handoff, excludeBlackWhite);
}

/* Guards against a resize firing at zero size (a hidden tab, a pane
 * mid-layout): one NaN reaching the camera would stick, since the zoom clamp
 * carries the previous value forward. */
function viewport() {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  return { width, height, aspect: width / height };
}

function dismissBridge() {
  if (!bridge || !bridge.isConnected) return;
  bridge.style.opacity = "0";
  setTimeout(() => bridge.remove(), 400);
}

function buildScene(data, handoff, excludeBlackWhite) {
  const container = document.getElementById("scene");
  const theme = currentTheme();
  const dotTex = dotTexture(theme.dot);
  const ringTex = ringTexture(theme.hub);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.background);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(viewport().width, viewport().height);
  container.appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  const nodesById = new Map(data.nodes.map((n) => [n.id, n]));

  // --- The disc's own guides. They start invisible: the 3D fold takes the
  // cylinder's scaffolding away as it turns, so the frame handed over has
  // none, and these fade in once this page is running. ---
  const guides = [];
  const guideGroup = new THREE.Group();
  scene.add(guideGroup);

  function addGuide(object, opacity) {
    object.material.opacity = 0;
    guides.push({ object, opacity });
    guideGroup.add(object);
  }

  function circle(radius, opacity) {
    const points = [];
    for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({
        color: theme.tagLine, transparent: true, opacity, depthWrite: false,
      })
    );
  }

  addGuide(circle(data.radius, GUIDE_OPACITY), GUIDE_OPACITY);
  addGuide(circle(data.radius / 2, GUIDE_OPACITY * 0.55), GUIDE_OPACITY * 0.55);

  // The hue wheel, at the same angles and the same distance out as in 3D --
  // after the quarter turn those swatches land exactly here.
  (data.hue_ticks || []).forEach((tick) => {
    const angle = THREE.MathUtils.degToRad(tick.hue);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        color: rgbToThreeColor(tick.rgb), transparent: true, depthWrite: false,
      })
    );
    sprite.scale.set(HUE_TICK_SIZE, HUE_TICK_SIZE, 1);
    sprite.position.set(Math.cos(angle) * (data.radius + 0.7), Math.sin(angle) * (data.radius + 0.7), 0);
    addGuide(sprite, 0.85);
  });

  const neutralLabel = makeTagSprite("neutral", theme.tagLabel);
  neutralLabel.position.set(0, 0.5, 0);
  addGuide(neutralLabel, 1);

  // --- Nodes. A dot now and a thumbnail later, as two sprites in the same
  // spot so they can cross-fade, exactly as the Connections view does. ---
  const entries = [];
  const pickables = [];
  data.nodes.forEach((n) => {
    const [x, y, z] = colourFlatPosition(n);
    const dot = makeNodeSprite({ is_hub: false }, dotTex, dotTex);
    dot.position.set(x, y, z);
    dot.userData = { ref: n };
    scene.add(dot);
    pickables.push(dot);

    const ring = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: ringTex, transparent: true, opacity: 0, depthWrite: false })
    );
    ring.scale.set(RING_SIZE, RING_SIZE, 1);
    ring.position.set(x, y, z);
    scene.add(ring);

    entries.push({ ref: n, dot, ring, x, y, z, thumb: null, load: "none", alpha: 0 });
  });
  const entryById = new Map(entries.map((e) => [e.ref.id, e]));

  const relationGeometry = new THREE.BufferGeometry();
  const relationLines = new THREE.LineSegments(
    relationGeometry,
    new THREE.LineBasicMaterial({
      color: theme.thread, transparent: true, opacity: RELATION_OPACITY, depthWrite: false,
    })
  );
  scene.add(relationLines);

  // --- Camera: same orthographic convention as connections.js, on the
  // negative z side looking back toward +z. ---
  const nodePoints = entries.map((e) => ({ x: e.x, y: e.y }));
  const nodeBounds = bounds(entries.map((e) => [e.x, e.y]));
  const discSpan = 2 * (data.radius + 1.2);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, CAMERA_DISTANCE * 2);
  const center = new THREE.Vector2();
  let viewHeight;

  function fitHeight() {
    return Math.max(discSpan, discSpan / viewport().aspect) * COLOUR_FLAT_MARGIN;
  }

  if (handoff) {
    center.set(handoff.centerX, handoff.centerY);
    viewHeight = handoff.viewHeight;
  } else {
    center.set(0, 0);
    viewHeight = fitHeight();
  }
  // Never clamp the framing handed over by the 3D view -- that would show up
  // as a jump on the first frame, the one thing this has to avoid.
  const maxViewHeight = Math.max(fitHeight(), viewHeight);

  function applyCamera() {
    const { aspect } = viewport();
    const halfHeight = viewHeight / 2;
    const halfWidth = halfHeight * aspect;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.position.set(center.x, center.y, -CAMERA_DISTANCE);
    camera.up.set(0, 1, 0);
    camera.lookAt(center.x, center.y, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  function clampCenter() {
    center.x = Math.min(Math.max(center.x, nodeBounds.minX), nodeBounds.maxX);
    center.y = Math.min(Math.max(center.y, nodeBounds.minY), nodeBounds.maxY);
    keepAReferenceInView();
  }

  function keepAReferenceInView() {
    const halfHeight = (viewHeight / 2) * VISIBLE_MARGIN;
    const halfWidth = halfHeight * viewport().aspect;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const p of nodePoints) {
      const dx = Math.abs(p.x - center.x);
      const dy = Math.abs(p.y - center.y);
      if (dx <= halfWidth && dy <= halfHeight) return;
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = p;
      }
    }
    if (!nearest) return;
    center.x = Math.min(Math.max(center.x, nearest.x - halfWidth), nearest.x + halfWidth);
    center.y = Math.min(Math.max(center.y, nearest.y - halfHeight), nearest.y + halfHeight);
  }

  applyCamera();

  const worldAt = (clientX, clientY) => {
    const { width, height } = viewport();
    return new THREE.Vector3((clientX / width) * 2 - 1, -(clientY / height) * 2 + 1, 0).unproject(camera);
  };

  // --- Selection, using the same rules as the 3D map: plain click replaces,
  // shift-click extends, a click on nothing clears. ---
  let selection = new Set(handoff?.selection || []);
  let matches = new Map();

  const panel = createColourPanel({
    onMatches: (scoreById) => {
      matches = new Map(scoreById);
      applyEmphasis();
    },
    onFocus: (id) => focusNode(id),
  });
  panel.onClear(() => setSelection(new Set()));
  document.getElementById("cm-bw").checked = excludeBlackWhite;
  panel.setExcludeBlackWhite(excludeBlackWhite);

  document.getElementById("cm-bw").addEventListener("change", (e) => {
    // Positions come from the stored profiles the toggle filters, so the map
    // itself has to be rebuilt -- a reload with the flag is the honest way to
    // do that, and there is no 3D frame to stay in step with here.
    const url = new URL(window.location.href);
    url.searchParams.set("bw", e.target.checked ? "1" : "0");
    window.location.href = url.toString();
  });

  function setSelection(ids) {
    selection = new Set([...ids].filter((id) => entryById.has(id)));
    matches = new Map();
    applyEmphasis();
    panel.setSelection(selection, nodesById);
  }

  function focusNode(id) {
    const entry = entryById.get(id);
    if (!entry) return;
    center.set(entry.x, entry.y);
    clampCenter();
    applyCamera();
  }

  /* Selected nodes come forward with a ring; once a search has run its matches
   * stay lit too, so the answer is visible as a region of the disc. */
  function applyEmphasis() {
    const hasFocus = selection.size > 0 || matches.size > 0;
    entries.forEach((entry) => {
      const isSelected = selection.has(entry.ref.id);
      const lit = isSelected || matches.has(entry.ref.id);
      entry.emphasis = !hasFocus || lit ? 1 : DIMMED_OPACITY;
      entry.ring.material.opacity = isSelected ? 0.95 : 0;
      entry.ring.visible = isSelected;
      const size = isSelected ? SELECTED_THUMB_SIZE : THUMB_SIZE;
      if (entry.thumb) entry.thumb.scale.set(size, size, 1);
      entry.ring.scale.setScalar(RING_SIZE);
    });
    updateRelationLines();
  }

  function updateRelationLines() {
    const picked = [...selection].map((id) => entryById.get(id)).filter(Boolean);
    if (picked.length < 2) {
      relationGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      relationLines.visible = false;
      return;
    }
    const cx = picked.reduce((s, e) => s + e.x, 0) / picked.length;
    const cy = picked.reduce((s, e) => s + e.y, 0) / picked.length;
    const positions = new Float32Array(picked.length * 6);
    picked.forEach((e, i) => positions.set([e.x, e.y, 0, cx, cy, 0], i * 6));
    relationGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    relationLines.visible = true;
  }

  // --- Pan, zoom, hover and click ---
  let dragging = false;
  let dragPointer = null;
  let lastClient = { x: 0, y: 0 };
  let downAt = null;

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    dragPointer = e.pointerId;
    lastClient = { x: e.clientX, y: e.clientY };
    downAt = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
  });

  function endDrag(e) {
    if (!dragging || e.pointerId !== dragPointer) return;
    dragging = false;
    canvas.classList.remove("dragging");
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (err) {
      // pointer already gone -- nothing to release
    }
  }
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener("pointerup", (e) => {
    endDrag(e);
    if (!downAt) return;
    // A drag that happens to end on a node pans the canvas; it doesn't select.
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 4) return;

    const hit = pick(e.clientX, e.clientY);
    if (!hit) {
      if (!e.shiftKey) setSelection(new Set());
      return;
    }
    const id = hit.userData.ref.id;
    const next = e.shiftKey ? new Set(selection) : new Set();
    if (e.shiftKey && selection.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (dragging) {
      const before = worldAt(lastClient.x, lastClient.y);
      const after = worldAt(e.clientX, e.clientY);
      center.x += before.x - after.x;
      center.y += before.y - after.y;
      clampCenter();
      applyCamera();
      lastClient = { x: e.clientX, y: e.clientY };
      nodeLabel.classList.remove("visible");
      return;
    }
    const hit = pick(e.clientX, e.clientY);
    if (hit) {
      const ref = hit.userData.ref;
      nodeLabelTitle.textContent = ref.title;
      nodeLabelMeta.textContent =
        `L ${Math.round(ref.lightness * 100)} · C ${Math.round(ref.chroma)} · h ${Math.round(ref.hue)}°`;
      nodeLabel.classList.add("visible");
      canvas.style.cursor = "pointer";
    } else {
      nodeLabel.classList.remove("visible");
      canvas.style.cursor = "";
    }
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.0015);
      const target = Math.min(Math.max(viewHeight * factor, MIN_VIEW_HEIGHT), maxViewHeight);
      if (target === viewHeight) return;

      // Zoom about the cursor: whatever is under it stays under it.
      const before = worldAt(e.clientX, e.clientY);
      viewHeight = target;
      applyCamera();
      const after = worldAt(e.clientX, e.clientY);
      center.x += before.x - after.x;
      center.y += before.y - after.y;
      clampCenter();
      applyCamera();
    },
    { passive: false }
  );

  const raycaster = new THREE.Raycaster();
  function pick(clientX, clientY) {
    const { width, height } = viewport();
    raycaster.setFromCamera(
      new THREE.Vector2((clientX / width) * 2 - 1, -(clientY / height) * 2 + 1), camera
    );
    return raycaster.intersectObjects(pickables)[0]?.object || null;
  }

  window.addEventListener("resize", () => {
    const { width, height } = viewport();
    renderer.setSize(width, height);
    viewHeight = Math.min(viewHeight, Math.max(fitHeight(), MIN_VIEW_HEIGHT));
    clampCenter();
    applyCamera();
  });

  // --- Reveal: thumbnails fade in where their dots are, guides fade in with
  // them, all of it starting from the frame the 3D view handed over. ---
  let guideAlpha = 0;
  let lastFrameTime = performance.now();
  let firstRenderDone = false;

  function startThumbnail(entry) {
    entry.load = "loading";
    new THREE.TextureLoader().load(
      `/media/${entry.ref.id}/thumb`,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        const size = selection.has(entry.ref.id) ? SELECTED_THUMB_SIZE : THUMB_SIZE;
        const thumb = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0, depthWrite: false })
        );
        thumb.position.set(entry.x, entry.y, 0);
        thumb.scale.set(size, size, 1);
        thumb.userData = { ref: entry.ref };
        scene.add(thumb);
        pickables.push(thumb);
        entry.thumb = thumb;
        entry.load = "ready";
      },
      undefined,
      () => {
        // A reference with no thumbnail keeps its dot as the final state.
        entry.load = "failed";
      }
    );
  }

  setInterval(revealPass, THUMB_LOAD_INTERVAL_MS);
  revealPass();

  function revealPass() {
    const halfHeight = (viewHeight / 2) * THUMB_LOAD_MARGIN;
    const halfWidth = halfHeight * viewport().aspect;
    let budget = THUMB_LOAD_BUDGET;
    for (const entry of entries) {
      if (budget === 0) break;
      if (entry.load !== "none") continue;
      if (Math.abs(entry.x - center.x) > halfWidth || Math.abs(entry.y - center.y) > halfHeight) continue;
      startThumbnail(entry);
      budget--;
    }
  }

  function updateFades(now) {
    const elapsed = Math.min(100, now - lastFrameTime);
    lastFrameTime = now;

    const step = 1 - Math.exp(-elapsed / THUMB_FADE_TAU_MS);
    for (const entry of entries) {
      const emphasis = entry.emphasis ?? 1;
      const target = entry.load === "ready" ? 1 : 0;
      if (entry.alpha !== target) {
        entry.alpha += (target - entry.alpha) * step;
        if (Math.abs(target - entry.alpha) < 0.002) entry.alpha = target;
      }
      if (entry.thumb) {
        entry.thumb.material.opacity = entry.alpha * emphasis;
        entry.thumb.visible = entry.alpha > 0;
      }
      entry.dot.material.opacity = (1 - entry.alpha) * emphasis;
      entry.dot.visible = entry.alpha < 1;
    }

    if (guideAlpha < 1) {
      const guideStep = 1 - Math.exp(-elapsed / GUIDE_FADE_TAU_MS);
      guideAlpha += (1 - guideAlpha) * guideStep;
      if (1 - guideAlpha < 0.002) guideAlpha = 1;
      guides.forEach(({ object, opacity }) => (object.material.opacity = opacity * guideAlpha));
      relationLines.material.opacity = RELATION_OPACITY * guideAlpha;
    }
  }

  applyEmphasis();
  panel.setSelection(selection, nodesById);

  animate();

  function animate() {
    requestAnimationFrame(animate);
    updateFades(performance.now());
    renderer.render(scene, camera);

    // The still from the 3D page comes down only once there's a real frame
    // behind it to replace it with.
    if (!firstRenderDone) {
      firstRenderDone = true;
      dismissBridge();
      panelEl.classList.add("ready");
    }
  }
}
