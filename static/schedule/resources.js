// The Resources tab: a manual archive of places to get things -- fabric
// shops, haberdashers, suppliers. Each resource has a name, a location
// (reusing the schedule's locations, so travel and opening hours come for
// free), a URL and notes; underneath it is a list of what it stocks, each
// item free-text tagged. The search box at the top runs over every
// resource's name, notes and stock at once -- "who sells horsehair canvas"
// is one query, GET /api/resources/search.
//
// No external places lookup in v1 (see schedule.html): that needs a places
// API and a decision about sending location data off-machine.
//
// Everything persists through the API -- no localStorage (CLAUDE.md rule 2).
// Drawn in the drafting language like the rest of this page: ruled lines, no
// fills, uppercase micro labels (drafting.css).

const nameInput = document.getElementById("resource-name-input");
const locationInput = document.getElementById("resource-location-input");
const urlInput = document.getElementById("resource-url-input");
const notesInput = document.getElementById("resource-notes-input");
const saveBtn = document.getElementById("resource-save-btn");
const saveStatus = document.getElementById("resource-save-status");

const searchInput = document.getElementById("resource-search-input");
const listEl = document.getElementById("resource-list");
const emptyEl = document.getElementById("resource-list-empty");
const searchEmptyEl = document.getElementById("resource-search-empty");

// Locations, fetched once per refresh and shared by the entry form and every
// card's location select.
let locations = [];

// --- API ------------------------------------------------------------------

async function apiUpdateResource(id, fields) {
  await fetch(`/api/resources/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
}

async function apiAddItem(id, item, tags) {
  await fetch(`/api/resources/${id}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item, tags }),
  });
}

async function apiRemoveItem(id, item) {
  await fetch(`/api/resources/${id}/items`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item }),
  });
}

async function apiDeleteResource(id) {
  await fetch(`/api/resources/${id}`, { method: "DELETE" });
}

// --- Small builders ------------------------------------------------------

function locationSelect(current, onChange) {
  const select = document.createElement("select");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No location";
  select.appendChild(none);
  locations.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    select.appendChild(opt);
  });
  select.value = current || "";
  select.addEventListener("change", () => onChange(select.value || null));
  return select;
}

// An inline-editable line of text: click to edit, blur/Enter commits, Escape
// reverts. Same idea as tasks.js's editable title, kept local so this module
// doesn't reach into that tab.
function editableText(value, { placeholder, onCommit, className }) {
  const el = document.createElement("span");
  el.className = className;
  el.contentEditable = "true";
  el.spellcheck = false;
  el.textContent = value || "";
  if (!value && placeholder) el.dataset.placeholder = placeholder;
  const commit = () => {
    const next = el.textContent.trim();
    if (next === (value || "")) return;
    onCommit(next);
  };
  el.addEventListener("blur", commit);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el.blur();
    } else if (e.key === "Escape") {
      el.textContent = value || "";
      el.blur();
    }
  });
  return el;
}

function tagChips(tags) {
  const wrap = document.createElement("span");
  wrap.className = "resource-item-tags";
  (tags || []).forEach((t) => {
    const chip = document.createElement("span");
    chip.className = "resource-tag";
    chip.textContent = t;
    wrap.appendChild(chip);
  });
  return wrap;
}

