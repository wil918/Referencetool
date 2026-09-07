// Photo capture on the phone: take or pick a photo, and send it into the
// archive through capture.py's existing pipeline (POST /api/captures).
//
// Nothing here is a second ingest path. capture.py already does the hard part
// -- it accepts a multipart file, writes it to a pending dir, returns 202, and
// a background worker tags and embeds it, surviving restarts. This module only
// produces the envelope that pipeline expects and hands the bytes to the
// phone's offline queue (offline-queue.js), so a photo taken with no
// connection uploads when the Mac is next reachable.
//
// Two things happen before the upload:
//   - iPhone photos are HEIC, which ingest.IMAGE_EXTS does not accept. We
//     decode the photo and re-encode it as JPEG in a canvas, so what reaches
//     the server is always a format it already handles. No HEIC support is
//     added server-side (that would mean a native decoder dependency); the
//     conversion is simpler here and solves the size problem at the same time.
//   - the same re-encode caps the long edge and drops to JPEG quality, taking
//     a ~4 MB photo to a few hundred KB. That matters because the offline
//     queue lives in IndexedDB, which has real size limits, and because the
//     canvas re-encode also strips the photo's EXIF -- including any GPS tag.
//
// This file is phone-only: day-mobile.js mounts it, the shared day.js knows
// nothing about it. Everything visual is drafting.css + day-mobile.css.

import { queueCapture, onCaptureUploaded } from "./offline-queue.js";

// A captured photo useful for CLIP and Claude tagging does not need to be full
// resolution: CLIP encodes at 224 px, and Claude's vision endpoint downscales
// anything over ~1568 px on the long edge. 2048 keeps a little headroom over
// that without storing a 12-megapixel original; 0.82 is visually clean JPEG
// and lands a phone photo around 300-500 KB.
const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.82;

// How long to keep asking the server "is this one done yet". Tagging plus a
// CLIP encode is a few seconds once warm, but the very first capture after a
// reboot downloads the CLIP model (~600 MB), so the ceiling is generous. The
// capture completes server-side regardless of whether we're still watching.
const POLL_INTERVAL_MS = 4000;
const POLL_ATTEMPTS = 75;

let mounted = false;
let projects = [];
// Recent capture attempts, newest first. In memory only: this is status
// feedback, not data the user created -- the photo itself is safe on the
// server or in the offline queue, and a reload simply forgets the little
// "processing / done" line. (CLAUDE.md hard rule 2.)
const items = [];

let root;
let listEl;
let noteInput;
let projectSelect;

// --- mount ---------------------------------------------------------------

/** Build the photo-capture panel into `container`. Idempotent -- day-mobile.js
 *  may call it again after the token screen is re-entered. */
export function mountPhotoCapture(container) {
  if (mounted || !container) return;
  mounted = true;
  root = container;

  root.className = "dr-photo";
  root.innerHTML = "";

  const heading = document.createElement("span");
  heading.className = "dr-label";
  heading.textContent = "Add a photo";

  // One hidden input per source. `capture` asks iOS for the camera directly;
  // without it the same accept= gives the photo library. Both allow multiple
  // so a handful picked from the library each become their own capture.
  const cameraInput = fileInput({ capture: "environment" });
  const libraryInput = fileInput({ multiple: true });

  const actions = document.createElement("div");
  actions.className = "dr-photo-actions";
  actions.append(
    triggerButton("Take photo", cameraInput),
    triggerButton("Choose photo", libraryInput),
  );

  const noteLabel = document.createElement("label");
  noteLabel.className = "dr-photo-field";
  const noteCaption = document.createElement("span");
  noteCaption.className = "dr-micro";
  noteCaption.textContent = "Note (optional)";
  noteInput = document.createElement("input");
  noteInput.type = "text";
  noteInput.className = "dr-photo-note";
  noteInput.placeholder = "why you saved it";
  noteInput.autocapitalize = "sentences";
  noteLabel.append(noteCaption, noteInput);

  const projectLabel = document.createElement("label");
  projectLabel.className = "dr-photo-field";
  const projectCaption = document.createElement("span");
  projectCaption.className = "dr-micro";
  projectCaption.textContent = "Add to project (optional)";
  projectSelect = document.createElement("select");
  projectSelect.className = "dr-photo-project";
  projectSelect.innerHTML = '<option value="">No project</option>';
  projectLabel.append(projectCaption, projectSelect);

  listEl = document.createElement("div");
  listEl.className = "dr-photo-list";

  root.append(heading, actions, noteLabel, projectLabel, cameraInput, libraryInput, listEl);

  loadProjects();

  // A photo that was queued offline and has now uploaded: adopt the server's
  // capture id and start polling it, exactly as an immediate upload does.
  onCaptureUploaded((clientId, summary) => {
    const item = items.find((it) => it.clientId === clientId);
    if (!item) return;
    applyStatus(item, summary);
    poll(item);
  });

  render();
}

function fileInput({ capture, multiple } = {}) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.hidden = true;
  if (capture) input.capture = capture;
  if (multiple) input.multiple = true;
  input.addEventListener("change", () => {
    const files = Array.from(input.files || []);
    input.value = ""; // let the same photo be picked again later
    files.forEach(addOne);
  });
  return input;
}

