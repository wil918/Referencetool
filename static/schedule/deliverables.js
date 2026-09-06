// The Deliverables tab: a first-class view of what a project owes and how
// close it is to owing it. Deliverables are how the work is actually marked,
// so this is not a sub-panel of the Tasks tab -- it is its own drawing.
//
// What it draws, per selected project:
//   - every deliverable in position order, with due date and weighting;
//   - the brief's own `spec` JSON rendered readably -- page counts, required
//     items as a ticked checklist -- WHATEVER SHAPE it happens to be, because
//     brief formats vary year to year (see db.py's DELIVERABLES_SCHEMA);
//   - progress from its tasks: done, remaining, at risk;
//   - risk stated once at the deliverable level ("4 of 6 tasks can't be
//     placed -- Part 2 will not be finished in time"), which is the sentence
//     someone acts on, rather than five scattered task warnings;
//   - a control on every task to move it between deliverables.
//
// At-risk data comes from GET /api/schedule, which recomputes it fresh on
// every read against the current deliverable due dates (see
// scheduling.plan / _at_risk) -- so editing a due date here and re-fetching
// is enough; committing new blocks is the Tasks/Schedule tab's Replan.

import { makeKey } from "./key.js";
import { initBriefImport } from "./brief-import.js";

const projectSelect = document.getElementById("deliverable-project-select");
const newBtn = document.getElementById("deliverable-new-btn");
const listEl = document.getElementById("deliverable-list");
const emptyEl = document.getElementById("deliverable-list-empty");
const hintEl = document.getElementById("deliverable-project-hint");

// The brief importer owns its own button (#brief-import-btn) and review sheet;
// this tab just tells it which project is selected and reloads once a brief is
// approved into deliverables, tasks and commitments.
const briefImport = initBriefImport({
  getProjectId: () => selectedProjectId,
  onApplied: () => refreshDeliverables(),
});

// The selected project persists across tab switches within a session; there is
// no server-side "current project" and inventing one for this tab alone would
// be a lie the rest of the app doesn't tell.
let selectedProjectId = "";

// --- small helpers --------------------------------------------------------

