// The task detail panel a calendar block opens into: the same three
// outcomes and pin control tasks.js renders on the Tasks tab, in a modal, so
// clicking a block on the week view can complete/pin a task without leaving
// the calendar. Deliberately a thin sibling of tasks.js rather than an
// import from it -- tasks.js's builders are wired directly to the Tasks
// tab's own DOM ids and its own refreshTaskList(), and reaching into that
// from here would couple two independently-owned tabs together for what is,
// underneath, five small POSTs this module already knows how to make itself.
// Same card classes throughout (.task-card, .task-chips, ...) so the two
// surfaces read as the same UI wherever they overlap.
//
// Exports openTaskPanel(taskId, { onChange }) -- onChange fires after any
// action that could have moved something on the calendar (an outcome, a
// pin/unlock), so the caller (calendar.js) knows to reload.

import { makeKey } from "./key.js";
import { describeRule } from "./recurrence.js";

let overlay = null;
let box = null;

function ensureModal() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.hidden = true;

  box = document.createElement("div");
  box.className = "modal-box task-panel-box";
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

function formatMinutes(total) {
  if (total == null) return null;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function makeStaticChip(text) {
  const chip = document.createElement("span");
  chip.className = "task-chip";
  chip.textContent = text;
  return chip;
}

function formatBlockTime(block) {
  if (block.granularity !== "slot") {
    return new Date(`${block.start}T00:00:00`).toLocaleDateString();
  }
  const start = new Date(block.start);
  const end = new Date(block.end);
  const day = start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const endTime = end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}–${endTime}`;
}

async function setBlockLocked(blockId, isLocked, refresh) {
  await fetch(`/api/schedule/blocks/${blockId}/lock`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_locked: isLocked }),
  });
  refresh();
}

/* The slot, and its lock, as one keyed value -- the lock belongs beside the
 * time it locks rather than in a row of its own. */
function makeSlotValue(block, refresh) {
  const wrap = document.createElement("span");
  wrap.className = "task-schedule-row";
  wrap.appendChild(document.createTextNode(formatBlockTime(block)));

  if (block.granularity === "slot") {
    const pinBtn = document.createElement("button");
    pinBtn.className = "btn task-pin-btn" + (block.is_locked ? " active" : "");
    pinBtn.title = block.is_locked ? "Unlock this slot" : "Lock to this slot";
    pinBtn.textContent = block.is_locked ? "Locked" : "Lock";
    pinBtn.addEventListener("click", () => setBlockLocked(block.id, !block.is_locked, refresh));
    wrap.appendChild(pinBtn);
  }
  return wrap;
}

/* The task's deliverable, settable from the task itself -- the same control
 * the Deliverables tab offers, so a block on the calendar can be filed under
 * a deliverable without leaving the drawing. A change here shifts what the
 * deliverable owes and can move the task's effective deadline (a task inherits
 * its deliverable's due date -- see scheduling._own_deadline), so onChange
 * fires for the caller to reload. */
/* The resources this task is a trip for. Linking one can fill the task's
 * location (db.add_task_resource), which moves it on the calendar -- so both
 * refresh() and onChange() fire after a change here. */
async function linkResource(taskId, resourceId, refresh, onChange) {
  await fetch(`/api/tasks/${taskId}/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resource_id: resourceId }),
  });
  refresh();
  onChange();
}

async function unlinkResource(taskId, resourceId, refresh, onChange) {
  await fetch(`/api/tasks/${taskId}/resources`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resource_id: resourceId }),
  });
  refresh();
  onChange();
}

