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

const umbrellaSelect = document.getElementById("calendar-default-umbrella-select");

const statusEl = document.getElementById("calendar-import-status");

let storedFeedUrl = null;

function formatWindowDate(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

// The same shape as the countable outcome of running the sync twice: the
// second run should read "no additions", not just "it worked" -- that's
// what makes a duplicate-on-resync bug visible instead of silently passing.
//
// events_found (VEVENT components in the file) and events_in_window (what
// actually got considered for sync) are also always returned, but only
// worth a line when they differ -- a bare "Added 0, updated 0, removed 0"
// reads identically whether the feed genuinely had nothing new or the
// parser or window excluded everything, and that's exactly what should
// never happen silently.
function describeSummary(data) {
  const counts = `Added ${data.created}, updated ${data.updated}, removed ${data.deleted}.`;
  if (data.events_found === data.events_in_window) return counts;
  const start = formatWindowDate(data.window_start);
  const end = formatWindowDate(data.window_end);
  return `${counts} ${data.events_found} events found, ${data.events_in_window} within the `
    + `import window (${start} - ${end}).`;
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

// --- Default location umbrella (see ics_import._resolve_import_location) ---
//
// schedule_settings, not this module's own state -- it's the same setting
// locations.js's parent-location picker feeds, just configured from here
// since import is where it actually gets used.

async function refreshUmbrellaSelect() {
  const [locations, settings] = await Promise.all([
    fetch("/api/locations").then((r) => r.json()),
    fetch("/api/schedule-settings").then((r) => r.json()),
  ]);
  umbrellaSelect.innerHTML = '<option value="">No default umbrella</option>';
  locations.forEach((loc) => {
    const opt = document.createElement("option");
    opt.value = loc.id;
    opt.textContent = loc.name;
    umbrellaSelect.appendChild(opt);
  });
  umbrellaSelect.value = settings.default_location_umbrella_id || "";
}

umbrellaSelect.addEventListener("change", async () => {
  const res = await fetch("/api/schedule-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ default_location_umbrella_id: umbrellaSelect.value || null }),
  });
  if (!res.ok) {
    const data = await res.json();
    statusEl.textContent = `Error: ${data.error}`;
    await refreshUmbrellaSelect(); // revert the select to what's actually saved
  }
});

// --- Open / close ---

openBtn.addEventListener("click", async () => {
  overlay.hidden = false;
  statusEl.textContent = "";
  // fileNameEl is deliberately left alone -- the last file chosen this
  // session stays visible across a close/reopen, the same as the feed URL
  // persisting across one. Only picking a new file replaces it.
  await refreshStoredFeedUrl();
  await refreshUmbrellaSelect();
});
closeBtn.addEventListener("click", () => {
  overlay.hidden = true;
});
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeBtn.click();
});

export function initCalendarImport() {}
