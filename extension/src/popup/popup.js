/**
 * The popup: review what's on the page, then save it.
 *
 * Deliberately thin. It asks the content script what's here, shows it, and
 * hands captures to the archive. It holds no archive state of its own -- the
 * project list is fetched live, and once a capture is accepted the archive's
 * queue owns it.
 */
import {
  health, listProjects, checkDuplicate, createCapture, createCaptureBatch,
  ArchiveUnavailableError,
} from "../services/api.js";
import { getSettings, rememberProject } from "../services/settings.js";
import { ensureCollector, sendToTab as sendToTabRaw } from "../services/inject.js";
import { dataUrlToBlob } from "../services/download.js";

const el = (id) => document.getElementById(id);

const state = {
  tabId: null,
  page: null,
  /** Indices into page.images that the user has selected. */
  selected: new Set(),
  /** Index into page.pdfs of the chosen document, or null. Single-select --
   * unlike images, "which PDF" isn't a multi-select question in practice. */
  selectedPdf: null,
  mode: "image",
  projects: [],
  archiveOk: false,
};

init();

async function init() {
  bindEvents();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  el("page-title").textContent = tab?.title || "This page";
  el("page-domain").textContent = safeDomain(tab?.url);

  // Both are slow-ish and independent, so don't serialise them.
  await Promise.all([loadArchive(), loadPage()]);
}

function bindEvents() {
  for (const btn of document.querySelectorAll(".mode-btn")) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  }
  el("save-btn").addEventListener("click", save);
  el("retry-btn").addEventListener("click", loadArchive);
  el("select-all-btn").addEventListener("click", toggleSelectAll);
  el("project").addEventListener("change", () => {
    renderRecentProjects();
    refreshSaveButton();
  });
}

// --- loading ---------------------------------------------------------------

async function loadArchive() {
  const status = await health();
  state.archiveOk = status.ok;
  el("unavailable").hidden = status.ok;
  if (!status.ok) {
    el("unavailable-detail").textContent =
      `${status.error}. Start the reference library, then retry.`;
    refreshSaveButton();
    return;
  }

  try {
    state.projects = await listProjects();
  } catch {
    state.projects = [];
  }
  await renderProjects();
  refreshSaveButton();
}

async function loadPage() {
  if (state.tabId == null) return;

  try {
    await ensureCollector(state.tabId);
  } catch (err) {
    // Chrome forbids scripting on some pages (the Web Store, chrome://,
    // the new-tab page) -- that surfaces here as a rejected promise.
    showPageError(err.message || "cannot read this page");
    return;
  }

  const described = await sendToTab({ type: "describe-page" });
  if (!described.ok) {
    showPageError(described.error);
    return;
  }

  state.page = described.page;
  el("page-title").textContent = state.page.source.page_title || el("page-title").textContent;
  el("page-domain").textContent = state.page.source.domain || "";

  renderImages();
  renderPdfs();
  renderSelection();
  renderPagePreview();
  renderMetadata();

  // Land on whichever mode the page actually offers: a highlighted quote is a
  // deliberate act, so it wins over everything else. A detected PDF beats
  // the image grid -- on a document-reader page, whatever findImages() found
  // is usually page fragments, not something worth offering as the default.
  if (state.page.selection) setMode("text");
  else if (state.page.pdfs?.length) setMode("pdf");
  else if (state.page.images.length) setMode("image");
  else setMode("page");
}

function sendToTab(message) {
  return sendToTabRaw(state.tabId, message);
}

function showPageError(message) {
  el("image-empty").hidden = false;
  el("image-empty").textContent = `Can't read this page — ${message}`;
  el("text-empty").hidden = false;
  refreshSaveButton();
}