function makeResourcesValue(task, linked, allResources, refresh, onChange) {
  const wrap = document.createElement("span");
  wrap.className = "task-schedule-row task-panel-resources";
  const linkedIds = linked.map((r) => r.id);

  linked.forEach((r) => {
    const chip = document.createElement("span");
    chip.className = "task-chip";
    chip.textContent = r.name;
    const x = document.createElement("button");
    x.className = "task-resource-unlink";
    x.setAttribute("aria-label", `Unlink ${r.name}`);
    x.textContent = "×";
    x.addEventListener("click", () => unlinkResource(task.id, r.id, refresh, onChange));
    chip.appendChild(x);
    wrap.appendChild(chip);
  });

  const unlinked = allResources.filter((r) => !linkedIds.includes(r.id));
  if (unlinked.length) {
    const add = document.createElement("select");
    add.innerHTML = `<option value="">${linkedIds.length ? "Link another…" : "Link a resource…"}</option>`;
    unlinked.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name;
      add.appendChild(opt);
    });
    add.addEventListener("change", () => {
      if (add.value) linkResource(task.id, add.value, refresh, onChange);
    });
    wrap.appendChild(add);
  }
  return wrap;
}

async function setDeliverable(taskId, deliverableId, refresh, onChange) {
  await fetch(`/api/tasks/${taskId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deliverable_id: deliverableId || null }),
  });
  refresh();
  onChange();
}

function makeDeliverableValue(task, deliverables, refresh, onChange) {
  const select = document.createElement("select");
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
  select.setAttribute("aria-label", "Move this task to another deliverable");
  select.addEventListener("change", () =>
    setDeliverable(task.id, select.value, refresh, onChange));
  return select;
}

function defaultActualMinutes(task, block) {
  if (block) return Math.round((new Date(block.end) - new Date(block.start)) / 60000);
  return task.est_minutes || "";
}

async function completeTask(taskId, corrections, refresh, onChange) {
  await fetch(`/api/tasks/${taskId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corrections || {}),
  });
  refresh();
  onChange();
}

async function partialTask(taskId, actualMinutes, remainderEstMinutes, refresh, onChange) {
  const res = await fetch(`/api/tasks/${taskId}/partial`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actual_minutes: actualMinutes, est_minutes: remainderEstMinutes }),
  });
  refresh();
  onChange();
  return res.ok;
}

async function notCompletedTask(taskId, refresh, onChange) {
  await fetch(`/api/tasks/${taskId}/not-completed`, { method: "POST" });
  refresh();
  onChange();
}

function makePartialForm(task, block, wrap, refresh, onChange) {
  const form = document.createElement("div");
  form.className = "task-partial-form";

  const spentLabel = document.createElement("label");
  spentLabel.textContent = "Minutes spent";
  const spentInput = document.createElement("input");
  spentInput.type = "number";
  spentInput.min = "1";
  spentInput.value = defaultActualMinutes(task, block);
  spentLabel.appendChild(spentInput);

  const remainingLabel = document.createElement("label");
  remainingLabel.textContent = "Minutes remaining";
  const remainingInput = document.createElement("input");
  remainingInput.type = "number";
  remainingInput.min = "1";
  remainingLabel.appendChild(remainingInput);

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn primary";
  saveBtn.textContent = "Save";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn";
  cancelBtn.textContent = "Cancel";
  const status = document.createElement("span");
  status.className = "muted";

  saveBtn.addEventListener("click", async () => {
    const spent = Number(spentInput.value);
    const remaining = Number(remainingInput.value);
    if (!spent || spent <= 0) {
      status.textContent = "Minutes spent must be a positive number.";
      return;
    }
    if (!remaining || remaining <= 0) {
      status.textContent = "A fresh estimate for what remains is required.";
      return;
    }
    const ok = await partialTask(task.id, spent, remaining, refresh, onChange);
    if (!ok) status.textContent = "Could not save -- try again.";
  });
  cancelBtn.addEventListener("click", () => wrap.replaceChildren());

  form.append(spentLabel, remainingLabel, saveBtn, cancelBtn, status);
  return form;
}

