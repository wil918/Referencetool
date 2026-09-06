/* The reusable calendar grid -- an hourly, multi-day view. The week view
 * (schedule.js) mounts this with numDays: 7; the day view a later session
 * adds should be numDays: 1 against the same component, not a copy of it.
 * (Month view is a fundamentally different layout -- a grid of day cells,
 * no hourly axis -- so it won't call createCalendar at all; it can still
 * reuse loadCalendarData/effectiveBandWindow below.)
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

import { cadenceTag } from "./recurrence.js";

const PX_PER_MIN = 1; // 60px/hour -- keeps every time<->pixel conversion a plain subtraction
// A day, for scheduling purposes, starts at 5am and runs a full 24 hours --
// through midnight and into the small hours (12am-4:59am) of the FOLLOWING
// calendar date, which still renders at the bottom of THIS date's column
// rather than the top of tomorrow's (tomorrow's own column starts at ITS
// 5am). elapsedInColumn/isoForColumnElapsed below are the two directions of
// that mapping; everything that positions or drags something on the axis
// goes through one of them rather than assuming a date's own 00:00-23:59.
const START_HOUR = 5;
const DAY_SPAN_MIN = 24 * 60;
const GRID_HEIGHT = DAY_SPAN_MIN * PX_PER_MIN;
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

function dateOfIso(iso) {
  return iso.slice(0, 10);
}

/** Minutes elapsed since `dateStr`'s own column began (its 5am) for a raw
 *  0-1439 minutes-of-day value dated `eventDateStr` -- either `dateStr`
 *  itself (only sensible from 5am on: anything earlier in a date's own
 *  00:00-23:59 belongs to the PREVIOUS date's column, see slotEventsFor's
 *  own dateStr/nextDateStr split) or the day right after it, for the small
 *  hours before THAT day's own 5am start. */
function elapsedInColumn(dateStr, eventDateStr, rawMinutes) {
  if (eventDateStr === dateStr) return rawMinutes - START_HOUR * 60;
  return DAY_SPAN_MIN - START_HOUR * 60 + rawMinutes; // eventDateStr is the day after dateStr
}

function yForElapsed(elapsed) {
  return Math.max(0, Math.min(DAY_SPAN_MIN, elapsed)) * PX_PER_MIN;
}

/** The inverse of elapsedInColumn -- a pixel position within `dateStr`'s own
 *  track, back into the absolute date+time it represents, rolling into the
 *  following calendar date once the position carries past midnight. Used
 *  only for a block drag, which can land anywhere in the full 24h track;
 *  a band's own opens/closes never cross midnight (rawMinutesSameDay). */
function isoForColumnElapsed(dateStr, elapsedMinutes) {
  const raw = START_HOUR * 60 + elapsedMinutes;
  if (raw >= 24 * 60) return { dateStr: addDays(dateStr, 1), minutes: raw - 24 * 60 };
  return { dateStr, minutes: raw };
}

function rawMinutesSameDay(elapsedMinutes) {
  return START_HOUR * 60 + elapsedMinutes;
}

