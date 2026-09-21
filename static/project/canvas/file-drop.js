/* Loose files dropped onto the canvas from Finder.
 *
 * palette.js's drags are pointer events end to end -- pointerdown, pointer-
 * move, pointerup, never a native HTML5 drag -- because that's the mechanism
 * nodes.js already used for moving things once they're on the canvas, and
 * because a real native drag never promoted past pointerdown in the desktop
 * wrapper (see palette.js's own header comment). A file arriving from Finder
 * is the opposite case: it carries no pointerdown at all, only dragenter/
 * dragover/drop with a real OS payload in `dataTransfer.files`. The two
 * gestures never collide, because nothing here is ever `draggable` and
 * nothing the palette drags ever carries files -- an internal drag simply
 * never fires a drag* event for this listener to see.
 *
 * A dropped folder shows up in `dataTransfer.files` as a same-shaped "file":
 * zero bytes, no extension, no MIME type. Reading `webkitGetAsEntry()` would
 * tell folder and file apart for certain, but hard rule 5 reserves that API
 * for actual folder handling (which this isn't) and forbids a third use of
 * it -- so a folder is refused by the same by-extension check as any other
 * unsupported file, using that same zero-byte/no-extension shape only to
 * pick a clearer message, never to open or walk the thing.
 */

import { classifyDrop, PREVIEWABLE_EXTS } from "./file-types.js";

// Same step and wrap palette.js's own cascade uses for a repeated click-to-add
// -- a multi-file drop reads as the same "fan out, don't stack" gesture.
const CASCADE_STEP = 26;
const CASCADE_WRAP = 6;

const POLL_INTERVAL_MS = 1200;
// 3 minutes: Claude tagging plus a CLIP embed, worst case behind a cold model
// load. Generous on purpose -- the placeholder already tells the user
// something is happening, so waiting costs nothing but patience.
const POLL_ATTEMPTS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function refusalMessage(file, isFolder) {
  if (isFolder) {
    return "Folders can't be dropped onto the canvas — add one from the Add tab.";
  }
  return `"${file.name}" isn't a file this archive can add — see the Add tab for supported types.`;
}

function cascadePoint(base, index) {
  const offset = (index % CASCADE_WRAP) * CASCADE_STEP;
  return { x: base.x + offset, y: base.y + offset };
}

async function pollCapture(captureId) {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    let summary;
    try {
      const res = await fetch(`/api/captures/${captureId}`);
      if (!res.ok) continue;
      summary = await res.json();
    } catch {
      continue; // a network hiccup mid-poll -- try again next tick
    }
    if (summary.status === "done" || summary.status === "duplicate") {
      return { ok: true, referenceId: summary.reference_id };
    }
    if (summary.status === "failed") {
      return { ok: false, error: summary.error || "ingestion failed" };
    }
  }
  return { ok: false, error: "timed out waiting for the archive" };
}

/** One dropped file, start to finish: placeholder, upload, poll, swap-in.
 *  Runs to completion on its own -- callers fire-and-forget one of these per
 *  file in a multi-drop, so a slow or failing item never blocks the rest. */
async function ingestOne({ file, ext, point, project, nodes, onStatus }) {
  const previewUrl = PREVIEWABLE_EXTS.has(ext) ? URL.createObjectURL(file) : null;
  const label = ext === ".pdf" ? "PDF" : "TXT";
  const pending = nodes.addPendingReference(point, { previewUrl, label });

  let summary;
  try {
    const form = new FormData();
    // No page metadata to send -- this is a local file, not a captured
    // page -- so the envelope is just enough for capture.py to route it:
    // project_ids is what lands the reference in the project it was dropped
    // into, the same field the browser extension already sends.
    form.append("capture", JSON.stringify({ type: "file", project_ids: [project.id] }));
    form.append("file", file, file.name);
    const res = await fetch("/api/captures", { method: "POST", body: form });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || "the archive refused this file");
    summary = body;
  } catch (err) {
    pending.remove();
    onStatus(`Couldn't add "${file.name}" — ${err.message}.`);
    return;
  }

  const resolved = await pollCapture(summary.capture_id);
  pending.remove();

  if (!resolved.ok) {
    onStatus(`"${file.name}" couldn't be added — ${resolved.error}.`);
    return;
  }

  // A newly-ingested reference (or one this project hadn't seen before, in
  // the duplicate case) isn't in the reference list this page loaded at
  // boot -- registerReference makes it addressable before addNode tries to
  // render a card for it.
  const refRes = await fetch(`/api/references/${resolved.referenceId}`).catch(() => null);
  if (!refRes || !refRes.ok) {
    onStatus(`"${file.name}" was added to the archive, but couldn't be placed on the canvas.`);
    return;
  }
  const ref = await refRes.json();
  nodes.registerReference(ref);
  await nodes.addNode({ kind: "reference", reference_id: ref.id, x: point.x, y: point.y });
}

/** Wire native file drops on `viewport.container` into the capture pipeline.
 *  Mirrors palette.js's `isOverCanvas`/is-drop-target treatment so both drag
 *  sources read the same way to the person doing the dragging, even though
 *  the underlying event types share nothing. */
export function createFileDrop({ viewport, project, nodes, onStatus }) {
  const container = viewport.container;
  // dragenter/dragleave fire on every element boundary the pointer crosses
  // while over the container's subtree, not just the container itself -- a
  // depth counter is the standard fix, since enter and leave always balance
  // even when they fire on different descendants along the way.
  let depth = 0;

  const isFileDrag = (event) =>
    Array.from(event.dataTransfer?.types || []).includes("Files");

  function onDragEnter(event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth += 1;
    container.classList.add("is-drop-target");
  }

  function onDragOver(event) {
    if (!isFileDrag(event)) return;
    // Chrome (and most browsers) only fire `drop` if every dragover in
    // between called preventDefault -- its default action is "refuse".
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(event) {
    if (!isFileDrag(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) container.classList.remove("is-drop-target");
  }

  function onDrop(event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth = 0;
    container.classList.remove("is-drop-target");

    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    const base = viewport.screenToWorld(event.clientX, event.clientY);

    let placed = 0;
    for (const file of files) {
      const verdict = classifyDrop(file);
      if (!verdict.ok) {
        onStatus(refusalMessage(file, verdict.isFolder));
        continue;
      }
      const point = cascadePoint(base, placed);
      placed += 1;
      ingestOne({ file, ext: verdict.ext, point, project, nodes, onStatus });
    }
  }

  container.addEventListener("dragenter", onDragEnter);
  container.addEventListener("dragover", onDragOver);
  container.addEventListener("dragleave", onDragLeave);
  container.addEventListener("drop", onDrop);

  return {
    destroy() {
      container.removeEventListener("dragenter", onDragEnter);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("dragleave", onDragLeave);
      container.removeEventListener("drop", onDrop);
    },
  };
}
