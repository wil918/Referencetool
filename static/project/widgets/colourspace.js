/* The LCh colour cylinder, scoped to one project.
 *
 * The same map as the Colour mode of /graph.html, drawn by the same module
 * (static/colour-map.js) into a scene sized to this widget's box instead of
 * the window. Axes, per the perceptual reading of CIELCh: lightness up the
 * axis, chroma out from it, hue around it.
 *
 * Positions come from /api/projects/<pid>/colour/map -- a project's own
 * cylinder, ranked within its own references rather than against the whole
 * archive, so a project of near-neutrals still spreads out instead of
 * huddling on the axis. `coverage` in that response stays archive-wide,
 * because the backfill it exists to prompt is: there is one Analyse Colour
 * button, in the library's Settings, and it works through every unanalysed
 * image regardless of project.
 *
 * Searching *from* the map -- picking references and asking what resembles
 * them -- stays with the full-page view, which has a panel to put results in.
 * This widget is the picture: where this project's references sit in colour
 * space, at a glance, on the homepage.
 *
 * Pause view freezes the orbit controls on whatever angle the camera is
 * currently at and remembers it, so a project page can settle on one
 * considered shot instead of resetting to the default square-on framing on
 * every reload. Unchecking hands the camera back rather than resetting it.
 * Same mechanism as similarity.js's identical toggle -- see scene-widget.js's
 * setPaused.
 *
 * config: { exclude_black_white, paused, paused_view }
 */

import { createSceneWidget } from "../scene-widget.js";

export default {
  type: "colourspace",
  label: "Colour Space",
  container: false,
  permanent: false,
  defaultSize: { w: 8, h: 6 },
  minSize: { w: 3, h: 3 },

  create(host) {
    const projectId = host.project.id;
    // Read once at mount and then owned here: the toggle below writes it back
    // through host.save, and re-reading host.config mid-flight would race
    // that debounced write.
    let excludeBlackWhite = Boolean(host.config?.exclude_black_white);
    let paused = Boolean(host.config?.paused);
    const pausedView = host.config?.paused_view || null;

    const summary = (data) => `${data.nodes.length} references by lightness, chroma and hue`;

    async function fetchMap() {
      const res = await fetch(
        `/api/projects/${projectId}/colour/map?exclude_black_white=${excludeBlackWhite ? 1 : 0}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Colour map unavailable (${res.status}).`);
      return data;
    }

    // Coverage is the archive's, not this project's -- so the sentence says
    // where the work is done rather than implying a per-project button.
    function emptyState(data) {
      const pending = data.coverage?.pending || 0;
      return {
        message: pending
          ? `None of this project's images have a colour profile yet — ${pending} still to analyse across the archive.`
          : "No colour-analysed images in this project yet.",
        actionLabel: pending ? "Analyse Colour in Settings" : "Open Settings",
        actionHref: "/index.html#settings",
      };
    }

    return createSceneWidget(host, {
      async load() {
        const data = await fetchMap();
        return data.nodes.length ? { data } : { empty: emptyState(data) };
      },

      async build({ sceneHost, data, chrome, setCaption, setPaused }) {
        const { camera, controls, theme } = sceneHost;

        // Imported here rather than at the top of the module so a project
        // page with no 3D widget on it never loads Three.js at all -- see
        // scene-widget.js.
        const [THREE, { createColourMap }, common] = await Promise.all([
          import("three"),
          import("../../colour-map.js"),
          import("../../graph-common.js"),
        ]);

        const dotTex = common.dotTexture(theme.dot);
        const map = createColourMap(sceneHost.scene, theme);
        // The full-page view builds this hidden, since it starts in the
        // similarity layout and only flips to colour on demand. Here it is
        // the whole widget.
        map.group.visible = true;
        let sprites = map.setData(data, dotTex);

        /* Square on to the cylinder from a little above the equator, far
         * enough out to see all of it -- the same opening framing the
         * full-page Colour mode uses, in a box a few grid cells wide. */
        controls.target.set(0, 0, 0);
        camera.position.set(data.radius * 1.6, data.height * 0.5, data.radius * 1.6);
        controls.minDistance = 2;
        controls.maxDistance = Math.max(data.radius, data.height) * 4;
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

        // Every reference is meant to read as its own image here, so
        // thumbnails load regardless of distance -- nearest first, a few at a
        // time, so opening a project page doesn't fire one request per
        // reference at once.
        const cameraWorldPos = new THREE.Vector3();
        let frame = 0;
        const unsubscribeFrame = sceneHost.onFrame(() => {
          frame++;
          if (frame % 6 !== 0) return;
          camera.getWorldPosition(cameraWorldPos);
          sprites
            .filter((s) => s.userData.thumbState === "none")
            .sort((a, b) => a.position.distanceTo(cameraWorldPos) - b.position.distanceTo(cameraWorldPos))
            .slice(0, common.COLOUR_THUMB_BUDGET)
            .forEach((sprite) => common.loadThumbnail(sprite, () => map.refresh()));
        });

        /* The hover caption is what makes the cloud worth orbiting: a dot
         * says nothing until you can see which reference it is. Listeners go
         * on the canvas, which the scene host removes on dispose, so there is
         * nothing to unbind by hand. */
        const canvas = sceneHost.renderer.domElement;
        let resting = summary(data);
        setCaption(resting);

        canvas.addEventListener("pointermove", (event) => {
          const hit = sceneHost.pick(event, sprites);
          if (!hit) {
            setCaption(resting);
            return;
          }
          const ref = hit.object.userData.ref;
          setCaption(
            `${ref.title} · L ${Math.round(ref.lightness * 100)} · C ${Math.round(ref.chroma)} · h ${Math.round(ref.hue)}°`
          );
        });
        canvas.addEventListener("pointerleave", () => setCaption(resting));

        /* Positions are derived from the same filtered profiles a colour
         * search uses, so this toggle can't just hide the neutrals -- the map
         * is rebuilt, which is what makes it mean the same thing here as it
         * does in a search's results. */
        const toggle = document.createElement("label");
        toggle.className = "checkbox-label";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = excludeBlackWhite;
        toggle.append(box, document.createTextNode("Remove black & white"));
        chrome.appendChild(toggle);

        let disposed = false;
        box.addEventListener("change", async () => {
          excludeBlackWhite = box.checked;
          host.save({ ...host.config, exclude_black_white: excludeBlackWhite });
          box.disabled = true;
          setCaption("Reading colour profiles…");
          try {
            const next = await fetchMap();
            if (disposed) return;
            if (next.nodes.length) {
              sprites = map.setData(next, dotTex);
              resting = summary(next);
            } else {
              resting = emptyState(next).message;
            }
            setCaption(resting);
          } catch (err) {
            if (!disposed) setCaption(err.message || String(err));
          } finally {
            if (!disposed) box.disabled = false;
          }
        });

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
            disposed = true;
            unsubscribeFrame();
            // The map frees what it built into the scene; the dot texture is
            // this widget's, handed to every sprite in it (graph-common's
            // disposeSubtree explains the split).
            map.dispose();
            dotTex.dispose();
          },
        };
      },
    });
  },
};
