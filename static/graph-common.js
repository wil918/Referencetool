/* Shared look-and-feel for the two graph views: the 3D similarity graph
 * (/graph.html) and the flat Archive Connections canvas it folds down into
 * (/connections.html).
 *
 * Both pages import everything visual from here on purpose. The transition
 * between them works by the second page picking up exactly where the first
 * one left off, so any size, colour or material that lived in only one of
 * them would show up as a visible jump at the moment of the handoff.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export const DOT_SIZE = 0.16;
export const HUB_DOT_SIZE = 0.23;
export const THUMB_SIZE = 1.3;

/* The lens every 3D view of the archive is seen through -- the full-page
 * graph's opening shot, and the embedded scene host (shared/scene-host.js)
 * that project widgets render into. Here rather than in either of them so an
 * embedded scene is recognisably the same picture as the full-page one, at a
 * different size. `far` is generous because the full-page fold dollies a long
 * way back as the field of view narrows toward orthographic. */
export const FIELD_OF_VIEW = 50;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 2000;

// Nodes swap from a plain dot to a loaded thumbnail once the camera gets
// this close (world units) -- so zoomed out shows only the thread/dot
// structure, and thumbnails reveal themselves as you move in on a cluster.
export const THUMBNAIL_DISTANCE = 9;

// New thumbnails started per check in Colour mode, where every node loads one
// regardless of distance -- the same budgeting the flat Connections view uses
// to keep panning from firing off a request storm.
export const COLOUR_THUMB_BUDGET = 6;

export const PLANE_SIZE = 16;
export const PLANE_THICKNESS = 0.35;
export const PLANE_GAP_2D = 3; // breathing room between panes once they lie side by side

export const TAG_LABEL_HEIGHT = 0.34;
export const TAG_LABEL_OFFSET = 0.55;
export const TAG_LINE_OPACITY = 0.35;

/* The WebGL scene has its own palette, separate from the page's CSS custom
 * properties -- canvas content doesn't inherit those. Kept here rather than
 * read from getComputedStyle() so the two stay obviously in step by eye, the
 * same way the CSS copies in graph.html / connections.html do.
 *
 * Dot/hub/thread colours (not just the background) have to flip with the
 * theme: the light-mode dot is a near-black brown, which would simply
 * disappear against a dark background. The plane tint also switches its lerp
 * target from white to the dark background itself, so panes read as tinted
 * glass rather than bright plates floating in a dark room. */
export const THEMES = {
  light: {
    background: 0xeff2f9,
    dot: "#3a3733",
    hub: "#8a3f34",
    thread: 0xc23b2e,
    tagLabel: "rgba(58, 55, 51, 0.85)",
    tagLine: 0x9c968c,
    planeTint: 0xffffff,
    planeTintAmount: 0.55,
  },
  dark: {
    background: 0x262b31,
    dot: "#d7dde3",
    hub: "#e2705c",
    thread: 0xe0483a,
    tagLabel: "rgba(223, 228, 233, 0.85)",
    tagLine: 0x6b7280,
    planeTint: 0x262b31,
    planeTintAmount: 0.4,
  },
};

export function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? THEMES.dark : THEMES.light;
}

export const INTRA_THREAD_OPACITY = 0.45;
export const CROSS_THREAD_OPACITY = 0.22;

// How far a node recedes once something else has been singled out -- the
// colour map's selection and the similarity map's, which have to agree or the
// same gesture would read as a different strength of answer in each.
export const DIMMED_OPACITY = 0.22;

// What the 3D page hands to the flat page through sessionStorage: the camera
// framing to resume from, the graph data (so the flat page can draw its first
// frame without waiting on a fetch), and a still of the last 3D frame to hold
// on screen until WebGL has drawn the identical one underneath it.
export const HANDOFF_KEY = "archive-connections-handoff";
export const HANDOFF_IMAGE_KEY = "archive-connections-bridge";