function triggerButton(text, input) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn";
  btn.textContent = text;
  btn.addEventListener("click", () => input.click());
  return btn;
}

async function loadProjects() {
  try {
    const res = await fetch("/api/projects");
    if (!res.ok) return;
    projects = await res.json();
  } catch {
    return; // offline -- the picker just stays "No project"
  }
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.title;
    projectSelect.appendChild(opt);
  }
}

// --- one photo ---------------------------------------------------------

async function addOne(file) {
  const item = {
    localId: `p${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    clientId: null,
    captureId: null,
    name: file.name || "Photo",
    state: "converting", // converting -> queued|uploading -> processing -> done|duplicate|failed
    thumbUrl: null,
    detail: "",
  };
  items.unshift(item);
  render();

  let blob;
  try {
    blob = await toJpegBlob(file);
  } catch {
    item.state = "failed";
    item.detail = "Couldn't read that photo.";
    render();
    return;
  }

  item.thumbUrl = URL.createObjectURL(blob);
  item.detail = `${Math.round(blob.size / 1024)} KB`;
  item.state = navigator.onLine ? "uploading" : "queued";
  render();

  let result;
  try {
    result = await queueCapture(blob, jpegName(file.name), buildEnvelope());
  } catch (e) {
    item.state = "failed";
    item.detail = e && e.message ? e.message : "Upload failed.";
    render();
    return;
  }

  item.clientId = result.clientId;
  if (result.uploaded && result.summary) {
    applyStatus(item, result.summary);
    poll(item);
  } else {
    item.state = "queued";
    item.detail = "Waiting for the Mac";
    render();
  }
}

function buildEnvelope() {
  const envelope = { type: "image" };
  const note = noteInput.value.trim();
  if (note) envelope.user_note = note;
  if (projectSelect.value) envelope.project_ids = [projectSelect.value];
  return envelope;
}

// Decode the photo (Safari decodes HEIC natively) and redraw it, downscaled,
// into a canvas we read back as JPEG. Drawing an <img> honours the source EXIF
// orientation by default, so the result is upright; the re-encode drops all
// EXIF, GPS included.
//
// Decoding goes through the <img> load event, NOT HTMLImageElement.decode():
// decode() can hang indefinitely in some automated/background contexts, where
// the load event still fires.
async function toJpegBlob(file) {
  const img = await loadImage(file);
  try {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error("empty image");

    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);

    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
        "image/jpeg",
        JPEG_QUALITY,
      );
    });
  } finally {
    if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode failed"));
    };
    img.src = url;
  });
}

function jpegName(name) {
  const stem = (name || "photo").replace(/\.[^.]+$/, "").trim() || "photo";
  return `${stem}.jpg`;
}

// --- status ----------------------------------------------------------

// capture.py's status vocabulary -> our display state. "queued"/"processing"
// on the server both read as "processing" here (the photo is accepted and the
// worker has it); the phone's own pre-upload "queued" is a different thing.
const SERVER_STATE = {
  queued: "processing",
  processing: "processing",
  done: "done",
  duplicate: "duplicate",
  failed: "failed",
};

function applyStatus(item, summary) {
  if (summary.capture_id) item.captureId = summary.capture_id;
  item.state = SERVER_STATE[summary.status] || "processing";
  if (summary.reference && summary.reference.title) {
    item.detail = summary.reference.title;
  } else if (summary.status === "duplicate") {
    item.detail = "Already in the archive";
  } else if (summary.error) {
    item.detail = summary.error;
  } else {
    // Accepted and on the worker now -- drop any "waiting to upload" note so
    // the row falls back to the filename under the "Tagging" label.
    item.detail = "";
  }
  render();
}

async function poll(item) {
  if (!item.captureId) return;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (item.state === "done" || item.state === "duplicate" || item.state === "failed") return;
    await sleep(POLL_INTERVAL_MS);
    let summary;
    try {
      const res = await fetch(`/api/captures/${item.captureId}`);
      if (!res.ok) continue;
      summary = await res.json();
    } catch {
      continue; // lost the connection mid-poll -- try again next tick
    }
    applyStatus(item, summary);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- render ----------------------------------------------------------

const STATE_LABEL = {
  converting: "Preparing",
  queued: "Queued",
  uploading: "Uploading",
  processing: "Tagging",
  done: "Added",
  duplicate: "Duplicate",
  failed: "Failed",
};

function render() {
  if (!listEl) return;
  listEl.innerHTML = "";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "dr-photo-row";
    row.dataset.state = item.state;

    const thumb = document.createElement("span");
    thumb.className = "dr-photo-thumb";
    if (item.thumbUrl) thumb.style.backgroundImage = `url("${item.thumbUrl}")`;

    const body = document.createElement("span");
    body.className = "dr-photo-row-body";

    const state = document.createElement("span");
    state.className = "dr-photo-state";
    state.textContent = STATE_LABEL[item.state] || item.state;

    const detail = document.createElement("span");
    detail.className = "dr-photo-detail";
    detail.textContent = item.detail || item.name;

    body.append(state, detail);
    row.append(thumb, body);
    listEl.appendChild(row);
  }
}