// --- rendering -------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  for (const btn of document.querySelectorAll(".mode-btn")) {
    btn.classList.toggle("is-active", btn.dataset.mode === mode);
  }
  el("mode-image").hidden = mode !== "image";
  el("mode-pdf").hidden = mode !== "pdf";
  el("mode-text").hidden = mode !== "text";
  el("mode-page").hidden = mode !== "page";
  el("duplicate").hidden = true;
  refreshSaveButton();
  if (mode === "image" || mode === "pdf") maybeCheckDuplicate();
}

function renderImages() {
  const grid = el("image-grid");
  grid.textContent = "";
  const images = state.page?.images || [];

  el("image-empty").hidden = images.length > 0;
  el("grid-actions").hidden = images.length === 0;

  images.forEach((img) => {
    const btn = document.createElement("button");
    btn.className = "thumb";
    btn.title = img.image_alt || img.caption || img.image_url;

    const thumb = document.createElement("img");
    thumb.src = img.image_url;
    thumb.alt = "";
    // A thumbnail that won't load is one we probably can't download either,
    // so drop it rather than offering a broken tile.
    thumb.addEventListener("error", () => {
      state.selected.delete(img.index);
      btn.remove();
      refreshSelectionCount();
    });

    const light = document.createElement("span");
    light.className = "light";
    btn.append(thumb, light);

    if (img.width && img.height) {
      const dims = document.createElement("span");
      dims.className = "dims";
      dims.textContent = `${img.width}×${img.height}`;
      btn.appendChild(dims);
    }

    btn.addEventListener("click", () => {
      if (state.selected.has(img.index)) state.selected.delete(img.index);
      else state.selected.add(img.index);
      btn.classList.toggle("is-selected", state.selected.has(img.index));
      refreshSelectionCount();
      maybeCheckDuplicate();
    });

    grid.appendChild(btn);
  });

  // Pre-select the best candidate so the common case is one click.
  if (images.length) {
    state.selected.add(images[0].index);
    grid.firstElementChild?.classList.add("is-selected");
  }
  refreshSelectionCount();
}

/**
 * List detected PDFs as single-select rows -- not a grid, because unlike
 * images there's normally exactly one document worth saving, and a preview
 * grid isn't possible anyway: a PDF has no thumbnail until something
 * actually renders it, which is exactly the step this mode exists to skip.
 */
function renderPdfs() {
  const list = el("pdf-list");
  list.textContent = "";
  const pdfs = state.page?.pdfs || [];

  el("mode-pdf-btn").hidden = pdfs.length === 0;
  state.selectedPdf = pdfs.length ? 0 : null;

  pdfs.forEach((pdf, index) => {
    const row = document.createElement("button");
    row.className = "pdf-row";
    row.classList.toggle("is-selected", index === state.selectedPdf);
    row.title = pdf.pdf_url;

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "PDF";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = pdf.title;

    const light = document.createElement("span");
    light.className = "light";

    row.append(icon, name, light);
    row.addEventListener("click", () => {
      state.selectedPdf = index;
      for (const sibling of list.children) sibling.classList.remove("is-selected");
      row.classList.add("is-selected");
      refreshSaveButton();
      maybeCheckDuplicate();
    });

    list.appendChild(row);
  });
}

function renderSelection() {
  const selection = state.page?.selection;
  const hasText = Boolean(selection?.selected_text);
  el("text-empty").hidden = hasText;
  el("text-preview").hidden = !hasText;
  el("text-heading").hidden = !(hasText && selection.heading);
  document.querySelector('[data-mode="text"]').disabled = !hasText;

  if (hasText) {
    el("text-preview").textContent = selection.selected_text;
    if (selection.heading) el("text-heading").textContent = `Under: ${selection.heading}`;
  }
}

function renderPagePreview() {
  const source = state.page?.source || {};
  const metadata = state.page?.metadata || {};
  el("page-preview").textContent =
    metadata.description || source.page_title || source.url || "This page";
}