function humanize(key) {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function formatDate(s) {
  if (!s) return null;
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

function formatWeighting(w) {
  if (w == null) return null;
  // A weighting stored as 0.6 reads as 60% of the mark; one stored as 60
  // already is a percentage. Treat <= 1 as a fraction.
  return w <= 1 ? `${Math.round(w * 100)}%` : `${w}%`;
}

const RESOLVED = new Set(["done", "partial"]);
const OUTSTANDING = new Set(["pending", "scheduled"]);

// --- the spec, rendered for whatever shape it is -------------------------
//
// The one rule: render what is present, skip what is not, never assume a key.
// Keys beginning "__" are this view's own bookkeeping (the checklist tick
// state) and are never drawn.

function isChecklistKey(k) {
  return k.startsWith("__");
}

function checkedSet(spec) {
  return new Set(Array.isArray(spec.__checked) ? spec.__checked : []);
}

function renderScalarGroup(pairs) {
  // A run of plain key: value facts, drawn as one numbered key the way a
  // block's detail is (key.js) -- a leader per row, values right-aligned.
  return makeKey(pairs.map(([k, v]) => [humanize(k), String(v)]));
}

function renderChecklist(deliverable, specKey, items, checked, onToggle) {
  const list = document.createElement("div");
  list.className = "dr-checklist deliverable-checklist";

  items.forEach((item, i) => {
    const token = `${specKey}.${i}`;
    const row = document.createElement("label");
    row.className = "dr-checklist-row deliverable-check-row";
    const isDone = checked.has(token);
    if (isDone) row.classList.add("is-done");

    const toggle = document.createElement("span");
    toggle.className = "dr-toggle";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = isDone;
    box.addEventListener("change", () => onToggle(token, box.checked));
    const drawn = document.createElement("span");
    drawn.className = "dr-toggle-box";
    toggle.append(box, drawn);

    const text = document.createElement("span");
    text.className = "dr-checklist-title";
    text.textContent = typeof item === "string" ? item : JSON.stringify(item);

    row.append(toggle, text);
    list.appendChild(row);
  });
  return list;
}

function renderSpec(deliverable, onToggle) {
  const spec = deliverable.spec;
  const frag = document.createDocumentFragment();
  if (!spec || typeof spec !== "object") return frag;

  const checked = checkedSet(spec);
  const scalars = [];

  for (const [key, value] of Object.entries(spec)) {
    if (isChecklistKey(key)) continue;

    if (Array.isArray(value)) {
      const heading = document.createElement("p");
      heading.className = "dr-label deliverable-spec-heading";
      heading.textContent = humanize(key);
      frag.appendChild(heading);

      const allScalar = value.every((v) => v === null || typeof v !== "object");
      if (allScalar && value.length) {
        frag.appendChild(renderChecklist(deliverable, key, value, checked, onToggle));
      } else {
        // Array of objects: each becomes its own small key block, so a
        // "required items" list of {name, quantity} objects still reads.
        value.forEach((obj) => {
          if (obj && typeof obj === "object") {
            frag.appendChild(renderScalarGroup(Object.entries(obj)));
          } else {
            const p = document.createElement("p");
            p.className = "dr-body";
            p.textContent = String(obj);
            frag.appendChild(p);
          }
        });
      }
    } else if (value && typeof value === "object") {
      const heading = document.createElement("p");
      heading.className = "dr-label deliverable-spec-heading";
      heading.textContent = humanize(key);
      frag.appendChild(heading);
      frag.appendChild(renderScalarGroup(Object.entries(value)));
    } else if (value !== null && value !== undefined && value !== "") {
      scalars.push([key, value]);
    }
  }

  if (scalars.length) frag.insertBefore(renderScalarGroup(scalars), frag.firstChild);
  return frag;
}

// --- one deliverable ----------------------------------------------------

function progressFor(tasks, atRiskIds) {
  const done = tasks.filter((t) => RESOLVED.has(t.status));
  const outstanding = tasks.filter((t) => OUTSTANDING.has(t.status));
  const abandoned = tasks.filter((t) => t.status === "abandoned");
  const atRisk = outstanding.filter((t) => atRiskIds.has(t.id));
  return {
    total: tasks.length,
    done: done.length,
    remaining: outstanding.length,
    abandoned: abandoned.length,
    atRisk: atRisk.length,
  };
}

function renderRisk(deliverable, riskRow, atRiskEntries) {
  if (!riskRow || !riskRow.at_risk_tasks) return null;

  const box = document.createElement("div");
  box.className = "deliverable-risk";

  const head = document.createElement("p");
  head.className = "dr-label deliverable-risk-head";
  head.textContent = "At risk";
  box.appendChild(head);

  const sentence = document.createElement("p");
  sentence.className = "dr-body";
  const due = formatDate(deliverable.due_at);
  sentence.textContent =
    `${riskRow.at_risk_tasks} of ${riskRow.total_tasks} ` +
    `${riskRow.total_tasks === 1 ? "task" : "tasks"} cannot be placed` +
    `${due ? ` before ${due}` : ""}. As planned, this deliverable ` +
    `will not be completed in time.`;
  box.appendChild(sentence);

  // The specific tasks and the scheduler's stated reason for each -- so the
  // deliverable-level sentence stays a summary but the fix is still one click
  // away in the Tasks tab.
  const mine = atRiskEntries.filter((e) => e.deliverable_id === deliverable.id);
  if (mine.length) {
    const ul = document.createElement("ul");
    ul.className = "deliverable-risk-list";
    mine.forEach((e) => {
      const li = document.createElement("li");
      const strong = document.createElement("span");
      strong.className = "dr-heavier";
      strong.textContent = e.title;
      li.append(strong, document.createTextNode(` — ${e.message}`));
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
  return box;
}

function taskMover(task, deliverables, onMoved) {
  const select = document.createElement("select");
  select.className = "deliverable-task-move";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No deliverable";
  select.appendChild(none);
  deliverables.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d.title;
    select.appendChild(opt);
  });
  select.value = task.deliverable_id || "";
  select.setAttribute("aria-label", `Move "${task.title}" to another deliverable`);
  select.addEventListener("change", async () => {
    await fetch(`/api/tasks/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliverable_id: select.value || null }),
    });
    onMoved();
  });
  return select;
}

function renderTaskLine(task, deliverables, atRiskIds, onMoved) {
  const row = document.createElement("div");
  row.className = "deliverable-task-row";
  if (RESOLVED.has(task.status)) row.classList.add("is-done");

  const title = document.createElement("span");
  title.className = "deliverable-task-title";
  title.textContent = task.title;

  const status = document.createElement("span");
  status.className = "dr-micro";
  status.textContent = atRiskIds.has(task.id) && OUTSTANDING.has(task.status)
    ? "at risk"
    : task.status;

  row.append(title, status, taskMover(task, deliverables, onMoved));
  return row;
}

function renderDeliverable(deliverable, ctx) {
  const { tasksByDeliverable, deliverables, atRiskIds, atRiskEntries, riskByDeliverable, reload } =
    ctx;
  const tasks = tasksByDeliverable.get(deliverable.id) || [];
  const prog = progressFor(tasks, atRiskIds);

  const sheet = document.createElement("section");
  sheet.className = "deliverable-sheet";

  // Title block, the same shape the detail panels use.
  const header = document.createElement("div");
  header.className = "dr-titleblock";
  const field = document.createElement("div");
  field.className = "dr-titleblock-field";
  const micro = document.createElement("span");
  micro.className = "dr-micro";
  const due = formatDate(deliverable.due_at);
  micro.textContent = `Deliverable${due ? ` · due ${due}` : ""}`;
  const h = document.createElement("h3");
  h.className = "dr-title panel-title";
  h.textContent = deliverable.title;
  field.append(micro, h);
  header.appendChild(field);

  const editBtn = document.createElement("button");
  editBtn.className = "btn";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => openEditor(deliverable, reload));
  header.appendChild(editBtn);
  sheet.appendChild(header);

  // The facts and the progress, as one key.
  sheet.appendChild(
    makeKey([
      ["Due", due],
      ["Weighting", formatWeighting(deliverable.weighting)],
      ["Tasks", prog.total ? String(prog.total) : "None yet"],
      ["Done", prog.total ? `${prog.done} of ${prog.total}` : null],
      ["Remaining", prog.total ? String(prog.remaining) : null],
      ["At risk", prog.atRisk ? String(prog.atRisk) : null],
      ["Abandoned", prog.abandoned ? String(prog.abandoned) : null],
      ["Notes", deliverable.description, { wide: true }],
    ]),
  );

  const risk = renderRisk(deliverable, riskByDeliverable.get(deliverable.id), atRiskEntries);
  if (risk) sheet.appendChild(risk);

  const spec = renderSpec(deliverable, (token, on) => toggleChecklist(deliverable, token, on, reload));
  if (spec.childNodes.length) {
    const wrap = document.createElement("div");
    wrap.className = "deliverable-spec";
    wrap.appendChild(spec);
    sheet.appendChild(wrap);
  }

  // The tasks, each with its mover.
  if (tasks.length) {
    const label = document.createElement("p");
    label.className = "dr-label deliverable-tasks-label";
    label.textContent = "Tasks";
    sheet.appendChild(label);
    tasks.forEach((t) =>
      sheet.appendChild(renderTaskLine(t, deliverables, atRiskIds, reload)),
    );
  }

  return sheet;
}

async function toggleChecklist(deliverable, token, on, reload) {
  const spec = deliverable.spec && typeof deliverable.spec === "object" ? { ...deliverable.spec } : {};
  const set = new Set(Array.isArray(spec.__checked) ? spec.__checked : []);
  if (on) set.add(token);
  else set.delete(token);
  spec.__checked = [...set];
  await fetch(`/api/deliverables/${deliverable.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
  });
  reload();
}

// --- unassigned tasks in the project ----------------------------------
//
// The other half of "a task's deliverable is settable from here": tasks in
// this project not yet under any deliverable, so they can be pulled in.

function renderUnassigned(tasks, deliverables, atRiskIds, reload) {
  if (!tasks.length) return null;
  const sheet = document.createElement("section");
  sheet.className = "deliverable-sheet deliverable-sheet--unassigned";

  const label = document.createElement("p");
  label.className = "dr-label";
  label.textContent = `Not under a deliverable (${tasks.length})`;
  sheet.appendChild(label);

  const note = document.createElement("p");
  note.className = "muted";
  note.textContent =
    "Project tasks with no deliverable. They still compete for the same hours; " +
    "assign one to fold it into that deliverable's progress and risk.";
  sheet.appendChild(note);

  tasks.forEach((t) =>
    sheet.appendChild(renderTaskLine(t, deliverables, atRiskIds, reload)),
  );
  return sheet;
}

// --- the editor -------------------------------------------------------
//
// Create and edit by hand -- session 15 adds import from a brief, but this
// tab is fully usable without it. Built in JS rather than parked in
// schedule.html because it is one more modal than that file should carry.

let editorOverlay = null;
let editorBox = null;

function ensureEditor() {
  if (editorOverlay) return;
  editorOverlay = document.createElement("div");
  editorOverlay.className = "modal-overlay";
  editorOverlay.hidden = true;
  editorBox = document.createElement("div");
  editorBox.className = "modal-box deliverable-editor-box";
  editorOverlay.appendChild(editorBox);
  editorOverlay.addEventListener("click", (e) => {
    if (e.target === editorOverlay) editorOverlay.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !editorOverlay.hidden) editorOverlay.hidden = true;
  });
  document.body.appendChild(editorOverlay);
}

function labelled(text, control) {
  const l = document.createElement("label");
  l.textContent = text;
  l.appendChild(control);
  return l;
}

function openEditor(deliverable, reload) {
  ensureEditor();
  editorOverlay.hidden = false;
  editorBox.innerHTML = "";
  const creating = !deliverable;

  const header = document.createElement("div");
  header.className = "dr-titleblock";
  const field = document.createElement("div");
  field.className = "dr-titleblock-field";
  const micro = document.createElement("span");
  micro.className = "dr-micro";
  micro.textContent = creating ? "New deliverable" : "Edit deliverable";
  const h = document.createElement("h3");
  h.className = "dr-title panel-title";
  h.textContent = creating ? "New deliverable" : deliverable.title;
  field.append(micro, h);
  header.appendChild(field);
  editorBox.appendChild(header);

  const title = document.createElement("input");
  title.type = "text";
  title.value = deliverable?.title || "";
  title.placeholder = "e.g. Part 2 — Realisation";

  const due = document.createElement("input");
  due.type = "date";
  due.value = (deliverable?.due_at || "").slice(0, 10);

  const weighting = document.createElement("input");
  weighting.type = "number";
  weighting.min = "0";
  weighting.step = "any";
  weighting.value = deliverable?.weighting ?? "";
  weighting.placeholder = "0.6 or 60";

  const description = document.createElement("textarea");
  description.rows = 2;
  description.value = deliverable?.description || "";

  // The spec is JSON because its shape is not ours to fix (db.py). Editing it
  // by hand means editing that JSON directly -- the readable rendering is the
  // read side; this is the write side. Left blank means no spec.
  const spec = document.createElement("textarea");
  spec.rows = 8;
  spec.className = "deliverable-spec-json";
  spec.spellcheck = false;
  spec.value = deliverable?.spec ? JSON.stringify(stripChecklist(deliverable.spec), null, 2) : "";
  spec.placeholder = '{\n  "pages": 20,\n  "required_items": ["Fabric test 1", "Fabric test 2"]\n}';

  const status = document.createElement("p");
  status.className = "muted";

  const grid = document.createElement("div");
  grid.className = "deliverable-editor-grid";
  grid.append(
    labelled("Title", title),
    labelled("Due date", due),
    labelled("Weighting", weighting),
    labelled("Notes", description),
  );
  editorBox.appendChild(grid);
  editorBox.appendChild(labelled("Spec (JSON, from the brief)", spec));
  editorBox.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  if (!creating) {
    const del = document.createElement("button");
    del.className = "btn danger";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      del.disabled = true;
      await fetch(`/api/deliverables/${deliverable.id}`, { method: "DELETE" });
      editorOverlay.hidden = true;
      reload();
    });
    actions.appendChild(del);
  }

  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => { editorOverlay.hidden = true; });

  const save = document.createElement("button");
  save.className = "btn primary";
  save.textContent = creating ? "Create" : "Save";
  save.addEventListener("click", async () => {
    const name = title.value.trim();
    if (!name) {
      status.textContent = "A title is required.";
      return;
    }
    let parsedSpec = null;
    if (spec.value.trim()) {
      try {
        parsedSpec = JSON.parse(spec.value);
      } catch (err) {
        status.textContent = `Spec is not valid JSON: ${err.message}`;
        return;
      }
    }
    // Preserve the checklist ticks the readable view wrote, which the
    // hand-edited JSON above deliberately doesn't show.
    if (parsedSpec && deliverable?.spec?.__checked) {
      parsedSpec.__checked = deliverable.spec.__checked;
    }

    const body = {
      title: name,
      due_at: due.value || null,
      weighting: weighting.value === "" ? null : Number(weighting.value),
      description: description.value.trim() || null,
      spec: parsedSpec,
    };
    save.disabled = true;
    const url = creating
      ? `/api/projects/${selectedProjectId}/deliverables`
      : `/api/deliverables/${deliverable.id}`;
    const res = await fetch(url, {
      method: creating ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    save.disabled = false;
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      status.textContent = `Error: ${data.error || res.status}`;
      return;
    }
    editorOverlay.hidden = true;
    reload();
  });

  actions.append(cancel, save);
  editorBox.appendChild(actions);
  title.focus();
}

function stripChecklist(spec) {
  if (!spec || typeof spec !== "object") return spec;
  const copy = {};
  for (const [k, v] of Object.entries(spec)) if (!isChecklistKey(k)) copy[k] = v;
  return copy;
}

// --- the imported-brief banner --------------------------------------
//
// A one-line note that a brief backs these deliverables, with a link to the
// original and the "Import brief" button as the re-import path. The heavy
// rendering stays where it belongs: deliverables here, tasks on the Tasks
// tab, key dates on the calendar.

function renderBriefBanner(briefs) {
  if (!briefs || !briefs.length) return null;
  const brief = briefs[0];
  const applied = brief.extracted && brief.extracted.applied;

  const row = document.createElement("p");
  row.className = "dr-micro deliverable-brief-banner";

  const when = new Date(brief.imported_at).toLocaleDateString();
  row.append(document.createTextNode(`Brief imported ${when}. `));

  if (!applied) {
    const review = document.createElement("button");
    review.className = "btn";
    review.textContent = "Review & approve";
    review.addEventListener("click", () =>
      briefImport.review(brief.id, { onApplied: () => refreshDeliverables() }),
    );
    row.append(review, document.createTextNode(" "));
  }

  const link = document.createElement("a");
  link.href = `/api/briefs/${brief.id}/file`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Original PDF";
  row.append(link);
  return row;
}

// --- load and draw ----------------------------------------------------

async function populateProjects() {
  const projects = await fetch("/api/projects").then((r) => r.json());
  const current = selectedProjectId;
  projectSelect.innerHTML = "";
  if (!projects.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No projects yet";
    projectSelect.appendChild(opt);
    projectSelect.disabled = true;
    return [];
  }
  projectSelect.disabled = false;
  projects.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.title;
    projectSelect.appendChild(opt);
  });
  if (!current || !projects.some((p) => p.id === current)) {
    selectedProjectId = projects[0].id;
  }
  projectSelect.value = selectedProjectId;
  return projects;
}

