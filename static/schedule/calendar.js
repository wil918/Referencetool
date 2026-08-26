/* The reusable calendar grid -- an hourly, multi-day view. The week view
 * (schedule.js) mounts this with numDays: 7; the day view a later session
 * adds should be numDays: 1 against the same component, not a copy of it.
 * (Month view is a fundamentally different layout -- a grid of day cells,
 * no hourly axis -- so it won't call createCalendar at all; it can still
 * reuse loadCalendarData/effectiveBandWindow/deliverableColour below.)
 *
 * Owns: fetching everything a range needs in one pass, laying out commitments
 * and scheduled blocks against an hourly axis, the working/domestic hour
 * bands as background ranges, the suggested-bedtime marker, and the two
 * pointer gestures -- resizing a band's edge and dragging a task block to a
 * new time (see project/grid.js, which this borrows its pointer-capture/
 * drag-threshold/commit-on-release technique from, adapted from a cell grid
 * to a time axis).
 *
 * Deliberately does NOT render the at-risk list or the working-hours-editor
 * button -- those are how the Schedule TAB arranges things around this
 * component, not part of what a calendar grid is. schedule.js owns them and
 * reads at-risk data back out through onDataLoaded.
 */
import { deliverableColour } from "./colour.js";

const PX_PER_MIN = 1; // 60px/hour -- keeps every time<->pixel conversion a plain subtraction
const START_HOUR = 5;
const END_HOUR = 24;
const GRID_HEIGHT = (END_HOUR - START_HOUR) * 60 * PX_PER_MIN;
const DRAG_THRESHOLD = 4; // px of pointer movement before a press becomes a drag, same as grid.js
const BLOCK_SNAP_MIN = 5;
const BAND_SNAP_MIN = 15;
const MIN_BLOCK_HEIGHT_PX = 18;

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Monday=0..Sunday=6, matching Python's date.weekday() -- JS's getDay() is
// Sunday=0..Saturday=6, so this just rotates it.
function weekdayOf(dateStr) {
  return (new Date(`${dateStr}T00:00:00`).getDay() + 6) % 7;
}