async function renderProjects() {
  const select = el("project");
  // Carry forward an explicit choice; otherwise fall back to the project the
  // last capture went into, which is almost always the one wanted again. The
  // dropdown shows it plainly, so nothing is filed anywhere invisibly.
  const { lastProjectId } = await getSettings();
  const current = select.value || lastProjectId || "";
  select.textContent = "";

  const none = document.createElement("option");
  none.value = "";
  none.textContent = "General archive";
  select.appendChild(none);

  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.title;
    select.appendChild(option);
  }
  // Only keep it if that project still exists -- a deleted project would
  // otherwise leave the select showing nothing at all.
  select.value = current;
  if (select.value !== current) select.value = "";
  await renderRecentProjects();
  refreshSaveButton();
}

async function renderRecentProjects() {
  const { recentProjects } = await getSettings();
  const container = el("recent-projects");
  container.textContent = "";

  const known = recentProjects
    .map((id) => state.projects.find((p) => p.id === id))
    .filter(Boolean);

  container.hidden = known.length === 0;
  for (const project of known) {
    const chip = document.createElement("button");
    chip.className = "recent-chip";
    chip.textContent = project.title;
    chip.classList.toggle("is-active", el("project").value === project.id);
    chip.addEventListener("click", () => {
      el("project").value = project.id;
      renderRecentProjects();
    });
    container.appendChild(chip);
  }
}

/**
 * Show every extracted field with where it came from.
 *
 * The origin badge is the point: a JSON-LD creator and a guess from nearby
 * text look identical as strings, and only one of them should be trusted.
 */
function renderMetadata() {
  const list = el("metadata-list");
  list.textContent = "";
  const records = state.page?.provenance || [];

  if (!records.length) {
    const row = document.createElement("div");
    const dd = document.createElement("dd");
    dd.className = "muted";
    dd.textContent = "Nothing found on this page.";
    row.appendChild(dd);
    list.appendChild(row);
    return;
  }

  for (const record of records) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = record.field.replace(/_/g, " ");
    const dd = document.createElement("dd");
    dd.textContent = record.value;

    const origin = document.createElement("span");
    origin.className = `origin ${record.confidence}`;
    origin.textContent = record.source === "inferred" ? "AI inferred" : record.source;
    dd.appendChild(origin);

    row.append(dt, dd);
    list.appendChild(row);
  }
}

function refreshSelectionCount() {
  const n = state.selected.size;
  el("selection-count").textContent = `${n} selected`;
  el("select-all-btn").textContent =
    n === (state.page?.images.length || 0) ? "Clear" : "Select all";
  refreshSaveButton();
}

function toggleSelectAll() {
  const images = state.page?.images || [];
  const all = state.selected.size === images.length;
  state.selected = all ? new Set() : new Set(images.map((i) => i.index));
  for (const [i, btn] of [...el("image-grid").children].entries()) {
    btn.classList.toggle("is-selected", !all && i < images.length);
  }
  refreshSelectionCount();
}

function refreshSaveButton() {
  const button = el("save-btn");
  let ready = state.archiveOk;
  let label = "Save";

  if (state.mode === "image") {
    ready = ready && state.selected.size > 0;
    label = state.selected.size > 1 ? `Save ${state.selected.size} references` : "Save reference";
  } else if (state.mode === "pdf") {
    ready = ready && state.selectedPdf !== null;
    label = "Save document";
  } else if (state.mode === "text") {
    ready = ready && Boolean(state.page?.selection?.selected_text);
    label = "Save quotation";
  } else {
    ready = ready && Boolean(state.page);
    label = "Save page";
  }

  button.disabled = !ready;
  button.textContent = label;
}

// --- duplicate pre-check ---------------------------------------------------

async function maybeCheckDuplicate() {
  el("duplicate").hidden = true;
  if (!state.archiveOk) return;

  let content;
  if (state.mode === "image" && state.selected.size === 1) {
    const image = imageFor([...state.selected][0]);
    if (!image) return;
    content = { image_url: image.original_image_url || image.image_url };
  } else if (state.mode === "pdf" && state.selectedPdf !== null) {
    const pdf = pdfFor(state.selectedPdf);
    if (!pdf) return;
    content = { image_url: pdf.pdf_url };
  } else {
    return;
  }

  const result = await checkDuplicate({ type: "image", source: state.page.source, content });

  if (result?.duplicate && result.match) {
    el("duplicate").hidden = false;
    el("duplicate-detail").textContent = result.match.title
      ? `Saved already as “${result.match.title}”. Saving again will add it to the chosen project.`
      : "This one is already being saved.";
  }
}

