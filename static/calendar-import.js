// Calendar import: reachable from the Tasks tab, this is the UI for
// ics_import.py's sync_feed -- an uploaded .ics file, or a feed URL that's
// remembered so re-syncing it later doesn't mean pasting it again (see
// GET/POST /api/commitments/import and GET /api/commitments/feed).
//
// Its own module for the same reason locations.js is: self-contained state,
// and app.js is already large. Exports initCalendarImport(), called once
// from app.js's init section. Nothing else in the app reads commitments yet,
// so unlike locations.js there's no onChange callback to wire up.

const openBtn = document.getElementById("manage-calendar-btn");
const overlay = document.getElementById("calendar-overlay");
const closeBtn = document.getElementById("calendar-close-btn");

const fileInput = document.getElementById("calendar-file-input");
const fileNameEl = document.getElementById("calendar-file-name");

const feedUrlInput = document.getElementById("calendar-feed-url-input");
const feedImportBtn = document.getElementById("calendar-feed-import-btn");
const feedResyncBtn = document.getElementById("calendar-feed-resync-btn");

const statusEl = document.getElementById("calendar-import-status");

let storedFeedUrl = null;

// The same shape as the countable outcome of running the sync twice: the
// second run should read "no additions", not just "it worked" -- that's
// what makes a duplicate-on-resync bug visible instead of silently passing.
function describeSummary(data) {
  return `Added ${data.created}, updated ${data.updated}, removed ${data.deleted}.`;
}

async function runImport(body, { isFormData = false } = {}) {
  statusEl.textContent = "Importing...";
  feedImportBtn.disabled = true;
  feedResyncBtn.disabled = true;
  try {
    const res = await fetch("/api/commitments/import", {
      method: "POST",
      ...(isFormData ? { body } : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = `Error: ${data.error}`;
      return;
    }
    statusEl.textContent = describeSummary(data);
    await refreshStoredFeedUrl();
  } catch (err) {
    statusEl.textContent = `Error: ${err}`;
  } finally {
    feedImportBtn.disabled = false;
    feedResyncBtn.disabled = !storedFeedUrl;
  }
}

// --- File ---

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // see app.js's file-input handler for why
  if (!file) return;
  fileNameEl.textContent = file.name;

  const fd = new FormData();
  fd.append("file", file, file.name);
  await runImport(fd, { isFormData: true });
});

// --- Feed URL ---

async function refreshStoredFeedUrl() {
  const data = await fetch("/api/commitments/feed").then((r) => r.json());
  storedFeedUrl = data.feed_url || null;
  if (storedFeedUrl && !feedUrlInput.value) feedUrlInput.value = storedFeedUrl;
  feedResyncBtn.hidden = !storedFeedUrl;
  feedResyncBtn.disabled = !storedFeedUrl;
}

feedImportBtn.addEventListener("click", () => {
  const feedUrl = feedUrlInput.value.trim();
  if (!feedUrl) {
    statusEl.textContent = "Enter a feed URL first.";
    return;
  }
  runImport({ feed_url: feedUrl });
});
feedUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    feedImportBtn.click();
  }
});

// Re-sync always re-runs the *stored* feed, deliberately independent of
// whatever the user might be mid-typing into the field -- editing the field
// stages a new URL to Import, it doesn't change what Re-sync does until that
// import succeeds and becomes the stored one.
feedResyncBtn.addEventListener("click", () => {
  if (!storedFeedUrl) return;
  runImport({ feed_url: storedFeedUrl });
});

// --- Open / close ---

openBtn.addEventListener("click", async () => {
  overlay.hidden = false;
  statusEl.textContent = "";
  fileNameEl.textContent = "";
  await refreshStoredFeedUrl();
});
closeBtn.addEventListener("click", () => {
  overlay.hidden = true;
});
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeBtn.click();
});

export function initCalendarImport() {}
