// Recurrence, on the client side: the one shared place that knows how a
// recurrence rule is phrased, created, edited and removed.
//
// The backend model (db.recurrence_rules, scheduling.spawn_recurrence_successor)
// is INTERVAL-BASED AND FLOATING: "about every N days, within a tolerance
// window", measured from when the last instance was COMPLETED rather than from
// when it was scheduled. A rule carries only that cadence and whether it is
// active; what the task actually is lives on the tasks that carry its
// recurrence_id.
//
//   - Starting a recurrence is two API calls (create the rule, then create the
//     task with recurrence_id set -- see app.py's comment above the routes).
//     attachNewRule() does both so a caller never exposes the seam.
//   - Editing a rule affects FUTURE instances only. Each successor reads the
//     rule at spawn time; completed history is never rewritten. The copy in
//     every editing surface has to say so.
//   - Deleting a rule leaves the tasks it already spawned exactly as they are
//     (db.delete_recurrence_rule). Turning recurrence off on a task detaches
//     that task and deletes its now-orphaned rule; the task itself survives.

export async function loadRules() {
  const res = await fetch("/api/recurrence-rules");
  return res.ok ? res.json() : [];
}

export async function rulesById() {
  return Object.fromEntries((await loadRules()).map((r) => [r.id, r]));
}

/** The long phrasing, for a key row or a settings line. */
export function describeRule(rule) {
  if (!rule) return null;
  const every =
    rule.interval_days === 1 ? "every day" : `about every ${rule.interval_days} days`;
  const within = rule.window_days > 0 ? `, within ${rule.window_days}` : "";
  const paused = rule.active ? "" : " (paused)";
  return `Repeats ${every}${within}${paused}`;
}

/** The short phrasing, for a marker drawn on a block where space is scarce. */
export function cadenceTag(rule) {
  if (!rule) return null;
  const n = rule.interval_days;
  return (rule.active ? "" : "paused · ") + (n === 1 ? "daily" : `~${n}d`);
}

function ruleBody({ intervalDays, windowDays, preferredTime }) {
  return {
    interval_days: intervalDays,
    window_days: windowDays,
    preferred_time: preferredTime || null,
  };
}

export async function createRule(spec) {
  const res = await fetch("/api/recurrence-rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ruleBody(spec)),
  });
  return res.ok ? res.json() : null;
}

export async function updateRule(ruleId, spec) {
  const res = await fetch(`/api/recurrence-rules/${ruleId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ruleBody(spec)),
  });
  return res.ok ? res.json() : null;
}

export async function setRuleActive(ruleId, active) {
  await fetch(`/api/recurrence-rules/${ruleId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active }),
  });
}

export async function deleteRule(ruleId) {
  await fetch(`/api/recurrence-rules/${ruleId}`, { method: "DELETE" });
}

/** Turn a rule spec into a live rule and hang it on an existing task, in the
 *  order the API wants (rule first). Returns the rule, or null on failure. */
export async function attachRuleToTask(taskId, spec) {
  const rule = await createRule(spec);
  if (!rule) return null;
  await fetch(`/api/tasks/${taskId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recurrence_id: rule.id }),
  });
  return rule;
}

/** Detach a task from its rule and delete the rule, which is 1:1 with the
 *  task chain here. The task keeps every other detail. */
export async function detachRuleFromTask(taskId, ruleId) {
  await fetch(`/api/tasks/${taskId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recurrence_id: null }),
  });
  if (ruleId) await deleteRule(ruleId);
}

const DEFAULTS = { intervalDays: 7, windowDays: 2, preferredTime: "" };

/** The one-line control: "repeat about every [7] days, within [2]", plus an
 *  optional preferred time. Collapsed to a single checkbox until it is ticked,
 *  so it costs a non-recurring task one line and no attention.
 *
 *  `rule` seeds it from an existing rule (its checkbox starts ticked).
 *  `onChange(state)` fires on every edit with
 *    { repeats, intervalDays, windowDays, preferredTime } -- the caller owns
 *  what to do with it (the entry form reads it once at save; a task card acts
 *  on each change).
 */
export function makeRecurrenceField({ rule = null, onChange = () => {} } = {}) {
  const state = {
    repeats: Boolean(rule),
    intervalDays: rule ? rule.interval_days : DEFAULTS.intervalDays,
    windowDays: rule ? rule.window_days : DEFAULTS.windowDays,
    preferredTime: rule ? rule.preferred_time || "" : DEFAULTS.preferredTime,
  };

  const wrap = document.createElement("div");
  wrap.className = "task-recurrence-field";

  const toggle = document.createElement("label");
  toggle.className = "dr-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.repeats;
  const box = document.createElement("span");
  box.className = "dr-toggle-box";
  toggle.append(cb, box, document.createTextNode("Repeats"));

  // The rest of the sentence, revealed only when Repeats is on.
  const rest = document.createElement("span");
  rest.className = "task-recurrence-rest";
  rest.hidden = !state.repeats;

  const num = (value, min, aria) => {
    const i = document.createElement("input");
    i.type = "number";
    i.min = String(min);
    i.value = String(value);
    i.className = "task-recurrence-num";
    i.setAttribute("aria-label", aria);
    return i;
  };
  const intervalInput = num(state.intervalDays, 1, "Repeat interval in days");
  const windowInput = num(state.windowDays, 0, "Tolerance window in days");
  const timeInput = document.createElement("input");
  timeInput.type = "time";
  timeInput.value = state.preferredTime;
  timeInput.className = "task-recurrence-time";
  timeInput.setAttribute("aria-label", "Preferred time of day (optional)");

  rest.append(
    document.createTextNode(" about every "),
    intervalInput,
    document.createTextNode(" days, within "),
    windowInput,
    document.createTextNode(" — at "),
    timeInput,
    document.createTextNode(" if it can")
  );

  wrap.append(toggle, rest);

  const emit = () => {
    state.repeats = cb.checked;
    state.intervalDays = Math.max(1, Math.round(Number(intervalInput.value) || 1));
    state.windowDays = Math.max(0, Math.round(Number(windowInput.value) || 0));
    state.preferredTime = timeInput.value || "";
    rest.hidden = !state.repeats;
    onChange({ ...state });
  };

  cb.addEventListener("change", emit);
  [intervalInput, windowInput, timeInput].forEach((i) =>
    i.addEventListener("change", emit)
  );

  return { el: wrap, getState: () => ({ ...state }) };
}