function makeActionsRow(task, block, refresh, onChange) {
  const row = document.createElement("div");
  row.className = "task-card-actions";
  const formSlot = document.createElement("div");

  const completedBtn = document.createElement("button");
  completedBtn.className = "btn primary";
  completedBtn.textContent = "Completed";
  completedBtn.addEventListener("click", () => completeTask(task.id, null, refresh, onChange));

  const partialBtn = document.createElement("button");
  partialBtn.className = "btn";
  partialBtn.textContent = "Partially completed";
  partialBtn.addEventListener("click", () => {
    formSlot.replaceChildren(makePartialForm(task, block, formSlot, refresh, onChange));
  });

  const notCompletedBtn = document.createElement("button");
  notCompletedBtn.className = "btn";
  notCompletedBtn.textContent = "Not completed";
  notCompletedBtn.addEventListener("click", () => notCompletedTask(task.id, refresh, onChange));

  const buttons = document.createElement("div");
  buttons.className = "task-card-outcome-buttons";
  buttons.append(completedBtn, partialBtn, notCompletedBtn);

  row.append(buttons, formSlot);
  return row;
}

async function render(taskId, onChange) {
  box.innerHTML = "";
  const [task, actual, blocks, linkedResources, allResources] = await Promise.all([
    fetch(`/api/tasks/${taskId}`).then((r) => (r.ok ? r.json() : null)),
    fetch(`/api/tasks/${taskId}/actual`).then((r) => (r.ok ? r.json() : null)),
    fetch(`/api/tasks/${taskId}/blocks`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch(`/api/tasks/${taskId}/resources`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch(`/api/resources`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  // The rule this task carries, if any -- read-only here: the calendar block is
  // for acting on the plan, and a rule's cadence is edited on the Tasks tab.
  const rule = task?.recurrence_id
    ? await fetch(`/api/recurrence-rules/${task.recurrence_id}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    : null;
  if (!task) {
    box.textContent = "This task no longer exists.";
    return;
  }

  // Only a task with a project can have a deliverable -- deliverables belong
  // to one project (db.py).
  const deliverables = task.project_id
    ? await fetch(`/api/projects/${task.project_id}/deliverables`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])
    : [];

  const refresh = () => render(taskId, onChange);

  const header = document.createElement("div");
  header.className = "dr-titleblock";
  const field = document.createElement("div");
  field.className = "dr-titleblock-field";
  const kind = document.createElement("span");
  kind.className = "dr-micro";
  kind.textContent = `Task \u00b7 ${task.status}`;
  const h3 = document.createElement("h3");
  h3.className = "dr-title panel-title";
  h3.textContent = task.title;
  field.append(kind, h3);
  header.appendChild(field);

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", close);

  const card = document.createElement("div");
  card.className = "task-card task-panel-card";

  const currentBlock = (blocks || []).filter((b) => b.kind === "task").slice(-1)[0];
  const done = task.status === "done" || task.status === "partial";

  // One key for the whole task. Entries that resolve to nothing are dropped
  // before numbering, so the sequence never has a hole in it.
  card.appendChild(makeKey([
    ["Estimate", formatMinutes(task.est_minutes)],
    ["Importance", task.importance != null ? String(task.importance) : null],
    ["Difficulty", task.difficulty != null ? String(task.difficulty) : null],
    ["Deadline", task.deadline],
    ["Repeats", rule ? describeRule(rule).replace(/^Repeats /, "") : null],
    ["Deliverable", task.project_id
      ? makeDeliverableValue(task, deliverables, refresh, onChange)
      : null],
    ["Resources", (linkedResources.length || allResources.length) && !done
      ? makeResourcesValue(task, linkedResources, allResources, refresh, onChange)
      : linkedResources.length
        ? linkedResources.map((r) => r.name).join(", ")
        : null],
    ["Slot", currentBlock && !done ? makeSlotValue(currentBlock, refresh) : null],
    ["Spent", done && actual?.actual_minutes != null ? formatMinutes(actual.actual_minutes) : null],
    ["Goal", task.measurable_goal, { wide: true }],
    ["Notes", task.description, { wide: true }],
  ]));

  if (!done && task.status !== "abandoned") {
    card.appendChild(makeActionsRow(task, currentBlock, refresh, onChange));
  }

  box.append(header, card, closeBtn);
}

export function openTaskPanel(taskId, { onChange = () => {} } = {}) {
  ensureModal();
  overlay.hidden = false;
  render(taskId, onChange);
}

export function closeTaskPanel() {
  if (overlay) close();
}
