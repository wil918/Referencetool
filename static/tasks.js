// The Tasks tab: quick entry (one required field, everything else optional
// and hidden behind a disclosure), Claude-generated estimates shown as
// editable chips, and one-tap completion. See CLAUDE.md's data model section
// for tasks/task_actuals and the *_source convention this leans on.
//
// Deliberately its own module rather than folded into app.js -- app.js is
// already large, and this tab's entry/list/chip logic doesn't share state
// with anything else there. app.js imports refreshTaskList() to wire it into
// the existing tab-switch dispatcher, the same way it already imports
// carousel.js and folders.js.

import {
  makeRecurrenceField,
  createRule,
  attachRuleToTask,
  updateRule,
  detachRuleFromTask,
  describeRule,
  rulesById as loadRulesById,
} from "./schedule/recurrence.js";

// --- Elements ---

const descriptionInput = document.getElementById("task-description-input");
const saveBtn = document.getElementById("task-save-btn");
const saveStatus = document.getElementById("task-save-status");
const advanced = document.querySelector(".task-advanced");
const titleInput = document.getElementById("task-title-input");
const projectSelect = document.getElementById("task-project-select");
const deliverableSelect = document.getElementById("task-deliverable-select");
const deadlineInput = document.getElementById("task-deadline-input");
const locationSelect = document.getElementById("task-location-select");
const resourceSelect = document.getElementById("task-resource-select");
const supportSelect = document.getElementById("task-support-select");
const importanceInput = document.getElementById("task-importance-input");
const difficultyInput = document.getElementById("task-difficulty-input");
const estimateInput = document.getElementById("task-estimate-input");
const goalInput = document.getElementById("task-goal-input");

// The one-line "Repeats about every N days" control in the entry form. Rebuilt
// on reset so a saved recurring task doesn't leave the next task pre-armed.
const recurrenceSlot = document.getElementById("task-recurrence-slot");
let recurrenceField = null;
function mountRecurrenceField() {
  recurrenceField = makeRecurrenceField();
  recurrenceSlot.replaceChildren(recurrenceField.el);
}
mountRecurrenceField();

const filterProjectSelect = document.getElementById("task-filter-project");
const filterStatusSelect = document.getElementById("task-filter-status");
const listEl = document.getElementById("task-list");
const emptyEl = document.getElementById("task-list-empty");
const replanBtn = document.getElementById("task-replan-btn");
const atRiskPanel = document.getElementById("task-at-risk-panel");

// --- Option lists shared by the entry form and the list filter ---

async function populateProjectOptions(projects) {
  const current = projectSelect.value;
  projectSelect.innerHTML = '<option value="" selected>No project</option>';
  projects.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.title;
    projectSelect.appendChild(opt);
  });
  projectSelect.value = current;

  const currentFilter = filterProjectSelect.value;
  filterProjectSelect.innerHTML = '<option value="" selected>All projects</option>';
  projects.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.title;
    filterProjectSelect.appendChild(opt);
  });
  filterProjectSelect.value = currentFilter;
}

function populateLocationOptions(locations) {
  const current = locationSelect.value;
  locationSelect.innerHTML = '<option value="" selected>Anywhere</option>';
  locations.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    locationSelect.appendChild(opt);
  });
  locationSelect.value = current;
}

// Resources for the entry form's optional "Resource" link. Linking one on
// save carries that resource's location onto the task if it has none (see
// db.add_task_resource) -- a shop trip happens at the shop.
function populateResourceOptions(resources) {
  const current = resourceSelect.value;
  resourceSelect.innerHTML = '<option value="" selected>None</option>';
  resources.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = r.name;
    resourceSelect.appendChild(opt);
  });
  resourceSelect.value = current;
}

async function populateDeliverableOptions(projectId) {
  deliverableSelect.innerHTML = '<option value="" selected>No deliverable</option>';
  deliverableSelect.disabled = true;
  if (!projectId) return;
  const deliverables = await fetch(`/api/projects/${projectId}/deliverables`).then((r) => r.json());
  deliverables.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = d.title;
    deliverableSelect.appendChild(opt);
  });
  deliverableSelect.disabled = false;
}

projectSelect.addEventListener("change", () => populateDeliverableOptions(projectSelect.value));

// --- Entry: the single required field, everything else optional ---