function imageFor(index) {
  return (state.page?.images || []).find((i) => i.index === index) || null;
}

function pdfFor(index) {
  return (state.page?.pdfs || [])[index] || null;
}

// --- saving ----------------------------------------------------------------

async function save() {
  const button = el("save-btn");
  button.disabled = true;
  setStatus("Saving…");
  el("results").hidden = true;
  el("results").textContent = "";

  const projectId = el("project").value;
  const opts = {
    user_note: el("note").value,
    project_ids: projectId ? [projectId] : [],
  };

  try {
    if (state.mode === "image") await saveImages(opts);
    else if (state.mode === "pdf") await savePdf(opts);
    else if (state.mode === "text") await saveEnvelope("envelope-selection", opts);
    else await saveEnvelope("envelope-page", opts);

    if (projectId) await rememberProject(projectId);
  } catch (err) {
    if (err instanceof ArchiveUnavailableError) {
      el("unavailable").hidden = false;
      el("unavailable-detail").textContent = "Lost contact while saving. Nothing was lost — retry.";
      setStatus("");
    } else {
      setStatus(`Failed: ${err.message}`);
    }
  } finally {
    refreshSaveButton();
  }
}

async function saveEnvelope(messageType, opts) {
  const built = await sendToTab({ type: messageType, opts });
  if (!built.ok) throw new Error(built.error);
  await createCapture(built.envelope);
  setStatus("Saved — processing in the archive.");
}

/** Ask the background service worker to fetch bytes it's privileged to read
 * -- an image or a PDF, whichever the caller is downloading.
 *
 * The popup itself can't do this reliably: it's a privileged context too, so
 * it *could* fetch cross-origin, but Chrome destroys the popup document the
 * instant it loses focus -- one stray click outside it aborts an in-flight
 * download. The background service worker isn't tied to the popup's
 * lifetime, so the fetch happens there and the bytes come back as a data URL.
 */
function downloadFile(url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "download-file", url }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "no response from the extension" });
    });
  });
}

/**
 * Get a file's bytes, choosing whichever context can actually read it.
 *
 * Neither downloader is strictly better -- they fail in opposite directions:
 *
 *   - The page can fetch same-origin URLs with full session and referrer,
 *     but is blocked by CORS on anything cross-origin.
 *   - The background worker ignores CORS entirely, but sends no referrer,
 *     which hotlink-protected hosts answer with 403.
 *
 * So: same-origin goes through the page (a paywalled PDF served from the
 * article's own domain needs that session), everything else through the
 * background worker, and a same-origin attempt that fails for some other
 * reason still falls back rather than giving up.
 */
async function fetchBytes(url) {
  if (isSameOriginAsPage(url)) {
    const viaPage = await sendToTab({ type: "download-same-origin", url });
    if (viaPage.ok) return viaPage;
    if (!viaPage.crossOrigin) return viaPage; // a real failure, not a routing miss
  }
  return downloadFile(url);
}

