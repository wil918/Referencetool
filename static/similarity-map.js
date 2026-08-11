/* The similarity graph as objects: one translucent plane per cluster, a
 * billboard per reference, floating tag captions, and the threads between
 * them.
 *
 * A layout, not a page. Everything here builds into a scene handed in from
 * outside -- /graph.js owns a full-window renderer with a scripted intro and
 * a fold into the flat Connections view, while a project widget owns a small
 * one sized to its box (shared/scene-host.js) -- and this module knows about
 * neither. It is the same relationship colour-map.js already has with the
 * Colour mode of that page, and the two are deliberately the same shape.
 *
 * Positions come from graph_layout.build_graph(); nothing here decides where
 * a reference belongs. Everything visual comes from graph-common.js, so an
 * embedded graph and the full-page one are the same picture at two sizes.
 */
import * as THREE from "three";
import {
  CROSS_THREAD_OPACITY,
  DIMMED_OPACITY,
  INTRA_THREAD_OPACITY,
  PLANE_SIZE,
  TAG_LABEL_OFFSET,
  TAG_LINE_OPACITY,
  disposeSubtree,
  makeEdgeGroup,
  makeNodeSprite,
  makePlane,
  makeTagSprite,
  planeOffsets2d,
  ringTexture,
  tagAngle,
  updateEdgeGroup,
} from "./graph-common.js";

const RING_SIZE = 0.5; // floor for the ring around a node still drawn as a dot
const RELATION_OPACITY = 0.55;

