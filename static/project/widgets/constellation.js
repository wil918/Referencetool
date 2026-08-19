/* The constellation view, scoped to one project.
 *
 * The same layout as /graph.html's Constellation mode, drawn by the same
 * module (static/constellation-map.js) into a scene sized to this widget's
 * box: every reference placed by CLIP similarity alone, via
 * graph_layout.build_constellation()'s force-directed 3D simulation, coloured
 * by the plane view's own cluster colours rather than a second clustering.
 *
 * The graph comes from /api/projects/<pid>/similarity/constellation: the
 * project's own references, laid out among themselves. The scores
 * themselves are archive-wide, which is why the "nothing to draw" case
 * points at the library's Settings rather than at anything inside the
 * project -- the same split similarity.js already draws.
 *
 * No selection, no search panel -- like the full-page Constellation mode,
 * this hands straight over to the orbit controls. Its only extra chrome is
 * the honesty caption: this is a browsing surface, not a precise neighbour
 * finder, and the stress / neighbour-retention figures from
 * build_constellation say exactly how rough it is (see constellation-map.js).
 *
 * Pause view freezes the orbit controls on whatever angle the camera is
 * currently at and remembers it, the same mechanism as similarity.js's and
 * colourspace.js's identical toggle -- see scene-widget.js's setPaused.
 *
 * config: { paused, paused_view }
 */

import { createSceneWidget } from "../scene-widget.js";

export default {
  type: "constellation",
  label: "Constellation",
  container: false,
  permanent: false,
  defaultSize: { w: 8, h: 6 },
  minSize: { w: 3, h: 3 },

  create(host) {
    const projectId = host.project.id;
    let paused = Boolean(host.config?.paused);
    const pausedView = host.config?.paused_view || null;

    return createSceneWidget(host, {
      async load() {
        const res = await fetch(`/api/projects/${projectId}/similarity/constellation`);
        const data = await res.json();

        // The archive has no scores at all -- same sentence the library's
        // Settings uses, and the fix is there too (similarity.js's own case).
        if (!res.ok) {
          return {
            empty: {
              message: data.error || `Constellation unavailable (${res.status}).`,
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
                "This project needs at least two embedded references before a constellation can be drawn.",
              actionLabel: "See this project's references",
              actionHref: "#page=grid",
            },
          };
        }
        return { data };
      },

      async build({ sceneHost, data, chrome, setCaption, setPaused }) {
        const { camera, controls, theme } = sceneHost;

        // Imported here rather than at the top of the module so a project
        // page with no 3D widget on it never loads Three.js at all -- see
        // scene-widget.js.
        const [THREE, { createConstellationMap }, common] = await Promise.all([
          import("three"),
          import("../../constellation-map.js"),
          import("../../graph-common.js"),
        ]);

        const whiteDotTex = common.dotTexture("#ffffff");
        const map = createConstellationMap(sceneHost.scene, theme);
        map.group.visible = true;
        const sprites = map.setData(data, whiteDotTex);

        /* A three-quarter view sized to whatever this project's own
         * constellation spans, the same isometric feel similarity.js opens
         * on rather than a flat axis-aligned shot. */
        const r = map.metrics.boundingRadius;
        camera.position.set(r * 1.3, r * 0.9, r * 1.3);
        controls.target.set(0, 0, 0);
        controls.minDistance = 2;
        controls.maxDistance = r * 4;
        controls.update();

        /* A paused session overrides that default framing with the exact
         * camera position and orbit target it was paused on -- see the
         * Pause view toggle below -- and starts already frozen, so nothing
         * moves before the user acts on the checkbox. */
        if (paused && pausedView) {
          camera.position.set(pausedView.position.x, pausedView.position.y, pausedView.position.z);
          controls.target.set(pausedView.target.x, pausedView.target.y, pausedView.target.z);
          controls.update();
        }
        setPaused(paused);

        /* Plain language, not the statistics' names -- the same spirit as
         * the README's note about CLIP similarity scores running high: a
         * browsing surface, not a precise neighbour finder, said outright
         * rather than rounded away. */
        const restingCaption = () => {
          const distortion = Math.round(map.metrics.stress * 100);
          const retained = Math.round(map.metrics.neighbourRetention * 100);
          return (
            `${sprites.length} references · a rough map, not a precise one — ` +
            `distances are off by around ${distortion}% on average, true closest ` +
            `match found among the five nearest for about ${retained}%.`
          );
        };
        setCaption(restingCaption());

        // Thumbnails swap in as the camera closes on a node and drop back to
        // dots as it pulls away -- the same distance-based LOD as the
        // full-page view and similarity.js, at this widget's own distance.
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
              map.loadThumbnail(sprite);
            } else if (dist >= common.THUMBNAIL_DISTANCE && state === "loaded") {
              map.revertToDot(sprite, whiteDotTex);
            }
          }
        });

        /* Hover names the reference under the pointer; listeners are on the
         * canvas, which the scene host removes on dispose, so there is
         * nothing to unbind by hand. */
        const canvas = sceneHost.renderer.domElement;

        canvas.addEventListener("pointermove", (event) => {
          const hit = sceneHost.pick(event, sprites);
          canvas.style.cursor = "";
          if (!hit) {
            setCaption(restingCaption());
            return;
          }
          const ref = hit.object.userData.ref;
          setCaption(`${ref.title}${ref.is_own_work ? " · own work" : ""}`);
        });

        canvas.addEventListener("pointerleave", () => setCaption(restingCaption()));

        /* Freezes the camera exactly where it is and remembers that view --
         * position and orbit target are the smallest state that reproduces
         * it exactly, since OrbitControls derives everything else (azimuth,
         * polar angle, radius) from those same two vectors. Unpausing hands
         * the camera back rather than resetting it, so orbiting on from a
         * paused shot picks up where the pause left off. */
        const pauseToggle = document.createElement("label");
        pauseToggle.className = "checkbox-label";
        const pauseBox = document.createElement("input");
        pauseBox.type = "checkbox";
        pauseBox.checked = paused;
        pauseToggle.append(pauseBox, document.createTextNode("Pause view"));
        chrome.appendChild(pauseToggle);

        pauseBox.addEventListener("change", () => {
          paused = pauseBox.checked;
          host.save({
            ...host.config,
            paused,
            // Only recorded on pausing -- unpausing leaves the last saved
            // angle alone, so pausing again without touching the camera
            // saves the same view instead of losing it.
            ...(paused
              ? {
                  paused_view: {
                    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
                    target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
                  },
                }
              : {}),
          });
          setPaused(paused);
        });

        return {
          destroy() {
            unsubscribeFrame();
            // The map frees what it built into the scene; the dot texture is
            // this widget's, handed to every sprite in it (graph-common's
            // disposeSubtree explains the split).
            map.dispose();
            whiteDotTex.dispose();
          },
        };
      },
    });
  },
};
