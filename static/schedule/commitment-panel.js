// The read-only detail panel a commitment block opens into: everything the
// sparse calendar block deliberately leaves out of the block itself (see
// calendar.js's labelForBlock/subtitleForCommitment) -- module code,
// lecturer, details, site, and whatever the ICS parser couldn't confidently
// classify (see ics_import.py's meta and COMMITMENTS_SCHEMA). Same modal-box
// shell as task-panel.js; nothing here is editable, so there's no onChange
// to report back and no fetch of its own -- calendar.js already has the full
// commitment and the locations list in memory.
//
// Exports openCommitmentPanel(commitment, locationsById).

import { makeKey } from "./key.js";

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

export function openCommitmentPanel(commitment, locationsById = {}) {
  ensureModal();
  overlay.hidden = false;
  box.innerHTML = "";

  const meta = commitment.meta || {};
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
    ["Module code", meta.module_code],
    ["Lecturer", (meta.lecturer || []).join(", ")],
    ["Site", meta.site],
    ["Room", meta.room],
    ["Location", location ? location.name : null],
    ["Details", meta.details, { wide: true }],
  ]));

  const raw = makeRawSection(meta);
  if (raw) card.appendChild(raw);

  box.append(header, card, closeBtn);
}

export function closeCommitmentPanel() {
  if (overlay) close();
}