export function createSimilarityMap(scene, theme) {
  const group = new THREE.Group();
  scene.add(group);

  const ringTex = ringTexture(theme.hub);

  let data = null;
  let planeObjects = [];
  let nodesById = new Map(); // id -> sprite
  let tagSprites = [];
  let tagLineDefs = [];
  let tagLineMesh = null;
  let tagLineGeometry = null;
  let threadGroups = [];
  let adjacency = new Map(); // id -> Map(otherId -> score), from the drawn edges
  let selection = new Set();
  let lit = new Set(); // the current selection's neighbours, by combined score
  // Worked out once per layout rather than per frame of the fold, which runs
  // this at sixty frames a second for two and a half seconds.
  let flatOffsets = null;
  let extent = { zFirst: 0, zLast: 0, span: 1, boundingSize: PLANE_SIZE };

  // Where each cluster's pane currently is. Both stay put for the whole 3D
  // view and only move during the fold into the flat layout.
  const clusterZ = {};
  const clusterOffset = {};

  // Lines from each selected node to the group's centre of gravity -- the
  // same device colour-map.js uses, and for the same reason: several picks
  // have to read as one group being asked about, not as several separate
  // questions.
  const relationGeometry = new THREE.BufferGeometry();
  relationGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  const relationLines = new THREE.LineSegments(
    relationGeometry,
    new THREE.LineBasicMaterial({
      color: theme.thread, transparent: true, opacity: RELATION_OPACITY, depthWrite: false,
    })
  );
  group.add(relationLines);

  const nodeWorldPosition = (n) => {
    const off = clusterOffset[n.cluster];
    return [n.x + off.x, n.y + off.y, clusterZ[n.cluster]];
  };

  function updateTagLines() {
    const positions = tagLineGeometry.attributes.position.array;
    tagLineDefs.forEach((d, i) => {
      const z = clusterZ[d.cluster];
      const off = clusterOffset[d.cluster];
      positions.set([d.x1 + off.x, d.y1 + off.y, z, d.x2 + off.x, d.y2 + off.y, z], i * 6);
    });
    tagLineGeometry.attributes.position.needsUpdate = true;
  }

  function applyClusterLayout() {
    planeObjects.forEach((p) => {
      const z = clusterZ[p.cluster];
      const off = clusterOffset[p.cluster];
      [p.mesh, p.rim, p.glow].forEach((obj) => obj.position.set(off.x, off.y, z));
    });
    nodesById.forEach((sprite) => {
      const [x, y, z] = nodeWorldPosition(sprite.userData.ref);
      sprite.position.set(x, y, z);
      sprite.userData.ring?.position.set(x, y, z);
    });
    tagSprites.forEach((sprite) => {
      const off = clusterOffset[sprite.userData.cluster];
      sprite.position.set(
        sprite.userData.x + off.x,
        sprite.userData.y + off.y,
        clusterZ[sprite.userData.cluster]
      );
    });
    updateTagLines();
    threadGroups.forEach((g) => updateEdgeGroup(g, nodeWorldPosition));
    if (selection.size) updateRelationLines();
  }

  /* Build the whole layout. Called once per set of data -- a rebuild clears
   * what came before, the same way colour-map.js's setData does, so nothing
   * from a previous graph is left floating at coordinates nothing occupies. */
  function setData(next, dotTex, hubTex) {
    clear();
    data = next;
    flatOffsets = planeOffsets2d(data.planes);

    const zValues = data.planes.map((p) => p.z);
    const zFirst = zValues.length ? Math.min(...zValues) : 0;
    const zLast = zValues.length ? Math.max(...zValues) : 0;
    const span = zLast - zFirst || 1;
    extent = { zFirst, zLast, span, boundingSize: Math.max(PLANE_SIZE, span) };

    data.planes.forEach((p) => {
      clusterZ[p.cluster] = p.z;
      clusterOffset[p.cluster] = { x: 0, y: 0 };

      const { mesh, rim, glow } = makePlane(p, theme.planeTint, theme.planeTintAmount);
      group.add(mesh, rim, glow);
      planeObjects.push({ cluster: p.cluster, mesh, rim, glow });
    });

    data.nodes.forEach((n) => {
      const sprite = makeNodeSprite(n, dotTex, hubTex);
      sprite.userData = { ref: n, thumbState: "none" }; // "none" | "loading" | "loaded" | "failed"
      group.add(sprite);
      nodesById.set(n.id, sprite);
    });

    data.nodes.forEach((n) => {
      (n.tags || []).forEach((tag, idx) => {
        const sprite = makeTagSprite(tag, theme.tagLabel);
        const angle = tagAngle(idx);
        const dx = Math.cos(angle) * TAG_LABEL_OFFSET;
        const dy = Math.sin(angle) * TAG_LABEL_OFFSET;
        sprite.userData = { id: n.id, cluster: n.cluster, x: n.x + dx, y: n.y + dy };
        group.add(sprite);
        tagSprites.push(sprite);
        tagLineDefs.push({ cluster: n.cluster, x1: n.x, y1: n.y, x2: n.x + dx, y2: n.y + dy });
      });
    });

    tagLineGeometry = new THREE.BufferGeometry();
    tagLineGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(tagLineDefs.length * 6), 3)
    );
    tagLineMesh = new THREE.LineSegments(
      tagLineGeometry,
      new THREE.LineBasicMaterial({
        color: theme.tagLine, transparent: true, opacity: TAG_LINE_OPACITY, depthWrite: false,
      })
    );
    group.add(tagLineMesh);

    // Intra-cluster edges are drawn a little stronger than the sparser
    // cross-cluster ones, which are what visually cross between planes.
    threadGroups = [
      makeEdgeGroup(group, data.edges.filter((e) => !e.cross_cluster), data.nodes, INTRA_THREAD_OPACITY, theme.thread),
      makeEdgeGroup(group, data.edges.filter((e) => e.cross_cluster), data.nodes, CROSS_THREAD_OPACITY, theme.thread),
    ].filter(Boolean);

    adjacency = new Map(data.nodes.map((n) => [n.id, new Map()]));
    data.edges.forEach((e) => {
      adjacency.get(e.source)?.set(e.target, e.score);
      adjacency.get(e.target)?.set(e.source, e.score);
    });

    // Positions don't change again until the fold -- but the thread and
    // tag-line geometries were created with zeroed buffers, so this one call
    // is what actually populates them.
    applyClusterLayout();
    refocus(); // a selection made before a rebuild is still the user's
    return sprites();
  }

  const sprites = () => [...nodesById.values()];

  /* What the selection as a whole is similar to.
   *
   * Several references produce one ranked answer for the group, not one list
   * each -- the same reading /api/colour/search gives a multi-reference
   * colour selection ("what looks like this collection", not "what looks like
   * any one of these"). A reference the group has no thread to at all counts
   * as a zero rather than being left out of the average, so a node that only
   * one of five picks knows about doesn't outrank one they all do.
   */
  function combinedScores(ids) {
    const picked = new Set([...ids].filter((id) => nodesById.has(id)));
    if (!picked.size) return [];

    const totals = new Map();
    picked.forEach((id) => {
      adjacency.get(id).forEach((score, other) => {
        if (picked.has(other)) return;
        totals.set(other, (totals.get(other) || 0) + score);
      });
    });

    return [...totals.entries()]
      .map(([id, total]) => ({
        id,
        title: nodesById.get(id).userData.ref.title,
        score: total / picked.size,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /** Recompute what the current selection lights up, and show it. */
  function refocus() {
    selection = new Set([...selection].filter((id) => nodesById.has(id)));
    const matches = combinedScores(selection);
    lit = new Set(matches.map((m) => m.id));
    applyEmphasis();
    return matches;
  }

  /* A node's selection ring, made the first time it is actually selected.
   *
   * Lazily, so a view that never selects anything -- the full-page graph,
   * whose Colour mode owns all the selecting there is -- draws exactly the
   * sprites it drew before this module existed. */
  function ringFor(sprite) {
    if (!sprite.userData.ring) {
      const ring = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: ringTex, transparent: true, opacity: 0, depthWrite: false })
      );
      ring.position.copy(sprite.position);
      group.add(ring);
      sprite.userData.ring = ring;
    }
    return sprite.userData.ring;
  }

  /* Selected nodes come forward with a ring, and so does everything the
   * selection is threaded to -- seeing *where* the answer sits among the
   * clusters is the point of asking from the map. Everything else recedes. */
  function applyEmphasis() {
    const focused = selection.size > 0;

    nodesById.forEach((sprite, id) => {
      const isSelected = selection.has(id);
      const visible = !focused || isSelected || lit.has(id);
      sprite.material.opacity = visible ? 1 : DIMMED_OPACITY;

      const ring = isSelected ? ringFor(sprite) : sprite.userData.ring;
      if (!ring) return;
      ring.material.opacity = isSelected ? 0.95 : 0;
      // Sized off the sprite it marks rather than a constant, since the same
      // node is a small dot at a distance and a full thumbnail close up. The
      // floor keeps a ring around a bare dot big enough to see.
      ring.scale.setScalar(Math.max(sprite.scale.x * 1.5, RING_SIZE));
    });

    tagSprites.forEach((sprite) => {
      const id = sprite.userData.id;
      sprite.material.opacity = !focused || selection.has(id) || lit.has(id) ? 1 : DIMMED_OPACITY;
    });

    updateRelationLines();
  }

  function updateRelationLines() {
    const picked = [...selection].map((id) => nodesById.get(id)).filter(Boolean);
    if (picked.length < 2) {
      relationGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      return;
    }

    const centre = new THREE.Vector3();
    picked.forEach((s) => centre.add(s.position));
    centre.divideScalar(picked.length);

    const positions = new Float32Array(picked.length * 6);
    picked.forEach((s, i) => {
      positions.set([s.position.x, s.position.y, s.position.z, centre.x, centre.y, centre.z], i * 6);
    });
    relationGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    relationGeometry.attributes.position.needsUpdate = true;
  }

  function clear() {
    // Only the nodes' own loaded thumbnails and this layout's line geometries
    // are freed -- disposeSubtree leaves the page-wide shared plane, sprite
    // and tag-label resources alone. See its comment for the full rule.
    nodesById.forEach((sprite) => (sprite.userData.thumbState = "gone"));
    [...group.children]
      .filter((child) => child !== relationLines)
      .forEach((child) => disposeSubtree(child));

    planeObjects = [];
    nodesById = new Map();
    tagSprites = [];
    tagLineDefs = [];
    tagLineMesh = null;
    tagLineGeometry = null;
    threadGroups = [];
    adjacency = new Map();
    lit = new Set();
  }

  return {
    group,
    get sprites() {
      return sprites();
    },
    setData,

    /** The stack's extent, which is what a camera has to frame. */
    get metrics() {
      return extent;
    },

    /* The floating captions are the first thing to become clutter in a small
     * box -- a widget a few grid cells wide has no room for two labels per
     * reference -- so they are switchable, unlike on the full-page view where
     * they are simply always on. */
    setLabelsVisible(on) {
      tagSprites.forEach((sprite) => (sprite.visible = on));
      if (tagLineMesh) tagLineMesh.visible = on;
    },

    /** Focus the map on one reference or several. Returns the group's ranked
     *  neighbours, strongest first. */
    setSelection(ids) {
      selection = new Set(ids);
      return refocus();
    },

    get selection() {
      return new Set(selection);
    },

    combinedScores,

    /** Re-applied after a thumbnail loads, which changes a sprite's size. */
    refresh: applyEmphasis,

    /* --- The fold into the flat Connections view ---
     *
     * The panes slide out to their flat positions and come forward onto the
     * first plane's depth. The first plane is the one the camera is looking
     * at and its offset is (0, 0), so it never moves -- the framing holds
     * while everything else unfolds from behind it. */
    setFoldProgress(t) {
      const zFirst = extent.zFirst;
      data.planes.forEach((p) => {
        const target = flatOffsets.get(p.cluster);
        clusterOffset[p.cluster] = { x: target.x * t, y: target.y * t };
        clusterZ[p.cluster] = p.z + (zFirst - p.z) * t;
      });
      applyClusterLayout();
    },

    dispose() {
      clear();
      disposeSubtree(group);
      ringTex.dispose();
    },
  };
}
