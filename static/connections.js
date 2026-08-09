/* Archive Connections: the same graph as /graph.html, folded flat.
 *
 * Every reference in the library sits on an infinite canvas you pan and zoom
 * around, laid out exactly as the 3D stack looks once its panes are unfolded
 * side by side and viewed head-on. Arriving here from the 3D page's "Back to
 * library" link, the scene resumes the framing that page ended on, so the
 * two views read as one continuous move rather than a page change.
 */
import * as THREE from "three";
import {
  CROSS_THREAD_OPACITY,
  HANDOFF_IMAGE_KEY,
  HANDOFF_KEY,
  INTRA_THREAD_OPACITY,
  PLANE_SIZE,
  TAG_LABEL_OFFSET,
  TAG_LINE_OPACITY,
  THUMB_SIZE,
  bounds,
  currentTheme,
  dotTexture,
  makeEdgeGroup,
  makeNodeSprite,
  makePlane,
  makeTagSprite,
  planeOffsets2d,
  setupEnvironment,
  tagAngle,
  updateEdgeGroup,
} from "./graph-common.js";

const CAMERA_DISTANCE = 300; // arbitrary for an orthographic camera: only the frustum size matters
const MIN_VIEW_HEIGHT = 2.5; // closest zoom -- a couple of thumbnails across
const FIT_MARGIN = 1.08; // furthest zoom leaves a little air around the whole layout
const VISIBLE_MARGIN = 0.9; // a reference held in view sits inside the edge, not on it

// Time constants, not durations: each fade closes the remaining gap at this
// rate, so a toggle can reverse one mid-flight without a jump.
const THUMB_FADE_TAU_MS = 260;
const TAG_FADE_TAU_MS = 500;
const THUMB_LOAD_INTERVAL_MS = 120;
const THUMB_LOAD_BUDGET = 4; // new thumbnails started per check, so panning doesn't fire off a request storm
const THUMB_LOAD_MARGIN = 1.3; // start loading a little beyond the visible edge

const loadState = document.getElementById("load-state");
const errorState = document.getElementById("error-state");
const errorText = document.getElementById("error-text");
const statusLine = document.getElementById("status-line");
const nodeLabel = document.getElementById("node-label");
const nodeLabelTitle = document.getElementById("node-label-title");
const nodeLabelMeta = document.getElementById("node-label-meta");
const bridge = document.getElementById("bridge");

init();

async function init() {
  // The handoff is consumed on arrival: a later direct visit to this page
  // should frame the whole layout, not resume a stale camera.
  let handoff = null;
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (raw) handoff = JSON.parse(raw);
    sessionStorage.removeItem(HANDOFF_KEY);
    sessionStorage.removeItem(HANDOFF_IMAGE_KEY);
  } catch (err) {
    handoff = null;
  }

  let data = handoff && handoff.data;
  if (!data) {
    loadState.style.display = "flex";
    try {
      const res = await fetch("/api/similarity/graph");
      data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load graph data.");
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
    errorText.textContent = "Not enough references yet to build a graph.";
    dismissBridge();
    return;
  }

  loadState.style.display = "none";
  statusLine.textContent =
    `${data.nodes.length} references · ${data.cluster_count} clusters · ${data.edges.length} threads`;

  buildScene(data, handoff);
}

/* Browsers can fire a resize with a zero-sized window (a hidden tab, a pane
 * mid-layout). Reading the viewport through here means an aspect ratio is
 * never 0/0 -- one NaN reaching the camera would otherwise stick, since the
 * zoom clamp carries the previous value forward and NaN survives every
 * Math.min/max it touches. */
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

