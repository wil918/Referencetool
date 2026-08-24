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
const locationInput = document.getElementById("commitment-location-input");
const locationSuggestions = document.getElementById("commitment-location-suggestions");
const homeFirstInput = document.getElementById("commitment-home-first-input");
const prepField = document.getElementById("commitment-prep-field");
const prepInput = document.getElementById("commitment-prep-input");
const travelField = document.getElementById("commitment-travel-field");
const travelInput = document.getElementById("commitment-travel-input");

const saveStatus = document.getElementById("commitment-save-status");
const saveBtn = document.getElementById("commitment-save-btn");
const cancelBtn = document.getElementById("commitment-cancel-btn");

const listEl = document.getElementById("commitment-list");
const emptyEl = document.getElementById("commitment-list-empty");

let editingId = null; // null while adding; a commitment id while editing one
let knownLocations = []; // the archive's locations, for the suggestion match only
let selectedLocationId = null; // set only while the typed text still matches a suggestion picked

// --- Location: free text, with saved locations offered as a convenience ---
//
// commitments.location_name is what's actually stored and what
// scheduling.home_first_chain sizes the venue leg from (see COMMITMENTS_SCHEMA)
// -- a personal event never has to already exist in the locations table.
// Typing that happens to match a saved location surfaces it here purely so
// its travel_minutes_from_home can be reused as a starting point; picking one
// fills the travel-time field but leaves it editable, and it's never looked
// up again after saving (see home_first_chain's own docstring).

function matchingLocations(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return knownLocations.filter((l) => l.name.toLowerCase().includes(q)).slice(0, 6);
}

function renderLocationSuggestions() {
  const matches = matchingLocations(locationInput.value);
  locationSuggestions.innerHTML = "";
  locationSuggestions.hidden = matches.length === 0;
  matches.forEach((location) => {
    const row = document.createElement("div");
    row.className = "commitment-location-suggestion";
    row.tabIndex = 0;

    const name = document.createElement("span");
    name.textContent = location.name;
    row.appendChild(name);

    if (location.travel_minutes_from_home != null) {
      const minutes = document.createElement("span");
      minutes.className = "muted";
      minutes.textContent = `${location.travel_minutes_from_home}m from home`;
      row.appendChild(minutes);
    }

    const pick = () => {
      locationInput.value = location.name;
      selectedLocationId = location.id;
      // Pre-fills the travel field as a starting point -- never overwrites
      // a value already typed, since that's the user's own answer.
      if (!travelInput.value.trim() && location.travel_minutes_from_home != null) {
        travelInput.value = location.travel_minutes_from_home;
      }
      locationSuggestions.hidden = true;
    };
    row.addEventListener("click", pick);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
    locationSuggestions.appendChild(row);
  });
}

locationInput.addEventListener("input", () => {
  // The moment the text no longer names exactly what was picked, that pick
  // no longer applies -- location_id is only ever a live match, not a
  // sticky reference to whatever was last clicked.
  if (selectedLocationId) {
    const picked = knownLocations.find((l) => l.id === selectedLocationId);
    if (!picked || picked.name !== locationInput.value) selectedLocationId = null;
  }
  renderLocationSuggestions();
});
locationInput.addEventListener("focus", renderLocationSuggestions);
// A plain blur would fire before a suggestion's click handler runs and hide
// the list out from under it -- letting the click land first is what makes
// picking a suggestion by mouse work at all.
locationInput.addEventListener("blur", () => {
  setTimeout(() => { locationSuggestions.hidden = true; }, 150);
});
locationInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") locationSuggestions.hidden = true;
});

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

function datePart(localValue) {
  return localValue ? localValue.split("T")[0] : "";
}

// --- Start date carries over to end date, once, not on every keystroke ---
//
// Most personal events are same-day, so picking the start date fills the end
// date in as a convenience. It only overwrites the end date while that date
// is still following the start (empty, or left over from an earlier sync) --
// diverge it deliberately (an overnight event) and further start edits stop
// touching it.

let lastSyncedStartDate = "";

function syncEndDate() {
  const startDate = datePart(startInput.value);
  if (!startDate) return;
  const [endDate, endTime] = endInput.value.split("T");
  if (!endDate || endDate === lastSyncedStartDate) {
    // A datetime-local input rejects (and silently no-ops on) a value with
    // a date but no time -- so an end with no time of its own yet borrows
    // the start's, which is at least valid and gets corrected once a real
    // end time is entered.
    const time = endTime || startInput.value.split("T")[1] || "00:00";
    endInput.value = `${startDate}T${time}`;
  }
  lastSyncedStartDate = startDate;
}
// "input" rather than "change" -- a datetime-local input only fires "change"
// once the whole control loses focus, which is too late to feel automatic;
// "input" fires as soon as the date segment itself is complete.
startInput.addEventListener("input", syncEndDate);

