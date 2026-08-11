/* The 3D similarity graph, scoped to one project.
 *
 * The same layout as /graph.html, drawn by the same module
 * (static/similarity-map.js) into a scene sized to this widget's box: one
 * translucent plane per cluster, a billboard per reference, and the threads
 * between them. What it leaves behind is that page's choreography -- the
 * drifting opening shot, the scroll trigger, the fold into the flat
 * Connections canvas. A widget is looked at in passing, so it hands over to
 * the orbit controls immediately.
 *
 * The graph comes from /api/projects/<pid>/similarity/graph: the project's
 * own references, clustered among themselves and threaded only by the scores
 * whose both endpoints are in the project. The scores themselves are
 * archive-wide, which is why the "nothing to draw" case points at the
 * library's Settings rather than at anything inside the project.
 *
 * Clicking a reference asks what the graph is like it -- and shift-clicking
 * builds a group, which is answered as one question about the group rather
 * than as several separate ones, the same reading /api/colour/search gives a
 * multi-reference colour selection. See similarity-map.js's combinedScores.
 *
 * config: { show_labels, selection }
 */

import { createSceneWidget } from "../scene-widget.js";

// A drag that ends on a node orbited the camera; only a press that stayed put
// is a click on the reference under it.
const CLICK_SLOP_PX = 4;

