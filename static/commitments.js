// Personal events: reachable from the Tasks tab, this is the plain form for
// adding a commitment by hand -- going out, a haircut, a train. Deliberately
// NOT the task entry flow (see tasks.js): no estimation, no generated chips,
// no call to task_ai.py. A commitment blocks time and nothing more.
//
// Its own module for the same reason calendar-import.js and locations.js
// are: self-contained state, and app.js is already large. Exports
// initCommitments(), called once from app.js's init section.

const openBtn = document.getElementById("manage-commitments-btn");
const overlay = document.getElementById("commitments-overlay");
const closeBtn = document.getElementById("commitments-close-btn");

const titleInput = document.getElementById("commitment-title-input");
const startInput = document.getElementById("commitment-start-input");
const endInput = document.getElementById("commitment-end-input");
const locationSelect = document.getElementById("commitment-location-select");
const homeFirstInput = document.getElementById("commitment-home-first-input");
const prepField = document.getElementById("commitment-prep-field");
const prepInput = document.getElementById("commitment-prep-input");

const saveStatus = document.getElementById("commitment-save-status");
const saveBtn = document.getElementById("commitment-save-btn");
const cancelBtn = document.getElementById("commitment-cancel-btn");

const listEl = document.getElementById("commitment-list");
const emptyEl = document.getElementById("commitment-list-empty");

let editingId = null; // null while adding; a commitment id while editing one

// --- Locations ---

async function populateLocationOptions(locations) {
  const current = locationSelect.value;
  locationSelect.innerHTML = '<option value="" selected>None</option>';
  locations.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    locationSelect.appendChild(opt);
  });
  locationSelect.value = current;
}

// --- datetime-local <-> the "YYYY-MM-DDTHH:MM:SS" commitments store ---
//
// A datetime-local input's value has no seconds; the API (and every other
// commitment in the table, however it got there) always carries them.

function toStoredDateTime(localValue) {
  return localValue ? `${localValue}:00` : "";
}

function toLocalInputValue(stored) {
  return stored ? stored.slice(0, 16) : "";
}

// --- Home first: the prep field only matters once it's switched on ---

homeFirstInput.addEventListener("change", () => {
  prepField.hidden = !homeFirstInput.checked;
});

// --- Entry form ---

function resetForm() {
  editingId = null;
  titleInput.value = "";
  startInput.value = "";
  endInput.value = "";
  locationSelect.value = "";
  homeFirstInput.checked = false;
  prepInput.value = "";
  prepField.hidden = true;
  saveBtn.textContent = "Save";
  cancelBtn.hidden = true;
  saveStatus.textContent = "";
}

function loadIntoForm(commitment) {
  editingId = commitment.id;
  titleInput.value = commitment.title;
  startInput.value = toLocalInputValue(commitment.start);
  endInput.value = toLocalInputValue(commitment.end);
  locationSelect.value = commitment.location_id || "";
  homeFirstInput.checked = commitment.home_first;
  prepField.hidden = !commitment.home_first;
  prepInput.value = commitment.prep_minutes ?? "";
  saveBtn.textContent = "Update";
  cancelBtn.hidden = false;
  saveStatus.textContent = "";
  titleInput.focus();
}

cancelBtn.addEventListener("click", resetForm);