function minutesOfIso(iso) {
  const t = iso.split("T")[1];
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function clampMinutes(m) {
  return Math.max(START_HOUR * 60, Math.min(END_HOUR * 60, m));
}

function yForMinutes(m) {
  return (clampMinutes(m) - START_HOUR * 60) * PX_PER_MIN;
}

function minutesForY(y) {
  return START_HOUR * 60 + y / PX_PER_MIN;
}

function formatTime(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.round(minutes % 60);
  const period = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${period}`;
}

/* The (opens, closes) window one band is open on `dateStr`, mirroring
 * scheduling._band_window exactly: a date override beats the weekly
 * pattern, naming only one side of the override keeps the other from the
 * weekly row, and no weekly row with no override means shut. Kept in step
 * with the backend by hand rather than by sharing code across the
 * Python/JS boundary -- the two are the same seven lines apiece. */
export function effectiveBandWindow(dateStr, weeklyRows, overrides) {
  const weekday = weekdayOf(dateStr);
  const weekly = weeklyRows.find((h) => h.weekday === weekday);
  let opens = weekly?.opens || null;
  let closes = weekly?.closes || null;
  const override = overrides.find((o) => o.date === dateStr);
  if (override) {
    if (override.off) return null;
    opens = override.opens || opens;
    closes = override.closes || closes;
  }
  if (!opens || !closes) return null;
  return { opens, closes, hasOverride: Boolean(override) };
}

// --- Data loading ------------------------------------------------------------

async function getJSON(url) {
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

/** Everything one visible range needs, in one pass. Exported so a future
 * month view can reuse the fetch/shape without going through the hourly
 * grid this file also builds. */
export async function loadCalendarData(startDate, endDate) {
  const [schedule, commitments, workingHours, domesticHours, workingOverrides,
    domesticOverrides, bedtimes, tasks, projects] = await Promise.all([
    getJSON(`/api/schedule?start=${startDate}&end=${endDate}`),
    getJSON("/api/commitments"),
    getJSON("/api/working-hours"),
    getJSON("/api/domestic-hours"),
    getJSON("/api/hours-overrides?band=working"),
    getJSON("/api/hours-overrides?band=domestic"),
    getJSON(`/api/schedule/bedtimes?start=${startDate}&end=${endDate}`),
    getJSON("/api/tasks"),
    getJSON("/api/projects"),
  ]);

  const tasksById = Object.fromEntries((tasks || []).map((t) => [t.id, t]));
  const projectIds = [...new Set(
    (tasks || []).filter((t) => t.deliverable_id && t.project_id).map((t) => t.project_id)
  )];
  const deliverableLists = await Promise.all(
    projectIds.map((pid) => getJSON(`/api/projects/${pid}/deliverables`))
  );
  const deliverablesById = {};
  deliverableLists.forEach((list) => (list || []).forEach((d) => (deliverablesById[d.id] = d)));

  const stop = `${endDate}T23:59:59`;
  const startOfDay = `${startDate}T00:00:00`;
  const visibleCommitments = (commitments || []).filter((c) => c.start < stop && c.end > startOfDay);

  return {
    schedule: schedule || { blocks: [], at_risk: [], at_risk_by_deliverable: [], chronically_slipping: [] },
    commitments: visibleCommitments,
    workingHours: workingHours || [],
    domesticHours: domesticHours || [],
    workingOverrides: workingOverrides || [],
    domesticOverrides: domesticOverrides || [],
    bedtimes: bedtimes || [],
    tasksById,
    deliverablesById,
    projects: projects || [],
  };
}

// --- hours_overrides upsert ---------------------------------------------------
//
// db.create_hours_override never replaces an existing row for the same
// (date, band) -- see scheduling._band_window's "sorted by id" tie-break,
// which is stable but not "last write wins". A resize gesture that fires
// more than once for the same day (drag it twice, or use "Start day at"
// after already dragging) must not pile up rows that then fight over which
// one the backend honours, so every write here deletes whatever already
// covers this date+band first.

async function upsertHoursOverride(band, dateStr, patch) {
  const existing = (await getJSON(`/api/hours-overrides?band=${band}`)) || [];
  const matches = existing.filter((o) => o.date === dateStr);
  await Promise.all(matches.map((o) => fetch(`/api/hours-overrides/${o.id}`, { method: "DELETE" })));
  const base = matches[0] || {};
  await fetch("/api/hours-overrides", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      date: dateStr,
      band,
      opens: "opens" in patch ? patch.opens : base.opens ?? null,
      closes: "closes" in patch ? patch.closes : base.closes ?? null,
      off: "off" in patch ? patch.off : base.off ?? false,
    }),
  });
}

/* Update the WEEKLY pattern for one weekday instead of a single date --
 * "resizable per day and per week" (see CLAUDE.md's session prompt): a plain
 * drag narrows/widens just this occurrence, holding Shift while dropping
 * changes every future occurrence of that weekday. Wholesale-replace, same
 * contract as the hours-editor's Save button and db.save_working_hours. */
async function upsertWeeklyHours(band, weekday, patch) {
  const url = band === "working" ? "/api/working-hours" : "/api/domestic-hours";
  const current = (await getJSON(url)) || [];
  const existing = current.find((h) => h.weekday === weekday);
  const next = {
    weekday,
    opens: "opens" in patch ? patch.opens : existing?.opens ?? null,
    closes: "closes" in patch ? patch.closes : existing?.closes ?? null,
  };
  const rest = current.filter((h) => h.weekday !== weekday);
  await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hours: [...rest, next] }),
  });
}

async function replan() {
  await fetch("/api/schedule/plan", { method: "POST" });
}

// --- Lane layout for overlapping events within one day column ---------------
//
// Simple greedy interval colouring: sorted by start, each event takes the
// first lane whose previous occupant has already ended, else opens a new
// lane. Every event in the column shares the same lane COUNT (rather than
// each overlap cluster getting its own width), which is less space-optimal
// than a "real" calendar's local grouping but is a fraction of the code and
// never puts two events for the same moment in the same lane, which is the
// property that actually matters here.
function layoutLanes(events) {
  const sorted = [...events].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const laneEnds = [];
  const laned = sorted.map((ev) => {
    let lane = laneEnds.findIndex((end) => end <= ev.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(ev.endMin);
    } else {
      laneEnds[lane] = ev.endMin;
    }
    return { ...ev, lane };
  });
  const laneCount = laneEnds.length || 1;
  return laned.map((ev) => ({ ...ev, laneCount }));
}

// --- The component -------------------------------------------------------------

export function createCalendar(container, options = {}) {
  const numDays = options.numDays || 7;
  const onOpenTask = options.onOpenTask || (() => {});
  const onDataLoaded = options.onDataLoaded || (() => {});

  let startDate = options.startDate || todayStr();
  let data = null;
  let nowTimer = null;
  let gesture = null; // the one in-flight pointer gesture, band-resize or block-drag

  container.classList.add("schedule-calendar");
  container.innerHTML = `
    <div class="schedule-calendar-toolbar">
      <button type="button" class="btn schedule-nav-prev">&larr;</button>
      <button type="button" class="btn schedule-nav-today">Today</button>
      <button type="button" class="btn schedule-nav-next">&rarr;</button>
      <span class="schedule-range-label muted"></span>
    </div>
    <p class="schedule-empty-banner muted" hidden></p>
    <div class="schedule-calendar-body">
      <div class="schedule-hour-axis"></div>
      <div class="schedule-day-columns"></div>
    </div>
  `;

  const prevBtn = container.querySelector(".schedule-nav-prev");
  const nextBtn = container.querySelector(".schedule-nav-next");
  const todayBtn = container.querySelector(".schedule-nav-today");
  const rangeLabel = container.querySelector(".schedule-range-label");
  const emptyBanner = container.querySelector(".schedule-empty-banner");
  const bodyEl = container.querySelector(".schedule-calendar-body");
  const hourAxis = container.querySelector(".schedule-hour-axis");
  const columnsEl = container.querySelector(".schedule-day-columns");

  // Set once, on the grid itself rather than on .schedule-day-columns: a
  // custom property only cascades to descendants, and grid-template-columns
  // that reads it now lives on .schedule-calendar-body (style.css), an
  // ancestor of .schedule-day-columns, not that element itself. numDays is
  // fixed for this component's lifetime, so this never needs to run again.
  bodyEl.style.setProperty("--schedule-num-days", numDays);

  // The hour axis is identical every render -- built once.
  hourAxis.style.height = `${GRID_HEIGHT}px`;
  for (let h = START_HOUR; h < END_HOUR; h++) {
    const label = document.createElement("div");
    label.className = "schedule-hour-label";
    label.style.top = `${yForMinutes(h * 60)}px`;
    label.textContent = formatTime(h * 60);
    hourAxis.appendChild(label);
  }

  function visibleDates() {
    return Array.from({ length: numDays }, (_, i) => addDays(startDate, i));
  }

  // --- band + block extraction for one date ----------------------------------

  function bandsFor(dateStr) {
    const working = effectiveBandWindow(dateStr, data.workingHours, data.workingOverrides);
    const domestic = effectiveBandWindow(dateStr, data.domesticHours, data.domesticOverrides);
    return { working, domestic };
  }

  function slotEventsFor(dateStr) {
    const events = [];
    (data.schedule.blocks || []).forEach((b) => {
      if (b.granularity !== "slot" || !b.start.startsWith(dateStr)) return;
      const task = b.task_id ? data.tasksById[b.task_id] : null;
      events.push({
        type: "block",
        block: b,
        kind: b.kind,
        task,
        startMin: minutesOfIso(b.start),
        endMin: Math.max(minutesOfIso(b.start) + 1, minutesOfIso(b.end)),
      });
    });
    data.commitments.forEach((c) => {
      if (!c.start.startsWith(dateStr)) return; // rendered on the day it starts
      events.push({
        type: "commitment",
        commitment: c,
        startMin: minutesOfIso(c.start),
        endMin: Math.max(minutesOfIso(c.start) + 1, c.end.startsWith(dateStr) ? minutesOfIso(c.end) : 24 * 60),
      });
    });
    return events;
  }

  function dayListFor(dateStr) {
    return (data.schedule.blocks || [])
      .filter((b) => b.granularity === "day" && b.start === dateStr && b.kind === "task")
      .map((b) => ({ block: b, task: data.tasksById[b.task_id] }));
  }

  function bedtimeFor(dateStr) {
    return data.bedtimes.find((m) => m.evening_date === dateStr) || null;
  }

  // --- rendering ---------------------------------------------------------------

  function renderRangeLabel() {
    const first = visibleDates()[0];
    const last = visibleDates()[visibleDates().length - 1];
    const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    rangeLabel.textContent = numDays === 1 ? fmt(first) : `${fmt(first)} – ${fmt(last)}`;
  }

  function weekHasNoWorkingHours() {
    return visibleDates().every((d) => !bandsFor(d).working);
  }

  function renderEmptyBanner() {
    const taskBlockCount = (data.schedule.blocks || []).filter((b) => b.kind === "task").length;
    if (taskBlockCount > 0) {
      emptyBanner.hidden = true;
      return;
    }
    if (weekHasNoWorkingHours()) {
      emptyBanner.hidden = false;
      emptyBanner.textContent =
        "No working hours set -- nothing can be scheduled until you add some. Open Working hours below.";
    } else {
      emptyBanner.hidden = false;
      emptyBanner.textContent = "Nothing scheduled in this range.";
    }
  }

  function makeBandEl(band, kind, dateStr) {
    const el = document.createElement("div");
    el.className = `schedule-band schedule-band-${kind}`;
    const top = yForMinutes(minutesOfIso(`${dateStr}T${band.opens}:00`));
    const bottom = yForMinutes(minutesOfIso(`${dateStr}T${band.closes}:00`));
    el.style.top = `${top}px`;
    el.style.height = `${Math.max(bottom - top, 0)}px`;

    const topHandle = document.createElement("div");
    topHandle.className = "schedule-band-handle schedule-band-handle-top";
    const bottomHandle = document.createElement("div");
    bottomHandle.className = "schedule-band-handle schedule-band-handle-bottom";
    el.append(topHandle, bottomHandle);

    wireBandResize(topHandle, kind, dateStr, "opens");
    wireBandResize(bottomHandle, kind, dateStr, "closes");
    return el;
  }

  function labelForBlock(ev) {
    if (ev.type === "commitment") return ev.commitment.title;
    const b = ev.block;
    if (b.kind === "task") return ev.task ? ev.task.title : "Task";
    if (b.kind === "travel") return "Travel";
    if (b.kind === "prep") return "Getting ready";
    if (b.kind === "break") return "Break";
    return b.kind;
  }

  function makeEventEl(ev, dateStr) {
    const el = document.createElement("div");
    const kindClass = ev.type === "commitment" ? "commitment" : ev.block.kind;
    el.className = `schedule-block schedule-block-${kindClass}`;
    el.dataset.kind = kindClass;

    const top = yForMinutes(ev.startMin);
    const height = Math.max(yForMinutes(ev.endMin) - top, MIN_BLOCK_HEIGHT_PX);
    el.style.top = `${top}px`;
    el.style.height = `${height}px`;
    el.style.left = `${(ev.lane / ev.laneCount) * 100}%`;
    el.style.width = `${(1 / ev.laneCount) * 100}%`;

    if (ev.type === "block" && ev.block.kind === "task" && ev.task?.deliverable_id) {
      const dot = document.createElement("span");
      dot.className = "schedule-block-deliverable-dot";
      dot.style.background = deliverableColour(ev.task.deliverable_id);
      el.appendChild(dot);
    }

    const label = document.createElement("span");
    label.className = "schedule-block-label";
    label.textContent = labelForBlock(ev);
    el.appendChild(label);

    if (height > 32) {
      const time = document.createElement("span");
      time.className = "schedule-block-time muted";
      time.textContent = `${formatTime(ev.startMin)}–${formatTime(ev.endMin)}`;
      el.appendChild(time);
    }

    if (ev.type === "block" && ev.block.kind === "task" && ev.block.is_locked) {
      const pin = document.createElement("span");
      pin.className = "schedule-block-pin";
      pin.title = "Locked to this slot";
      pin.textContent = "\u{1F4CC}";
      el.appendChild(pin);
    }

    const isDraggableTask = ev.type === "block" && ev.block.kind === "task";
    if (isDraggableTask) {
      wireTaskBlockGesture(el, ev, dateStr);
    }
    return el;
  }

  function makeDayListEl(dateStr, items) {
    const wrap = document.createElement("div");
    wrap.className = "schedule-day-list";
    if (!items.length) return wrap;
    const heading = document.createElement("p");
    heading.className = "schedule-day-list-heading muted";
    heading.textContent = "Later this week -- no specific time yet:";
    wrap.appendChild(heading);
    items.forEach(({ block, task }) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "schedule-day-list-item";
      if (task?.deliverable_id) {
        chip.style.setProperty("--deliverable-colour", deliverableColour(task.deliverable_id));
        chip.classList.add("has-deliverable");
      }
      chip.textContent = task ? task.title : "Task";
      chip.addEventListener("click", () => onOpenTask(block.task_id));
      wrap.appendChild(chip);
    });
    return wrap;
  }

  function makeBedtimeEl(marker) {
    const el = document.createElement("div");
    el.className = "schedule-bedtime-marker";
    // A bedtime that rolls past midnight (e.g. 00:30) is still tonight's
    // marker -- clamp it to the bottom of the visible grid rather than
    // stretching the grid taller for a rare case; it reads as "very late
    // tonight", which is the truth.
    const minutes = minutesOfIso(marker.bedtime);
    const rolledPastMidnight = !marker.bedtime.startsWith(marker.evening_date);
    const y = rolledPastMidnight ? END_HOUR * 60 * PX_PER_MIN : yForMinutes(minutes);
    el.style.top = `${y}px`;
    const label = document.createElement("span");
    label.className = "schedule-bedtime-label";
    label.textContent = `Suggested bedtime ${formatTime(minutes)}${rolledPastMidnight ? " (after midnight)" : ""}`;
    el.appendChild(label);
    return el;
  }

  function makeNowLineEl() {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    if (minutes < START_HOUR * 60 || minutes > END_HOUR * 60) return null;
    const el = document.createElement("div");
    el.className = "schedule-now-line";
    el.style.top = `${yForMinutes(minutes)}px`;
    return el;
  }

  function renderDayColumn(dateStr) {
    const col = document.createElement("div");
    col.className = "schedule-day-col";
    if (dateStr === todayStr()) col.classList.add("is-today");

    const header = document.createElement("div");
    header.className = "schedule-day-header";
    const weekday = document.createElement("span");
    weekday.className = "schedule-day-weekday";
    weekday.textContent = WEEKDAY_LABELS[weekdayOf(dateStr)];
    const dateNum = document.createElement("span");
    dateNum.className = "schedule-day-date";
    dateNum.textContent = new Date(`${dateStr}T00:00:00`).getDate();
    header.append(weekday, dateNum);

    // "Start my day at..." -- the most-used control in the app (see
    // CLAUDE.md's session prompt): one native time input, no separate save.
    // Only offered on today, which is the only day "waking up late" means
    // anything for.
    if (dateStr === todayStr()) {
      const startAt = document.createElement("input");
      startAt.type = "time";
      startAt.className = "schedule-start-day-input";
      startAt.title = "Start my day at...";
      const working = bandsFor(dateStr).working;
      startAt.value = working ? working.opens : "";
      startAt.addEventListener("change", async () => {
        if (!startAt.value) return;
        await upsertHoursOverride("working", dateStr, { opens: startAt.value });
        await replan();
        await reload();
      });
      header.appendChild(startAt);
    }

    const track = document.createElement("div");
    track.className = "schedule-day-track";
    track.style.height = `${GRID_HEIGHT}px`;
    track.dataset.date = dateStr;

    const { working, domestic } = bandsFor(dateStr);
    if (working) track.appendChild(makeBandEl(working, "working", dateStr));
    if (domestic) track.appendChild(makeBandEl(domestic, "domestic", dateStr));

    const laned = layoutLanes(slotEventsFor(dateStr));
    laned.forEach((ev) => track.appendChild(makeEventEl(ev, dateStr)));

    const bedtime = bedtimeFor(dateStr);
    if (bedtime) track.appendChild(makeBedtimeEl(bedtime));

    const nowLine = makeNowLineEl();
    if (nowLine && dateStr === todayStr()) track.appendChild(nowLine);

    col.append(header, makeDayListEl(dateStr, dayListFor(dateStr)), track);
    return col;
  }

  function render() {
    renderRangeLabel();
    renderEmptyBanner();
    columnsEl.innerHTML = "";
    visibleDates().forEach((d) => columnsEl.appendChild(renderDayColumn(d)));
  }

  // --- gestures: band resize ----------------------------------------------------
  //
  // Same shape as project/grid.js's pointer state machine -- capture on
  // pointerdown, do nothing until DRAG_THRESHOLD is crossed, live-preview by
  // moving the element directly, commit exactly once on release. There's no
  // "invalid drop" here (unlike the grid, a band can't collide with
  // anything), so there's nothing to snap back from on release.

  function wireBandResize(handle, band, dateStr, edge) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || gesture) return;
      const bandEl = handle.parentElement;
      gesture = {
        kind: "band-resize", band, dateStr, edge, bandEl, pointerId: e.pointerId,
        startY: e.clientY, startTop: parseFloat(bandEl.style.top), startHeight: parseFloat(bandEl.style.height),
        active: false,
      };
      handle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
  }

  // --- gestures: drag a task block to a new time --------------------------------

  function wireTaskBlockGesture(el, ev, dateStr) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || gesture) return;
      gesture = {
        kind: "block-move", block: ev.block, dateStr, el, pointerId: e.pointerId,
        startY: e.clientY, startTop: parseFloat(el.style.top),
        durationMin: ev.endMin - ev.startMin, active: false,
      };
      el.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
  }

  function onPointerMove(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const dy = e.clientY - gesture.startY;
    if (!gesture.active) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return;
      gesture.active = true;
      if (gesture.kind === "block-move") gesture.el.classList.add("is-dragging");
    }
    e.preventDefault();

    if (gesture.kind === "band-resize") {
      const snap = BAND_SNAP_MIN * PX_PER_MIN;
      if (gesture.edge === "opens") {
        const newTop = Math.round((gesture.startTop + dy) / snap) * snap;
        const clamped = Math.max(0, Math.min(newTop, gesture.startTop + gesture.startHeight - snap));
        gesture.bandEl.style.top = `${clamped}px`;
        gesture.bandEl.style.height = `${gesture.startTop + gesture.startHeight - clamped}px`;
      } else {
        const newBottom = Math.round((gesture.startTop + gesture.startHeight + dy) / snap) * snap;
        const clamped = Math.max(gesture.startTop + snap, Math.min(newBottom, GRID_HEIGHT));
        gesture.bandEl.style.height = `${clamped - gesture.startTop}px`;
      }
    } else if (gesture.kind === "block-move") {
      const snap = BLOCK_SNAP_MIN * PX_PER_MIN;
      const newTop = Math.round((gesture.startTop + dy) / snap) * snap;
      gesture.el.style.top = `${Math.max(0, Math.min(newTop, GRID_HEIGHT - 4))}px`;
    }
  }

  async function onPointerUp(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const g = gesture;
    const wasDrag = g.active;
    gesture = null;

    if (g.kind === "band-resize") {
      if (wasDrag) {
        const top = parseFloat(g.bandEl.style.top);
        const height = parseFloat(g.bandEl.style.height);
        const edgeY = g.edge === "opens" ? top : top + height;
        const minutes = minutesForY(edgeY);
        const timeStr = `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(Math.round(minutes % 60)).padStart(2, "0")}`;
        if (e.shiftKey) {
          await upsertWeeklyHours(g.band, weekdayOf(g.dateStr), { [g.edge]: timeStr });
        } else {
          await upsertHoursOverride(g.band, g.dateStr, { [g.edge]: timeStr });
        }
        await replan();
        await reload();
      }
    } else if (g.kind === "block-move") {
      g.el.classList.remove("is-dragging");
      if (!wasDrag) {
        // A click, not a drag -- open the task.
        if (g.block.task_id) onOpenTask(g.block.task_id);
      } else {
        const startMin = minutesForY(parseFloat(g.el.style.top));
        const clamped = Math.max(START_HOUR * 60, Math.min(startMin, END_HOUR * 60 - g.durationMin));
        const iso = `${g.dateStr}T${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(Math.round(clamped % 60)).padStart(2, "0")}:00`;
        await fetch(`/api/schedule/blocks/${g.block.id}/move`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start: iso }),
        });
        await replan();
        await reload();
      }
    }
  }

  function onPointerCancel(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    gesture = null;
    render(); // discard any in-progress visual preview
  }

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);

  // --- navigation -----------------------------------------------------------

  async function reload() {
    const dates = visibleDates();
    data = await loadCalendarData(dates[0], dates[dates.length - 1]);
    render();
    onDataLoaded(data);
  }

  prevBtn.addEventListener("click", () => {
    startDate = addDays(startDate, -numDays);
    reload();
  });
  nextBtn.addEventListener("click", () => {
    startDate = addDays(startDate, numDays);
    reload();
  });
  todayBtn.addEventListener("click", () => {
    startDate = todayStr();
    reload();
  });

  // The now-line and "is today" framing both go stale at midnight if the
  // page is left open; cheap enough to just re-render on an interval rather
  // than tracking a day-boundary timer.
  nowTimer = setInterval(() => {
    if (data) render();
  }, 60_000);

  reload();

  return {
    reload,
    goToToday: () => todayBtn.click(),
    getStartDate: () => startDate,
    destroy() {
      clearInterval(nowTimer);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    },
  };
}