function buildScene(data, handoff) {
  const container = document.getElementById("scene");
  const theme = currentTheme();
  const dotTex = dotTexture(theme.dot);
  const hubTex = dotTexture(theme.hub);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.background);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(viewport().width, viewport().height);
  container.appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  setupEnvironment(scene, renderer);

  // Everything lies on z = 0. The camera sits on the negative side looking
  // back toward it -- the same side the 3D opening shot views the stack from,
  // which is what keeps the handoff frame identical rather than mirrored.
  const offsets = planeOffsets2d(data.planes);
  const offsetOf = (cluster) => offsets.get(cluster) || { x: 0, y: 0 };
  const nodePosition = (n) => {
    const off = offsetOf(n.cluster);
    return [n.x + off.x, n.y + off.y, 0];
  };

  // Objects are added in the same order as the 3D scene: with everything
  // transparent and coplanar, draw order is what settles the ties, so a
  // different order here would subtly change the picture.
  data.planes.forEach((p) => {
    const { mesh, rim, glow } = makePlane(p, theme.planeTint, theme.planeTintAmount);
    const off = offsetOf(p.cluster);
    [mesh, rim, glow].forEach((obj) => obj.position.set(off.x, off.y, 0));
    scene.add(mesh);
    scene.add(rim);
    scene.add(glow);
  });

  // Each node is a dot now and a thumbnail later: the thumbnail arrives as a
  // second sprite in the same spot so the two can cross-fade, rather than the
  // dot's texture being swapped out from under it.
  const nodeEntries = [];
  const pickables = [];
  data.nodes.forEach((n) => {
    const sprite = makeNodeSprite(n, dotTex, hubTex);
    const [x, y, z] = nodePosition(n);
    sprite.position.set(x, y, z);
    sprite.userData = { ref: n };
    scene.add(sprite);
    pickables.push(sprite);
    // `alpha` is how far this node has crossed from dot to thumbnail. It eases
    // toward whatever the Images toggle asks for, so the reveal runs backwards
    // just as happily as forwards.
    nodeEntries.push({ ref: n, dot: sprite, x, y, thumb: null, load: "none", alpha: 0 });
  });

  const tagSprites = [];
  const tagLineDefs = [];
  data.nodes.forEach((n) => {
    const [nx, ny] = nodePosition(n);
    (n.tags || []).forEach((tag, idx) => {
      const sprite = makeTagSprite(tag, theme.tagLabel);
      const angle = tagAngle(idx);
      const lx = nx + Math.cos(angle) * TAG_LABEL_OFFSET;
      const ly = ny + Math.sin(angle) * TAG_LABEL_OFFSET;
      sprite.position.set(lx, ly, 0);
      scene.add(sprite);
      tagSprites.push(sprite);
      tagLineDefs.push({ x1: nx, y1: ny, x2: lx, y2: ly });
    });
  });

  const tagLineGeometry = new THREE.BufferGeometry();
  const tagLinePositions = new Float32Array(tagLineDefs.length * 6);
  tagLineDefs.forEach((d, i) => {
    tagLinePositions.set([d.x1, d.y1, 0, d.x2, d.y2, 0], i * 6);
  });
  tagLineGeometry.setAttribute("position", new THREE.BufferAttribute(tagLinePositions, 3));
  const tagLineMesh = new THREE.LineSegments(
    tagLineGeometry,
    new THREE.LineBasicMaterial({
      color: theme.tagLine, transparent: true, opacity: TAG_LINE_OPACITY, depthWrite: false,
    })
  );
  scene.add(tagLineMesh);

  const threadGroups = [
    makeEdgeGroup(scene, data.edges.filter((e) => !e.cross_cluster), data.nodes, INTRA_THREAD_OPACITY, theme.thread),
    makeEdgeGroup(scene, data.edges.filter((e) => e.cross_cluster), data.nodes, CROSS_THREAD_OPACITY, theme.thread),
  ].filter(Boolean);
  threadGroups.forEach((g) => updateEdgeGroup(g, nodePosition));

  // --- Camera and the limits of the canvas ---

  // Panning is clamped to the references' own bounding box, so the middle of
  // the screen is always somewhere among them -- the canvas is free to move
  // around but can never be scrolled off into blank space.
  const nodePoints = data.nodes.map((n) => {
    const [x, y] = nodePosition(n);
    return { x, y };
  });
  const nodeBounds = bounds(data.nodes.map(nodePosition));
  // Zooming out stops once the panes themselves are all on screen.
  const paneBounds = bounds(
    data.planes.map((p) => {
      const off = offsetOf(p.cluster);
      return [off.x, off.y, 0];
    })
  );
  const layoutWidth = paneBounds.maxX - paneBounds.minX + PLANE_SIZE;
  const layoutHeight = paneBounds.maxY - paneBounds.minY + PLANE_SIZE;

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, CAMERA_DISTANCE * 2);
  const center = new THREE.Vector2();
  let viewHeight;

  if (handoff) {
    center.set(handoff.centerX, handoff.centerY);
    viewHeight = handoff.viewHeight;
  } else {
    center.set((nodeBounds.minX + nodeBounds.maxX) / 2, (nodeBounds.minY + nodeBounds.maxY) / 2);
    viewHeight = fitHeight();
  }
  // Never clamp the framing handed over by the 3D view -- that would show up
  // as a jump on the first frame, which is the one thing this has to avoid.
  const maxViewHeight = Math.max(fitHeight(), viewHeight);

  function fitHeight() {
    return Math.max(layoutHeight, layoutWidth / viewport().aspect) * FIT_MARGIN;
  }

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

  /* The canvas is free to move, but never far enough to end up looking at
   * nothing. Staying inside the references' bounding box isn't enough on its
   * own -- zoomed in, the gap between two panes sits well inside that box --
   * so if the view has drifted off every reference, it gets pulled back just
   * far enough for the nearest one to come back on screen. */
  function keepAReferenceInView() {
    const halfHeight = (viewHeight / 2) * VISIBLE_MARGIN;
    const halfWidth = halfHeight * viewport().aspect;

    let nearest = null;
    let nearestDistance = Infinity;
    for (const p of nodePoints) {
      const dx = Math.abs(p.x - center.x);
      const dy = Math.abs(p.y - center.y);
      if (dx <= halfWidth && dy <= halfHeight) return; // something is already in frame
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

  // Screen -> world through the camera itself rather than by hand: the view
  // looks along +z, which mirrors the x axis, and unprojecting keeps every
  // pan and zoom on the right side of that without sign-juggling.
  const worldAt = (clientX, clientY) => {
    const { width, height } = viewport();
    return new THREE.Vector3((clientX / width) * 2 - 1, -(clientY / height) * 2 + 1, 0).unproject(camera);
  };

  let dragging = false;
  let dragPointer = null;
  let lastClient = { x: 0, y: 0 };

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    dragPointer = e.pointerId;
    lastClient = { x: e.clientX, y: e.clientY };
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
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

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
    updateHover(e.clientX, e.clientY);
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
  function updateHover(clientX, clientY) {
    const { width, height } = viewport();
    raycaster.setFromCamera(new THREE.Vector2((clientX / width) * 2 - 1, -(clientY / height) * 2 + 1), camera);
    const hit = raycaster.intersectObjects(pickables)[0];
    if (hit) {
      const ref = hit.object.userData.ref;
      nodeLabelTitle.textContent = ref.title;
      nodeLabelMeta.textContent = `${ref.type}${ref.is_own_work ? " · own work" : ""}`;
      nodeLabel.classList.add("visible");
    } else {
      nodeLabel.classList.remove("visible");
    }
  }

  window.addEventListener("resize", () => {
    const { width, height } = viewport();
    renderer.setSize(width, height);
    viewHeight = Math.min(viewHeight, Math.max(fitHeight(), MIN_VIEW_HEIGHT));
    clampCenter();
    applyCamera();
  });

  // --- Reveal: thumbnails fade in where their dots are, and the floating tag
  // text fades away as they arrive. Both layers are also under the user's
  // control from the toggles at the top of the page. ---
  const imagesToggle = document.getElementById("toggle-images");
  const textToggle = document.getElementById("toggle-text");
  let showImages = imagesToggle.checked;
  let showText = textToggle.checked;
  // Text starts on because that's what the 3D view hands over, then steps
  // aside for the thumbnails -- unless the user has already said otherwise,
  // in which case their choice stands.
  let textChosenByUser = false;
  let textAlpha = 1;
  let lastFrameTime = performance.now();
  let firstRenderDone = false;

  imagesToggle.addEventListener("change", () => {
    showImages = imagesToggle.checked;
    if (showImages) revealPass();
  });

  textToggle.addEventListener("change", () => {
    showText = textToggle.checked;
    textChosenByUser = true;
  });

  function startThumbnail(entry) {
    entry.load = "loading";
    new THREE.TextureLoader().load(
      `/media/${entry.ref.id}/thumb`,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        const thumb = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0, depthWrite: false })
        );
        thumb.position.set(entry.x, entry.y, 0);
        thumb.scale.set(THUMB_SIZE, THUMB_SIZE, 1);
        thumb.userData = { ref: entry.ref };
        scene.add(thumb);
        pickables.push(thumb);
        entry.thumb = thumb;
        entry.load = "ready";

        if (!textChosenByUser && showText) {
          showText = false;
          textToggle.checked = false;
        }
      },
      undefined,
      () => {
        // Text references have no /thumb -- their dot is the final state.
        entry.load = "failed";
      }
    );
  }

  // Paced on a timer rather than a frame count: the reveal shouldn't run at
  // whatever rate the GPU happens to manage, and a backgrounded tab (where
  // requestAnimationFrame all but stops) shouldn't leave the page half
  // revealed when the user comes back to it.
  setInterval(revealPass, THUMB_LOAD_INTERVAL_MS);
  revealPass();

  function revealPass() {
    const halfHeight = (viewHeight / 2) * THUMB_LOAD_MARGIN;
    const halfWidth = halfHeight * viewport().aspect;
    let budget = THUMB_LOAD_BUDGET;

    if (!showImages) return; // nothing to show them in -- don't spend the requests

    for (const entry of nodeEntries) {
      if (budget === 0) break;
      if (entry.load !== "none") continue;
      if (Math.abs(entry.x - center.x) > halfWidth || Math.abs(entry.y - center.y) > halfHeight) continue;
      startThumbnail(entry);
      budget--;
    }
  }

  /* Both layers ease toward whatever the toggles currently ask for, framed as
   * a rate rather than a fixed timeline so a toggle flipped mid-fade simply
   * turns the fade around instead of restarting it. */
  function updateFades(now) {
    const elapsed = Math.min(100, now - lastFrameTime); // a backgrounded tab shouldn't jump on return
    lastFrameTime = now;

    const imageStep = 1 - Math.exp(-elapsed / THUMB_FADE_TAU_MS);
    for (const entry of nodeEntries) {
      const target = showImages && entry.load === "ready" ? 1 : 0;
      if (entry.alpha === target) continue;

      entry.alpha += (target - entry.alpha) * imageStep;
      if (Math.abs(target - entry.alpha) < 0.002) entry.alpha = target;

      if (entry.thumb) {
        entry.thumb.material.opacity = entry.alpha;
        entry.thumb.visible = entry.alpha > 0;
      }
      entry.dot.material.opacity = 1 - entry.alpha;
      entry.dot.visible = entry.alpha < 1;
    }

    const textTarget = showText ? 1 : 0;
    if (textAlpha !== textTarget) {
      const textStep = 1 - Math.exp(-elapsed / TAG_FADE_TAU_MS);
      textAlpha += (textTarget - textAlpha) * textStep;
      if (Math.abs(textTarget - textAlpha) < 0.002) textAlpha = textTarget;

      tagSprites.forEach((s) => {
        s.material.opacity = textAlpha;
        s.visible = textAlpha > 0;
      });
      tagLineMesh.material.opacity = TAG_LINE_OPACITY * textAlpha;
      tagLineMesh.visible = textAlpha > 0;
    }
  }

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
    }
  }
}
