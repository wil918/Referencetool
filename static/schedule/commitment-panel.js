// The detail panel a commitment block opens into: everything the sparse
// calendar block deliberately leaves out of the block itself (see calendar.js's
// labelForBlock/subtitleForCommitment) -- module code, lecturer, details, site,
// and whatever the ICS parser couldn't confidently classify (see ics_import.py's
// meta and COMMITMENTS_SCHEMA). Same modal-box shell as task-panel.js.
//
// Mostly read-only -- calendar.js already has the full commitment and the
// locations list in memory -- with one editable thing: whether a session the
// import decided isn't the user's (a different teaching group's, or an optional
// event) should count toward their schedule anyway. That writes
// commitments.capacity_override and reports back through onChange so the
// calendar reloads.
//
// Exports openCommitmentPanel(commitment, locationsById, { onChange }).

import { makeKey } from "./key.js";

// meta.field_sources names any field the deterministic parser did NOT produce.
const SOURCE_NOTE = { group: "from your group", model: "classified by Claude" };

const EXCLUSION_TEXT = {
  "not-your-group": "This session is listed for another teaching group, so it's left out of your schedule.",
  "optional-event": "This is an optional event, so it isn't counted in your schedule by default.",
};

let overlay = null;
let box = null;

function ensureModal() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.hidden = true;

  box = document.createElement("div");
  box.className = "modal-box commitment-panel-box";
  overlay.appendChild(box);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) close();
  });
  document.body.appendChild(overlay);
}

function close() {
  overlay.hidden = true;
  box.innerHTML = "";
}

function formatTimeRange(startIso, endIso) {
  const fmt = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = startIso.slice(0, 10) === endIso.slice(0, 10);
  return sameDay ? `${fmt(startIso)}–${fmt(endIso)}`
    : `${fmt(startIso)} – ${new Date(endIso).toLocaleDateString()} ${fmt(endIso)}`;
}

/* A parser that could not confidently name every field keeps the feed's own
 * text rather than guessing (see ics_import.py's _uniform) -- shown here,
 * once, whenever any of the classified fields came back empty, so the
 * ambiguity is visible instead of just looking like missing data. */
function makeRawSection(meta) {
  const missing = ["module_code", "module_name", "delivery_type", "site", "room"]
    .some((key) => !meta[key]);
  if (!missing || !meta.raw) return null;

  const wrap = document.createElement("div");
  wrap.className = "commitment-panel-raw";
  const h4 = document.createElement("h4");
  h4.textContent = "As received from the feed";
  wrap.appendChild(h4);
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "The parser couldn't confidently tell some of this session's fields apart -- here's the text it started from.";
  wrap.appendChild(hint);

  [["Summary", meta.raw.summary], ["Location", meta.raw.location], ["Description", meta.raw.description]]
    .forEach(([label, text]) => {
      if (!text) return;
      const p = document.createElement("p");
      p.className = "commitment-panel-raw-line";
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      p.append(strong, document.createTextNode(text.trim()));
      wrap.appendChild(p);
    });
  return wrap;
}

/* A session the import classified as not-the-user's shows why, and offers to
 * override that -- forcing it in (capacity_override = 1) or, once forced,
 * dropping back to the classification (capacity_override = null). */
function makeCapacitySection(commitment, onChange) {
  const reason = commitment.capacity_exclusion_reason;
  if (!reason) return null;

  const wrap = document.createElement("div");
  wrap.className = "commitment-panel-capacity";

  const forcedIn = commitment.counts_for_capacity; // true only if overridden in
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = forcedIn
    ? "You've chosen to count this toward your schedule."
    : (EXCLUSION_TEXT[reason] || "This session isn't counted in your schedule.");
  wrap.appendChild(p);

  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = forcedIn ? "Leave it out again" : "Count it in my schedule";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const res = await fetch(`/api/commitments/${commitment.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capacity_override: forcedIn ? null : 1 }),
    });
    if (res.ok) {
      close();
      onChange?.();
    } else {
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
  return wrap;
}

export function openCommitmentPanel(commitment, locationsById = {}, { onChange } = {}) {
  ensureModal();
  overlay.hidden = false;
  box.innerHTML = "";

  const meta = commitment.meta || {};
  const sources = meta.field_sources || {};
  const noteFor = (key) => SOURCE_NOTE[sources[key]];
  const location = commitment.location_id ? locationsById[commitment.location_id] : null;

  const header = document.createElement("div");
  header.className = "dr-titleblock";
  const field = document.createElement("div");
  field.className = "dr-titleblock-field";
  const kind = document.createElement("span");
  kind.className = "dr-micro";
  kind.textContent = meta.delivery_type || "Commitment";
  const h3 = document.createElement("h3");
  h3.className = "dr-title panel-title";
  h3.textContent = meta.module_name || commitment.title;
  field.append(kind, h3);
  header.appendChild(field);

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", close);

  const card = document.createElement("div");
  card.className = "task-card commitment-panel-card";
  card.appendChild(makeKey([
    ["Time", formatTimeRange(commitment.start, commitment.end)],
    ["Module code", meta.module_code, { note: noteFor("module_code") }],
    ["Lecturer", (meta.lecturer || []).join(", ")],
    ["Site", meta.site, { note: noteFor("site") }],
    ["Room", meta.room, { note: noteFor("room") }],
    ["Location", location ? location.name : null],
    ["Details", meta.details, { wide: true, note: noteFor("details") }],
  ]));

  const capacity = makeCapacitySection(commitment, onChange);
  if (capacity) card.appendChild(capacity);

  const raw = makeRawSection(meta);
  if (raw) card.appendChild(raw);

  box.append(header, card, closeBtn);
}

export function closeCommitmentPanel() {
  if (overlay) close();
}
