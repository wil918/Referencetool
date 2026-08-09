/* Colour mode for the 3D graph: the archive arranged in an LCh cylinder.
 *
 * A layout, not a second graph. The renderer, camera, orbit controls, hover
 * label, raycaster and thumbnail loading all belong to graph.js and are shared
 * with the similarity view -- this module only builds objects into that scene
 * and answers questions about them. Everything visual (dot textures, sprite
 * sizes, lighting, theme palette) comes from graph-common.js, so the two modes
 * stay recognisably the same picture with the references rearranged.
 *
 * Axes, per the perceptual reading of CIELCh:
 *   vertical   lightness -- dark at the bottom, light at the top
 *   radial     chroma    -- neutral on the axis, saturated at the rim
 *   angular    hue       -- the colour wheel, marked by the ring of swatches
 *
 * The positions themselves are computed server-side by colour.colour_map(),
 * from the colour profiles the search already stores. Nothing here decides
 * where a reference belongs.
 */
import * as THREE from "three";
import {
  DOT_SIZE,
  makeNodeSprite,
  makeTagSprite,
  ringTexture,
  rgbToThreeColor,
} from "./graph-common.js";

// Smaller than the similarity view's THUMB_SIZE (1.3): the cylinder packs the
// whole archive into one volume rather than spreading it over several planes,
// so thumbnails have to be smaller to stay individually readable.
const THUMB_SIZE = 0.9;
const SELECTED_THUMB_SIZE = 1.35;
const RING_SIZE = 1.9;

const GUIDE_OPACITY = 0.3;
const HUE_TICK_SIZE = 0.34;
const DIMMED_OPACITY = 0.22; // unselected nodes, once a selection exists
const RELATION_OPACITY = 0.55;

const CIRCLE_SEGMENTS = 96;

