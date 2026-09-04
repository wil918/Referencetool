// The Locations manager: reachable from the Tasks tab, it owns everything
// the schedule's location model needs -- the location itself, its weekly
// opening hours, one-off date overrides, and the pairwise travel matrix
// between locations. See CLAUDE.md's data model section for why hours,
// overrides and travel each get their own table instead of columns on
// `locations`.
//
// Its own module for the same reason tasks.js is: this doesn't share state
// with anything else in app.js, and app.js is already large. Exports
// initLocationsManager(onChange), called once from app.js's init section;
// onChange fires whenever a location is added, renamed or removed, so the
// Tasks tab's "Location" dropdowns can be refreshed without this module
// knowing anything about tasks.js.

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const openBtn = document.getElementById("manage-locations-btn");
const overlay = document.getElementById("locations-overlay");
const closeBtn = document.getElementById("locations-close-btn");

const newNameInput = document.getElementById("new-location-name");
const newAddBtn = document.getElementById("new-location-add-btn");
const listEl = document.getElementById("locations-list");
const listEmptyEl = document.getElementById("locations-list-empty");
const detailEl = document.getElementById("locations-detail");

const travelListEl = document.getElementById("travel-list");
const travelListEmptyEl = document.getElementById("travel-list-empty");
const travelFromSelect = document.getElementById("travel-from-select");
const travelToSelect = document.getElementById("travel-to-select");
const travelMinutesInput = document.getElementById("travel-minutes-input");
const travelBothInput = document.getElementById("travel-both-directions-input");
const travelAddBtn = document.getElementById("travel-add-btn");
const travelStatus = document.getElementById("travel-status");

const deleteOverlay = document.getElementById("delete-location-overlay");
const deleteText = document.getElementById("delete-location-text");
const deleteCancelBtn = document.getElementById("delete-location-cancel");
const deleteConfirmBtn = document.getElementById("delete-location-confirm");

let locations = [];
let selectedLocationId = null;
let pendingDelete = null;
let onChange = () => {};

// --- Locations list ---

async function refreshAll() {
  locations = await fetch("/api/locations").then((r) => r.json());
  renderLocationsList();
  renderTravelSelects();
  await renderTravelList();
  if (selectedLocationId && !locations.some((l) => l.id === selectedLocationId)) {
    selectedLocationId = null;
  }
  await renderDetail(selectedLocationId);
}

function renderLocationsList() {
  listEl.innerHTML = "";
  listEmptyEl.hidden = locations.length > 0;
  locations.forEach((loc) => {
    const row = document.createElement("div");
    row.className = "locations-row" + (loc.id === selectedLocationId ? " active" : "");
    row.tabIndex = 0;

    const name = document.createElement("span");
    name.className = "locations-row-name";
    name.textContent = loc.name;
    row.appendChild(name);

    if (loc.address) {
      const address = document.createElement("span");
      address.className = "locations-row-address muted";
      address.textContent = loc.address;
      row.appendChild(address);
    }

    const select = () => selectLocation(loc.id);
    row.addEventListener("click", select);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select();
      }
    });
    listEl.appendChild(row);
  });
}

async function selectLocation(id) {
  selectedLocationId = id;
  renderLocationsList();
  await renderDetail(id);
}

newAddBtn.addEventListener("click", async () => {
  const name = newNameInput.value.trim();
  if (!name) return;
  newAddBtn.disabled = true;
  try {
    const res = await fetch("/api/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) return;
    newNameInput.value = "";
    selectedLocationId = data.id;
    await refreshAll();
    onChange();
  } finally {
    newAddBtn.disabled = false;
  }
});
newNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    newAddBtn.click();
  }
});

// --- Detail panel: fields, weekly hours, date overrides ---

async function renderDetail(id) {
  const loc = locations.find((l) => l.id === id);
  detailEl.innerHTML = "";
  if (!loc) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Select a location to edit its details.";
    detailEl.appendChild(empty);
    return;
  }

  const [hours, overrides] = await Promise.all([
    fetch(`/api/locations/${loc.id}/hours`).then((r) => r.json()),
    fetch(`/api/locations/${loc.id}/overrides`).then((r) => r.json()),
  ]);

  detailEl.appendChild(buildDetailFields(loc));
  detailEl.appendChild(buildHoursSection(loc, hours));
  detailEl.appendChild(buildOverridesSection(loc, overrides));
}