function parseTags(raw) {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

// --- Items sub-list -----------------------------------------------------

function makeItemRow(resource, item, matched, refresh) {
  const row = document.createElement("div");
  row.className = "resource-item-row" + (matched ? " is-matched" : "");

  const name = document.createElement("span");
  name.className = "resource-item-name";
  name.textContent = item.item;

  const remove = document.createElement("button");
  remove.className = "btn resource-item-remove";
  remove.setAttribute("aria-label", `Remove ${item.item}`);
  remove.textContent = "×";
  remove.addEventListener("click", async () => {
    await apiRemoveItem(resource.id, item.item);
    refresh();
  });

  row.append(name, tagChips(item.tags), remove);
  return row;
}

function makeAddItemRow(resource, refresh) {
  const form = document.createElement("div");
  form.className = "resource-item-add";

  const itemField = document.createElement("input");
  itemField.type = "text";
  itemField.placeholder = "What it stocks";

  const tagsField = document.createElement("input");
  tagsField.type = "text";
  tagsField.placeholder = "Tags, comma separated";

  const add = document.createElement("button");
  add.className = "btn";
  add.textContent = "Add item";

  const submit = async () => {
    const item = itemField.value.trim();
    if (!item) return;
    await apiAddItem(resource.id, item, parseTags(tagsField.value));
    itemField.value = "";
    tagsField.value = "";
    refresh();
  };
  add.addEventListener("click", submit);
  itemField.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  tagsField.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  form.append(itemField, tagsField, add);
  return form;
}

// --- Resource card ----------------------------------------------------

function makeDeleteConfirm(resource, refresh) {
  const box = document.createElement("div");
  box.className = "resource-delete-confirm";
  const text = document.createElement("p");
  text.className = "muted";
  text.textContent =
    "Delete this resource? Its stock list goes too, and any task linked to it is unlinked (the task keeps its details).";
  const del = document.createElement("button");
  del.className = "btn danger";
  del.textContent = "Delete resource";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  del.addEventListener("click", async () => {
    await apiDeleteResource(resource.id);
    refresh();
  });
  cancel.addEventListener("click", () => box.replaceWith(makeActions(resource, refresh)));
  box.append(text, del, cancel);
  return box;
}

function makeActions(resource, refresh) {
  const actions = document.createElement("div");
  actions.className = "resource-actions";
  const del = document.createElement("button");
  del.className = "btn";
  del.textContent = "Delete";
  del.addEventListener("click", () => actions.replaceWith(makeDeleteConfirm(resource, refresh)));
  actions.appendChild(del);
  return actions;
}

function makeCard(resource, refresh, matchedItems) {
  const card = document.createElement("div");
  card.className = "resource-card";

  const head = document.createElement("div");
  head.className = "resource-card-head";

  const kind = document.createElement("span");
  kind.className = "dr-micro";
  kind.textContent = "Resource";

  const title = editableText(resource.name, {
    className: "resource-name dr-title",
    onCommit: (next) => {
      if (!next) return; // a name is required -- ignore an empty commit
      apiUpdateResource(resource.id, { name: next });
    },
  });

  head.append(kind, title);

  // Location / URL / notes as one keyed block -- the same "term, leader,
  // value" idiom the task and block detail panels use.
  const facts = document.createElement("div");
  facts.className = "resource-facts";

  const locRow = document.createElement("label");
  locRow.className = "resource-fact";
  locRow.append(
    Object.assign(document.createElement("span"), {
      className: "resource-fact-term",
      textContent: "Location",
    }),
    locationSelect(resource.location_id, (id) => apiUpdateResource(resource.id, { location_id: id }))
  );

  const urlRow = document.createElement("div");
  urlRow.className = "resource-fact";
  urlRow.append(
    Object.assign(document.createElement("span"), {
      className: "resource-fact-term",
      textContent: "URL",
    }),
    editableText(resource.url, {
      className: "resource-url",
      placeholder: "https://",
      onCommit: (next) => apiUpdateResource(resource.id, { url: next }),
    })
  );
  if (resource.url) {
    const open = document.createElement("a");
    open.className = "resource-url-open";
    open.href = resource.url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "open ↗";
    urlRow.appendChild(open);
  }

  const notesRow = document.createElement("div");
  notesRow.className = "resource-fact";
  notesRow.append(
    Object.assign(document.createElement("span"), {
      className: "resource-fact-term",
      textContent: "Notes",
    }),
    editableText(resource.notes, {
      className: "resource-notes",
      placeholder: "Which branch, what for, who to ask",
      onCommit: (next) => apiUpdateResource(resource.id, { notes: next }),
    })
  );

  facts.append(locRow, urlRow, notesRow);

  const stock = document.createElement("div");
  stock.className = "resource-stock";
  const stockLabel = document.createElement("p");
  stockLabel.className = "dr-micro resource-stock-label";
  stockLabel.textContent = "Stocks";
  stock.appendChild(stockLabel);
  const matched = new Set((matchedItems || []).map((i) => i.item));
  (resource.items || []).forEach((item) => {
    stock.appendChild(makeItemRow(resource, item, matched.has(item.item), refresh));
  });
  stock.appendChild(makeAddItemRow(resource, refresh));

  card.append(head, facts, stock, makeActions(resource, refresh));
  return card;
}

// --- Render -----------------------------------------------------------

function render(resources, { matchedByResource } = {}) {
  listEl.innerHTML = "";
  const searching = !!matchedByResource;
  emptyEl.hidden = searching || resources.length > 0;
  searchEmptyEl.hidden = !searching || resources.length > 0;
  resources.forEach((r) => {
    listEl.appendChild(
      makeCard(r, refreshResources, matchedByResource && matchedByResource[r.id])
    );
  });
}

function populateEntryLocations() {
  const current = locationInput.value;
  locationInput.innerHTML = '<option value="" selected>No location</option>';
  locations.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    locationInput.appendChild(opt);
  });
  locationInput.value = current;
}

export async function refreshResources() {
  const query = searchInput.value.trim();
  const [resources, locs] = await Promise.all([
    query
      ? fetch(`/api/resources/search?q=${encodeURIComponent(query)}`).then((r) => r.json())
      : fetch("/api/resources").then((r) => r.json()),
    fetch("/api/locations").then((r) => r.json()),
  ]);
  locations = locs;
  populateEntryLocations();

  if (query) {
    const matchedByResource = Object.fromEntries(
      resources.map((r) => [r.id, r.matched_items || []])
    );
    render(resources, { matchedByResource });
  } else {
    render(resources);
  }
}

// --- Entry -----------------------------------------------------------

saveBtn.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if (!name) {
    saveStatus.textContent = "Give the resource a name first.";
    return;
  }
  saveBtn.disabled = true;
  saveStatus.textContent = "Saving…";
  try {
    const res = await fetch("/api/resources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        location_id: locationInput.value || undefined,
        url: urlInput.value.trim() || undefined,
        notes: notesInput.value.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      saveStatus.textContent = `Error: ${data.error}`;
      return;
    }
    nameInput.value = "";
    urlInput.value = "";
    notesInput.value = "";
    locationInput.value = "";
    saveStatus.textContent = `Added "${data.name}".`;
    // A new resource should show even if a search filter is active and
    // wouldn't match it -- clearing the box is the least surprising.
    searchInput.value = "";
    refreshResources();
  } finally {
    saveBtn.disabled = false;
  }
});

let searchDebounce = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(refreshResources, 200);
});

export function initResources() {
  refreshResources();
}
