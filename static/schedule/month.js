// The month view: the schedule at the altitude where a collision weeks out is
// visible -- two deadlines in one week, a finishing buffer landing on a trip --
// not the altitude where a single block is read.
//
// It does NOT mount the hourly calendar component (calendar.js). A month has
// no hourly axis, so what it reuses from the shared code is the DATA pass
// (loadCalendarData) and the working-hours helper, not the grid. What it draws
// is the drafting language's `.dr-month` primitive plus the four things a
// month is actually for:
//
//   - deadline markers, weighted by importance
//   - per-day load, read as tone rather than as counted blocks
//   - at-risk days, marked in red
//   - the protected finishing buffer before each deadline, visibly reserved
//
// The construction layer earns its keep here more than on any other surface:
// compass arcs are struck back from each deadline and projection lines run
// across the weeks, so the run-up to a hand-in is drawn as geometry. It stays
// texture -- everything that must be read at a glance is an object line or a
// tone, and the whole construction overlay comes off with `.dr-no-construction`
// exactly as it does on the week view.

import { loadCalendarData, effectiveBandWindow } from "./calendar.js";

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
// A working day with no hours set still has to score somewhere on the load
// ramp, so the tiers fall back to this when effectiveBandWindow returns null.
const FALLBACK_DAY_MINUTES = 8 * 60;

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d);
}
function todayStr() {
  return iso(new Date());
}
// Monday=0..Sunday=6, matching calendar.js and Python's date.weekday().
function weekdayOf(dateStr) {
  return (new Date(`${dateStr}T00:00:00`).getDay() + 6) % 7;
}
function firstOfMonth(dateStr) {
  return `${dateStr.slice(0, 7)}-01`;
}
function addMonths(firstStr, n) {
  const d = new Date(`${firstStr}T00:00:00`);
  d.setMonth(d.getMonth() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function clampImportance(value) {
  const n = Number(value);
  return n >= 1 && n <= 5 ? Math.round(n) : 3;
}

export function createMonth(container, options = {}) {
  const onOpenDay = options.onOpenDay || (() => {});

  let anchor = firstOfMonth(options.startDate || todayStr());
  let data = null;
  let lastModel = null;

  // Rebuilt on every load. deliverableIndex numbers the deliverables with a
  // deadline in view, the same idiom the week view keys its blocks by.
  let deliverableIndex = new Map();

  container.classList.add("schedule-month");
  container.innerHTML = `
    <div class="schedule-month-toolbar schedule-calendar-toolbar">
      <button type="button" class="btn schedule-month-prev">&larr;</button>
      <button type="button" class="btn schedule-month-today">This month</button>
      <button type="button" class="btn schedule-month-next">&rarr;</button>
      <span class="schedule-range-label schedule-month-label"></span>
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
    <div class="dr-month-grid-wrap">
      <div class="dr-month"></div>
      <div class="dr-month-construction dr-construction" aria-hidden="true"></div>
    </div>
    <div class="dr-month-key" hidden></div>
  `;

  const prevBtn = container.querySelector(".schedule-month-prev");
  const nextBtn = container.querySelector(".schedule-month-next");
  const todayBtn = container.querySelector(".schedule-month-today");
  const label = container.querySelector(".schedule-month-label");
  const gridEl = container.querySelector(".dr-month");
  const constructionEl = container.querySelector(".dr-month-construction");
  const keyEl = container.querySelector(".dr-month-key");

  // The two print switches flip a class on <body>, same as the week view's --
  // the whole layer is one custom property either way, so neither costs a
  // re-render and neither is persisted (CLAUDE.md hard rule 2).
  container.querySelector(".schedule-construction-switch").addEventListener("change", (e) => {
    document.body.classList.toggle("dr-no-construction", !e.target.checked);
  });
  container.querySelector(".schedule-texture-switch").addEventListener("change", (e) => {
    document.body.classList.toggle("dr-no-texture", !e.target.checked);
  });

  // --- the grid's dates ------------------------------------------------------

  function gridDates() {
    const first = `${anchor}`;
    const lead = weekdayOf(first);
    const start = addDays(first, -lead);
    const daysInMonth = new Date(
      Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 0,
    ).getDate();
    // Exactly the weeks this month touches -- 4, 5 or 6 -- never a fixed 6,
    // so a short month is not padded with a whole ruled row of nothing.
    const rows = Math.ceil((lead + daysInMonth) / 7);
    return { start, rows, dates: Array.from({ length: rows * 7 }, (_, i) => addDays(start, i)) };
  }

  // --- deriving the four overlays from one plan -----------------------------

  function deriveModel(dates) {
    const inMonth = anchor.slice(0, 7);
    const blocks = data.schedule.blocks || [];
    const tasksById = data.tasksById || {};
    const deliverablesById = data.deliverablesById || {};

    // Load: task-block minutes per day. Nothing else counts against a day's
    // weight -- travel, prep and breaks are how a day gets full, but they are
    // not the work the month view is asking "will this fit" about. Stored
    // blocks carry no duration column, so a slot block is measured end minus
    // start and a day-granularity one (bare date, no times) falls back to the
    // task's own estimate.
    const loadByDate = {};
    blocks.forEach((b) => {
      if (b.kind !== "task") return;
      const d = b.start.slice(0, 10);
      let minutes = (new Date(b.end) - new Date(b.start)) / 60000;
      if (!(minutes > 0)) minutes = tasksById[b.task_id]?.est_minutes || 0;
      loadByDate[d] = (loadByDate[d] || 0) + minutes;
    });

    // At risk: the day a task is effectively due, and every day already
    // holding one of its blocks. Both matter -- a collision you can act on is
    // sometimes in the run-up, not on the deadline itself.
    const atRiskTaskIds = new Set((data.schedule.at_risk || []).map((e) => e.task_id).filter(Boolean));
    const atRiskDates = new Set();
    (data.schedule.at_risk || []).forEach((e) => {
      const d = (e.effective_deadline || e.deadline || "").slice(0, 10);
      if (d) atRiskDates.add(d);
    });
    blocks.forEach((b) => {
      if (b.kind === "task" && atRiskTaskIds.has(b.task_id)) atRiskDates.add(b.start.slice(0, 10));
    });

    // Deadlines. A deliverable's own due date stands in for its member tasks
    // -- showing the brief once is the right altitude here -- so a task that
    // only inherits its deliverable's date is folded into that one marker.
    const deadlinesByDate = {};
    const shownDeliverables = new Set();
    const pushDeadline = (dateStr, entry) => {
      (deadlinesByDate[dateStr] = deadlinesByDate[dateStr] || []).push(entry);
    };

    Object.values(deliverablesById).forEach((deliv) => {
      if (!deliv.due_at) return;
      const dateStr = deliv.due_at.slice(0, 10);
      const memberImps = Object.values(tasksById)
        .filter((t) => t.deliverable_id === deliv.id && t.importance)
        .map((t) => clampImportance(t.importance));
      const memberFinishing = Object.values(tasksById)
        .some((t) => t.deliverable_id === deliv.id && t.is_finishing);
      shownDeliverables.add(deliv.id);
      pushDeadline(dateStr, {
        title: deliv.title || "Deliverable",
        importance: memberImps.length ? Math.max(...memberImps) : 3,
        finishing: memberFinishing,
        atRisk: atRiskDates.has(dateStr),
        deliverableId: deliv.id,
      });
    });

    Object.values(tasksById).forEach((t) => {
      if (!t.deadline) return;
      if (t.status === "done" || t.status === "abandoned") return;
      // Its deliverable already carries this date -- don't draw it twice.
      if (t.deliverable_id && shownDeliverables.has(t.deliverable_id)
        && deliverablesById[t.deliverable_id]?.due_at?.slice(0, 10) === t.deadline) return;
      pushDeadline(t.deadline, {
        title: t.title,
        importance: clampImportance(t.importance),
        finishing: Boolean(t.is_finishing),
        atRisk: atRiskDates.has(t.deadline),
        deliverableId: t.deliverable_id || null,
      });
    });

    // The finishing buffer. _protected_spans reserves [deadline - buffer,
    // deadline] for every deadline that has is_finishing work; mirror that
    // here at day resolution. The buffer is in elapsed minutes, so a day is
    // one 24h step of it -- and the deadline day itself is inside the span.
    const bufferMinutes = data.finishingBufferMinutes || 24 * 60;
    const bufferDays = Math.max(1, Math.ceil(bufferMinutes / (24 * 60)));
    const bufferByDate = {};
    Object.entries(deadlinesByDate).forEach(([dateStr, entries]) => {
      if (!entries.some((e) => e.finishing)) return;
      for (let back = 0; back <= bufferDays; back++) {
        const d = addDays(dateStr, -back);
        bufferByDate[d] = { isDeadlineDay: back === 0 };
      }
    });

    // Commitments as faint lines -- not because a month wants to list events,
    // but because "a buffer that overlaps a trip" is only visible if the trip
    // is on the sheet too.
    const commitmentsByDate = {};
    (data.commitments || []).forEach((c) => {
      let d = c.start.slice(0, 10);
      const end = c.end.slice(0, 10);
      let guard = 0;
      while (d <= end && guard++ < 40) {
        (commitmentsByDate[d] = commitmentsByDate[d] || []).push(
          c.meta?.module_name || c.title || "Event",
        );
        d = addDays(d, 1);
      }
    });

    // The key under the sheet: every deliverable with a deadline in view.
    deliverableIndex = new Map();
    dates.forEach((dateStr) => {
      (deadlinesByDate[dateStr] || []).forEach((e) => {
        if (e.deliverableId && !deliverableIndex.has(e.deliverableId)) {
          deliverableIndex.set(e.deliverableId, deliverableIndex.size + 1);
        }
      });
    });

    return {
      inMonth, loadByDate, atRiskDates, deadlinesByDate, bufferByDate,
      commitmentsByDate,
      dayCapacity: (dateStr) => {
        const band = effectiveBandWindow(dateStr, data.workingHours || [], data.workingOverrides || []);
        if (!band) return FALLBACK_DAY_MINUTES;
        const [oh, om] = band.opens.split(":").map(Number);
        const [ch, cm] = band.closes.split(":").map(Number);
        return Math.max(60, (ch * 60 + cm) - (oh * 60 + om));
      },
    };
  }

  // Load as a four-step tone ramp, read against the day's own working
  // capacity: a light half-day, a full day, a packed day, an overbooked one.
  function loadTier(minutes, capacity) {
    if (!minutes) return 0;
    const ratio = minutes / capacity;
    if (ratio <= 0.5) return 1;
    if (ratio <= 0.85) return 2;
    if (ratio <= 1.05) return 3;
    return 4;
  }

  // --- rendering -----------------------------------------------------------

  function renderLabel() {
    const y = Number(anchor.slice(0, 4));
    const m = Number(anchor.slice(5, 7)) - 1;
    label.textContent = `${MONTH_LABELS[m]} ${y}`.toUpperCase();
  }

  function render() {
    renderLabel();
    const { dates } = gridDates();
    const model = deriveModel(dates);

    gridEl.innerHTML = "";
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((name) => {
      const head = document.createElement("div");
      head.className = "dr-month-head";
      head.textContent = name;
      gridEl.appendChild(head);
    });

    dates.forEach((dateStr) => gridEl.appendChild(renderCell(dateStr, model)));
    lastModel = model;
    renderConstruction();
    renderKey();
  }

  function renderCell(dateStr, model) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "dr-month-cell";
    cell.dataset.date = dateStr;
    const outside = dateStr.slice(0, 7) !== model.inMonth;
    if (outside) cell.classList.add("is-outside");
    if (dateStr === todayStr()) cell.classList.add("is-today");

    const buffer = model.bufferByDate[dateStr];
    if (buffer && !outside) cell.classList.add("is-buffer");

    // Load tone, but never on a cell that is out of the month (crosshatch
    // there means "not our material" and must stay legible) or already
    // reserved as buffer (its hatch is the reservation).
    if (!outside && !buffer) {
      const tier = loadTier(model.loadByDate[dateStr] || 0, model.dayCapacity(dateStr));
      if (tier) cell.classList.add(`is-load-${tier}`);
    }

    if (model.atRiskDates.has(dateStr) && !outside) {
      cell.classList.add("is-at-risk");
      const flag = document.createElement("span");
      flag.className = "dr-flag";
      flag.textContent = "At risk";
      cell.appendChild(flag);
    }

    const figure = document.createElement("span");
    figure.className = "dr-month-figure";
    figure.textContent = new Date(`${dateStr}T00:00:00`).getDate();
    cell.appendChild(figure);

    if (buffer && !outside) {
      const tag = document.createElement("span");
      tag.className = "dr-month-tag";
      tag.textContent = buffer.isDeadlineDay ? "Finishing" : "Reserved";
      cell.appendChild(tag);
    }

    // Entries: deadlines first, then one commitment line, then a tally of
    // anything left unsaid. Deliberately sparse -- the tone carries the load,
    // so the text only ever carries what the tone cannot.
    const deadlines = model.deadlinesByDate[dateStr] || [];
    deadlines.slice(0, 2).forEach((entry) => {
      const line = document.createElement("span");
      line.className = "dr-month-entry dr-month-entry--deadline";
      const weight = entry.importance >= 4 ? "is-major" : entry.importance <= 2 ? "is-minor" : "";
      if (weight) line.classList.add(weight);
      const idx = entry.deliverableId ? deliverableIndex.get(entry.deliverableId) : null;
      if (idx) {
        const mark = document.createElement("span");
        mark.className = "dr-index";
        mark.textContent = String(idx).padStart(2, "0");
        line.appendChild(mark);
      }
      line.appendChild(document.createTextNode(entry.title));
      cell.appendChild(line);
    });

    const commitments = model.commitmentsByDate[dateStr] || [];
    if (commitments.length && deadlines.length < 2) {
      const line = document.createElement("span");
      line.className = "dr-month-entry dr-month-entry--timetabled";
      line.textContent = commitments[0];
      cell.appendChild(line);
    }

    const hidden = Math.max(0, deadlines.length - 2)
      + Math.max(0, commitments.length - (deadlines.length < 2 ? 1 : 0));
    if (hidden && !outside) {
      const more = document.createElement("span");
      more.className = "dr-month-more dr-micro";
      more.textContent = `+${hidden}`;
      cell.appendChild(more);
    }

    cell.addEventListener("click", () => onOpenDay(dateStr));
    return cell;
  }

  // The construction layer: one overlay over the whole grid, compass arcs
  // struck back from each deadline and projection lines run across its week and
  // down its column, so the run-up to a hand-in is drawn as geometry. Placed
  // from the deadline cells' own measured boxes rather than a percentage
  // estimate -- the weekday-head row is shorter than a week row, so an
  // even-rows guess would drift. `.dr-construction` on the container is what
  // takes the whole layer off with `.dr-no-construction`.
  function renderConstruction() {
    constructionEl.innerHTML = "";
    if (!lastModel) return;
    const wrap = constructionEl.getBoundingClientRect();
    gridEl.querySelectorAll(".dr-month-cell").forEach((cell) => {
      const entries = lastModel.deadlinesByDate[cell.dataset.date];
      if (!entries || !entries.length) return;
      const r = cell.getBoundingClientRect();
      const cx = r.left - wrap.left + r.width / 2;
      const cy = r.top - wrap.top + r.height / 2;
      const importance = Math.max(...entries.map((e) => e.importance));

      // Concentric sweeps, wider for a heavier deadline -- the more important
      // hand-in casts the longer shadow back over its run-up.
      const scale = 0.7 + importance * 0.12;
      [70, 132, 205].forEach((radius) => {
        const arc = document.createElement("div");
        arc.className = "dr-arc";
        arc.style.left = `${cx}px`;
        arc.style.top = `${cy}px`;
        arc.style.setProperty("--dr-arc-r", `${Math.round(radius * scale)}px`);
        // The struck radius points up and back into the run-up weeks.
        arc.style.setProperty("--dr-radius-angle", "-140deg");
        constructionEl.appendChild(arc);
      });

      const hRay = document.createElement("div");
      hRay.className = "dr-month-projection dr-month-projection--h";
      hRay.style.top = `${cy}px`;
      constructionEl.appendChild(hRay);

      const vRay = document.createElement("div");
      vRay.className = "dr-month-projection dr-month-projection--v";
      vRay.style.left = `${cx}px`;
      constructionEl.appendChild(vRay);
    });
  }

  function renderKey() {
    keyEl.innerHTML = "";
    const rows = [];

    if (deliverableIndex.size) {
      [...deliverableIndex.entries()].forEach(([id, idx]) => {
        rows.push([
          String(idx).padStart(2, "0"),
          "Deliverable",
          data.deliverablesById[id]?.title || "Untitled",
        ]);
      });
    }

    // A short legend of the marks the sheet uses, so the tones are readable
    // without having learnt them -- a drawing carries its own key.
    const legend = [
      ["load", "Daily load", "Light → overbooked, against that day's working hours"],
      ["risk", "At risk", "A deadline that cannot be met, and its run-up"],
      ["buffer", "Finishing buffer", "Time before a hand-in reserved for finishing work"],
    ];

    rows.forEach(([num, term, value]) => {
      const row = document.createElement("div");
      row.className = "dr-key-row";
      row.innerHTML = `
        <span class="dr-key-num">${num}</span>
        <span class="dr-key-term">${term}</span>
        <span class="dr-key-leader"></span>
        <span class="dr-key-value"></span>`;
      row.querySelector(".dr-key-value").textContent = value;
      keyEl.appendChild(row);
    });

    legend.forEach(([kind, term, value]) => {
      const row = document.createElement("div");
      row.className = "dr-key-row dr-key-row--legend";
      row.innerHTML = `
        <span class="dr-key-swatch dr-key-swatch--${kind}"></span>
        <span class="dr-key-term">${term}</span>
        <span class="dr-key-leader"></span>
        <span class="dr-key-value"></span>`;
      row.querySelector(".dr-key-value").textContent = value;
      keyEl.appendChild(row);
    });

    keyEl.hidden = false;
  }

  // --- data + navigation --------------------------------------------------

  async function reload() {
    const { dates } = gridDates();
    data = await loadCalendarData(dates[0], dates[dates.length - 1]);
    render();
  }

  prevBtn.addEventListener("click", () => { anchor = addMonths(anchor, -1); reload(); });
  nextBtn.addEventListener("click", () => { anchor = addMonths(anchor, 1); reload(); });
  todayBtn.addEventListener("click", () => { anchor = firstOfMonth(todayStr()); reload(); });

  // The construction overlay is placed from measured cell boxes, so it has to
  // be redrawn when the grid reflows. Only that layer -- the cells and tones
  // are pure CSS and take care of themselves.
  let resizeRaf = null;
  function onResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      renderConstruction();
    });
  }
  window.addEventListener("resize", onResize);

  reload();

  return {
    reload,
    getAnchor: () => anchor,
    destroy() {
      window.removeEventListener("resize", onResize);
    },
  };
}