function formatTime(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.round(minutes % 60);
  const period = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${period}`;
}

/** formatTime for an elapsed-since-5am value rather than a raw
 *  minutes-of-day one -- the two agree at 5am (elapsed 0) and diverge from
 *  there, so an elapsed value must be converted back to true wall-clock
 *  minutes (mod a full day) before formatting, or a wrapped time (e.g.
 *  elapsed 1140 = midnight) would print as whatever raw hour that elapsed
 *  count happens to equal instead of 12am. */
function formatElapsed(elapsed) {
  return formatTime((START_HOUR * 60 + elapsed) % (24 * 60));
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
 * grid this file also builds.
 *
 * `end`'s own small hours (12am-4:59am) render at the bottom of `endDate`'s
 * column -- see elapsedInColumn -- so both fetches below reach one day past
 * `endDate` rather than stopping exactly at it, or that continuation would
 * have nothing to draw. The extra day's later hours come along too and are
 * simply never rendered by anything on screen, which costs nothing worth
 * avoiding with a narrower, time-of-day-aware request. */
export async function loadCalendarData(startDate, endDate) {
  const fetchEnd = addDays(endDate, 1);
  const [schedule, commitments, workingHours, domesticHours, workingOverrides,
    domesticOverrides, bedtimes, tasks, projects, locations, recurrenceRules] = await Promise.all([
    getJSON(`/api/schedule?start=${startDate}&end=${fetchEnd}`),
    getJSON("/api/commitments"),
    getJSON("/api/working-hours"),
    getJSON("/api/domestic-hours"),
    getJSON("/api/hours-overrides?band=working"),
    getJSON("/api/hours-overrides?band=domestic"),
    getJSON(`/api/schedule/bedtimes?start=${startDate}&end=${endDate}`),
    getJSON("/api/tasks"),
    getJSON("/api/projects"),
    getJSON("/api/locations"),
    getJSON("/api/recurrence-rules"),
  ]);
  const locationsById = Object.fromEntries((locations || []).map((l) => [l.id, l]));

  const tasksById = Object.fromEntries((tasks || []).map((t) => [t.id, t]));
  const projectIds = [...new Set(
    (tasks || []).filter((t) => t.deliverable_id && t.project_id).map((t) => t.project_id)
  )];
  const deliverableLists = await Promise.all(
    projectIds.map((pid) => getJSON(`/api/projects/${pid}/deliverables`))
  );
  const deliverablesById = {};
  deliverableLists.forEach((list) => (list || []).forEach((d) => (deliverablesById[d.id] = d)));

  const stop = `${fetchEnd}T23:59:59`;
  const startOfDay = `${startDate}T00:00:00`;
  const visibleCommitments = (commitments || []).filter((c) => c.start < stop && c.end > startOfDay);

  return {
    schedule: schedule || { blocks: [], at_risk: [], at_risk_by_deliverable: [], chronically_slipping: [] },
    // Minutes reserved before each deadline for finishing work. Only the month
    // view (month.js) draws this; the hourly grid ignores it.
    finishingBufferMinutes: schedule?.finishing_buffer_minutes ?? 24 * 60,
    commitments: visibleCommitments,
    workingHours: workingHours || [],
    domesticHours: domesticHours || [],
    workingOverrides: workingOverrides || [],
    domesticOverrides: domesticOverrides || [],
    bedtimes: bedtimes || [],
    tasksById,
    deliverablesById,
    recurrenceRulesById: Object.fromEntries((recurrenceRules || []).map((r) => [r.id, r])),
    projects: projects || [],
    locationsById,
  };
}

// --- Location umbrellas: display vs. travel -------------------------------
//
// Mirrors scheduling.resolve_location_root/travel_minutes by hand rather than
// sharing code across the Python/JS boundary -- same convention as
// effectiveBandWindow above. Only the home leg is needed here (a block shows
// the trip FROM HOME to get to it, never location-to-location), which is
// simpler than the backend's full pairwise travel_minutes.

function resolveLocationRoot(locationsById, locationId) {
  let current = locationId;
  const seen = new Set();
  while (locationsById[current]?.parent_location_id && !seen.has(current)) {
    seen.add(current);
    current = locationsById[current].parent_location_id;
  }
  return current;
}

/** Minutes from home to `locationId`'s umbrella, or null when travel doesn't
 * apply at all -- no location, an online one (see LOCATIONS_SCHEMA.is_online),
 * or nobody has entered a travel_minutes_from_home for its umbrella yet. */
function travelMinutesFromHome(locationsById, locationId) {
  if (!locationId) return null;
  const location = locationsById[locationId];
  if (!location || location.is_online) return null;
  const root = locationsById[resolveLocationRoot(locationsById, locationId)];
  const minutes = root?.travel_minutes_from_home;
  return minutes ? minutes : null;
}

function leaveByLabel(startIso, minutes) {
  const leave = new Date(new Date(startIso).getTime() - minutes * 60000);
  return leave.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
  const onOpenCommitment = options.onOpenCommitment || (() => {});
  const onDataLoaded = options.onDataLoaded || (() => {});
  // Only the week view (numDays: 7) should open on Monday regardless of what
  // day it is today -- the day view (numDays: 1) mounts this same component
  // and must show exactly the date it's asked for, so it defaults off there.
  const snapToWeek = "snapToWeek" in options ? options.snapToWeek : numDays === 7;
  // The single-day view (schedule/day.js) is the one read while actually
  // moving between places, so it is the one that shows a travel leg's
  // destination as well as its length, and the one that opens scrolled to
  // now rather than to the top of a 24-hour track. Neither is week-specific
  // behaviour being removed -- the week view simply has no room for either.
  const dayView = numDays === 1;

  // weekdayOf is Monday=0..Sunday=6, so subtracting it walks back to that
  // week's Monday. addDays(mon, ±numDays) is still a Monday once numDays is
  // itself a multiple of 7, so prev/next don't need to re-snap -- only the
  // two places that can hand in an arbitrary date (here, and Today) do.
  const snapDate = (d) => (snapToWeek ? addDays(d, -weekdayOf(d)) : d);

  let startDate = snapDate(options.startDate || todayStr());
  let data = null;
  let nowTimer = null;
  // Rebuilt on every load: which tasks the scheduler flagged, and a stable
  // 1..n index per deliverable in the visible range. The index is what the
  // blocks are keyed by -- see the deliverable key drawn under the calendar.
  let atRiskTaskIds = new Set();
  let deliverableIndex = new Map();
  let gesture = null; // the one in-flight pointer gesture, band-resize or block-drag

  container.classList.add("schedule-calendar");
  container.innerHTML = `
    <div class="schedule-calendar-toolbar">
      <button type="button" class="btn schedule-nav-prev">&larr;</button>
      <button type="button" class="btn schedule-nav-today">Today</button>
      <button type="button" class="btn schedule-nav-next">&rarr;</button>
      <span class="schedule-range-label"></span>
      <span class="schedule-toggles">
        <label class="dr-toggle">
          <input type="checkbox" class="schedule-construction-switch" checked>
          <span class="dr-toggle-box"></span>
          Construction
        </label>
        <label class="dr-toggle">
          <input type="checkbox" class="schedule-texture-switch" checked>
          <span class="dr-toggle-box"></span>
          Texture
        </label>
      </span>
    </div>
    <p class="schedule-empty-banner muted" hidden></p>
    <div class="schedule-calendar-body">
      <div class="schedule-hour-axis dr-axis"></div>
      <div class="schedule-day-columns"></div>
    </div>
    <div class="schedule-deliverable-key dr-key" hidden></div>
  `;

  const prevBtn = container.querySelector(".schedule-nav-prev");
  const nextBtn = container.querySelector(".schedule-nav-next");
  const todayBtn = container.querySelector(".schedule-nav-today");
  const rangeLabel = container.querySelector(".schedule-range-label");
  const emptyBanner = container.querySelector(".schedule-empty-banner");
  const bodyEl = container.querySelector(".schedule-calendar-body");
  const hourAxis = container.querySelector(".schedule-hour-axis");
  const columnsEl = container.querySelector(".schedule-day-columns");
  const deliverableKeyEl = container.querySelector(".schedule-deliverable-key");

  /* The two print switches. Both flip a class on <body> -- the whole layer is
   * one custom property either way (see drafting.css), so neither costs a
   * re-render, and neither is persisted: they are how the sheet is printed
   * today, not something the user made (CLAUDE.md hard rule 2). */
  container.querySelector(".schedule-construction-switch").addEventListener("change", (e) => {
    document.body.classList.toggle("dr-no-construction", !e.target.checked);
  });
  container.querySelector(".schedule-texture-switch").addEventListener("change", (e) => {
    document.body.classList.toggle("dr-no-texture", !e.target.checked);
  });

  // Set once, on the grid itself rather than on .schedule-day-columns: a
  // custom property only cascades to descendants, and grid-template-columns
  // that reads it now lives on .schedule-calendar-body (style.css), an
  // ancestor of .schedule-day-columns, not that element itself. numDays is
  // fixed for this component's lifetime, so this never needs to run again.
  bodyEl.style.setProperty("--schedule-num-days", numDays);

  // The hour axis is identical every render -- built once. 24 labels, one
  // per hour elapsed since 5am: the wall-clock hour they name wraps back
  // round through midnight (%24) for the last five, 12am through 4am.
  hourAxis.style.height = `${GRID_HEIGHT}px`;
  for (let i = 0; i < 24; i++) {
    const wallHour = (START_HOUR + i) % 24;
    const label = document.createElement("div");
    // Every third figure carries more weight, so the rule can be counted in
    // threes without being read (drafting.css's .is-major).
    label.className = `dr-axis-figure${i % 3 === 0 ? " is-major" : ""}`;
    label.style.top = `${yForElapsed(i * 60)}px`;
    label.textContent = formatTime(wallHour * 60);
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

  /* startMin/endMin below are minutes ELAPSED since dateStr's own 5am (see
   * elapsedInColumn), not raw minutes-of-day -- that's what lets this
   * column and the axis agree on where anything sits, including something
   * dated tomorrow that's really tonight's continuation past midnight.
   * formatElapsed (not formatTime) is what turns one of these back into a
   * displayable wall-clock time. */
  function slotEventsFor(dateStr) {
    const nextDateStr = addDays(dateStr, 1);
    // A slot-granularity item belongs to this column if it's dated today
    // from 5am on, or dated tomorrow but still in the small hours before
    // tomorrow's OWN 5am start -- the same split START_HOUR draws
    // everywhere else on the axis.
    const belongsHere = (eventDateStr, rawMinutes) =>
      (eventDateStr === dateStr && rawMinutes >= START_HOUR * 60) ||
      (eventDateStr === nextDateStr && rawMinutes < START_HOUR * 60);

    const events = [];
    (data.schedule.blocks || []).forEach((b) => {
      if (b.granularity !== "slot") return;
      const eventDateStr = dateOfIso(b.start);
      const rawStart = minutesOfIso(b.start);
      if (!belongsHere(eventDateStr, rawStart)) return;
      const task = b.task_id ? data.tasksById[b.task_id] : null;
      const startMin = elapsedInColumn(dateStr, eventDateStr, rawStart);
      const endMin = elapsedInColumn(dateStr, dateOfIso(b.end), minutesOfIso(b.end));
      events.push({
        type: "block",
        block: b,
        kind: b.kind,
        task,
        startMin,
        endMin: Math.max(startMin + 1, endMin),
      });
    });
    data.commitments.forEach((c) => {
      const eventDateStr = dateOfIso(c.start);
      const rawStart = minutesOfIso(c.start);
      if (!belongsHere(eventDateStr, rawStart)) return;
      const startMin = elapsedInColumn(dateStr, eventDateStr, rawStart);
      // Ends beyond this column's own reach (a different date than it
      // started) clip at this track's bottom, same as always -- a
      // multi-day commitment is rendered fresh on each day it touches, not
      // stretched continuously across columns.
      const endDateStr = dateOfIso(c.end);
      const endMin = endDateStr === eventDateStr ? elapsedInColumn(dateStr, endDateStr, minutesOfIso(c.end)) : DAY_SPAN_MIN;
      events.push({
        type: "commitment",
        commitment: c,
        startMin,
        endMin: Math.max(startMin + 1, endMin),
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
    // A tone over a transparent ground, never a fill -- which is what lets a
    // working and a domestic band that cover the same hour both survive and
    // read as two materials at once.
    el.className = `dr-band dr-band--${kind}`;
    // Working/domestic hours never cross midnight, so both edges are always
    // this same date -- elapsedInColumn's same-day branch.
    const top = yForElapsed(elapsedInColumn(dateStr, dateStr, minutesOfIso(`${dateStr}T${band.opens}:00`)));
    const bottom = yForElapsed(elapsedInColumn(dateStr, dateStr, minutesOfIso(`${dateStr}T${band.closes}:00`)));
    el.style.top = `${top}px`;
    el.style.height = `${Math.max(bottom - top, 0)}px`;

    const label = document.createElement("span");
    label.className = "dr-band-label";
    label.textContent = kind;
    el.appendChild(label);

    const topHandle = document.createElement("div");
    topHandle.className = "dr-band-handle dr-band-handle--top";
    const bottomHandle = document.createElement("div");
    bottomHandle.className = "dr-band-handle dr-band-handle--bottom";
    el.append(topHandle, bottomHandle);

    wireBandResize(topHandle, kind, dateStr, "opens");
    wireBandResize(bottomHandle, kind, dateStr, "closes");
    return el;
  }

  function labelForBlock(ev) {
    // The module name is THE IMPORTANT ONE (see ics_import.py's parser) --
    // it's what a lecture actually IS, where the bare module code or a raw
    // feed title is not. Falls back to the commitment's own title for
    // anything not imported from a house-format feed (a personal event, or a
    // commitment the parser couldn't confidently name).
    if (ev.type === "commitment") return ev.commitment.meta?.module_name || ev.commitment.title;
    const b = ev.block;
    if (b.kind === "task") return ev.task ? ev.task.title : "Task";
    if (b.kind === "travel") return "Travel";
    if (b.kind === "prep") return "Getting ready";
    if (b.kind === "break") return "Break";
    return b.kind;
  }

  /* delivery type and room -- the second-most-useful thing a block can show,
   * never competing with the module name for top billing (see labelForBlock).
   * Room over site: "E1.01" tells you where to walk, "E Building" doesn't. */
  function subtitleForCommitment(commitment) {
    const meta = commitment.meta || {};
    const parts = [meta.delivery_type, meta.room || meta.site].filter(Boolean);
    return parts.join(" · "); // middle dot
  }

  function travelHintForCommitment(commitment) {
    const minutes = travelMinutesFromHome(data.locationsById, commitment.location_id);
    if (!minutes) return null;
    return `${minutes} min travel · leave ${leaveByLabel(commitment.start, minutes)}`;
  }

  /* A block is a drawn object: paper ground and an edge, and what KIND of
   * thing it is is said by that edge -- never by a fill and never by a hue.
   * Travel is the one exception, because it is not an object at all: it is
   * the line between two of them, so makeTravelEl draws it as one. */
  function makeEventEl(ev, dateStr) {
    const el = document.createElement("div");
    const kindClass = ev.type === "commitment" ? "timetabled" : ev.block.kind;
    el.className = `dr-block dr-block--${kindClass}`;
    el.dataset.kind = kindClass;

    const top = yForElapsed(ev.startMin);
    const height = Math.max(yForElapsed(ev.endMin) - top, MIN_BLOCK_HEIGHT_PX);
    el.style.top = `${top}px`;
    el.style.height = `${height}px`;
    el.style.left = `${(ev.lane / ev.laneCount) * 100}%`;
    el.style.width = `${(1 / ev.laneCount) * 100}%`;

    if (ev.type === "block" && ev.block.kind === "task" && atRiskTaskIds.has(ev.block.task_id)) {
      el.classList.add("dr-block--at-risk");
      const flag = document.createElement("span");
      flag.className = "dr-flag";
      flag.textContent = "At risk";
      el.appendChild(flag);
    }

    const label = document.createElement("span");
    label.className = "dr-block-label";
    label.textContent = labelForBlock(ev);
    el.appendChild(label);

    // A calendar cell that tries to show everything shows nothing -- each
    // extra line only earns its place once the block is tall enough to hold
    // the ones before it too, in order of how useful it is at a glance.
    if (ev.type === "commitment") {
      const subtitle = subtitleForCommitment(ev.commitment);
      if (subtitle && height > 44) {
        const sub = document.createElement("span");
        sub.className = "dr-block-sub";
        sub.textContent = subtitle;
        el.appendChild(sub);
      }
    }

    if (height > 32) {
      const time = document.createElement("span");
      time.className = "dr-block-time";
      time.textContent = `${formatElapsed(ev.startMin)}\u2013${formatElapsed(ev.endMin)}`;
      el.appendChild(time);
    }

    if (ev.type === "commitment") {
      const travelHint = height > 60 ? travelHintForCommitment(ev.commitment) : null;
      if (travelHint) {
        const travel = document.createElement("span");
        travel.className = "dr-block-sub";
        travel.textContent = travelHint;
        el.appendChild(travel);
      }
    }

    // The deliverable is keyed by number rather than by colour: this language
    // has one red and one wash to spend and a rotating hue palette is not in
    // it (see deliverableIndex, and the key drawn under the calendar).
    if (ev.type === "block" && ev.block.kind === "task" && ev.task?.deliverable_id) {
      const idx = deliverableIndex.get(ev.task.deliverable_id);
      if (idx && height > 26) {
        const mark = document.createElement("span");
        mark.className = "dr-index";
        mark.textContent = String(idx).padStart(2, "0");
        el.appendChild(mark);
      }
    }

    // A recurring task will quietly reappear after it is done; one that won't
    // is a different thing and must not read the same. A small letterspaced
    // tag in the corner says the cadence -- no hue, this language has none to
    // spend (see the full phrasing on the Tasks tab and in the detail key).
    if (ev.type === "block" && ev.block.kind === "task" && ev.task?.recurrence_id) {
      const rule = data.recurrenceRulesById[ev.task.recurrence_id];
      const tag = cadenceTag(rule);
      if (tag) {
        el.classList.add("dr-block--recurring");
        const mark = document.createElement("span");
        mark.className = "dr-recur";
        mark.textContent = tag;
        mark.title = `Repeats ${rule.interval_days === 1 ? "every day" : `about every ${rule.interval_days} days`}`;
        el.appendChild(mark);
      }
    }

    // Locked to a slot: a datum mark -- a drawing fixes a point with a circle
    // and a cross through it, which is exactly what a pinned block is.
    if (ev.type === "block" && ev.block.kind === "task" && ev.block.is_locked) {
      el.classList.add("dr-block--locked");
      const datum = document.createElement("span");
      datum.className = "dr-datum";
      datum.title = "Locked to this slot";
      el.appendChild(datum);
    }

    const isDraggableTask = ev.type === "block" && ev.block.kind === "task";
    if (isDraggableTask) {
      wireTaskBlockGesture(el, ev, dateStr);
    } else if (ev.type === "commitment") {
      el.addEventListener("click", () => onOpenCommitment(ev.commitment));
    }
    return el;
  }

  /* Travel is not a block. It is the line between two things, so it is drawn
   * as one: a dashed leader down the left of the track with an arrowhead
   * where it arrives, and the duration lettered beside it. Nothing is boxed,
   * because nothing is happening in that time except moving. */
  function makeTravelEl(ev) {
    const el = document.createElement("div");
    el.className = "dr-leader";
    const top = yForElapsed(ev.startMin);
    el.style.top = `${top}px`;
    el.style.height = `${Math.max(yForElapsed(ev.endMin) - top, 8)}px`;
    el.style.left = "10%";

    const minutes = Math.round(ev.endMin - ev.startMin);
    const label = document.createElement("span");
    label.className = "dr-leader-label";
    // In the day view the leader says where the trip is going, not only how
    // long it takes -- "Studio · 25 min", the two facts you want mid-walk.
    const dest = dayView && ev.block?.to_location_id
      ? data.locationsById[ev.block.to_location_id]
      : null;
    label.textContent = dest ? `${dest.name} · ${minutes} min` : `${minutes} min`;
    el.appendChild(label);
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
      const idx = task?.deliverable_id ? deliverableIndex.get(task.deliverable_id) : null;
      if (idx) {
        const mark = document.createElement("span");
        mark.className = "dr-index";
        mark.textContent = String(idx).padStart(2, "0");
        chip.appendChild(mark);
      }
      chip.appendChild(document.createTextNode(task ? task.title : "Task"));
      chip.addEventListener("click", () => onOpenTask(block.task_id));
      wrap.appendChild(chip);
    });
    return wrap;
  }

  function makeBedtimeEl(dateStr, marker) {
    const el = document.createElement("div");
    el.className = "dr-marker";
    // A bedtime that rolls past midnight (e.g. 00:30) is still tonight's
    // marker -- elapsedInColumn is what places it proportionally in the
    // 12am-4am stretch at the bottom of this column instead of clamping it
    // to a single dumped-at-the-edge position.
    const bedtimeDateStr = dateOfIso(marker.bedtime);
    const rawMinutes = minutesOfIso(marker.bedtime);
    const rolledPastMidnight = bedtimeDateStr !== dateStr;
    const y = yForElapsed(elapsedInColumn(dateStr, bedtimeDateStr, rawMinutes));
    el.style.top = `${y}px`;
    const label = document.createElement("span");
    label.className = "dr-marker-label";
    label.textContent = `Bedtime ${formatTime(rawMinutes)}${rolledPastMidnight ? " (past midnight)" : ""}`;
    el.appendChild(label);
    return el;
  }

  function makeNowLineEl(dateStr) {
    if (dateStr !== todayStr()) return null;
    const now = new Date();
    const rawMinutes = now.getHours() * 60 + now.getMinutes();
    // Between midnight and 5am, "now" belongs at the bottom of YESTERDAY's
    // column (its own small-hours continuation), not today's -- today's
    // cycle-day hasn't started yet by this convention. Rare enough (using
    // the app in the middle of the night) that simply not drawing a line in
    // that window, same as before, is an acceptable edge rather than
    // something worth a second column lookup for.
    if (rawMinutes < START_HOUR * 60) return null;
    const el = document.createElement("div");
    el.className = "dr-now";
    el.style.top = `${yForElapsed(elapsedInColumn(dateStr, dateStr, rawMinutes))}px`;
    const label = document.createElement("span");
    label.className = "dr-now-label";
    label.textContent = "Now";
    el.appendChild(label);
    return el;
  }

  /* --- Deadlines: a compass arc struck from the point ---------------------
   * A task deadline is a date, not a time, so the point is the close of that
   * day's working band (or 5pm if none is set) -- "by the end of the day you
   * are willing to work". The rule and its label are information and stay
   * whatever the construction layer is doing; the two sweeps back into the
   * run-up are setting-out, drawn once per DATE rather than once per task. */
  function deadlineFor(dateStr) {
    const tasks = Object.values(data.tasksById || {})
      .filter((t) => t.deadline === dateStr && t.status !== "done" && t.status !== "abandoned");
    if (!tasks.length) return null;
    const working = bandsFor(dateStr).working;
    const closes = working ? working.closes : "17:00";
    return { tasks, elapsed: elapsedInColumn(dateStr, dateStr, minutesOfIso(`${dateStr}T${closes}:00`)) };
  }

  function makeDeadlineEls(dateStr, deadline) {
    const y = yForElapsed(deadline.elapsed);
    const els = [];

    // Struck first so the arcs sit behind everything they generated.
    [110, 190].forEach((r) => {
      const arc = document.createElement("div");
      arc.className = "dr-arc dr-construction";
      arc.style.top = `${y}px`;
      arc.style.setProperty("--dr-arc-r", `${r}px`);
      els.push(arc);
    });

    const point = document.createElement("div");
    point.className = "dr-point";
    point.style.top = `${y}px`;
    point.style.left = "50%";
    els.push(point);

    const rule = document.createElement("div");
    rule.className = "dr-deadline";
    rule.style.top = `${y}px`;
    const label = document.createElement("span");
    label.className = "dr-deadline-label";
    label.textContent = deadline.tasks.length === 1
      ? `Due: ${deadline.tasks[0].title}`
      : `${deadline.tasks.length} due today`;
    rule.appendChild(label);
    els.push(rule);

    return els;
  }

  function renderDayColumn(dateStr) {
    const col = document.createElement("div");
    col.className = "schedule-day-col dr-col";
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
    track.className = "schedule-day-track dr-track";
    track.style.height = `${GRID_HEIGHT}px`;
    track.dataset.date = dateStr;

    const { working, domestic } = bandsFor(dateStr);
    if (working) track.appendChild(makeBandEl(working, "working", dateStr));
    if (domestic) track.appendChild(makeBandEl(domestic, "domestic", dateStr));

    // The deadline is set out before anything is drawn on top of it.
    const deadline = deadlineFor(dateStr);
    if (deadline) makeDeadlineEls(dateStr, deadline).forEach((el) => track.appendChild(el));

    const laned = layoutLanes(slotEventsFor(dateStr));
    laned.forEach((ev) => {
      track.appendChild(ev.type === "block" && ev.block.kind === "travel"
        ? makeTravelEl(ev)
        : makeEventEl(ev, dateStr));
    });

    // The one-second question the week view has to answer: where is the next
    // thing. Marked with the loudest annotation the language allows, and only
    // ever on today.
    if (dateStr === todayStr()) markNextBlock(track);

    const bedtime = bedtimeFor(dateStr);
    if (bedtime) track.appendChild(makeBedtimeEl(dateStr, bedtime));

    const nowLine = makeNowLineEl(dateStr);
    if (nowLine) track.appendChild(nowLine);

    col.append(header, makeDayListEl(dateStr, dayListFor(dateStr)), track);
    return col;
  }

  /* The next task or commitment still to come today, marked with a red
   * bracket set OUTSIDE its own edge so it reads as an annotation pointing at
   * the block rather than as a change to it. Runs on the finished track, so
   * it does not need to know how the blocks were built. */
  function markNextBlock(track) {
    const now = new Date();
    const rawMinutes = now.getHours() * 60 + now.getMinutes();
    if (rawMinutes < START_HOUR * 60) return;
    const nowY = yForElapsed(rawMinutes - START_HOUR * 60);
    let best = null;
    track.querySelectorAll(".dr-block--task, .dr-block--timetabled").forEach((el) => {
      const top = parseFloat(el.style.top);
      if (top >= nowY && (!best || top < parseFloat(best.style.top))) best = el;
    });
    if (best) best.classList.add("is-next");
  }

  /* Every deliverable with work in the visible range, numbered, as a key at
   * the corner of the sheet. This is what the index marks on the blocks refer
   * to -- the drafting answer to "which project is this", where the
   * neumorphic version spent a rotating hue palette on it. */
  function renderDeliverableKey() {
    deliverableIndex = new Map();
    const seen = [];
    (data.schedule.blocks || []).forEach((b) => {
      const task = b.task_id ? data.tasksById[b.task_id] : null;
      const id = task?.deliverable_id;
      if (id && !deliverableIndex.has(id)) {
        deliverableIndex.set(id, seen.length + 1);
        seen.push(id);
      }
    });

    deliverableKeyEl.innerHTML = "";
    deliverableKeyEl.hidden = seen.length === 0;
    seen.forEach((id, i) => {
      const row = document.createElement("div");
      row.className = "dr-key-row";
      const num = document.createElement("span");
      num.className = "dr-key-num";
      num.textContent = String(i + 1).padStart(2, "0");
      const term = document.createElement("span");
      term.className = "dr-key-term";
      term.textContent = "Deliverable";
      const leader = document.createElement("span");
      leader.className = "dr-key-leader";
      const value = document.createElement("span");
      value.className = "dr-key-value";
      value.textContent = data.deliverablesById[id]?.title || "Untitled";
      row.append(num, term, leader, value);
      deliverableKeyEl.appendChild(row);
    });
  }

  function render() {
    renderRangeLabel();
    renderEmptyBanner();
    atRiskTaskIds = new Set((data.schedule.at_risk || []).map((e) => e.task_id).filter(Boolean));
    renderDeliverableKey();
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
      if (gesture.kind === "block-move") {
        gesture.el.classList.add("is-dragging");
        // The slot it came from, left on the sheet the way a mechanism is
        // drawn through its arc -- construction, so it goes with that layer.
        const ghost = document.createElement("div");
        ghost.className = "dr-block dr-block--ghost dr-construction";
        ghost.style.cssText = gesture.el.style.cssText;
        ghost.style.top = `${gesture.startTop}px`;
        gesture.ghost = ghost;
        gesture.el.parentElement.appendChild(ghost);
      }
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
        const edgeElapsed = g.edge === "opens" ? top : top + height;
        const minutes = rawMinutesSameDay(edgeElapsed); // bands never cross midnight
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
      g.ghost?.remove();
      if (!wasDrag) {
        // A click, not a drag -- open the task.
        if (g.block.task_id) onOpenTask(g.block.task_id);
      } else {
        // Position on screen IS the elapsed-since-5am value at PX_PER_MIN=1;
        // isoForColumnElapsed is what rolls a drop near the bottom into an
        // absolute time on the FOLLOWING calendar date once it crosses
        // midnight, rather than the old flat clamp at this date's own
        // end-of-day that a wider track would now make impossible to reach.
        const elapsed = Math.max(0, Math.min(parseFloat(g.el.style.top) / PX_PER_MIN, DAY_SPAN_MIN - g.durationMin));
        const { dateStr: targetDate, minutes: targetMinutes } = isoForColumnElapsed(g.dateStr, elapsed);
        const iso = `${targetDate}T${String(Math.floor(targetMinutes / 60)).padStart(2, "0")}:${String(Math.round(targetMinutes % 60)).padStart(2, "0")}:00`;
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
    gesture.ghost?.remove();
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
    scrollToNow();
    onDataLoaded(data);
  }

  /* The day view opens a 24-hour track, and the top of it (5am) is almost
   * never where you want to be looking. Drop the scroll so the current hour
   * sits a third of the way down -- or 8am, if the day on screen isn't
   * today. Week view keeps its own top-of-track default. */
  function scrollToNow() {
    if (!dayView) return;
    const onToday = visibleDates().includes(todayStr());
    const rawMinutes = onToday ? new Date().getHours() * 60 + new Date().getMinutes() : 8 * 60;
    const elapsed = Math.max(0, rawMinutes - START_HOUR * 60);
    bodyEl.scrollTop = Math.max(0, elapsed * PX_PER_MIN - bodyEl.clientHeight / 3);
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
    startDate = snapDate(todayStr());
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
    // Jump to an arbitrary date -- the month view calls this to open a day
    // the user clicked. Snaps the same way Today does, so a week view lands
    // on that date's Monday and a day view lands on the date itself.
    goToDate: (dateStr) => {
      startDate = snapDate(dateStr);
      reload();
    },
    getStartDate: () => startDate,
    destroy() {
      clearInterval(nowTimer);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    },
  };
}