function resetEntryForm() {
  descriptionInput.value = "";
  titleInput.value = "";
  projectSelect.value = "";
  populateDeliverableOptions("");
  deadlineInput.value = "";
  locationSelect.value = "";
  resourceSelect.value = "";
  supportSelect.value = "independent";
  importanceInput.value = "";
  difficultyInput.value = "";
  estimateInput.value = "";
  goalInput.value = "";
  advanced.open = false;
  mountRecurrenceField();
}

saveBtn.addEventListener("click", async () => {
  const description = descriptionInput.value.trim();
  if (!description) {
    saveStatus.textContent = "Describe the task first.";
    return;
  }

  saveStatus.textContent = "Saving...";
  saveBtn.disabled = true;

  // Claude fills in whatever the form left blank -- generation happens
  // every time so a partially-filled form (say, just an estimate) still
  // gets a suggested goal and title. A failure here degrades to "nothing
  // generated" rather than blocking the save: the one required field is the
  // sentence, and that alone must always be enough to save a task.
  let generated = { title: "", est_minutes: null, importance: null, difficulty: null, measurable_goal: "" };
  try {
    const res = await fetch("/api/tasks/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    });
    if (res.ok) generated = await res.json();
  } catch {
    // offline or the API key is missing -- fall through with nothing generated
  }

  const userTitle = titleInput.value.trim();
  const userImportance = importanceInput.value.trim();
  const userDifficulty = difficultyInput.value.trim();
  const userEstimate = estimateInput.value.trim();
  const userGoal = goalInput.value.trim();

  const title = userTitle || generated.title || description.slice(0, 60);
  const measurable_goal = userGoal || generated.measurable_goal || undefined;

  const body = {
    title,
    description,
    measurable_goal,
    project_id: projectSelect.value || undefined,
    deliverable_id: deliverableSelect.value || undefined,
    deadline: deadlineInput.value || undefined,
    required_location_id: locationSelect.value || undefined,
    support_level: supportSelect.value,
    est_minutes: userEstimate ? Number(userEstimate) : generated.est_minutes ?? undefined,
    est_minutes_source: userEstimate ? "user" : generated.est_minutes != null ? "generated" : undefined,
    importance: userImportance ? Number(userImportance) : generated.importance ?? undefined,
    importance_source: userImportance ? "user" : generated.importance != null ? "generated" : undefined,
    difficulty: userDifficulty ? Number(userDifficulty) : generated.difficulty ?? undefined,
    difficulty_source: userDifficulty ? "user" : generated.difficulty != null ? "generated" : undefined,
  };

  // Recurrence is rule-first: create the rule, then create the task already
  // carrying its recurrence_id, so the user's one "Save" is the API's two
  // steps (see recurrence.js and app.py's route comment). A rule that fails
  // to create doesn't block the task -- it just saves as a one-off.
  const recur = recurrenceField.getState();
  if (recur.repeats) {
    const rule = await createRule(recur);
    if (rule) body.recurrence_id = rule.id;
    else saveStatus.textContent = "Couldn't set up the repeat -- saving as a one-off.";
  }

  try {
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      saveStatus.textContent = `Error: ${data.error}`;
    } else {
      // Link the chosen resource once the task exists -- this also fills the
      // task's location from the resource if it had none (see
      // db.add_task_resource). A failure here doesn't undo the saved task.
      if (resourceSelect.value) {
        await fetch(`/api/tasks/${data.id}/resources`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resource_id: resourceSelect.value }),
        });
      }
      saveStatus.textContent = `Saved "${data.title}".`;
      resetEntryForm();
      refreshTaskList();
    }
  } catch (err) {
    saveStatus.textContent = `Error: ${err}`;
  } finally {
    saveBtn.disabled = false;
  }
});

// --- Editable chips ---
//
// A chip is a label; clicking it (or activating it with the keyboard) swaps
// the label for a number input in place. Blur or Enter commits, Escape
// reverts -- there is no separate edit/save mode to leave dangling.

function makeChip({ text, generated, onEdit }) {
  const chip = document.createElement("span");
  chip.className = "task-chip" + (generated ? " generated" : "");
  chip.tabIndex = 0;
  const label = document.createElement("span");
  label.textContent = text;
  chip.appendChild(label);
  // Guards against a double-click (or a stray repeat while a fetch from the
  // first edit is still in flight) re-entering edit mode on a chip that's
  // already showing its input -- replaceChild would throw on the second
  // attempt since `label` is no longer a child of `chip` by then.
  const activate = () => {
    if (chip.querySelector("input")) return;
    onEdit(chip, label);
  };
  chip.addEventListener("click", activate);
  chip.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  });
  return chip;
}