function buildDetailFields(loc) {
  const wrap = document.createElement("div");
  wrap.className = "location-detail-fields";

  const header = document.createElement("div");
  header.className = "location-detail-header";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "location-name-input";
  nameInput.value = loc.name;
  header.appendChild(nameInput);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn danger";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => confirmDeleteLocation(loc));
  header.appendChild(deleteBtn);
  wrap.appendChild(header);

  const status = document.createElement("p");
  status.className = "location-detail-status muted";

  const saveField = async (fields) => {
    status.textContent = "Saving...";
    const res = await fetch(`/api/locations/${loc.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    const data = await res.json();
    if (!res.ok) {
      status.textContent = `Error: ${data.error}`;
      return false;
    }
    Object.assign(loc, data);
    status.textContent = "Saved.";
    renderLocationsList();
    renderTravelSelects();
    renderTravelList();
    onChange();
    return true;
  };

  nameInput.addEventListener("blur", () => {
    const value = nameInput.value.trim();
    if (!value || value === loc.name) {
      nameInput.value = loc.name;
      return;
    }
    saveField({ name: value });
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameInput.blur();
    }
  });

  const addressLabel = document.createElement("label");
  addressLabel.append("Address");
  const addressInput = document.createElement("input");
  addressInput.type = "text";
  addressInput.value = loc.address || "";
  addressLabel.appendChild(addressInput);
  addressInput.addEventListener("blur", () => {
    const value = addressInput.value.trim();
    if (value === (loc.address || "")) return;
    saveField({ address: value || null });
  });
  wrap.appendChild(addressLabel);

  // Parent (umbrella) and online separate DISPLAY from TRAVEL -- see
  // CLAUDE.md's data model section. A specific place (Studio, Library)
  // points at an umbrella that travel is actually priced to and from; an
  // online place has none at all. Both are checked server-side too (an
  // unknown or cyclical parent is rejected there), this is just the picker.
  const parentLabel = document.createElement("label");
  parentLabel.append("Parent location (umbrella)");
  const parentSelect = document.createElement("select");
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "None -- its own umbrella";
  parentSelect.appendChild(noneOption);
  locations
    .filter((l) => l.id !== loc.id)
    .forEach((l) => {
      const opt = document.createElement("option");
      opt.value = l.id;
      opt.textContent = l.name;
      parentSelect.appendChild(opt);
    });
  parentSelect.value = loc.parent_location_id || "";
  parentLabel.appendChild(parentSelect);
  parentSelect.addEventListener("change", async () => {
    const ok = await saveField({ parent_location_id: parentSelect.value || null });
    // The travel field below is disabled/enabled by whether a parent is
    // set, so a successful change has to redraw the whole panel to stay
    // honest. A rejection (a cycle) leaves the select itself un-reverted --
    // re-rendering it too would need re-deriving its old value for no gain,
    // since the error message already says what went wrong.
    if (ok) await renderDetail(loc.id);
  });
  wrap.appendChild(parentLabel);

  const onlineLabel = document.createElement("label");
  onlineLabel.className = "checkbox-label";
  const onlineInput = document.createElement("input");
  onlineInput.type = "checkbox";
  onlineInput.checked = Boolean(loc.is_online);
  onlineLabel.appendChild(onlineInput);
  onlineLabel.append("No travel from anywhere (online)");
  onlineInput.addEventListener("change", () => {
    saveField({ is_online: onlineInput.checked });
  });
  wrap.appendChild(onlineLabel);

  const travelLabel = document.createElement("label");
  travelLabel.append("Travel from home (minutes)");
  const travelHint = document.createElement("span");
  travelHint.className = "muted";
  travelHint.textContent = loc.parent_location_id
    ? " -- ignored while a parent is set; edit the parent's instead"
    : "";
  travelLabel.appendChild(travelHint);
  const travelInput = document.createElement("input");
  travelInput.type = "number";
  travelInput.min = "0";
  travelInput.value = loc.travel_minutes_from_home ?? "";
  travelInput.disabled = Boolean(loc.parent_location_id);
  travelLabel.appendChild(travelInput);
  travelInput.addEventListener("change", () => {
    const raw = travelInput.value.trim();
    const value = raw === "" ? null : Math.max(0, Math.round(Number(raw)));
    if (value === (loc.travel_minutes_from_home ?? null)) return;
    saveField({ travel_minutes_from_home: value });
  });
  wrap.appendChild(travelLabel);

  const notesLabel = document.createElement("label");
  notesLabel.append("Notes");
  const notesInput = document.createElement("textarea");
  notesInput.rows = 2;
  notesInput.value = loc.notes || "";
  notesLabel.appendChild(notesInput);
  notesInput.addEventListener("blur", () => {
    const value = notesInput.value.trim();
    if (value === (loc.notes || "")) return;
    saveField({ notes: value || null });
  });
  wrap.appendChild(notesLabel);

  wrap.appendChild(status);
  return wrap;
}

// A row's "Closed" checkbox and its two time inputs disable together --
// shared by the weekly grid and the override add-row below.
function wireClosedToggle(closedInput, opensInput, closesInput) {
  const sync = () => {
    opensInput.disabled = closedInput.checked;
    closesInput.disabled = closedInput.checked;
  };
  closedInput.addEventListener("change", sync);
  sync();
}

function buildHoursSection(loc, hours) {
  const wrap = document.createElement("div");
  wrap.className = "location-hours-section";

  const h4 = document.createElement("h4");
  h4.textContent = "Weekly hours";
  wrap.appendChild(h4);

  const byWeekday = Object.fromEntries(hours.map((h) => [h.weekday, h]));
  const grid = document.createElement("div");
  grid.className = "location-hours-grid";

  const rows = WEEKDAYS.map((label, weekday) => {
    const existing = byWeekday[weekday];
    const row = document.createElement("div");
    row.className = "location-hours-row";

    const dayLabel = document.createElement("span");
    dayLabel.className = "location-hours-day";
    dayLabel.textContent = label;
    row.appendChild(dayLabel);

    const closedLabel = document.createElement("label");
    closedLabel.className = "checkbox-label";
    const closedInput = document.createElement("input");
    closedInput.type = "checkbox";
    // No row at all reads the same as an explicitly closed row -- a day
    // that's never been configured starts out closed rather than guessing
    // at hours for it.
    closedInput.checked = !existing || (!existing.opens && !existing.closes);
    closedLabel.appendChild(closedInput);
    closedLabel.append("Closed");
    row.appendChild(closedLabel);

    const opensInput = document.createElement("input");
    opensInput.type = "time";
    opensInput.value = existing?.opens || "";
    row.appendChild(opensInput);

    const closesInput = document.createElement("input");
    closesInput.type = "time";
    closesInput.value = existing?.closes || "";
    row.appendChild(closesInput);

    wireClosedToggle(closedInput, opensInput, closesInput);
    grid.appendChild(row);
    return { weekday, closedInput, opensInput, closesInput };
  });
  wrap.appendChild(grid);

  const status = document.createElement("p");
  status.className = "muted";

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn";
  saveBtn.textContent = "Save weekly hours";
  saveBtn.addEventListener("click", async () => {
    // Always the whole week -- see db.save_location_hours, it's a wholesale
    // replace, not per-day upserts.
    const payload = rows.map(({ weekday, closedInput, opensInput, closesInput }) => ({
      weekday,
      opens: closedInput.checked ? null : opensInput.value || null,
      closes: closedInput.checked ? null : closesInput.value || null,
    }));
    saveBtn.disabled = true;
    status.textContent = "Saving...";
    try {
      const res = await fetch(`/api/locations/${loc.id}/hours`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours: payload }),
      });
      if (!res.ok) {
        const data = await res.json();
        status.textContent = `Error: ${data.error}`;
        return;
      }
      status.textContent = "Saved.";
    } catch (err) {
      status.textContent = `Error: ${err}`;
    } finally {
      saveBtn.disabled = false;
    }
  });
  wrap.appendChild(saveBtn);
  wrap.appendChild(status);
  return wrap;
}

function formatOverride(o) {
  if (o.closed) return "closed all day";
  const parts = [];
  if (o.opens) parts.push(`opens ${o.opens}`);
  if (o.closes) parts.push(`closes ${o.closes}`);
  return parts.length ? parts.join(", ") : "no change recorded";
}

function buildOverridesSection(loc, overrides) {
  const wrap = document.createElement("div");
  wrap.className = "location-overrides-section";

  const h4 = document.createElement("h4");
  h4.textContent = "Date overrides";
  wrap.appendChild(h4);

  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent =
    "A specific date beats the weekly pattern above. Leave opens or closes blank to keep the normal time for that half of the day -- e.g. just a closes time for \"shuts early on the 27th.\"";
  wrap.appendChild(hint);

  const list = document.createElement("div");
  list.className = "location-overrides-list";

  function renderList(items) {
    list.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No overrides yet.";
      list.appendChild(empty);
      return;
    }
    items.forEach((o) => {
      const row = document.createElement("div");
      row.className = "location-override-row";

      const text = document.createElement("span");
      text.textContent = `${o.date} — ${formatOverride(o)}`;
      row.appendChild(text);

      const removeBtn = document.createElement("button");
      removeBtn.className = "btn danger";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        removeBtn.disabled = true;
        const res = await fetch(`/api/locations/${loc.id}/overrides`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: o.id }),
        });
        renderList(await res.json());
      });
      row.appendChild(removeBtn);
      list.appendChild(row);
    });
  }
  renderList(overrides);
  wrap.appendChild(list);

  const addRow = document.createElement("div");
  addRow.className = "location-override-add-row";

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  addRow.appendChild(dateInput);

  const closedLabel = document.createElement("label");
  closedLabel.className = "checkbox-label";
  const closedInput = document.createElement("input");
  closedInput.type = "checkbox";
  closedLabel.appendChild(closedInput);
  closedLabel.append("Closed all day");
  addRow.appendChild(closedLabel);

  const opensInput = document.createElement("input");
  opensInput.type = "time";
  addRow.appendChild(opensInput);

  const closesInput = document.createElement("input");
  closesInput.type = "time";
  addRow.appendChild(closesInput);

  wireClosedToggle(closedInput, opensInput, closesInput);

  const status = document.createElement("p");
  status.className = "muted";

  const addBtn = document.createElement("button");
  addBtn.className = "btn primary";
  addBtn.textContent = "Add override";
  addBtn.addEventListener("click", async () => {
    const date = dateInput.value;
    if (!date) {
      status.textContent = "Pick a date first.";
      return;
    }
    addBtn.disabled = true;
    status.textContent = "Saving...";
    try {
      const res = await fetch(`/api/locations/${loc.id}/overrides`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          closed: closedInput.checked,
          opens: closedInput.checked ? null : opensInput.value || null,
          closes: closedInput.checked ? null : closesInput.value || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        status.textContent = `Error: ${data.error}`;
        return;
      }
      renderList(data);
      dateInput.value = "";
      closedInput.checked = false;
      opensInput.value = "";
      closesInput.value = "";
      wireClosedToggle(closedInput, opensInput, closesInput);
      status.textContent = "";
    } catch (err) {
      status.textContent = `Error: ${err}`;
    } finally {
      addBtn.disabled = false;
    }
  });
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);
  wrap.appendChild(status);
  return wrap;
}

// --- Delete ---

function confirmDeleteLocation(loc) {
  pendingDelete = loc;
  deleteText.textContent = `Delete "${loc.name}"?`;
  deleteOverlay.hidden = false;
}

deleteCancelBtn.addEventListener("click", () => {
  pendingDelete = null;
  deleteOverlay.hidden = true;
});
deleteOverlay.addEventListener("click", (e) => {
  if (e.target === deleteOverlay) deleteCancelBtn.click();
});

deleteConfirmBtn.addEventListener("click", async () => {
  if (!pendingDelete) return;
  deleteConfirmBtn.disabled = true;
  try {
    await fetch(`/api/locations/${pendingDelete.id}`, { method: "DELETE" });
    if (selectedLocationId === pendingDelete.id) selectedLocationId = null;
    pendingDelete = null;
    deleteOverlay.hidden = true;
    await refreshAll();
    onChange();
  } finally {
    deleteConfirmBtn.disabled = false;
  }
});

// --- Pairwise travel ---
//
// The matrix is small (session plan: "the handful of pairs actually
// travelled"), so add/remove just re-fetches the current list, edits it in
// memory, and PUTs the whole thing back -- same wholesale-replace contract
// db.save_travel already commits to.

function renderTravelSelects() {
  const prevFrom = travelFromSelect.value;
  const prevTo = travelToSelect.value;
  travelFromSelect.innerHTML = "";
  travelToSelect.innerHTML = "";
  locations.forEach((loc) => {
    const optFrom = document.createElement("option");
    optFrom.value = loc.id;
    optFrom.textContent = loc.name;
    travelFromSelect.appendChild(optFrom);
    travelToSelect.appendChild(optFrom.cloneNode(true));
  });
  if (prevFrom) travelFromSelect.value = prevFrom;
  if (prevTo) travelToSelect.value = prevTo;
}

async function renderTravelList() {
  const travel = await fetch("/api/travel").then((r) => r.json());
  const nameById = Object.fromEntries(locations.map((l) => [l.id, l.name]));
  travelListEl.innerHTML = "";
  travelListEmptyEl.hidden = travel.length > 0;
  travel.forEach((t) => {
    const row = document.createElement("div");
    row.className = "travel-row";

    const text = document.createElement("span");
    const fromName = nameById[t.from_location_id] || "(deleted)";
    const toName = nameById[t.to_location_id] || "(deleted)";
    text.textContent = `${fromName} → ${toName}: ${t.minutes} min`;
    row.appendChild(text);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn danger";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      removeBtn.disabled = true;
      const remaining = travel.filter(
        (e) => !(e.from_location_id === t.from_location_id && e.to_location_id === t.to_location_id)
      );
      await fetch("/api/travel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ travel: remaining }),
      });
      await renderTravelList();
    });
    row.appendChild(removeBtn);
    travelListEl.appendChild(row);
  });
}

travelAddBtn.addEventListener("click", async () => {
  const from = travelFromSelect.value;
  const to = travelToSelect.value;
  const minutesRaw = travelMinutesInput.value.trim();
  if (!from || !to) {
    travelStatus.textContent = "Pick both locations.";
    return;
  }
  if (from === to) {
    travelStatus.textContent = "Pick two different locations.";
    return;
  }
  if (minutesRaw === "" || Number.isNaN(Number(minutesRaw))) {
    travelStatus.textContent = "Enter the minutes.";
    return;
  }
  const minutes = Math.max(0, Math.round(Number(minutesRaw)));

  travelAddBtn.disabled = true;
  travelStatus.textContent = "Saving...";
  try {
    const existing = await fetch("/api/travel").then((r) => r.json());
    const keep = (e, f, t) => !(e.from_location_id === f && e.to_location_id === t);
    let next = existing.filter((e) => keep(e, from, to));
    next.push({ from_location_id: from, to_location_id: to, minutes });
    if (travelBothInput.checked) {
      next = next.filter((e) => keep(e, to, from));
      next.push({ from_location_id: to, to_location_id: from, minutes });
    }
    await fetch("/api/travel", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ travel: next }),
    });
    travelMinutesInput.value = "";
    travelStatus.textContent = "Saved.";
    await renderTravelList();
  } finally {
    travelAddBtn.disabled = false;
  }
});

// --- Open / close ---

openBtn.addEventListener("click", async () => {
  overlay.hidden = false;
  await refreshAll();
});
closeBtn.addEventListener("click", () => {
  overlay.hidden = true;
});
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeBtn.click();
});

export function initLocationsManager(onChangeCallback) {
  if (onChangeCallback) onChange = onChangeCallback;
}
