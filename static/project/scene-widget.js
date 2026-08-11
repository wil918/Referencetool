/* The frame around a 3D widget: its box, its chrome, and its lifecycle.
 *
 * Both Three.js widgets (colourspace, similarity) need the same handful of
 * things, and none of them are about what is actually in the scene:
 *
 *   - Three.js is loaded on demand. registry.js imports every widget module
 *     statically, so a static `import * as THREE` here would put a megabyte
 *     of renderer on every project page whether or not it has a 3D widget on
 *     it. The scene modules are dynamically imported the first time one of
 *     these widgets actually mounts.
 *
 *   - Nothing is built at all when there is no data to draw. A project with
 *     no colour-analysed images, or an archive with no similarity scores,
 *     gets a sentence saying so and a link to where it is fixed -- not an
 *     empty box, and not a WebGL context spent on nothing.
 *
 *   - host.onResize -> sceneHost.resize(), and destroy() -> dispose(). The
 *     second is not optional: browsers cap live WebGL contexts at around
 *     sixteen, so a widget that leaks one per add/remove cycle takes the
 *     whole page down with it after a few cycles.
 *
 *   - The scene goes inert while the grid is being edited. Edit mode is for
 *     arranging boxes, and a canvas that still grabbed the pointer to orbit
 *     would be a hole in that.
 */

/* `load` runs before anything is built: it returns { data } to go ahead, or
 * { empty: { message, actionLabel, actionHref } } to show a sentence instead.
 * `build({ sceneHost, data, chrome, setCaption })` then fills the scene and
 * returns { destroy() } for whatever it made -- it may be async (both widgets
 * import their scene module inside it), and is awaited so that destroy()
 * always has the finished thing to tear down rather than a promise of one.
 */
export function createSceneWidget(host, { load, build }) {
  const frame = document.createElement("div");
  frame.className = "widget-scene";

  const mount = document.createElement("div");
  mount.className = "widget-scene-canvas";
  frame.appendChild(mount);

  // Controls the widget puts over its scene (a toggle or two). Empty and
  // therefore invisible until the widget adds something.
  const chrome = document.createElement("div");
  chrome.className = "widget-scene-chrome";
  frame.appendChild(chrome);

  const caption = document.createElement("div");
  caption.className = "widget-scene-caption";
  frame.appendChild(caption);

  const status = document.createElement("div");
  status.className = "widget-scene-status";
  frame.appendChild(status);

  host.el.appendChild(frame);

  let cancelled = false;
  let sceneHost = null;
  let contents = null;
  let unsubscribeEdit = null;

  function setCaption(text) {
    caption.textContent = text || "";
  }

  function showStatus(message, actionLabel, actionHref) {
    status.innerHTML = "";
    const line = document.createElement("p");
    line.className = "muted";
    line.textContent = message;
    status.appendChild(line);
    if (actionLabel && actionHref) {
      const link = document.createElement("a");
      link.className = "btn";
      link.href = actionHref;
      link.textContent = actionLabel;
      status.appendChild(link);
    }
    status.hidden = false;
  }

  async function boot() {
    showStatus("Loading…");
    let outcome;
    try {
      outcome = await load();
    } catch (err) {
      if (cancelled) return;
      showStatus(err.message || String(err));
      return;
    }
    if (cancelled) return;

    if (outcome.empty) {
      const { message, actionLabel, actionHref } = outcome.empty;
      showStatus(message, actionLabel, actionHref);
      return;
    }

    // Only now is the renderer worth loading: a project page with no 3D
    // widget on it never pays for Three.js at all.
    const { createSceneHost } = await import("../shared/scene-host.js");
    if (cancelled) return;

    status.hidden = true;
    status.innerHTML = "";

    // Transparent rather than the graph pages' opaque theme colour, so the
    // scene sits on the project's own background -- including a custom one --
    // instead of laying a pale rectangle over it. On a project that hasn't
    // changed its background the two are the same colour anyway, which is
    // what makes an embedded scene read as the same picture as the full-page
    // view it came from.
    // Held locally until it is finished and running. destroy() can land at any
    // await in here, and it can only tear down what it has been given -- so
    // anything half-built is this function's own to clean up, below.
    const scene = createSceneHost(mount, { background: null });
    let built;
    try {
      built = (await build({ sceneHost: scene, data: outcome.data, chrome, setCaption })) || {};
    } catch (err) {
      scene.dispose();
      if (!cancelled) showStatus(err.message || String(err));
      return;
    }

    // Removed while its scene was still being built.
    if (cancelled) {
      built.destroy?.();
      scene.dispose();
      return;
    }

    sceneHost = scene;
    contents = built;
    scene.start();

    // Fires once immediately, so a widget mounted while the grid is already
    // being edited starts inert rather than waiting for the next flip.
    unsubscribeEdit = host.editMode?.subscribe((editing) => {
      sceneHost?.setInteractive(!editing);
    });
  }

  // Both halves of a resize are the scene host's job (registry.js's
  // host.onResize spells out why a WebGL canvas needs both).
  host.onResize(() => sceneHost?.resize());

  boot();

  return {
    destroy() {
      cancelled = true;
      unsubscribeEdit?.();
      // Contents first: each map disposes what it built into the scene, then
      // the host throws away the context that was drawing it.
      contents?.destroy?.();
      sceneHost?.dispose();
      sceneHost = null;
      contents = null;
      frame.remove();
    },
  };
}
