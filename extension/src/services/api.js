/**
 * The only place that talks to the archive.
 *
 * Keeping every request behind this module means the extension has exactly
 * one outbound destination -- the configured archive -- which is what makes
 * the privacy claim checkable rather than aspirational.
 *
 * These calls must run from an extension context (popup or service worker),
 * never a content script: a content script's fetch carries the *page's*
 * origin, which the archive's CORS rule deliberately refuses.
 */
import { getSettings } from "./settings.js";

/** Thrown when the archive can't be reached at all, as opposed to refusing. */
export class ArchiveUnavailableError extends Error {
  constructor(message) {
    super(message || "Archive unavailable");
    this.name = "ArchiveUnavailableError";
  }
}

async function request(path, { method = "GET", json, form, timeout = 15000 } = {}) {
  const { endpoint, token } = await getSettings();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    body = form; // let the browser set the multipart boundary
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(`${endpoint}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    // A refused connection and an abort are indistinguishable to fetch, and
    // both mean the same thing to the user: the archive isn't answering.
    throw new ArchiveUnavailableError(
      err.name === "AbortError" ? "Archive timed out" : "Archive unavailable"
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const error = new Error((data && data.error) || `Archive returned ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

/** Is the archive running and reachable? Never throws. */
export async function health() {
  try {
    const data = await request("/api/health", { timeout: 4000 });
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function listProjects() {
  const projects = await request("/api/projects");
  return (projects || []).map((p) => ({
    id: p.id,
    title: p.title,
    reference_count: p.reference_count,
  }));
}

/** Ask whether a capture already exists, by URL. Never blocks a save. */
export async function checkDuplicate(envelope) {
  try {
    return await request("/api/captures/check", {
      method: "POST",
      json: { capture: envelope },
      timeout: 4000,
    });
  } catch {
    return { duplicate: false, match: null };
  }
}

/**
 * Send one capture.
 * @param {Object} envelope
 * @param {Blob} [blob] image bytes, when the capture is an image
 */
export async function createCapture(envelope, blob) {
  if (blob) {
    const form = new FormData();
    form.append("capture", JSON.stringify(envelope));
    form.append("file", blob, filenameFor(envelope, blob));
    return request("/api/captures", { method: "POST", form, timeout: 60000 });
  }
  return request("/api/captures", { method: "POST", json: { capture: envelope } });
}

/**
 * Send several captures at once.
 * @param {Array<{envelope: Object, blob?: Blob}>} items
 */
export async function createCaptureBatch(items) {
  const form = new FormData();
  form.append("captures", JSON.stringify(items.map((i) => i.envelope)));
  items.forEach((item, i) => {
    if (item.blob) form.append(`file${i}`, item.blob, filenameFor(item.envelope, item.blob));
  });
  return request("/api/captures/batch", { method: "POST", form, timeout: 120000 });
}

export async function getCapture(captureId) {
  return request(`/api/captures/${encodeURIComponent(captureId)}`);
}

/**
 * A filename with the right extension.
 *
 * The archive routes on extension (`.jpg` vs `.txt` vs `.pdf`), so this has
 * to reflect the real content type rather than being decorative.
 */
export function filenameFor(envelope, blob) {
  const fromType = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "application/pdf": ".pdf",
  }[blob?.type] || null;

  const url = envelope?.content?.image_url || "";
  let fromUrl = null;
  try {
    const path = new URL(url).pathname;
    const match = /\.(jpe?g|png|gif|webp|bmp|pdf)$/i.exec(path);
    if (match) fromUrl = `.${match[1].toLowerCase()}`.replace(".jpeg", ".jpg");
  } catch {
    fromUrl = null;
  }

  return `capture${fromType || fromUrl || ".jpg"}`;
}
