// The day view: today at a glance.
//
// It mounts the SAME calendar component the week view uses (calendar.js),
// with numDays: 1 and snapToWeek: false, and arranges around it the things
// you only want when the day in question is now -- exactly the way
// schedule.js arranges the week's at-risk panel around the same component.
// Nothing here is a second calendar; the shared component draws the track,
// the bands, the deadline arcs and the now-line, and this module draws the
// check-in, the ledger and the completion list that sit above it.
//
// This is the most-opened screen in the app, so it is built for a
// three-second read: the energy check-in is one tap, each of the three
// outcomes is one tap, and the ledger answers "am I still on track" with no
// tap at all. Completeness is the week view's job.

import { createCalendar, effectiveBandWindow } from "./calendar.js";
import { openTaskPanel } from "./task-panel.js";
import { openCommitmentPanel } from "./commitment-panel.js";
import { makeKey } from "./key.js";

const checkinEl = document.getElementById("day-checkin");
const ledgerEl = document.getElementById("day-ledger");
const calendarEl = document.getElementById("day-calendar");

let calendar = null;
let locationsById = {};

// --- small shared helpers ---------------------------------------------------

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function minutesNow() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function toMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function formatMinutes(total) {
  const t = Math.max(0, Math.round(total));
  const h = Math.floor(t / 60);
  const m = t % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// A task block belongs to "today" for the ledger's purposes if its calendar
// date is today. This is the same simplification dayListFor makes in
// calendar.js -- the small-hours-belong-to-yesterday rule the axis follows is
// deliberately not reproduced here, because a tally is a glance, not a
// placement, and one block landing in the wrong day's count at 1am is not
// worth importing elapsedInColumn for.
function todayTaskBlocks(data) {
  const date = todayStr();
  return (data.schedule.blocks || [])
    .filter((b) => b.kind === "task" && b.granularity === "slot" && b.start.slice(0, 10) === date)
    .sort((a, b) => a.start.localeCompare(b.start));
}

function isResolved(task) {
  return task && (task.status === "done" || task.status === "partial");
}

// --- The energy check-in ---------------------------------------------------
//
// A five-station graduated scale. The scheduler already infers a value for
// today from yesterday's commitments (scheduling.infer_energy); this is the
// daily correction to it, persisted as daily_capacity.manual_energy through
// PUT /api/capacity/<date>. Tapping the station that is already set clears
// the override back to the inferred guess -- so the control is its own undo.

async function renderCheckin() {
  const date = todayStr();
  const cap = await fetch(`/api/capacity/${date}`).then((r) => (r.ok ? r.json() : null));
  const inferred = cap?.inferred_energy ?? 3;
  const manual = cap?.manual_energy ?? null;
  const shown = manual ?? inferred;

  checkinEl.className = "dr-checkin";
  checkinEl.innerHTML = "";

  const label = document.createElement("span");
  label.className = "dr-label";
  label.textContent = "Energy today";

  const gauge = document.createElement("div");
  gauge.className = "dr-gauge";
  for (let n = 1; n <= 5; n++) {
    const station = document.createElement("button");
    station.type = "button";
    station.className = "dr-gauge-station";
    if (n === shown) station.classList.add("is-set");
    else if (n === inferred && manual === null) station.classList.add("is-inferred");
    station.textContent = String(n);
    station.setAttribute("aria-label", `Set today's energy to ${n} of 5`);
    // Tapping the current manual value again passes null, which clears the
    // override; every other tap sets that value.
    station.addEventListener("click", () => setEnergy(date, n === manual ? null : n));
    gauge.appendChild(station);
  }

  const note = document.createElement("span");
  note.className = "dr-micro";
  note.textContent = manual === null ? "Inferred from yesterday" : "Set by you";

  checkinEl.append(label, gauge, note);
}

async function setEnergy(date, value) {
  await fetch(`/api/capacity/${date}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manual_energy: value }),
  });
  // Energy gates the difficulty the scheduler will place (see
  // scheduling.ENERGY_MAX_DIFFICULTY), so a change to it is a planning input
  // exactly like a change to working hours -- replan, then redraw. Same
  // contract as calendar.js's band-resize gesture.
  await fetch("/api/schedule/plan", { method: "POST" });
  await renderCheckin();
  calendar?.reload();
}

// --- The ledger: what is done, what remains, whether it fits --------------

function renderLedger(data) {
  const blocks = todayTaskBlocks(data);
  const done = blocks.filter((b) => isResolved(data.tasksById[b.task_id]));
  const remaining = blocks.filter((b) => !isResolved(data.tasksById[b.task_id]));
  const remainingMin = remaining.reduce(
    (sum, b) => sum + (new Date(b.end) - new Date(b.start)) / 60000,
    0,
  );

  const band = effectiveBandWindow(todayStr(), data.workingHours || [], data.workingOverrides || []);
  let timeLeft = null;
  if (band) {
    timeLeft = Math.max(0, toMin(band.closes) - Math.max(minutesNow(), toMin(band.opens)));
  }

  let verdict = null;
  if (remaining.length && timeLeft !== null) {
    const over = remainingMin - timeLeft;
    verdict = document.createElement("span");
    if (over > 1) {
      verdict.className = "dr-tally-over";
      verdict.textContent = `Over by ${formatMinutes(over)}`;
    } else {
      verdict.textContent = `${formatMinutes(-over)} spare`;
    }
  }

  ledgerEl.innerHTML = "";

  const ledgerHead = document.createElement("span");
  ledgerHead.className = "dr-label";
  ledgerHead.textContent = "The day so far";

  ledgerEl.append(
    ledgerHead,
    makeKey([
      ["Done", `${done.length} of ${blocks.length}`],
      ["Left to do", remaining.length ? formatMinutes(remainingMin) : "Nothing"],
      ["Time to work", timeLeft === null ? "No working hours today" : formatMinutes(timeLeft)],
      ["Verdict", verdict],
    ]),
  );

  const listHead = document.createElement("span");
  listHead.className = "dr-label";
  listHead.textContent = "Still ahead";
  ledgerEl.appendChild(listHead);
  renderChecklist(blocks, data);
}

// --- The completion list -------------------------------------------------
//
// Every task block scheduled today, in time order, each with its three
// outcomes inline. Completion is the primary action on this sheet, so it is
// not behind a menu: Completed and Missed are a single tap, and Partial opens
// a two-field remainder estimate in place (the one outcome that genuinely
// needs a number -- see scheduling.resolve_partial).

function renderChecklist(blocks, data) {
  if (!blocks.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Nothing scheduled today.";
    ledgerEl.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "dr-checklist";

  blocks.forEach((block) => {
    const task = data.tasksById[block.task_id];
    const row = document.createElement("div");
    row.className = "dr-checklist-row";

    const time = document.createElement("span");
    time.className = "dr-checklist-time";
    time.textContent = new Date(block.start)
      .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    const title = document.createElement("button");
    title.type = "button";
    title.className = "dr-checklist-title";
    title.textContent = task ? task.title : "Task";
    title.addEventListener("click", () => openTask(block.task_id));

    row.append(time, title);

    if (isResolved(task)) {
      row.classList.add("is-done");
      const mark = document.createElement("span");
      mark.className = "dr-checklist-mark";
      mark.textContent = task.status === "partial" ? "Part" : "Done";
      row.appendChild(mark);
    } else if (task && task.status !== "abandoned") {
      row.appendChild(makeOutcomes(task, block));
    }

    list.appendChild(row);
  });

  ledgerEl.appendChild(list);
}

function makeOutcomes(task, block) {
  const wrap = document.createElement("div");
  wrap.className = "dr-outcomes";

  const button = (text, cls, onClick) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `dr-outcome ${cls}`;
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  };

  wrap.append(
    button("Completed", "is-done", () =>
      resolveOutcome(`/api/tasks/${task.id}/complete`, {})),
    button("Partial", "is-part", () => openPartial(task, block, wrap)),
    button("Missed", "is-miss", () =>
      resolveOutcome(`/api/tasks/${task.id}/not-completed`, null)),
  );
  return wrap;
}

function openPartial(task, block, wrap) {
  wrap.classList.add("is-editing");
  wrap.innerHTML = "";

  const spent = document.createElement("input");
  spent.type = "number";
  spent.min = "1";
  spent.value = Math.round((new Date(block.end) - new Date(block.start)) / 60000)
    || task.est_minutes || "";
  spent.setAttribute("aria-label", "Minutes spent so far");

  const left = document.createElement("input");
  left.type = "number";
  left.min = "1";
  left.placeholder = "left";
  left.setAttribute("aria-label", "Minutes still remaining");

  const save = document.createElement("button");
  save.type = "button";
  save.className = "dr-outcome is-done";
  save.textContent = "Save";
  save.addEventListener("click", () => {
    const s = Number(spent.value);
    const r = Number(left.value);
    if (!s || s <= 0) return spent.classList.add("is-invalid");
    if (!r || r <= 0) return left.classList.add("is-invalid");
    resolveOutcome(`/api/tasks/${task.id}/partial`, { actual_minutes: s, est_minutes: r });
  });

  wrap.append(spent, left, save);
}

async function resolveOutcome(url, body) {
  await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // Parity with task-panel.js: an outcome records the fact and drops the
  // task's own future blocks, but does NOT reshuffle the rest of the plan --
  // that stays an explicit Replan. Just reload so the list and ledger catch
  // up with the new status.
  calendar?.reload();
}

function openTask(taskId) {
  openTaskPanel(taskId, { onChange: () => calendar?.reload() });
}

// --- entry point ---------------------------------------------------------

export function refreshDay() {
  renderCheckin();
  if (!calendar) {
    calendar = createCalendar(calendarEl, {
      numDays: 1,
      // A single-day view showing Monday when it is Thursday would be
      // nonsense -- this is the option that exists for exactly this case.
      snapToWeek: false,
      onOpenTask: openTask,
      onOpenCommitment: (commitment) => openCommitmentPanel(commitment, locationsById),
      onDataLoaded: (data) => {
        locationsById = data.locationsById;
        renderLedger(data);
      },
    });
  } else {
    calendar.reload();
  }
}