export function rgbToThreeColor([r, g, b]) {
  return new THREE.Color(r / 255, g / 255, b / 255);
}

export function dotTexture(color) {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.7, color);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // One texture behind every dot in the view -- belongs to whoever made it,
  // not to any one sprite. See disposeSubtree.
  texture.userData.shared = true;
  return texture;
}

/* A hollow ring, drawn behind a node to mark it as selected. A sprite rather
 * than geometry so it always faces the camera and stays legible from any
 * orbit angle, exactly like the dots and thumbnails it sits behind. */
export function ringTexture(color, lineWidth = 5) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - lineWidth, 0, Math.PI * 2);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.userData.shared = true; // one ring texture behind every node's ring
  return texture;
}

// Keyed on colour as well as text: the two themes need different textures
// for the same tag, so a switch doesn't keep serving the stale one. Cached
// across every view on the page, which is why the entries are marked shared
// below -- see disposeSubtree.
const tagTextureCache = new Map();
export function tagTexture(text, color) {
  const key = `${color}::${text}`;
  if (tagTextureCache.has(key)) return tagTextureCache.get(key);

  const fontSize = 30;
  const font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const measuring = document.createElement("canvas").getContext("2d");
  measuring.font = font;
  const textWidth = measuring.measureText(text).width;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(textWidth) + 20;
  canvas.height = fontSize + 14;
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 10, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.userData.shared = true;
  const entry = { texture, aspect: canvas.width / canvas.height };
  tagTextureCache.set(key, entry);
  return entry;
}

// Golden angle -- spreads a node's labels around it without a fixed pattern.
export function tagAngle(index) {
  return index * 2.399963;
}

/* Returns the environment map it installed, so a scene that doesn't live for
 * the lifetime of the page (a widget's) can release it again -- unlike the
 * lights, which own no GPU memory. The generator itself is disposed here and
 * now: it only owns the scratch targets used to build the map, never the map
 * it returns. */
export function setupEnvironment(scene, renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = environment;

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
  keyLight.position.set(6, 10, 8);
  scene.add(keyLight);
  return environment;
}

let sharedPlaneGeo = null;
let sharedPlaneEdgeGeo = null;
function planeGeometries() {
  if (!sharedPlaneGeo) {
    sharedPlaneGeo = new THREE.BoxGeometry(PLANE_SIZE, PLANE_SIZE, PLANE_THICKNESS);
    sharedPlaneEdgeGeo = new THREE.EdgesGeometry(sharedPlaneGeo);
    // One pair for every plane in every view on the page -- see disposeSubtree.
    sharedPlaneGeo.userData.shared = true;
    sharedPlaneEdgeGeo.userData.shared = true;
  }
  return { geo: sharedPlaneGeo, edgeGeo: sharedPlaneEdgeGeo };
}

/* Release everything a subtree of the scene graph owns on the GPU, and detach
 * it from its parent.
 *
 * Several project widgets can be on screen at once, each with its own scene,
 * and a removed widget has to give its memory back. What it may not free is
 * anything it merely *references*: `userData.shared` marks a resource that
 * belongs to something outside this subtree -- the plane geometries and tag
 * label textures cached once for the whole page, and the dot and ring
 * textures a view creates and hands to every one of its sprites. Those are
 * the creator's to dispose, once, when the view itself goes. Sprite geometry
 * is skipped for the same reason: every Sprite on the page shares one
 * module-level geometry inside three.js.
 *
 * What is left -- per-object line geometries, every material, and the
 * thumbnails loaded onto individual nodes -- is genuinely this subtree's.
 */
export function disposeSubtree(root) {
  root.traverse((object) => {
    if (object.geometry && !object.isSprite && !object.geometry.userData.shared) {
      object.geometry.dispose();
    }
    const materials = Array.isArray(object.material)
      ? object.material
      : object.material ? [object.material] : [];
    for (const material of materials) {
      if (material.map && !material.map.userData.shared) material.map.dispose();
      material.dispose();
    }
  });
  root.parent?.remove(root);
}