export async function refreshDeliverables() {
  const projects = await populateProjects();

  if (!projects.length || !selectedProjectId) {
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = "Create a project first — deliverables belong to one.";
    newBtn.disabled = true;
    briefImport.setEnabled(false);
    return;
  }
  newBtn.disabled = false;
  briefImport.setEnabled(true);

  const pid = selectedProjectId;
  const [deliverables, tasks, schedule, briefs] = await Promise.all([
    fetch(`/api/projects/${pid}/deliverables`).then((r) => r.json()),
    fetch(`/api/tasks?project_id=${pid}`).then((r) => r.json()),
    fetch("/api/schedule").then((r) => r.json()),
    fetch(`/api/projects/${pid}/briefs`).then((r) => r.json()),
  ]);

  const atRiskEntries = schedule.at_risk || [];
  const atRiskIds = new Set(atRiskEntries.map((e) => e.task_id));
  const riskByDeliverable = new Map(
    (schedule.at_risk_by_deliverable || []).map((r) => [r.deliverable_id, r]),
  );

  const tasksByDeliverable = new Map();
  const unassigned = [];
  tasks.forEach((t) => {
    if (t.deliverable_id) {
      if (!tasksByDeliverable.has(t.deliverable_id)) tasksByDeliverable.set(t.deliverable_id, []);
      tasksByDeliverable.get(t.deliverable_id).push(t);
    } else {
      unassigned.push(t);
    }
  });

  const reload = () => refreshDeliverables();
  const ctx = {
    tasksByDeliverable,
    deliverables,
    atRiskIds,
    atRiskEntries,
    riskByDeliverable,
    reload,
  };

  listEl.innerHTML = "";
  emptyEl.hidden = deliverables.length > 0 || briefs.length > 0;
  emptyEl.textContent = "No deliverables yet — import a brief above, or add one by hand.";

  const banner = renderBriefBanner(briefs);
  if (banner) listEl.appendChild(banner);

  deliverables.forEach((d) => listEl.appendChild(renderDeliverable(d, ctx)));
  const un = renderUnassigned(unassigned, deliverables, atRiskIds, reload);
  if (un) listEl.appendChild(un);

  hintEl.hidden = projects.length < 2;
}

projectSelect.addEventListener("change", () => {
  selectedProjectId = projectSelect.value;
  refreshDeliverables();
});

newBtn.addEventListener("click", () => openEditor(null, () => refreshDeliverables()));
