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
const supportSelect = document.getElementById("task-support-select");
const importanceInput = document.getElementById("task-importance-input");
const difficultyInput = document.getElementById("task-difficulty-input");
const estimateInput = document.getElementById("task-estimate-input");
const goalInput = document.getElementById("task-goal-input");

const filterProjectSelect = document.getElementById("task-filter-project");
const filterStatusSelect = document.getElementById("task-filter-status");
const listEl = document.getElementById("task-list");
const emptyEl = document.getElementById("task-list-empty");

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
  supportSelect.value = "independent";
  importanceInput.value = "";
  difficultyInput.value = "";
  estimateInput.value = "";
  goalInput.value = "";
  advanced.open = false;
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

// --- Completion ---
//
// One tap: POST with no body at all, and app.py fills every actual from the
// task's own estimate/difficulty/importance (or its scheduled block's
// length, if it has one). Editing an actual afterwards re-posts just that
// field -- see api_complete_task's resolve(), which keeps whatever was
// already recorded for anything not sent this time.

async function completeTask(taskId, corrections) {
  await fetch(`/api/tasks/${taskId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corrections || {}),
  });
  refreshTaskList();
}

function makeActualsRow(task, actual) {
  const row = document.createElement("div");
  row.className = "task-actuals";

  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = "Done";
  row.appendChild(label);
  if (!actual) return row;

  if (actual.actual_minutes != null) {
    row.appendChild(
      makeChip({
        text: formatMinutes(actual.actual_minutes),
        generated: false,
        onEdit: (chip, lbl) =>
          startNumberEdit(chip, lbl, actual.actual_minutes, 1, 24 * 60, (value) =>
            completeTask(task.id, { actual_minutes: value })
          ),
      })
    );
  }
  if (actual.actual_importance != null) {
    row.appendChild(
      makeChip({
        text: `importance ${actual.actual_importance}`,
        generated: false,
        onEdit: (chip, lbl) =>
          startNumberEdit(chip, lbl, actual.actual_importance, 1, 5, (value) =>
            completeTask(task.id, { actual_importance: value })
          ),
      })
    );
  }
  if (actual.actual_difficulty != null) {
    row.appendChild(
      makeChip({
        text: `difficulty ${actual.actual_difficulty}`,
        generated: false,
        onEdit: (chip, lbl) =>
          startNumberEdit(chip, lbl, actual.actual_difficulty, 1, 5, (value) =>
            completeTask(task.id, { actual_difficulty: value })
          ),
      })
    );
  }
  return row;
}

function makeActionsRow(task) {
  const row = document.createElement("div");
  row.className = "task-card-actions";
  const doneBtn = document.createElement("button");
  doneBtn.className = "btn primary";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => completeTask(task.id));
  row.appendChild(doneBtn);
  return row;
}

// --- Task card ---

function makeTaskCard(task, lookups) {
  const card = document.createElement("div");
  card.className = "task-card" + (task.status === "done" ? " done" : "");

  const header = document.createElement("div");
  header.className = "task-card-header";
  header.appendChild(makeEditableTitle(task));
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

  const chips = makeGeneratedChips(task);
  if (chips.children.length) card.appendChild(chips);

  if (task.measurable_goal) card.appendChild(makeEditableGoal(task));

  if (task.status === "done") {
    card.appendChild(makeActualsRow(task, lookups.actualsByTask[task.id]));
  } else {
    card.appendChild(makeActionsRow(task));
  }

  return card;
}

// --- List: filtered by project and status ---

export async function refreshTaskList() {
  const projectId = filterProjectSelect.value;
  const status = filterStatusSelect.value;

  const params = new URLSearchParams();
  if (projectId) params.set("project_id", projectId);
  if (status) params.set("status", status);

  const [tasks, projects, locations] = await Promise.all([
    fetch(`/api/tasks${params.toString() ? "?" + params : ""}`).then((r) => r.json()),
    fetch("/api/projects").then((r) => r.json()),
    fetch("/api/locations").then((r) => r.json()),
  ]);

  await populateProjectOptions(projects);
  populateLocationOptions(locations);
  filterProjectSelect.value = projectId;
  filterStatusSelect.value = status;

  const projectsById = Object.fromEntries(projects.map((p) => [p.id, p.title]));
  const locationsById = Object.fromEntries(locations.map((l) => [l.id, l.name]));

  const doneTasks = tasks.filter((t) => t.status === "done");
  const actualsEntries = await Promise.all(
    doneTasks.map((t) => fetch(`/api/tasks/${t.id}/actual`).then((r) => r.json()).then((a) => [t.id, a]))
  );
  const actualsByTask = Object.fromEntries(actualsEntries);

  listEl.innerHTML = "";
  emptyEl.hidden = tasks.length > 0;
  tasks.forEach((task) => {
    listEl.appendChild(makeTaskCard(task, { projectsById, locationsById, actualsByTask }));
  });
}

filterProjectSelect.addEventListener("change", refreshTaskList);
filterStatusSelect.addEventListener("change", refreshTaskList);
