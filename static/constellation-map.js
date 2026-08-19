/* The constellation view: every reference placed by CLIP similarity alone,
 * via the force-directed 3D layout in graph_layout.build_constellation() --
 * a third archive-wide layout, alongside the cluster-plane stack
 * (similarity-map.js) and the LCh colour cylinder (colour-map.js), and a
 * fourth CALLER of shared/scene-host.js rather than a fourth renderer.
 *
 * A layout, not a page, exactly like its two siblings: everything here
 * builds into a scene handed in from outside, and every visual constant
 * (dot size, thread opacity, thumbnail distance) comes from graph-common.js
 * so this reads as the same picture as the other two views at whatever size
 * it's drawn.
 *
 * Positions carry the similarity information here -- there is no cluster
 * plane or radial arrangement doing that job -- so only the sparse strongest
 * threads the server already picked (build_constellation's
 * CONSTELLATION_EDGE_TOP_FRACTION) are drawn; anything more would just be
 * noise on top of the layout itself.
 *
 * Node colour is the plane view's own cluster colour (each node's `color`,
 * carried by the API response from graph_layout.build_constellation, which
 * reuses build_graph's k-means labels rather than reclustering), so the two
 * views visibly agree about what the groups are. Nodes start as a plain
 * white dot tinted per cluster; a loaded thumbnail drops the tint (a real
 * photo shown through a colour filter would just look wrong) and a reverted
 * one picks it back up.
 *
 * This view is a browsing surface, not a precise neighbour finder -- the
 * server-computed stress and neighbour-retention figures say exactly how
 * rough it is. graph.js reads them off `metrics` and puts them in the status
 * line in plain language, the same spirit as the README's note about CLIP
 * similarity scores running high, rather than rounding them away.
 */
import * as THREE from "three";
import {
  DOT_SIZE,
  disposeSubtree,
  loadThumbnail,
  makeEdgeGroup,
  revertToDot,
  rgbToThreeColor,
  updateEdgeGroup,
} from "./graph-common.js";

const THREAD_OPACITY = 0.3;

export function createConstellationMap(scene, theme) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  let nodesById = new Map();
  let sprites = [];
  let threadGroup = null;
  let metrics = { stress: 0, neighbourRetention: 0, boundingRadius: 10 };

  function tintOf(sprite) {
    return rgbToThreeColor(sprite.userData.ref.color);
  }

  /* One plain white dot, tinted per sprite via material.color rather than a
   * texture per cluster -- a handful of cluster colours would mean a
   * handful of extra canvas textures to track and dispose for no real
   * benefit over multiplying a white base by an RGB tint. */
  function makeSprite(node, whiteDotTex) {
    const material = new THREE.SpriteMaterial({
      map: whiteDotTex,
      color: rgbToThreeColor(node.color),
      transparent: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(DOT_SIZE, DOT_SIZE, 1);
    sprite.userData = { ref: node, thumbState: "none" };
    return sprite;
  }

  function clear() {
    nodesById.forEach((sprite) => (sprite.userData.thumbState = "gone"));
    [...group.children].forEach((child) => disposeSubtree(child));
    nodesById = new Map();
    sprites = [];
    threadGroup = null;
  }

  function setData(data, whiteDotTex) {
    clear();

    data.nodes.forEach((n) => {
      const sprite = makeSprite(n, whiteDotTex);
      sprite.position.set(n.x, n.y, n.z);
      group.add(sprite);
      nodesById.set(n.id, sprite);
    });
    sprites = [...nodesById.values()];

    if (data.edges.length) {
      threadGroup = makeEdgeGroup(group, data.edges, data.nodes, THREAD_OPACITY, theme.thread);
      if (threadGroup) updateEdgeGroup(threadGroup, (n) => [n.x, n.y, n.z]);
    }

    let boundingRadius = 10;
    data.nodes.forEach((n) => {
      boundingRadius = Math.max(boundingRadius, Math.hypot(n.x, n.y, n.z));
    });
    metrics = {
      stress: data.stress,
      neighbourRetention: data.neighbour_retention,
      boundingRadius,
    };

    return sprites;
  }

  return {
    group,
    get sprites() {
      return sprites;
    },
    get metrics() {
      return metrics;
    },
    setData,

    /* A loaded thumbnail is a real photo -- shown through the cluster tint
     * it would just look discoloured, so the tint drops the moment one
     * lands. `whiteDotTex`/`onLoaded` are graph-common's loadThumbnail
     * signature exactly. */
    loadThumbnail(sprite, onLoaded) {
      loadThumbnail(sprite, (s) => {
        s.material.color.set(0xffffff);
        onLoaded?.(s);
      });
    },

    /* The reverse: back to a plain dot, and the cluster tint comes back
     * with it -- this is what makes the zoomed-out view read as coloured
     * groups again once a thumbnail drops out of range. */
    revertToDot(sprite, whiteDotTex) {
      revertToDot(sprite, whiteDotTex, whiteDotTex);
      sprite.material.color.copy(tintOf(sprite));
    },

    dispose() {
      clear();
      disposeSubtree(group);
    },
  };
}
