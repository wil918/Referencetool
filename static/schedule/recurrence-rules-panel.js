// The Settings tab's "Recurring tasks" section: every recurrence rule, with
// pause / resume / edit / delete.
//
// A rule holds only a cadence; the task it repeats lives on the tasks that
// carry its recurrence_id, so each row is labelled with the title of that
// chain's most recent instance. Editing changes future instances only and
// deleting leaves every task already spawned in place -- both true in the
// backend (scheduling.spawn_recurrence_successor reads the rule at spawn
// time; db.delete_recurrence_rule keeps the tasks) and both said in the copy
// here so the user isn't guessing.

import { loadRules, describeRule, updateRule, setRuleActive, deleteRule } from "./recurrence.js";

const listEl = document.getElementById("recurrence-rules-list");
const emptyEl = document.getElementById("recurrence-rules-empty");

function latestTitleByRule(tasks) {
  // The newest instance's title stands in for the rule -- it's what the user
  // would recognise it by. created_at is an ISO string, so a string compare
  // orders it.
  const best = {};
  (tasks || []).forEach((t) => {
    if (!t.recurrence_id) return;
    const cur = best[t.recurrence_id];
    if (!cur || t.created_at > cur.created_at) best[t.recurrence_id] = t;
  });
  return best;
}

function fieldRow(labelText, input) {
  const row = document.createElement("label");
  row.className = "recurrence-edit-field";
  row.append(document.createTextNode(labelText), input);
  return row;
}

function makeEditor(rule, onDone) {
  const form = document.createElement("div");
  form.className = "recurrence-edit-form";

  const interval = document.createElement("input");
  interval.type = "number";
  interval.min = "1";
  interval.value = String(rule.interval_days);

  const windowInput = document.createElement("input");
  windowInput.type = "number";
  windowInput.min = "0";
  windowInput.value = String(rule.window_days);

  const time = document.createElement("input");
  time.type = "time";
  time.value = rule.preferred_time || "";

  const save = document.createElement("button");
  save.className = "btn primary";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "Cancel";

  const note = document.createElement("p");
  note.className = "muted recurrence-edit-note";
  note.textContent = "Future instances only -- tasks already completed keep their timing.";

  save.addEventListener("click", async () => {
    await updateRule(rule.id, {
      intervalDays: Math.max(1, Math.round(Number(interval.value) || 1)),
      windowDays: Math.max(0, Math.round(Number(windowInput.value) || 0)),
      preferredTime: time.value || "",
    });
    onDone();
  });
  cancel.addEventListener("click", onDone);

  form.append(
    fieldRow("Every … days", interval),
    fieldRow("Within … days", windowInput),
    fieldRow("Preferred time", time),
    save,
    cancel,
    note
  );
  return form;
}

function makeDeleteConfirm(rule, onDone) {
  const box = document.createElement("div");
  box.className = "recurrence-delete-confirm";
  const text = document.createElement("p");
  text.className = "muted";
  text.textContent =
    "Delete this rule? Every task it has already made stays exactly as it is -- only the repeat stops.";
  const del = document.createElement("button");
  del.className = "btn danger";
  del.textContent = "Delete rule";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = "Cancel";
  del.addEventListener("click", async () => {
    await deleteRule(rule.id);
    onDone();
  });
  cancel.addEventListener("click", onDone);
  box.append(text, del, cancel);
  return box;
}

function makeRow(rule, task) {
  const row = document.createElement("div");
  row.className = "recurrence-rule-row" + (rule.active ? "" : " is-paused");

  const head = document.createElement("div");
  head.className = "recurrence-rule-head";

  const title = document.createElement("span");
  title.className = "recurrence-rule-title";
  title.textContent = task ? task.title : "Repeat with no current task";

  const cadence = document.createElement("span");
  cadence.className = "recurrence-rule-cadence muted";
  cadence.textContent = describeRule(rule);

  head.append(title, cadence);

  const actions = document.createElement("div");
  actions.className = "recurrence-rule-actions";
  const slot = document.createElement("div");
  slot.className = "recurrence-rule-slot";

  const pauseBtn = document.createElement("button");
  pauseBtn.className = "btn";
  pauseBtn.textContent = rule.active ? "Pause" : "Resume";
  pauseBtn.title = rule.active
    ? "Stop spawning new instances -- existing tasks are untouched"
    : "Start spawning instances again from the next completion";
  pauseBtn.addEventListener("click", async () => {
    await setRuleActive(rule.id, !rule.active);
    refresh();
  });

  const editBtn = document.createElement("button");
  editBtn.className = "btn";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => {
    slot.replaceChildren(makeEditor(rule, refresh));
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => {
    slot.replaceChildren(makeDeleteConfirm(rule, refresh));
  });

  actions.append(pauseBtn, editBtn, deleteBtn);
  row.append(head, actions, slot);
  return row;
}

async function refresh() {
  const [rules, tasks] = await Promise.all([
    loadRules(),
    fetch("/api/tasks").then((r) => (r.ok ? r.json() : [])),
  ]);
  const titles = latestTitleByRule(tasks);

  listEl.innerHTML = "";
  emptyEl.hidden = rules.length > 0;
  rules
    .slice()
    .sort((a, b) => Number(b.active) - Number(a.active))
    .forEach((rule) => listEl.appendChild(makeRow(rule, titles[rule.id])));
}

export function initRecurrenceRulesPanel() {
  refresh();
}

export { refresh as refreshRecurrenceRules };
