/* The browser's side of the portfolio staging store (portfolio.py): every call
 * the spread, the Portfolio widget and its management view make, and nothing
 * that draws. Same arrangement as folders.js.
 *
 * A staged page is a working file, not an archive reference. Staging one is a
 * plain upload -- no tagging, no embedding, no queue to wait on -- and the
 * response is the page. Only promotePage() reaches the archive.
 */

export const thumbUrl = (pageId) => `/api/portfolio/pages/${pageId}/thumb`;
export const fileUrl = (pageId) => `/api/portfolio/pages/${pageId}/file`;

async function request(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || "that didn't work");
  return body;
}

const post = (path, body) =>
  request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

/** The staged pages, where each one sits, and every spread's slots in order. */
export const loadPortfolio = (projectId) => request(`/api/projects/${projectId}/portfolio`);

/** Stage several files at once. Resolves to { pages, errors } -- a file that
 *  couldn't be staged is in `errors` and doesn't stop the rest; rejects only
 *  when nothing at all was staged. `orientation`/`fit` choose the print check
 *  each page comes back with. */
export async function stagePages(projectId, files, { orientation, fit } = {}) {
  const form = new FormData();
  for (const file of files) form.append("file", file, file.name);
  if (orientation) form.append("orientation", orientation);
  if (fit) form.append("fit", fit);
  const res = await fetch(`/api/projects/${projectId}/portfolio/pages`, { method: "POST", body: form });
  const body = await res.json().catch(() => null);
  if (!res.ok && !body?.pages?.length) throw new Error(body?.error || "the pages couldn't be added");
  return body;
}

/** One file. Resolves to the staged page (with its `print` check). */
export async function stagePage(projectId, file, options) {
  const { pages } = await stagePages(projectId, [file], options);
  return pages[0];
}

export const deletePage = (pageId) => request(`/api/portfolio/pages/${pageId}`, { method: "DELETE" });

/** Stage `file` in place of a page: it takes every slot the old one held, and
 *  the old one stays in the store as an earlier version. */
export async function replacePage(pageId, file) {
  const form = new FormData();
  form.append("file", file, file.name);
  return request(`/api/portfolio/pages/${pageId}/replace`, { method: "POST", body: form });
}

/** Add a page to the archive as own work -- the one call here that tags and
 *  embeds. { reference_id, created }: created is false if the archive already
 *  held it. Slow (Claude, then CLIP), so callers do these one at a time. */
export const promotePage = (pageId) => post(`/api/portfolio/pages/${pageId}/promote`);

export const placePage = (pageId, nodeId, index) =>
  post(`/api/portfolio/pages/${pageId}/place`, { node_id: nodeId, index });

export const fillSpread = (projectId, nodeId) =>
  post(`/api/projects/${projectId}/portfolio/fill`, { node_id: nodeId });

// --- what the canvas needs to know about a page ---------------------------------

/* A spread's entry holds only a page id, but the canvas needs the page's size
 * to say how it will print. That used to be read off the thumbnail <img> --
 * which is now a 400px copy, and would call every page low resolution -- so it
 * comes from the store's own record instead, which holds the real pixels.
 * One cache per project, shared by every spread on the canvas. */

const registries = new Map();

export function pageRegistry(projectId) {
  if (!registries.has(projectId)) {
    const pages = new Map();
    let loading = null;
    registries.set(projectId, {
      get: (id) => pages.get(id) || null,
      put(page) {
        pages.set(page.id, page);
      },
      /** Fetch every staged page's record; concurrent callers share one request. */
      load() {
        loading ||= loadPortfolio(projectId)
          .then((overview) => {
            pages.clear();
            for (const page of overview.pages) pages.set(page.id, page);
          })
          .finally(() => {
            loading = null;
          });
        return loading;
      },
    });
  }
  return registries.get(projectId);
}

// --- export -----------------------------------------------------------------------

/** What exporting a spread at `dpi` (or the widget's value, if omitted) will do
 *  to each page. */
export const exportPlan = (nodeId, dpi) =>
  request(`/api/canvas/nodes/${nodeId}/export-plan${dpi ? `?dpi=${encodeURIComponent(dpi)}` : ""}`);

function newJobId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The download is a real navigation, not a fetch turned into a Blob: a Blob
// "download" doesn't save in the desktop build's WKWebView (export.py says why),
// and a navigation is what every other download here uses. The cost is that
// the page that started it never hears when it ends, so the server reports
// that itself, under the name given in ?job=.
const START_PATIENCE_MS = 90_000; // a "where to save?" prompt can sit a while
const EXPORT_PATIENCE_MS = 15 * 60_000;

/** Start a spread's PDF download and resolve once the server has sent the last
 *  byte of it: "done", or "failed" / "cancelled" / "timeout". `dpi` is a
 *  one-off override; leave it out for the Portfolio widget's value. */
export async function exportPdf(nodeId, { dpi } = {}) {
  const job = newJobId();
  const link = document.createElement("a");
  link.href = `/api/canvas/nodes/${nodeId}/export.pdf?job=${job}${dpi ? `&dpi=${encodeURIComponent(dpi)}` : ""}`;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();

  const started = Date.now();
  let seenRunning = false;
  while (Date.now() - started < EXPORT_PATIENCE_MS) {
    await sleep(600);
    let state;
    try {
      ({ state } = await request(`/api/portfolio/exports/${job}`));
    } catch {
      continue; // a hiccup mid-poll -- ask again
    }
    if (state === "done" || state === "failed" || state === "cancelled") return state;
    if (state === "running") seenRunning = true;
    else if (!seenRunning && Date.now() - started > START_PATIENCE_MS) return "timeout";
  }
  return "timeout";
}

const pageList = (numbers) =>
  numbers.length === 1
    ? `Page ${numbers[0]}`
    : `Pages ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;

/** An export plan (exportPlan's answer) as the sentences worth saying about it:
 *  what gets resampled, and what is below the target and left as it is --
 *  warned about, because resampling up invents detail that was never there.
 *  Past tense for after an export, `future` for the dialog before one. Empty
 *  when there is nothing to say. */
export function describePlan(plan, { future = false } = {}) {
  const notes = [];
  const { downsampled, below_target: below, dpi } = plan;
  const tense = (numbers) => (future ? "will be" : numbers.length === 1 ? "was" : "were");
  if (downsampled.length) {
    notes.push(`${pageList(downsampled)} ${tense(downsampled)} resampled down to ${dpi} dpi.`);
  }
  if (below.length) {
    const many = below.length > 1;
    notes.push(
      `${pageList(below)} ${many ? "are" : "is"} below ${dpi} dpi, so ${many ? "they" : "it"} ${tense(below)} left as ` +
        `${many ? "they" : "it"} came — enlarging would only invent detail.`
    );
  }
  return notes;
}