function startNumberEdit(chip, label, currentValue, min, max, onCommit) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.value = String(currentValue);
  chip.replaceChild(input, label);
  input.focus();
  input.select();

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const raw = input.value.trim();
    if (raw === "" || Number.isNaN(Number(raw))) {
      chip.replaceChild(label, input);
      return;
    }
    const value = Math.max(min, Math.min(max, Math.round(Number(raw))));
    onCommit(value);
  };
  const revert = () => {
    if (settled) return;
    settled = true;
    chip.replaceChild(label, input);
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      input.removeEventListener("blur", commit);
      revert();
    }
  });
}

function formatMinutes(total) {
  if (total == null) return null;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// --- Task field edits (title, chips) ---

async function saveTaskFields(taskId, fields) {
  await fetch(`/api/tasks/${taskId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  refreshTaskList();
}

function makeEditableTitle(task) {
  const h3 = document.createElement("h3");
  h3.className = "task-title";
  h3.contentEditable = "true";
  h3.spellcheck = false;
  h3.textContent = task.title;
  const commit = () => {
    const value = h3.textContent.trim();
    if (!value || value === task.title) {
      h3.textContent = task.title;
      return;
    }
    saveTaskFields(task.id, { title: value });
  };
  h3.addEventListener("blur", commit);
  h3.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      h3.blur();
    }
  });
  return h3;
}

function makeEditableGoal(task) {
  const p = document.createElement("p");
  p.className = "task-goal";
  p.contentEditable = "true";
  p.spellcheck = false;
  p.textContent = task.measurable_goal;
  const commit = () => {
    const value = p.textContent.trim();
    if (value === task.measurable_goal) return;
    saveTaskFields(task.id, { measurable_goal: value });
  };
  p.addEventListener("blur", commit);
  p.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      p.blur();
    }
  });
  return p;
}

function makeGeneratedChips(task) {
  const chips = document.createElement("div");
  chips.className = "task-chips";

  if (task.est_minutes != null) {
    chips.appendChild(
      makeChip({
        text: formatMinutes(task.est_minutes),
        generated: task.est_minutes_source === "generated",
        onEdit: (chip, label) =>
          startNumberEdit(chip, label, task.est_minutes, 1, 24 * 60, (value) =>
            saveTaskFields(task.id, { est_minutes: value, est_minutes_source: "user" })
          ),
      })
    );
  }
  if (task.importance != null) {
    chips.appendChild(
      makeChip({
        text: `importance ${task.importance}`,
        generated: task.importance_source === "generated",
        onEdit: (chip, label) =>
          startNumberEdit(chip, label, task.importance, 1, 5, (value) =>
            saveTaskFields(task.id, { importance: value, importance_source: "user" })
          ),
      })
    );
  }
  if (task.difficulty != null) {
    chips.appendChild(
      makeChip({
        text: `difficulty ${task.difficulty}`,
        generated: task.difficulty_source === "generated",
        onEdit: (chip, label) =>
          startNumberEdit(chip, label, task.difficulty, 1, 5, (value) =>
            saveTaskFields(task.id, { difficulty: value, difficulty_source: "user" })
          ),
      })
    );
  }
  return chips;
}

// --- The three outcomes ---
//
// A scheduled block resolves one of three ways (see SCHEDULE_SCOPE.md's
// "three outcomes"). Completed is still the one-tap case: POST with no body
// at all, and app.py fills every actual from the task's own estimate/
// difficulty/importance (or its scheduled block's length, if it has one).
// Editing an actual afterwards re-posts just that field -- see
// api_complete_task's resolve(), which keeps whatever was already recorded
// for anything not sent this time. Partial and not-completed are their own
// routes rather than flags on this one, matching the backend split.

async function completeTask(taskId, corrections) {
  await fetch(`/api/tasks/${taskId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corrections || {}),
  });
  refreshTaskList();
}

async function partialTask(taskId, actualMinutes, remainderEstMinutes) {
  const res = await fetch(`/api/tasks/${taskId}/partial`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actual_minutes: actualMinutes, est_minutes: remainderEstMinutes }),
  });
  refreshTaskList();
  return res.ok;
}