export default {
  type: "similarity",
  label: "Similarity Graph",
  container: false,
  permanent: false,
  defaultSize: { w: 8, h: 6 },
  minSize: { w: 3, h: 3 },

  create(host) {
    const projectId = host.project.id;
    let showLabels = host.config?.show_labels ?? false;
    let selection = new Set(host.config?.selection || []);

    return createSceneWidget(host, {
      async load() {
        const res = await fetch(`/api/projects/${projectId}/similarity/graph`);
        const data = await res.json();

        // The archive has no scores at all -- the API says so in the same
        // sentence the library's Settings uses, and the fix is there too.
        if (!res.ok) {
          return {
            empty: {
              message: data.error || `Graph unavailable (${res.status}).`,
              actionLabel: "Open Settings",
              actionHref: "/index.html#settings",
            },
          };
        }

        // Scores exist, but this project has nothing to lay out: fewer than
        // two references, or none of them embedded (a project of text notes).
        if (!data.nodes.length) {
          return {
            empty: {
              message:
                "This project needs at least two embedded references before a graph can be drawn.",
              actionLabel: "See this project's references",
              actionHref: "#page=grid",
            },
          };
        }
        return { data };
      },

      async build({ sceneHost, data, chrome, setCaption }) {
        const { camera, controls, theme } = sceneHost;

        // Imported here rather than at the top of the module so a project
        // page with no 3D widget on it never loads Three.js at all -- see
        // scene-widget.js.
        const [THREE, { createSimilarityMap }, common] = await Promise.all([
          import("three"),
          import("../../similarity-map.js"),
          import("../../graph-common.js"),
        ]);

        const dotTex = common.dotTexture(theme.dot);
        const hubTex = common.dotTexture(theme.hub);
        const map = createSimilarityMap(sceneHost.scene, theme);
        const sprites = map.setData(data, dotTex, hubTex);
        map.setLabelsVisible(showLabels);

        /* The isometric three-quarter view the full-page graph settles into
         * once its intro is over, at the same radius relative to the stack --
         * never a flat axis-aligned shot, which would hide the depth that is
         * the whole point of the plane stack. */
        const { boundingSize } = map.metrics;
        const isoRadius = boundingSize * 1.15;
        camera.position.copy(new THREE.Vector3(1, 1, 1).normalize().multiplyScalar(isoRadius));
        controls.target.set(0, 0, 0);
        controls.minDistance = 2;
        controls.maxDistance = boundingSize * 3;
        controls.update();

        const restingCaption = () =>
          `${data.nodes.length} references · ${data.cluster_count} clusters · ${data.edges.length} threads`;

        /* What the current selection is: nothing, one reference, or a group
         * answered as one. The strongest match is named because it is the
         * answer the question was asked for; the rest are lit in the scene. */
        function describe(matches) {
          if (!selection.size) return restingCaption();
          const top = matches[0];
          const lead = selection.size === 1
            ? map.sprites.find((s) => selection.has(s.userData.ref.id))?.userData.ref.title
            : `${selection.size} references combined`;
          return top
            ? `${lead} → ${top.title} (${top.score.toFixed(3)})`
            : `${lead} — no threads to anything else in this project`;
        }

        function applySelection(next, { persist = true } = {}) {
          selection = new Set(next);
          const matches = map.setSelection(selection);
          setCaption(describe(matches));
          if (persist) host.save({ ...host.config, selection: [...selection] });
        }

        applySelection(selection, { persist: false });

        // Thumbnails swap in as the camera closes on a cluster and drop back
        // to dots as it pulls away, so a wide shot stays legible as structure
        // -- the same budgeting as the full-page view, at its distance.
        const cameraWorldPos = new THREE.Vector3();
        let frame = 0;
        const unsubscribeFrame = sceneHost.onFrame(() => {
          frame++;
          if (frame % 6 !== 0) return;
          camera.getWorldPosition(cameraWorldPos);
          for (const sprite of sprites) {
            const dist = sprite.position.distanceTo(cameraWorldPos);
            const state = sprite.userData.thumbState;
            if (dist < common.THUMBNAIL_DISTANCE && state === "none") {
              common.loadThumbnail(sprite, () => map.refresh());
            } else if (dist >= common.THUMBNAIL_DISTANCE && state === "loaded") {
              common.revertToDot(sprite, dotTex, hubTex);
              map.refresh();
            }
          }
        });

        /* Hover names the reference under the pointer; click drives the map
         * from it. Both listeners are on the canvas, which the scene host
         * removes on dispose, so there is nothing to unbind by hand. */
        const canvas = sceneHost.renderer.domElement;

        canvas.addEventListener("pointermove", (event) => {
          const hit = sceneHost.pick(event, sprites);
          canvas.style.cursor = hit ? "pointer" : "";
          if (!hit) return;
          const ref = hit.object.userData.ref;
          setCaption(`${ref.title}${ref.is_own_work ? " · own work" : ""}`);
        });

        canvas.addEventListener("pointerleave", () => {
          setCaption(describe(map.combinedScores(selection)));
        });

        let downAt = null;
        canvas.addEventListener("pointerdown", (event) => {
          downAt = { x: event.clientX, y: event.clientY };
        });

        canvas.addEventListener("pointerup", (event) => {
          if (!downAt) return;
          const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
          downAt = null;
          if (moved > CLICK_SLOP_PX) return;

          const hit = sceneHost.pick(event, sprites);
          if (!hit) {
            if (!event.shiftKey && selection.size) applySelection(new Set());
            return;
          }
          const id = hit.object.userData.ref.id;
          // Shift extends the selection, plain click replaces it -- the same
          // multi-select convention the archive grid and the colour map use.
          const next = event.shiftKey ? new Set(selection) : new Set();
          if (event.shiftKey && selection.has(id)) next.delete(id);
          else next.add(id);
          applySelection(next);
        });

        /* Two tag captions per reference is the full-page view's density, and
         * it is far too much for a box a few cells wide -- so here they are
         * off by default and switchable, rather than simply always on. */
        const toggle = document.createElement("label");
        toggle.className = "checkbox-label";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = showLabels;
        toggle.append(box, document.createTextNode("Tag labels"));
        chrome.appendChild(toggle);

        box.addEventListener("change", () => {
          showLabels = box.checked;
          map.setLabelsVisible(showLabels);
          host.save({ ...host.config, show_labels: showLabels });
        });

        return {
          destroy() {
            unsubscribeFrame();
            // The map frees what it built into the scene; the dot textures
            // are this widget's, handed to every sprite in it (graph-common's
            // disposeSubtree explains the split).
            map.dispose();
            dotTex.dispose();
            hubTex.dispose();
          },
        };
      },
    });
  },
};