// --- Home first: prep/travel only matter once it's switched on ---

homeFirstInput.addEventListener("change", () => {
  prepField.hidden = !homeFirstInput.checked;
  travelField.hidden = !homeFirstInput.checked;
});

// --- Entry form ---

function resetForm() {
  editingId = null;
  titleInput.value = "";
  startInput.value = "";
  endInput.value = "";
  lastSyncedStartDate = "";
  locationInput.value = "";
  selectedLocationId = null;
  locationSuggestions.hidden = true;
  homeFirstInput.checked = false;
  prepInput.value = "";
  prepField.hidden = true;
  travelInput.value = "";
  travelField.hidden = true;
  saveBtn.textContent = "Save";
  cancelBtn.hidden = true;
  saveStatus.textContent = "";
}

function loadIntoForm(commitment) {
  editingId = commitment.id;
  titleInput.value = commitment.title;
  startInput.value = toLocalInputValue(commitment.start);
  endInput.value = toLocalInputValue(commitment.end);
  lastSyncedStartDate = datePart(startInput.value);
  locationInput.value = commitment.location_name || "";
  selectedLocationId = commitment.location_id || null;
  locationSuggestions.hidden = true;
  homeFirstInput.checked = commitment.home_first;
  prepField.hidden = !commitment.home_first;
  prepInput.value = commitment.prep_minutes ?? "";
  travelField.hidden = !commitment.home_first;
  travelInput.value = commitment.travel_minutes ?? "";
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
  const locationName = locationInput.value.trim() || null;
  const travelMinutes = travelInput.value.trim() ? Number(travelInput.value) : null;
  // An event with no known travel time produces a chain short by exactly the
  // trip to it -- the one error that wouldn't be noticed until being late.
  // Prompt rather than silently omit it.
  if (homeFirst && travelMinutes === null) {
    const proceed = confirm(
      "This event's travel time from home isn't set, so the final leg of the home-first " +
      "chain can't be sized -- it'll be marked incomplete. Save it without one anyway?"
    );
    if (!proceed) {
      travelInput.focus();
      return;
    }
  }

  const body = {
    title,
    start,
    end,
    location_id: selectedLocationId,
    location_name: locationName,
    home_first: homeFirst,
    prep_minutes: homeFirst && prepInput.value.trim() ? Number(prepInput.value) : null,
    travel_minutes: homeFirst ? travelMinutes : null,
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

function makeCommitmentCard(commitment) {
  const card = document.createElement("div");
  card.className = "commitment-card";

  const main = document.createElement("div");
  main.className = "commitment-card-main";

  const title = document.createElement("span");
  title.className = "commitment-card-title";
  title.textContent = commitment.title;
  main.appendChild(title);

  const metaParts = [formatRange(commitment)];
  if (commitment.location_name) metaParts.push(commitment.location_name);
  if (commitment.home_first) metaParts.push("Home first");
  const meta = document.createElement("span");
  meta.className = "commitment-card-meta";
  meta.textContent = metaParts.join(" · ");
  main.appendChild(meta);

  // Incomplete purely because home_first is set with no known travel time --
  // see the save-time prompt above for why that combination is allowed to
  // exist.
  if (commitment.home_first && commitment.travel_minutes == null) {
    const warning = document.createElement("span");
    warning.className = "commitment-card-meta commitment-card-warning";
    warning.textContent = "Travel time not set -- chain incomplete";
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
  knownLocations = locations;

  // /api/commitments also returns calendar-imported events (see
  // calendar-import.js) -- this form is only for the ones added by hand.
  // Editing or deleting an imported one here would just be reverted or
  // recreated on the next sync (see ics_import.sync_feed), so it's excluded
  // rather than shown and silently overridden.
  const personal = commitments.filter((c) => !c.source);
  const sorted = [...personal].sort((a, b) => a.start.localeCompare(b.start));
  listEl.innerHTML = "";
  emptyEl.hidden = sorted.length > 0;
  sorted.forEach((c) => listEl.appendChild(makeCommitmentCard(c)));
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