/* Swap a node's dot for its own thumbnail.
 *
 * Shared by the full-page graph and the project widgets so a reference looks
 * the same in both. `onLoaded` is for a caller that sizes sprites itself (the
 * colour map draws a selected node larger, so it has to re-apply its
 * emphasis once the texture arrives and the sprite grows).
 *
 * A view torn down mid-flight marks its sprites "gone" (each map module's
 * dispose does this), which is what stops a late arrival from resurrecting a
 * texture on a sprite whose scene no longer exists.
 */
export function loadThumbnail(sprite, onLoaded) {
  const ref = sprite.userData.ref;
  sprite.userData.thumbState = "loading";
  new THREE.TextureLoader().load(
    `/media/${ref.id}/thumb`,
    (texture) => {
      if (sprite.userData.thumbState !== "loading") {
        texture.dispose();
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      sprite.material.map = texture;
      sprite.material.needsUpdate = true;
      const size = sprite.userData.baseSize || THUMB_SIZE;
      sprite.scale.set(size, size, 1);
      sprite.userData.thumbState = "loaded";
      onLoaded?.(sprite);
    },
    undefined,
    () => {
      // Text/PDF references have no /thumb -- leave the dot as-is.
      if (sprite.userData.thumbState === "loading") sprite.userData.thumbState = "failed";
    }
  );
}

export function revertToDot(sprite, dotTex, hubTex) {
  const ref = sprite.userData.ref;
  // The thumbnail it was showing is this view's own, loaded for this sprite
  // and referenced by nothing else once it is off the material.
  if (sprite.material.map !== dotTex && sprite.material.map !== hubTex) {
    sprite.material.map?.dispose();
  }
  sprite.material.map = ref.is_hub ? hubTex : dotTex;
  sprite.material.needsUpdate = true;
  const size = ref.is_hub ? HUB_DOT_SIZE : DOT_SIZE;
  sprite.scale.set(size, size, 1);
  sprite.userData.thumbState = "none";
}

/* One translucent glass sheet for a cluster, tinted by the average colour of
 * that cluster's own images, with a rim blending the average and the most
 * common colour together. Real physical transmission, plus a slightly larger
 * fainter copy of the rim to fake a soft blur (WebGL mostly ignores
 * LineBasicMaterial.linewidth, so a glow needs a second pass, not a thicker
 * line). Returned unpositioned -- the caller places it. */
export function makePlane(plane, tintColor, tintAmount) {
  const { geo, edgeGeo } = planeGeometries();

  const faceColor = rgbToThreeColor(plane.face_color).lerp(new THREE.Color(tintColor), tintAmount);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshPhysicalMaterial({
      color: faceColor,
      transmission: 0.92,
      thickness: PLANE_THICKNESS,
      ior: 1.45,
      roughness: 0.14,
      clearcoat: 0.35,
      clearcoatRoughness: 0.3,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );

  const edgeColor = rgbToThreeColor(plane.edge_color);
  const rim = new THREE.LineSegments(
    edgeGeo,
    new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.6, depthWrite: false })
  );
  const glow = new THREE.LineSegments(
    edgeGeo,
    new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.22, depthWrite: false })
  );
  glow.scale.set(1.035, 1.035, 1.6);

  return { mesh, rim, glow };
}

export function makeNodeSprite(node, dotTex, hubTex) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: node.is_hub ? hubTex : dotTex, transparent: true, depthWrite: false })
  );
  const size = node.is_hub ? HUB_DOT_SIZE : DOT_SIZE;
  sprite.scale.set(size, size, 1);
  return sprite;
}

export function makeTagSprite(tag, color) {
  const { texture, aspect } = tagTexture(tag, color);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
  );
  sprite.scale.set(TAG_LABEL_HEIGHT * aspect, TAG_LABEL_HEIGHT, 1);
  return sprite;
}

