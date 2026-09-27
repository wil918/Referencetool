/* The canvas's side of capture.py's queue: hand a file over, then wait for
 * the worker to turn it into a reference.
 *
 * Two things put files on the canvas -- a drop from Finder (file-drop.js) and
 * an upload onto a spread's page (spread.js) -- and both go through the same
 * POST /api/captures the browser extension uses, rather than a second upload
 * path: the request returns as soon as the bytes are on disk, and tagging and
 * embedding happen on the worker afterwards.
 */

const POLL_INTERVAL_MS = 1200;
// 3 minutes: Claude tagging plus a CLIP embed, worst case behind a cold model
// load. Generous on purpose -- the placeholder already tells the user
// something is happening, so waiting costs nothing but patience.
const POLL_ATTEMPTS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Upload one file into the capture queue. Resolves to the capture summary
 *  (capture_id, status, and `print` when the envelope asked for a print
 *  check); rejects with a readable message if the archive refused it. */
export async function postCapture(file, envelope) {
  const form = new FormData();
  form.append("capture", JSON.stringify(envelope));
  form.append("file", file, file.name);
  const res = await fetch("/api/captures", { method: "POST", body: form });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || "the archive refused this file");
  return body;
}

/** Wait for a capture to finish. Resolves to { ok: true, referenceId } once
 *  it's in the archive (or turned out to be there already), { ok: false,
 *  error } if ingest failed, or { ok: false, timedOut: true } if it's still
 *  going when patience runs out -- which isn't a failure, only a reason to
 *  look again later. `isCancelled()` stops the wait early, for a page that's
 *  going away. */
export async function pollCapture(captureId, { isCancelled = () => false } = {}) {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    if (isCancelled()) return { ok: false, cancelled: true };
    let summary;
    try {
      const res = await fetch(`/api/captures/${captureId}`);
      if (res.status === 404) return { ok: false, error: "the upload was lost" };
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
  return { ok: false, timedOut: true, error: "timed out waiting for the archive" };
}