async function notCompletedTask(taskId) {
  await fetch(`/api/tasks/${taskId}/not-completed`, { method: "POST" });
  refreshTaskList();
}

// Editable only for a DONE task, through the same /complete route that
// created the actual in the first place (see api_complete_task's resolve()).
// A PARTIAL task's actual is shown the same way but read-only: re-posting to
// /complete would flip its status back to 'done', which isn't what fixing a
// typo in "time spent" is supposed to do -- there's no correction route for
// a segment that's already closed as partial.
function makeActualsRow(task, actual) {
  const row = document.createElement("div");
  row.className = "task-actuals";
  const editable = task.status === "done";

  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = task.status === "partial" ? "Partially completed" : "Done";
  row.appendChild(label);
  if (!actual) return row;

  if (actual.actual_minutes != null) {
    row.appendChild(
      editable
        ? makeChip({
            text: formatMinutes(actual.actual_minutes),
            generated: false,
            onEdit: (chip, lbl) =>
              startNumberEdit(chip, lbl, actual.actual_minutes, 1, 24 * 60, (value) =>
                completeTask(task.id, { actual_minutes: value })
              ),
          })
        : makeStaticChip(formatMinutes(actual.actual_minutes))
    );
  }
  if (actual.actual_importance != null) {
    row.appendChild(
      editable
        ? makeChip({
            text: `importance ${actual.actual_importance}`,
            generated: false,
            onEdit: (chip, lbl) =>
              startNumberEdit(chip, lbl, actual.actual_importance, 1, 5, (value) =>
                completeTask(task.id, { actual_importance: value })
              ),
          })
        : makeStaticChip(`importance ${actual.actual_importance}`)
    );
  }
  if (actual.actual_difficulty != null) {
    row.appendChild(
      editable
        ? makeChip({
            text: `difficulty ${actual.actual_difficulty}`,
            generated: false,
            onEdit: (chip, lbl) =>
              startNumberEdit(chip, lbl, actual.actual_difficulty, 1, 5, (value) =>
                completeTask(task.id, { actual_difficulty: value })
              ),
          })
        : makeStaticChip(`difficulty ${actual.actual_difficulty}`)
    );
  }
  return row;
}

function makeStaticChip(text) {
  const chip = document.createElement("span");
  chip.className = "task-chip";
  chip.textContent = text;
  return chip;
}

function defaultActualMinutes(task, block) {
  if (block) return Math.round((new Date(block.end) - new Date(block.start)) / 60000);
  return task.est_minutes || "";
}

function makePartialForm(task, block, wrap) {
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
    const ok = await partialTask(task.id, spent, remaining);
    if (!ok) status.textContent = "Could not save -- try again.";
  });
  cancelBtn.addEventListener("click", () => wrap.replaceChildren());

  form.append(spentLabel, remainingLabel, saveBtn, cancelBtn, status);
  return form;
}

function makeActionsRow(task, block) {
  const row = document.createElement("div");
  row.className = "task-card-actions";

  const formSlot = document.createElement("div");

  const completedBtn = document.createElement("button");
  completedBtn.className = "btn primary";
  completedBtn.textContent = "Completed";
  completedBtn.addEventListener("click", () => completeTask(task.id));

  const partialBtn = document.createElement("button");
  partialBtn.className = "btn";
  partialBtn.textContent = "Partially completed";
  partialBtn.addEventListener("click", () => {
    formSlot.replaceChildren(makePartialForm(task, block, formSlot));
  });

  const notCompletedBtn = document.createElement("button");
  notCompletedBtn.className = "btn";
  notCompletedBtn.textContent = "Not completed";
  notCompletedBtn.addEventListener("click", () => notCompletedTask(task.id));

  const buttons = document.createElement("div");
  buttons.className = "task-card-outcome-buttons";
  buttons.append(completedBtn, partialBtn, notCompletedBtn);

  row.append(buttons, formSlot);
  return row;
}

// --- The current scheduled block, and pinning it -----------------------------

async function setBlockLocked(blockId, isLocked) {
  await fetch(`/api/schedule/blocks/${blockId}/lock`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_locked: isLocked }),
  });
  refreshTaskList();
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