export function createColourMap(scene, theme) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  // The scaffolding turns as one rigid body during the fold while the nodes
  // are placed individually -- they have to land coplanar, which a rotation
  // alone can't do, and scaling the group instead would squash the sprites
  // along with it.
  const guideGroup = new THREE.Group();
  group.add(guideGroup);

  const ringTex = ringTexture(theme.hub);
  const nodes = new Map(); // id -> sprite
  // The cylinder's scaffolding, tracked separately so the fold can fade it
  // out: an axis, rings and a hue wheel describe a *cylinder*, and there is
  // nothing for them to become once it has flattened.
  const guides = [];
  let sprites = [];
  let selection = new Set();
  let matches = new Map(); // id -> score, from a colour search

  // Lines from each selected node to the group's centre of gravity -- what
  // makes a multi-selection read as one group with a shared colour character
  // rather than several unrelated picks.
  const relationGeometry = new THREE.BufferGeometry();
  relationGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  const relationLines = new THREE.LineSegments(
    relationGeometry,
    new THREE.LineBasicMaterial({
      color: theme.thread, transparent: true, opacity: RELATION_OPACITY, depthWrite: false,
    })
  );
  group.add(relationLines);

  function circle(radius, y, color, opacity) {
    const points = [];
    for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius));
    }
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
    );
  }

  /* The scaffolding that makes the cylinder readable as a colour space rather
   * than a cloud: the neutral axis, two chroma rings for scale, the hue wheel,
   * and labels for which way is light. */
  function buildGuides(data) {
    const halfHeight = data.height / 2;
    guides.length = 0;
    // Every guide's designed opacity is remembered so the fold can scale them
    // all down together and back up without flattening them to one value.
    const addGuide = (object) => {
      guides.push({ object, opacity: object.material.opacity });
      guideGroup.add(object);
    };

    const axis = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, -halfHeight, 0),
        new THREE.Vector3(0, halfHeight, 0),
      ]),
      new THREE.LineBasicMaterial({
        color: theme.tagLine, transparent: true, opacity: GUIDE_OPACITY, depthWrite: false,
      })
    );
    addGuide(axis);

    // Rings at the rim and half way out, at the top and bottom of the range,
    // so the cylinder has visible extent from any angle.
    for (const y of [-halfHeight, halfHeight]) {
      addGuide(circle(data.radius, y, theme.tagLine, GUIDE_OPACITY));
      addGuide(circle(data.radius / 2, y, theme.tagLine, GUIDE_OPACITY * 0.55));
    }

    // The hue wheel, on the equator: each swatch marks the direction its own
    // hue family lies in, so a cluster's angle can be read off directly.
    (data.hue_ticks || []).forEach((tick) => {
      const angle = THREE.MathUtils.degToRad(tick.hue);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          color: rgbToThreeColor(tick.rgb), transparent: true, opacity: 0.85, depthWrite: false,
        })
      );
      sprite.scale.set(HUE_TICK_SIZE, HUE_TICK_SIZE, 1);
      sprite.position.set(
        Math.cos(angle) * (data.radius + 0.7), 0, Math.sin(angle) * (data.radius + 0.7)
      );
      addGuide(sprite);
    });

    [["light", halfHeight + 0.85], ["dark", -halfHeight - 0.85]].forEach(([text, y]) => {
      const label = makeTagSprite(text, theme.tagLabel);
      label.position.set(0, y, 0);
      addGuide(label);
    });
  }

  function setData(data, dotTex) {
    // Rings and guides are separate objects from the nodes, so clearing only
    // the nodes would leave the previous layout's rings and rim floating at
    // positions nothing occupies any more -- visible every time the black and
    // white toggle rebuilds the map.
    //
    // Only a loaded thumbnail's texture is freed: the dot, ring and tag-label
    // textures are shared or cached in graph-common, and disposing one would
    // pull it out from under every other sprite still using it.
    nodes.forEach((sprite) => {
      if (sprite.userData.thumbState === "loaded") sprite.material.map?.dispose();
    });
    [...group.children]
      .filter((child) => child !== relationLines)
      .forEach((child) => {
        group.remove(child);
        // Every Sprite in three.js shares one module-level geometry, so
        // disposing it here would pull the rug out from under the similarity
        // view's sprites too. Only the guide lines own theirs.
        if (!child.isSprite) child.geometry?.dispose();
        child.material?.dispose();
      });
    nodes.clear();

    buildGuides(data);

    data.nodes.forEach((n) => {
      const sprite = makeNodeSprite({ is_hub: false }, dotTex, dotTex);
      sprite.position.set(n.x, n.y, n.z);
      // Same shape of userData as the similarity view's nodes, so graph.js's
      // hover label and thumbnail loader work on either mode's sprites.
      sprite.userData = { ref: n, thumbState: "none", baseSize: THUMB_SIZE };
      group.add(sprite);
      nodes.set(n.id, sprite);

      const ring = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: ringTex, transparent: true, opacity: 0, depthWrite: false })
      );
      ring.scale.set(RING_SIZE, RING_SIZE, 1);
      ring.position.copy(sprite.position);
      group.add(ring);
      sprite.userData.ring = ring;
    });

    sprites = [...nodes.values()];
    applyEmphasis();
    return sprites;
  }

  /* Selected nodes come forward at full opacity with a ring; when a search has
   * run, its matches stay lit too -- the point of searching from the map is
   * seeing *where* the matches are, which needs them visible against the rest. */
  function applyEmphasis() {
    const hasFocus = selection.size > 0 || matches.size > 0;

    nodes.forEach((sprite, id) => {
      const isSelected = selection.has(id);
      const isMatch = matches.has(id);
      const lit = isSelected || isMatch;

      sprite.material.opacity = !hasFocus || lit ? 1 : DIMMED_OPACITY;
      sprite.userData.ring.material.opacity = isSelected ? 0.95 : 0;

      const loaded = sprite.userData.thumbState === "loaded";
      const size = isSelected ? SELECTED_THUMB_SIZE : sprite.userData.baseSize;
      sprite.userData.baseSize = isSelected ? SELECTED_THUMB_SIZE : THUMB_SIZE;
      sprite.scale.setScalar(loaded ? size : DOT_SIZE);
      sprite.userData.ring.scale.setScalar(isSelected ? RING_SIZE : RING_SIZE * 0.7);
    });

    updateRelationLines();
  }

  function updateRelationLines() {
    const picked = [...selection].map((id) => nodes.get(id)).filter(Boolean);
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

  return {
    group,
    get sprites() {
      return sprites;
    },
    setData,
    setSelection(ids) {
      selection = new Set(ids);
      applyEmphasis();
    },
    setMatches(scoreById) {
      matches = new Map(scoreById);
      applyEmphasis();
    },
    /** Re-applied after a thumbnail loads, which changes a sprite's size. */
    refresh: applyEmphasis,
    thumbSize(sprite) {
      return sprite.userData.baseSize;
    },

    /* --- The fold into the flat colour view ---
     *
     * A quarter turn about the x axis, so the cylinder tips over and the
     * camera ends up looking at its footprint. Turning the whole group is
     * what keeps every node, ring and swatch in step for free -- and it means
     * the flat page can place a node at colourFlatPosition() and land on
     * exactly the pixel the last 3D frame left it at.
     */
    setFoldProgress(t) {
      // Nodes follow that same quarter turn, with the depth it produces eased
      // away to nothing so they finish on one plane -- see colourFlatPosition
      // for why the coplanar ending is what makes the handoff exact.
      const angle = -Math.PI / 2 * t;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      nodes.forEach((sprite) => {
        const { x, y, z } = sprite.userData.ref;
        sprite.position.set(x, y * cos - z * sin, (y * sin + z * cos) * (1 - t));
        sprite.userData.ring.position.copy(sprite.position);
      });

      guideGroup.rotation.x = angle;

      // The scaffolding describes a cylinder, so it leaves with the cylinder;
      // the flat page fades its own disc guides in on arrival.
      const fade = 1 - t;
      guides.forEach(({ object, opacity }) => {
        object.material.opacity = opacity * fade;
        object.visible = fade > 0.001;
      });
    },

    /** Selection chrome is handed to the flat page as state, not as pixels. */
    hideChrome() {
      relationLines.visible = false;
      nodes.forEach((sprite) => (sprite.userData.ring.material.opacity = 0));
    },
  };
}