function isSameOriginAsPage(url) {
  try {
    const pageUrl = state.page?.source?.url;
    if (!pageUrl) return false;
    return new URL(url, pageUrl).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Save the selected images.
 *
 * Each image is downloaded individually, so per-item failures (a dead link, a
 * host that blocks the request outright) are reported per row rather than
 * sinking the whole selection.
 */
async function saveImages(opts) {
  const indices = [...state.selected];
  const items = [];
  const failures = [];

  for (const index of indices) {
    const image = imageFor(index);
    setStatus(`Preparing ${items.length + failures.length + 1} of ${indices.length}…`);

    const built = await sendToTab({ type: "envelope-image", index, opts });
    if (!built.ok) {
      failures.push({ label: labelFor(image), error: built.error });
      continue;
    }

    const fetched = await fetchBytes(built.envelope.content.image_url);
    if (!fetched.ok) {
      failures.push({ label: labelFor(image), error: fetched.error });
      continue;
    }

    items.push({
      envelope: built.envelope,
      blob: await dataUrlToBlob(fetched.dataUrl),
      label: labelFor(image),
    });
  }

  if (!items.length) {
    renderResults([], failures);
    throw new Error(failures[0]?.error || "nothing could be downloaded");
  }

  setStatus(`Sending ${items.length}…`);
  const accepted = [];

  if (items.length === 1) {
    const result = await createCapture(items[0].envelope, items[0].blob);
    accepted.push({ label: items[0].label, status: result.status });
  } else {
    const response = await createCaptureBatch(items);
    const results = response.results || [];
    // The archive returns one result per submitted capture. Iterate over what
    // was *sent* rather than what came back, so a short or malformed response
    // shows the missing ones as unknown instead of quietly dropping them.
    items.forEach((item, i) => {
      const r = results[i];
      if (!r) failures.push({ label: item.label, error: "no result returned" });
      else if (r.ok) accepted.push({ label: item.label, status: r.status });
      else failures.push({ label: item.label, error: r.error });
    });
  }

  renderResults(accepted, failures);
  setStatus(
    failures.length
      ? `${accepted.length} saved, ${failures.length} failed.`
      : "Saved — processing in the archive."
  );
}

/**
 * Save the chosen document, whole -- one file, not a batch of page images.
 * The archive's own PDF pipeline (text + largest embedded figures, tagged
 * together) takes it from here once the bytes arrive.
 */
async function savePdf(opts) {
  const pdf = pdfFor(state.selectedPdf);
  if (!pdf) throw new Error("no document selected");

  setStatus("Downloading document…");
  const built = await sendToTab({ type: "envelope-pdf", index: state.selectedPdf, opts });
  if (!built.ok) throw new Error(built.error);

  const fetched = await fetchBytes(built.envelope.content.image_url);
  if (!fetched.ok) throw new Error(fetched.error);

  setStatus("Sending…");
  const result = await createCapture(built.envelope, await dataUrlToBlob(fetched.dataUrl));
  renderResults([{ label: pdf.title, status: result.status }], []);
  setStatus("Saved — processing in the archive.");
}

function labelFor(image) {
  if (!image) return "image";
  const label = image.image_alt || image.caption || filenameOf(image.image_url);
  // Alt text and captions can be a whole sentence, and a filename can be a
  // long hash -- keep the row (and its tooltip) readable.
  return label.length > 70 ? `${label.slice(0, 69)}…` : label;
}

function filenameOf(url) {
  // An inline image's "path" is its entire base64 payload, which is useless
  // as a label and enormous as a tooltip.
  if (typeof url === "string" && url.startsWith("data:")) return "inline image";
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    return name || new URL(url).hostname || "image";
  } catch {
    return "image";
  }
}

/** Per-item outcome, so a partial batch is legible. */
function renderResults(accepted, failures) {
  const container = el("results");
  container.textContent = "";
  container.hidden = accepted.length + failures.length < 2;

  for (const item of accepted) {
    container.appendChild(resultRow("ok", "✓", item.label));
  }
  for (const item of failures) {
    container.appendChild(resultRow("fail", "⚠", `${item.label} — ${item.error}`));
  }
}

function resultRow(kind, icon, text) {
  const row = document.createElement("div");
  row.className = `result-row ${kind}`;
  const i = document.createElement("span");
  i.className = "icon";
  i.textContent = icon;
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = text;
  label.title = text;
  row.append(i, label);
  return row;
}

function setStatus(text) {
  el("status").textContent = text;
}

function safeDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
