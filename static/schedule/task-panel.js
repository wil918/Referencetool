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

function makeChipsRow(task) {
  const row = document.createElement("div");
  row.className = "task-chips";
  if (task.est_minutes != null) row.appendChild(makeStaticChip(formatMinutes(task.est_minutes)));
  if (task.importance != null) row.appendChild(makeStaticChip(`importance ${task.importance}`));
  if (task.difficulty != null) row.appendChild(makeStaticChip(`difficulty ${task.difficulty}`));
  return row;
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

function makeScheduleRow(block, refresh) {
  const row = document.createElement("div");
  row.className = "task-schedule-row";
  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = `Scheduled: ${formatBlockTime(block)}`;
  row.appendChild(label);

  if (block.granularity === "slot") {
    const pinBtn = document.createElement("button");
    pinBtn.className = "btn task-pin-btn" + (block.is_locked ? " active" : "");
    pinBtn.title = block.is_locked ? "Unlock this slot" : "Lock to this slot";
    pinBtn.textContent = block.is_locked ? "Locked" : "Lock";
    pinBtn.addEventListener("click", () => setBlockLocked(block.id, !block.is_locked, refresh));
    row.appendChild(pinBtn);
  }
  return row;
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
  const [task, actual, blocks] = await Promise.all([
    fetch(`/api/tasks/${taskId}`).then((r) => (r.ok ? r.json() : null)),
    fetch(`/api/tasks/${taskId}/actual`).then((r) => (r.ok ? r.json() : null)),
    fetch(`/api/tasks/${taskId}/blocks`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  if (!task) {
    box.textContent = "This task no longer exists.";
    return;
  }

  const refresh = () => render(taskId, onChange);

  const header = document.createElement("div");
  header.className = "task-card-header";
  const h3 = document.createElement("h3");
  h3.className = "task-title";
  h3.textContent = task.title;
  header.appendChild(h3);
  const status = document.createElement("span");
  status.className = "muted";
  status.textContent = task.status;
  header.appendChild(status);

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", close);

  const card = document.createElement("div");
  card.className = "task-card task-panel-card";

  if (task.description) {
    const desc = document.createElement("p");
    desc.className = "muted";
    desc.textContent = task.description;
    card.appendChild(desc);
  }
  card.appendChild(makeChipsRow(task));
  if (task.measurable_goal) {
    const goal = document.createElement("p");
    goal.className = "task-goal";
    goal.textContent = task.measurable_goal;
    card.appendChild(goal);
  }

  if (task.status === "done" || task.status === "partial") {
    const row = document.createElement("div");
    row.className = "task-actuals";
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = task.status === "partial" ? "Partially completed" : "Done";
    row.appendChild(label);
    if (actual) {
      if (actual.actual_minutes != null) row.appendChild(makeStaticChip(formatMinutes(actual.actual_minutes)));
      if (actual.actual_importance != null) row.appendChild(makeStaticChip(`importance ${actual.actual_importance}`));
      if (actual.actual_difficulty != null) row.appendChild(makeStaticChip(`difficulty ${actual.actual_difficulty}`));
    }
    card.appendChild(row);
  } else if (task.status !== "abandoned") {
    const currentBlock = (blocks || []).filter((b) => b.kind === "task").slice(-1)[0];
    if (currentBlock) card.appendChild(makeScheduleRow(currentBlock, refresh));
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