saveBtn.addEventListener("click", async () => {
  const title = titleInput.value.trim();
  const start = toStoredDateTime(startInput.value);
  const end = toStoredDateTime(endInput.value);
  if (!title || !start || !end) {
    saveStatus.textContent = "Title, start and end are all required.";
    return;
  }

  const homeFirst = homeFirstInput.checked;
  const locationId = locationSelect.value || null;
  // An event with no location produces a chain short by exactly the trip to
  // it -- the one error that wouldn't be noticed until being late. Prompt
  // rather than silently omit it.
  if (homeFirst && !locationId) {
    const proceed = confirm(
      "This event has no location, so the final leg of the home-first chain can't be " +
      "sized -- it'll be marked incomplete. Save it without one anyway?"
    );
    if (!proceed) {
      locationSelect.focus();
      return;
    }
  }

  const body = {
    title,
    start,
    end,
    location_id: locationId,
    home_first: homeFirst,
    prep_minutes: homeFirst && prepInput.value.trim() ? Number(prepInput.value) : null,
  };

  saveStatus.textContent = "Saving...";
  saveBtn.disabled = true;
  try {
    const res = await fetch(
      editingId ? `/api/commitments/${editingId}` : "/api/commitments",
      {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      saveStatus.textContent = `Error: ${data.error}`;
    } else {
      resetForm();
      await refreshCommitmentList();
    }
  } catch (err) {
    saveStatus.textContent = `Error: ${err}`;
  } finally {
    saveBtn.disabled = false;
  }
});

// --- List ---

function formatRange(commitment) {
  const start = new Date(commitment.start);
  const end = new Date(commitment.end);
  const sameDay = start.toDateString() === end.toDateString();
  const dateOpts = { day: "numeric", month: "short", year: "numeric" };
  const timeOpts = { hour: "2-digit", minute: "2-digit" };
  const startText = `${start.toLocaleDateString("en-GB", dateOpts)}, ${start.toLocaleTimeString("en-GB", timeOpts)}`;
  const endText = sameDay
    ? end.toLocaleTimeString("en-GB", timeOpts)
    : `${end.toLocaleDateString("en-GB", dateOpts)}, ${end.toLocaleTimeString("en-GB", timeOpts)}`;
  return `${startText} – ${endText}`;
}

function makeCommitmentCard(commitment, locationsById) {
  const card = document.createElement("div");
  card.className = "commitment-card";

  const main = document.createElement("div");
  main.className = "commitment-card-main";

  const title = document.createElement("span");
  title.className = "commitment-card-title";
  title.textContent = commitment.title;
  main.appendChild(title);

  const metaParts = [formatRange(commitment)];
  if (commitment.location_id && locationsById[commitment.location_id]) {
    metaParts.push(locationsById[commitment.location_id]);
  }
  if (commitment.home_first) metaParts.push("Home first");
  const meta = document.createElement("span");
  meta.className = "commitment-card-meta";
  meta.textContent = metaParts.join(" · ");
  main.appendChild(meta);

  // Incomplete purely because home_first is set with no location -- see the
  // save-time prompt above for why that combination is allowed to exist.
  if (commitment.home_first && !commitment.location_id) {
    const warning = document.createElement("span");
    warning.className = "commitment-card-meta commitment-card-warning";
    warning.textContent = "No location -- chain incomplete";
    main.appendChild(warning);
  }

  card.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "commitment-card-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "btn";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => loadIntoForm(commitment));
  actions.appendChild(editBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn danger";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", async () => {
    await fetch(`/api/commitments/${commitment.id}`, { method: "DELETE" });
    if (editingId === commitment.id) resetForm();
    await refreshCommitmentList();
  });
  actions.appendChild(deleteBtn);

  card.appendChild(actions);
  return card;
}

async function refreshCommitmentList() {
  const [commitments, locations] = await Promise.all([
    fetch("/api/commitments").then((r) => r.json()),
    fetch("/api/locations").then((r) => r.json()),
  ]);
  await populateLocationOptions(locations);
  const locationsById = Object.fromEntries(locations.map((l) => [l.id, l.name]));

  // /api/commitments also returns calendar-imported events (see
  // calendar-import.js) -- this form is only for the ones added by hand.
  // Editing or deleting an imported one here would just be reverted or
  // recreated on the next sync (see ics_import.sync_feed), so it's excluded
  // rather than shown and silently overridden.
  const personal = commitments.filter((c) => !c.source);
  const sorted = [...personal].sort((a, b) => a.start.localeCompare(b.start));
  listEl.innerHTML = "";
  emptyEl.hidden = sorted.length > 0;
  sorted.forEach((c) => listEl.appendChild(makeCommitmentCard(c, locationsById)));
}

// --- Open / close ---

openBtn.addEventListener("click", async () => {
  overlay.hidden = false;
  resetForm();
  await refreshCommitmentList();
});
closeBtn.addEventListener("click", () => {
  overlay.hidden = true;
});
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeBtn.click();
});

export function initCommitments() {}