function makeScheduleRow(block) {
  const row = document.createElement("div");
  row.className = "task-schedule-row";

  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = `Scheduled: ${formatBlockTime(block)}`;
  row.appendChild(label);

  // Locking only makes sense for a real time of day -- a day-granularity
  // allocation five weeks out has no slot to pin to (see
  // scheduling.SLOT_DETAIL_DAYS), so the control simply isn't offered there.
  if (block.granularity === "slot") {
    const pinBtn = document.createElement("button");
    pinBtn.className = "btn task-pin-btn" + (block.is_locked ? " active" : "");
    pinBtn.title = block.is_locked ? "Unlock this slot" : "Lock to this slot";
    pinBtn.textContent = block.is_locked ? "Locked" : "Lock";
    pinBtn.addEventListener("click", () => setBlockLocked(block.id, !block.is_locked));
    row.appendChild(pinBtn);
  }

  return row;
}

// --- Recurrence, per card -------------------------------------------------
//
// A finished instance shows its cadence as plain text -- it is history, and
// editing the rule from a closed task reads as if it would rewrite that task.
// A live task gets the editable one-liner: ticking it creates and attaches a
// rule, unticking it detaches this task and deletes the (1:1) rule, leaving
// the task itself untouched.

function makeRecurrenceRow(task, rule) {
  if (task.status === "done" || task.status === "partial" || task.status === "abandoned") {
    const row = document.createElement("p");
    row.className = "task-recurrence-static muted";
    row.textContent = rule ? describeRule(rule) : "";
    row.hidden = !rule;
    return row;
  }

  const field = makeRecurrenceField({
    rule,
    onChange: async (state) => {
      if (state.repeats && !rule) {
        await attachRuleToTask(task.id, state);
        refreshTaskList();
      } else if (state.repeats && rule) {
        await updateRule(rule.id, state);
        refreshTaskList();
      } else if (!state.repeats && rule) {
        await detachRuleFromTask(task.id, rule.id);
        refreshTaskList();
      }
    },
  });
  return field.el;
}

// --- Resources, per card -------------------------------------------------
//
// The resources a shop trip is for. Linking one carries its location onto
// the task when the task has none (db.add_task_resource), so the list is
// refreshed after any change -- the card's location meta reads
// required_location_id.