/* Where each cluster's pane sits once the stack is folded flat.
 *
 * Ordered front-to-back by the depth they had in 3D, so the pane the opening
 * shot looks at keeps offset (0, 0) -- it never moves during the fold, which
 * is what lets the camera hold its framing while the others fan out from
 * behind it. Offsets go negative because the flat view is seen from the same
 * side as that opening shot (camera on -z looking toward +z), which mirrors
 * the x axis: negative world x reads as left-to-right on screen. */
export function planeOffsets2d(planes) {
  const ordered = planes.slice().sort((a, b) => a.z - b.z);
  const columns = Math.ceil(Math.sqrt(ordered.length));
  const spacing = PLANE_SIZE + PLANE_GAP_2D;

  const offsets = new Map();
  ordered.forEach((plane, i) => {
    offsets.set(plane.cluster, {
      x: -(i % columns) * spacing,
      y: -Math.floor(i / columns) * spacing,
    });
  });
  return offsets;
}

/* Builds one LineSegments covering a whole group of edges, plus enough
 * bookkeeping (each edge's two endpoint node records) for updateEdgeGroup()
 * to fill in the actual vertex positions afterward.
 *
 * `parent` is any Object3D: the flat page adds these straight to its scene,
 * while the similarity map puts them in its own group so the whole layout can
 * be shown, hidden and disposed as one thing. */
export function makeEdgeGroup(parent, edges, nodes, opacity, color) {
  if (!edges.length) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const defs = edges.map((e) => ({ a: byId.get(e.source), b: byId.get(e.target) })).filter((d) => d.a && d.b);
  if (!defs.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(defs.length * 6), 3));
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const mesh = new THREE.LineSegments(geometry, material);
  parent.add(mesh);
  return { geometry, defs, mesh };
}

/* `positionOf(nodeRecord)` returns the node's current [x, y, z]. Passed in
 * rather than read off the record so the same geometry can follow the panes
 * while they move (the 3D fold) or sit at a fixed flat offset (the 2D view). */
export function updateEdgeGroup(group, positionOf) {
  const positions = group.geometry.attributes.position.array;
  group.defs.forEach((d, i) => {
    const [ax, ay, az] = positionOf(d.a);
    const [bx, by, bz] = positionOf(d.b);
    positions.set([ax, ay, az, bx, by, bz], i * 6);
  });
  group.geometry.attributes.position.needsUpdate = true;
}

/* Where a Colour-mode node ends up once the cylinder has folded flat.
 *
 * The fold is a quarter turn of the map about the x axis, which sends
 * (x, y, z) to (x, z, -y) -- so the flat view is the cylinder's footprint:
 * hue still the angle, chroma still the radius, lightness spent.
 *
 * The depth that quarter turn produces is then collapsed to zero over the
 * same move, leaving every reference coplanar. That last part is what makes
 * the handoff exact rather than nearly exact: the fold ends on a very narrow
 * field of view but still a perspective one, so references at different
 * depths would be scaled by up to 3.7% against the flat page's genuinely
 * orthographic camera -- plainly visible on a thumbnail. With nothing left to
 * separate in depth there is no perspective left to disagree about.
 *
 * Lightness rather than chroma is the axis given up because of what this
 * archive is: most of it is near-neutral, and a neutral's hue angle is noise.
 * Unrolling the cylinder into a hue strip would scatter those references
 * across the full width on the strength of that noise. Keeping the disc holds
 * them where they belong instead -- together, at the middle.
 *
 * Both the fold and the flat page read positions from here so there is one
 * definition of where a reference sits, not two that have to be kept in step.
 */
export function colourFlatPosition(node) {
  return [node.x, node.z, 0];
}

// Air left around the disc when the flat view frames the whole thing.
export const COLOUR_FLAT_MARGIN = 1.08;

export function bounds(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  points.forEach(([x, y]) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  });
  return { minX, maxX, minY, maxY };
}

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
