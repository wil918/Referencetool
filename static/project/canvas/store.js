/* Every call the canvas makes to the API, and the queue that batches the
 * chatty ones.
 *
 * The canvas has no Save button, which is the whole difference between it and
 * the homepage grid: a drag is committed the moment the pointer is released,
 * a lock the moment it is clicked, a text edit the moment focus leaves. That
 * only works if the writes are cheap, so:
 *
 *   - Structure -- adding and deleting nodes and edges -- goes straight out
 *     on its own route and is awaited, because the caller needs the row back
 *     (a new node's id) or needs to know it failed.
 *
 *   - Everything else is a partial PATCH of one node, coalesced per node id
 *     and flushed after a short pause. A drag is hundreds of pointermoves and
 *     one write; a drag followed by a lock is still one write. app.py's PATCH
 *     route only touches the fields it is sent, so merging a move and a lock
 *     into one body is safe in a way a bulk PUT would not be -- and the bulk
 *     PUT is deliberately never used from here: it replaces the whole canvas,
 *     so an incremental edit sent through it would race every other edit.
 */

// Long enough to swallow a whole drag, short enough that letting go of a node
// and immediately reloading keeps the drop. Matches the widget config debounce
// in registry.js, which exists for the same reason.
const PATCH_DELAY = 400;

export function createStore(projectId) {
  // node id -> the fields still to be written for it. Merged rather than
  // queued, so the last value of each field is the one that goes out.
  const pending = new Map();
  let timer = null;
  // Fired with a message when a write fails, so the page can say so rather
  // than leaving the screen and the database quietly disagreeing.
  let onError = () => {};

  async function request(path, options) {
    const res = await fetch(path, options);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || "The canvas couldn't be saved.");
    return body;
  }

  // --- reads ---------------------------------------------------------------

  const load = () => request(`/api/projects/${projectId}/canvas`);

  // --- structure -----------------------------------------------------------

  const createNode = (fields) =>
    request(`/api/projects/${projectId}/canvas/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });

  function deleteNode(nodeId) {
    // Anything still queued for this node is about to be a PATCH against a
    // row that no longer exists -- a 404, and a spurious error message.
    pending.delete(nodeId);
    return request(`/api/canvas/nodes/${nodeId}`, { method: "DELETE" });
  }

  const createEdge = (sourceNodeId, targetNodeId) =>
    request(`/api/projects/${projectId}/canvas/edges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_node_id: sourceNodeId, target_node_id: targetNodeId }),
    });

  const deleteEdge = (edgeId) => request(`/api/canvas/edges/${edgeId}`, { method: "DELETE" });

  // --- the debounced patch queue -------------------------------------------

  /** Queue a partial update for one node. Fields merge with anything already
   *  waiting for that node; the write goes out once the user pauses. */
  function patchNode(nodeId, fields) {
    pending.set(nodeId, { ...(pending.get(nodeId) || {}), ...fields });
    clearTimeout(timer);
    timer = setTimeout(flush, PATCH_DELAY);
  }

  /* Send everything waiting.
   *
   * `keepalive` is for the unload path: the browser is allowed to abandon an
   * ordinary fetch as the document goes away, which is exactly the moment a
   * just-finished drag is still sitting in the queue.
   */
  function flush({ keepalive = false } = {}) {
    clearTimeout(timer);
    timer = null;
    if (pending.size === 0) return Promise.resolve();

    const batch = [...pending.entries()];
    pending.clear();

    return Promise.all(
      batch.map(([nodeId, fields]) =>
        request(`/api/canvas/nodes/${nodeId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields),
          keepalive,
        }).catch((err) => onError(err.message))
      )
    );
  }

  // A drag finished a fraction of a second before the tab closed is still a
  // drag the user made. pagehide rather than beforeunload: it also fires when
  // the page goes into the back/forward cache, where beforeunload does not.
  const onPageHide = () => flush({ keepalive: true });
  window.addEventListener("pagehide", onPageHide);

  return {
    load,
    createNode,
    deleteNode,
    createEdge,
    deleteEdge,
    patchNode,
    flush,
    setErrorHandler(fn) {
      onError = fn || (() => {});
    },
    destroy() {
      window.removeEventListener("pagehide", onPageHide);
      // Leaving the canvas is an unload as far as pending edits are concerned.
      flush();
    },
  };
}