async function linkResource(taskId, resourceId) {
  await fetch(`/api/tasks/${taskId}/resources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resource_id: resourceId }),
  });
  refreshTaskList();
}

async function unlinkResource(taskId, resourceId) {
  await fetch(`/api/tasks/${taskId}/resources`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resource_id: resourceId }),
  });
  refreshTaskList();
}

function makeResourcesRow(task, lookups) {
  const linkedIds = task.resource_ids || [];
  const row = document.createElement("div");
  row.className = "task-resources-row";

  const term = document.createElement("span");
  term.className = "task-resources-term";
  term.textContent = "Resources";
  row.appendChild(term);

  linkedIds.forEach((id) => {
    const resource = lookups.resourcesById[id];
    const chip = document.createElement("span");
    chip.className = "task-chip task-resource-chip";
    chip.textContent = resource ? resource.name : "unknown";
    const x = document.createElement("button");
    x.className = "task-resource-unlink";
    x.setAttribute("aria-label", `Unlink ${resource ? resource.name : "resource"}`);
    x.textContent = "×";
    x.addEventListener("click", () => unlinkResource(task.id, id));
    chip.appendChild(x);
    row.appendChild(chip);
  });

  const unlinked = (lookups.allResources || []).filter((r) => !linkedIds.includes(r.id));
  if (unlinked.length) {
    const add = document.createElement("select");
    add.className = "task-resource-add";
    add.innerHTML = `<option value="">${linkedIds.length ? "Link another…" : "Link a resource…"}</option>`;
    unlinked.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name;
      add.appendChild(opt);
    });
    add.addEventListener("change", () => {
      if (add.value) linkResource(task.id, add.value);
    });
    row.appendChild(add);
  }

  return row;
}

// --- Task card ---

function makeTaskCard(task, lookups) {
  const card = document.createElement("div");
  card.className = "task-card" + (task.status === "done" ? " done" : "");

  const header = document.createElement("div");
  header.className = "task-card-header";
  header.appendChild(makeEditableTitle(task));
  if (lookups.slippingIds.has(task.id)) {
    const badge = document.createElement("span");
    badge.className = "task-slip-badge";
    badge.title = `Slipped ${task.slip_count} times`;
    badge.textContent = `Slipped ${task.slip_count}x`;
    header.appendChild(badge);
  }
  const statusLabel = document.createElement("span");
  statusLabel.className = "muted";
  statusLabel.textContent = task.status;
  header.appendChild(statusLabel);
  card.appendChild(header);

  const metaParts = [];
  if (task.project_id && lookups.projectsById[task.project_id]) {
    metaParts.push(lookups.projectsById[task.project_id]);
  }
  if (task.deadline) {
    const d = new Date(task.deadline);
    metaParts.push(Number.isNaN(d.getTime()) ? `Due ${task.deadline}` : `Due ${d.toLocaleDateString()}`);
  }
  if (task.required_location_id && lookups.locationsById[task.required_location_id]) {
    metaParts.push(lookups.locationsById[task.required_location_id]);
  }
  if (task.support_level && task.support_level !== "independent") metaParts.push(task.support_level);
  if (metaParts.length) {
    const meta = document.createElement("p");
    meta.className = "task-meta";
    meta.textContent = metaParts.join(" · ");
    card.appendChild(meta);
  }

  // The task's deliverable, settable here as well as from the Deliverables
  // tab -- only meaningful once the task has a project, since a deliverable
  // belongs to one. A change can move the task's effective deadline (it
  // inherits its deliverable's due date), so the list is refreshed after.
  if (task.project_id) {
    const options = lookups.deliverablesByProject[task.project_id] || [];
    const wrap = document.createElement("label");
    wrap.className = "task-deliverable-row";
    wrap.textContent = "Deliverable ";
    const select = document.createElement("select");
    select.innerHTML = '<option value="">No deliverable</option>';
    options.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = d.title;
      select.appendChild(opt);
    });
    select.value = task.deliverable_id || "";
    select.addEventListener("change", () =>
      saveTaskFields(task.id, { deliverable_id: select.value || null }));
    wrap.appendChild(select);
    card.appendChild(wrap);
  }

  const chips = makeGeneratedChips(task);
  if (chips.children.length) card.appendChild(chips);

  card.appendChild(makeRecurrenceRow(task, lookups.rulesById[task.recurrence_id] || null));

  if ((task.resource_ids || []).length || (lookups.allResources || []).length) {
    card.appendChild(makeResourcesRow(task, lookups));
  }

  if (task.measurable_goal) card.appendChild(makeEditableGoal(task));

  if (task.status === "done" || task.status === "partial") {
    card.appendChild(makeActualsRow(task, lookups.actualsByTask[task.id]));
  } else if (task.status !== "abandoned") {
    const block = lookups.blocksByTask[task.id];
    if (block) card.appendChild(makeScheduleRow(block));
    card.appendChild(makeActionsRow(task, block));
  }

  return card;
}

// --- Replanning ---
//
// POST /api/schedule/plan resolves whatever's lapsed and replaces the future
// of the plan (see scheduling.replan) -- safe to call as often as this runs.
// Triggered once automatically the first time this tab is opened in a
// session (standing in for "on first load each day" -- there's no
// day-boundary tracking here, just the one call this page ever needs) and
// on demand via the button; SCHEDULE_SCOPE.md's other trigger, "whenever
// working or domestic hours change", has no UI yet to hang a call off.
let hasReplannedThisSession = false;

async function runReplan() {
  replanBtn.disabled = true;
  try {
    await fetch("/api/schedule/plan", { method: "POST" });
  } finally {
    replanBtn.disabled = false;
  }
}

replanBtn.addEventListener("click", async () => {
  await runReplan();
  refreshTaskList();
});

// --- At risk, and chronic slippers ---

function makeAtRiskList(entries) {
  const ul = document.createElement("ul");
  entries.forEach((e) => {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = e.title;
    li.append(title, document.createTextNode(` — ${e.message}`));
    ul.appendChild(li);
  });
  return ul;
}

function renderAtRiskPanel(schedule) {
  const atRisk = schedule.at_risk || [];
  const byDeliverable = schedule.at_risk_by_deliverable || [];
  const slipping = schedule.chronically_slipping || [];

  atRiskPanel.innerHTML = "";
  atRiskPanel.hidden = atRisk.length === 0 && slipping.length === 0;
  if (atRiskPanel.hidden) return;

  if (byDeliverable.length) {
    const section = document.createElement("div");
    section.className = "task-at-risk-section";
    const h = document.createElement("h4");
    h.textContent = "At risk, by deliverable";
    section.appendChild(h);
    byDeliverable.forEach((d) => {
      const p = document.createElement("p");
      p.textContent = `${d.title || "Untitled deliverable"}: ${d.at_risk_tasks} of ${d.total_tasks} tasks at risk`;
      section.appendChild(p);
    });
    atRiskPanel.appendChild(section);
  }

  const standalone = atRisk.filter((e) => !e.deliverable_id);
  if (standalone.length) {
    const section = document.createElement("div");
    section.className = "task-at-risk-section";
    const h = document.createElement("h4");
    h.textContent = "At risk";
    section.appendChild(h);
    section.appendChild(makeAtRiskList(standalone));
    atRiskPanel.appendChild(section);
  }

  if (slipping.length) {
    const section = document.createElement("div");
    section.className = "task-at-risk-section";
    const h = document.createElement("h4");
    h.textContent = "Slipping repeatedly";
    section.appendChild(h);
    const ul = document.createElement("ul");
    slipping.forEach((s) => {
      const li = document.createElement("li");
      li.textContent = `${s.title} — slipped ${s.slip_count} times`;
      ul.appendChild(li);
    });
    section.appendChild(ul);
    atRiskPanel.appendChild(section);
  }
}

// --- List: filtered by project and status ---

export async function refreshTaskList() {
  if (!hasReplannedThisSession) {
    hasReplannedThisSession = true;
    await runReplan();
  }

  const projectId = filterProjectSelect.value;
  const status = filterStatusSelect.value;

  const params = new URLSearchParams();
  if (projectId) params.set("project_id", projectId);
  if (status) params.set("status", status);

  const [tasks, projects, locations, resources, schedule, rulesById] = await Promise.all([
    fetch(`/api/tasks${params.toString() ? "?" + params : ""}`).then((r) => r.json()),
    fetch("/api/projects").then((r) => r.json()),
    fetch("/api/locations").then((r) => r.json()),
    fetch("/api/resources").then((r) => r.json()),
    fetch("/api/schedule").then((r) => r.json()),
    loadRulesById(),
  ]);

  await populateProjectOptions(projects);
  populateLocationOptions(locations);
  populateResourceOptions(resources);
  filterProjectSelect.value = projectId;
  filterStatusSelect.value = status;
  renderAtRiskPanel(schedule);

  const projectsById = Object.fromEntries(projects.map((p) => [p.id, p.title]));
  const locationsById = Object.fromEntries(locations.map((l) => [l.id, l.name]));
  const resourcesById = Object.fromEntries(resources.map((r) => [r.id, r]));

  // Deliverables for every project a listed task belongs to, so each card can
  // offer its own deliverable picker -- one request per distinct project.
  const taskProjectIds = [...new Set(tasks.map((t) => t.project_id).filter(Boolean))];
  const deliverableLists = await Promise.all(
    taskProjectIds.map((pid) =>
      fetch(`/api/projects/${pid}/deliverables`).then((r) => r.json()).then((d) => [pid, d])
    )
  );
  const deliverablesByProject = Object.fromEntries(deliverableLists);
  const blocksByTask = Object.fromEntries(
    (schedule.blocks || []).filter((b) => b.kind === "task" && b.task_id).map((b) => [b.task_id, b])
  );
  const slippingIds = new Set((schedule.chronically_slipping || []).map((s) => s.task_id));

  const doneOrPartialTasks = tasks.filter((t) => t.status === "done" || t.status === "partial");
  const actualsEntries = await Promise.all(
    doneOrPartialTasks.map((t) =>
      fetch(`/api/tasks/${t.id}/actual`).then((r) => r.json()).then((a) => [t.id, a])
    )
  );
  const actualsByTask = Object.fromEntries(actualsEntries);

  listEl.innerHTML = "";
  emptyEl.hidden = tasks.length > 0;
  tasks.forEach((task) => {
    listEl.appendChild(
      makeTaskCard(task, {
        projectsById,
        locationsById,
        resourcesById,
        allResources: resources,
        actualsByTask,
        blocksByTask,
        slippingIds,
        deliverablesByProject,
        rulesById,
      })
    );
  });
}

filterProjectSelect.addEventListener("change", refreshTaskList);
filterStatusSelect.addEventListener("change", refreshTaskList);
