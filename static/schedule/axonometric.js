/* The axonometric month -- the same month as the plan view (month.js), drawn
 * as a construction rather than as a table.
 *
 * THE IDEA, in one sentence: the grid lies on the base plane and the day's
 * work is stacked up the vertical axis, so HEIGHT IS LOAD -- a heavy day is a
 * tower, an empty day is flat ground, and a deadline week reads as a ridge
 * before a single word has been read. Everything else on the sheet exists to
 * make that one reading trustworthy.
 *
 * WHAT MAPS TO WHAT
 *   a day          a cell on the base plane
 *   a task         a block in that day's stack, at its place in the day
 *   a commitment   the same, distinguished by RULE, not by hue -- object
 *                  lines a step lighter and a doubled leading edge, which is
 *                  exactly how section 8 distinguishes one on the flat
 *   travel         a dashed riser: the line between two things, not a thing
 *   a deadline     a circle struck on the base plane, which projects to an
 *                  ellipse -- struck WHOLE, centre marked, radius drawn
 *   today          marked on the plane, never by colouring its tower
 *
 * TWO THINGS THAT ARE EASY TO GET WRONG AND FATAL WHEN THEY ARE
 *
 *   1. ONE PROJECTION FUNCTION. Every point on this sheet -- cell corners,
 *      block faces, arcs, rays, lettering, the plan's alignment below --
 *      comes out of `project()`. Nothing is placed by eye and nothing has a
 *      second, "close enough" copy of the arithmetic. That is also what makes
 *      an orientation control a later afternoon's work rather than a rewrite:
 *      the axes live in one place.
 *
 *   2. BACK TO FRONT, SORTED BY (row + col). In this projection a cell's
 *      distance from the viewer is exactly row + col, so painting the days in
 *      that order is the whole hidden-surface algorithm. Get it wrong and
 *      towers overlap the wrong way round; no amount of styling fixes it,
 *      because the drawing is then simply false.
 *
 * DRAWN, NOT RENDERED. Style comes entirely from drafting.css section 19 --
 * this module chooses geometry and class names and never a colour, a weight
 * or a size. Even the scale is a custom property (--dr-axo-cell / -unit /
 * -margin), read once per draw, the way --dr-hour governs the week.
 *
 * PERFORMANCE. A busy month is several hundred blocks. So: one path per
 * block (three faces as three subpaths of one `d`), the setting-out drawn
 * ONCE for the whole sheet rather than once per block, no filter, no blend
 * and no mask anywhere in the SVG, and nothing on the sheet moves after it
 * is drawn. Hover changes a class on one path and the geometry of one leader.
 */

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;
const SVG_NS = "http://www.w3.org/2000/svg";

// The stack starts at the day's own 5am, matching calendar.js's column split,
// so a 1am block belongs to the previous day's tower on this sheet exactly as
// it belongs to the previous day's column on the week view.
const START_HOUR = 5;

// A cell's footprint is inset a little so two neighbouring towers never share
// an edge -- touching prisms read as one solid and the grid stops being
// legible under them.
const FOOT_INSET = 0.08;

// Below this many minutes a block is still drawn (the tower's height has to
// stay honest) but carries no leading edge of its own: at a couple of pixels
// tall a cut weight is thicker than the block it is on.
const SPINE_MIN_MINUTES = 20;

// How much of the day's stack the vertical scale is ruled for, at minimum --
// so an empty month still shows the measure the towers would be read against.
const MIN_SCALE_HOURS = 8;

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function minutesOfIso(iso) {
  const t = iso.split("T")[1];
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** The date whose TOWER an event belongs to -- its own date from 5am on, the
 *  day before it in the small hours. Mirrors calendar.js's elapsedInColumn
 *  split so the two drawings never disagree about which day a 1am block is. */
function towerDateOf(iso) {
  const dateStr = iso.slice(0, 10);
  if (iso.length <= 10) return dateStr;
  return minutesOfIso(iso) < START_HOUR * 60 ? addDays(dateStr, -1) : dateStr;
}

/** Minutes since the tower's own 5am, used only to ORDER the stack -- the
 *  height of a block is its duration, never its position in the day. */
function orderKeyOf(iso) {
  if (iso.length <= 10) return Number.MAX_SAFE_INTEGER; // undated within its day: stacked last
  const raw = minutesOfIso(iso);
  return raw < START_HOUR * 60 ? raw + 24 * 60 - START_HOUR * 60 : raw - START_HOUR * 60;
}

function durationMinutes(startIso, endIso) {
  if (!startIso || !endIso || startIso.length <= 10) return 0;
  return (new Date(endIso) - new Date(startIso)) / 60000;
}

function formatTimeIso(iso) {
  if (!iso || iso.length <= 10) return "";
  const raw = minutesOfIso(iso);
  const h = Math.floor(raw / 60) % 24;
  const m = raw % 60;
  const period = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${period}`;
}

function formatHours(minutes) {
  const h = minutes / 60;
  return h >= 10 ? String(Math.round(h)) : (Math.round(h * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

/** One number out of a custom property, so the sheet's scale is a value in
 *  drafting.css rather than a second copy of it here. Falls back rather than
 *  producing NaN geometry if the property is ever missing. */
function cssPx(el, name, fallback) {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v !== null && v !== undefined) el.setAttribute(k, v);
  });
  return el;
}

/** A closed polygon from a list of projected points -- every face, cell and
 *  study on the sheet is one of these. */
function polygon(points) {
  return `M${points.map((p) => `${round(p.x)},${round(p.y)}`).join("L")}Z`;
}

function line(a, b) {
  return `M${round(a.x)},${round(a.y)}L${round(b.x)},${round(b.y)}`;
}

// Two decimals: enough for a hairline to land where it was constructed, short
// enough that a month's worth of path data is not half a megabyte of digits.
function round(n) {
  return Math.round(n * 100) / 100;
}

/* --- The one projection ---------------------------------------------------
 * True isometric: the two horizontal axes at 30 degrees above the page, the
 * third straight up. `col` is the weekday, `row` the week, `z` the hours of
 * work stacked on that day.
 *
 * Every position on the sheet -- including the plan's own column pitch below
 * the dividing rule, which is this function's dx for one column -- is derived
 * from here. Adding an orientation control later means changing these two
 * lines and nothing else. */
function makeProjection(m) {
  return function project(col, row, z = 0) {
    return {
      x: m.originX + (col - row) * COS30 * m.cellW,
      y: m.originY + (col + row) * SIN30 * m.cellH - z * m.unitH,
    };
  };
}

/* --- What is stacked on a day --------------------------------------------
 * Task blocks, commitments and travel, in the order they happen. Deliberately
 * NOT prep and breaks: they are the padding around work rather than the work,
 * and stacking them would make a comfortably padded day stand taller than a
 * dense one, which is the one reading this drawing may not get wrong.
 *
 * Overlaps are stacked in sequence rather than side by side. The planner does
 * not schedule a task over a commitment, so an overlap here is a conflict
 * worth seeing as extra height -- and lanes in projection would cost the
 * footprint its meaning as "one day". */
function buildStacks(dates, data, atRiskTaskIds) {
  const inRange = new Set(dates);
  const stacks = {};
  dates.forEach((d) => (stacks[d] = []));

  const push = (dateStr, item) => {
    if (inRange.has(dateStr)) stacks[dateStr].push(item);
  };

  (data.schedule.blocks || []).forEach((b) => {
    if (b.kind !== "task" && b.kind !== "travel") return;
    const task = b.task_id ? data.tasksById[b.task_id] : null;
    // A day-granularity block has no times at all, so it is measured by the
    // task's own estimate -- the same fallback month.js's load pass uses.
    let minutes = durationMinutes(b.start, b.end);
    if (!(minutes > 0)) minutes = task?.est_minutes || 0;
    if (!(minutes > 0)) return;
    push(towerDateOf(b.start), {
      kind: b.kind,
      order: orderKeyOf(b.start),
      minutes,
      title: b.kind === "travel" ? "Travel" : (task?.title || "Task"),
      time: b.start.length > 10 ? `${formatTimeIso(b.start)}–${formatTimeIso(b.end)}` : "",
      atRisk: b.kind === "task" && atRiskTaskIds.has(b.task_id),
      recurring: Boolean(task?.recurrence_id),
    });
  });

  (data.commitments || []).forEach((c) => {
    // A commitment that runs over midnight is drawn on the day it starts and
    // measured to the end of that day's stack, the same way the week view
    // clips one at the bottom of its column rather than stretching it across.
    const minutes = Math.min(durationMinutes(c.start, c.end), 24 * 60);
    if (!(minutes > 0)) return;
    push(towerDateOf(c.start), {
      kind: "timetabled",
      order: orderKeyOf(c.start),
      minutes,
      title: c.meta?.module_name || c.title || "Event",
      time: `${formatTimeIso(c.start)}–${formatTimeIso(c.end)}`,
      excluded: c.counts_for_capacity === false,
    });
  });

  (data.recurrenceGhosts || []).forEach((g) => {
    const task = g.task_id ? data.tasksById[g.task_id] : null;
    let minutes = durationMinutes(g.start, g.end);
    if (!(minutes > 0)) minutes = task?.est_minutes || 0;
    if (!(minutes > 0)) return;
    push(towerDateOf(g.start), {
      kind: "ghost",
      order: orderKeyOf(g.start),
      minutes,
      title: task?.title || "Recurring task",
      time: "",
    });
  });

  // Stack it: chronological, then run a cumulative height up from the ground.
  // Excluded commitments and provisional repeats sit in the stack (they are
  // ON the day) but add no height, because they claim none of the user's time
  // -- the same reason the flat view draws them as set-out rather than inked.
  Object.values(stacks).forEach((items) => {
    items.sort((a, b) => a.order - b.order || b.minutes - a.minutes);
    let z = 0;
    items.forEach((item) => {
      const claims = !item.excluded && item.kind !== "ghost";
      item.z0 = z;
      item.z1 = z + item.minutes / 60;
      if (claims) z = item.z1;
    });
  });

  return stacks;
}

/* --- The prism -----------------------------------------------------------
 * A block is a box on its day's cell, between two heights. Only three of its
 * six faces can be seen: the top, and the two whose outward normals point at
 * the viewer -- the ones sharing the front corner (largest col + row). Drawn
 * as three closed subpaths of ONE path, so the fill covers the silhouette and
 * the stroke gives every visible edge, including the Y down the front corner,
 * at one element per block. */
function prismPath(project, col, row, z0, z1) {
  const a = col + FOOT_INSET;
  const b = col + 1 - FOOT_INSET;
  const c = row + FOOT_INSET;
  const d = row + 1 - FOOT_INSET;

  const top = [project(a, c, z1), project(b, c, z1), project(b, d, z1), project(a, d, z1)];
  // The col = b face is the right-hand one (larger col means larger x); the
  // row = d face is the left-hand one (larger row means smaller x).
  const right = [project(b, c, z1), project(b, d, z1), project(b, d, z0), project(b, c, z0)];
  const left = [project(a, d, z1), project(b, d, z1), project(b, d, z0), project(a, d, z0)];

  return `${polygon(top)}${polygon(right)}${polygon(left)}`;
}

/** The block's leading vertical edge: the front corner, stood on end. This is
 *  section 8's spine -- the heaviest line in the system on a task, doubled on
 *  something timetabled. */
function spineLine(project, col, row, z0, z1) {
  const b = col + 1 - FOOT_INSET;
  const d = row + 1 - FOOT_INSET;
  return line(project(b, d, z0), project(b, d, z1));
}

/* ========================================================================
 * The sheet
 * ====================================================================== */

export function createAxonometric(host, options = {}) {
  const onOpenDay = options.onOpenDay || (() => {});

  host.classList.add("dr-axo-sheet");
  host.innerHTML = `
    <div class="dr-axo-upper"></div>
    <div class="dr-axo-lower">
      <div class="dr-axo-margin dr-axo-margin--left"></div>
      <div class="dr-axo-plan"></div>
      <div class="dr-axo-margin dr-axo-margin--right"></div>
    </div>
  `;

  const upperEl = host.querySelector(".dr-axo-upper");
  const planEl = host.querySelector(".dr-axo-plan");
  const leftMarginEl = host.querySelector(".dr-axo-margin--left");
  const rightMarginEl = host.querySelector(".dr-axo-margin--right");

  // Kept between draws only so hover can move the leader without rebuilding.
  let identified = null;
  let leaderPath = null;
  let leaderText = null;
  let leaderTime = null;
  let calloutWidth = 0;

  /** Where the drawing puts things. Derived once per draw from the measure in
   *  drafting.css and the container's own width -- the cell shrinks to fit a
   *  narrow window rather than the sheet scrolling sideways. */
  function layout(rows, towers, maxTowerHours) {
    const cellMax = cssPx(host, "--dr-axo-cell", 92);
    const unitH = cssPx(host, "--dr-axo-unit", 17);
    const margin = cssPx(host, "--dr-axo-margin", 104);
    const overrun = cssPx(host, "--dr-overrun", 18);

    const sheetW = Math.max(560, host.clientWidth || 900);
    // The base plane spans (7 + rows) column-widths across in projection: from
    // its left corner at col 0, row `rows` to its right corner at col 7, row 0.
    const spanCols = 7 + rows;
    const cellW = Math.min(cellMax, (sheetW - 2 * margin) / (spanCols * COS30));
    const cellH = cellW; // true isometric: one square grid, two equal axes

    const drawingW = spanCols * COS30 * cellW;
    // x = 0 at (col 0, row 0); the leftmost point of the plane is at col 0,
    // row `rows`, which is -rows column-widths from it.
    const originX = (sheetW - drawingW) / 2 + rows * COS30 * cellW;

    // Where the drawing actually reaches, rather than where it could. A tower
    // near the front of the plane starts much further down the sheet than one
    // at the back, so padding the top by the tallest tower in the month leaves
    // a hand's width of blank paper above the drawing on almost every month.
    // Measured instead: the highest point anything reaches, the risers'
    // overrun included, and the vertical scale, which is struck from the
    // plane's left corner and can out-reach every tower on a quiet month.
    const scaleHours = Math.max(Math.ceil(maxTowerHours), MIN_SCALE_HOURS);
    let minY = rows * SIN30 * cellH - scaleHours * unitH - 12;
    towers.forEach(({ col, row, hours }) => {
      minY = Math.min(minY, (col + row) * SIN30 * cellH - hours * unitH - overrun);
    });
    const originY = 20 - minY;

    const planeBottom = originY + spanCols * SIN30 * cellH;
    // Room under the plane for the weekday scale lettered along its front edge.
    const divideY = planeBottom + 58;
    const svgH = divideY + 34;

    const planW = 7 * COS30 * cellW;

    return {
      cellW, cellH, unitH, margin, overrun, sheetW, svgH,
      originX, originY, rows, divideY, planW,
      planLeft: (sheetW - planW) / 2,
    };
  }

  /* --- The construction layer, drawn once for the whole sheet -------------
   * The base grid ruled across the plane and overrunning it, the vertical
   * axis carried up out of every cell, the compass circles struck whole from
   * each deadline, and the rays that tie the plane to the plan below. Four
   * paths and one ellipse per deadline, whatever the month holds.
   *
   * Every one of these is texture. Nothing that has to be read at 8am is in
   * here, and the group carries `.dr-construction` so `.dr-no-construction`
   * removes it outright. */
  function drawConstruction(root, g, project, model, dates, cellOf, maxTowerHours) {
    const layer = svg("g", { class: "dr-axo-construction dr-construction", "aria-hidden": "true" });

    // 1. The plane, set out. Ruled whole in both directions and overrunning
    //    at both ends -- the overrun is what makes a pencil line read as
    //    setting-out rather than as a second, sloppier object line.
    const over = g.overrun / (COS30 * g.cellW); // the overrun, in cell units along an axis
    const setOut = [];
    for (let col = 0; col <= 7; col++) {
      setOut.push(line(project(col, -over), project(col, g.rows + over)));
    }
    for (let row = 0; row <= g.rows; row++) {
      setOut.push(line(project(-over, row), project(7 + over, row)));
    }
    layer.appendChild(svg("path", { class: "dr-axo-setout", d: setOut.join("") }));

    // 2. The vertical axis, carried up out of the plane. One ray at each cell's
    //    three visible corners, running past the top of whatever stands there
    //    -- the part that shows above a tower is the part that reads as
    //    projection, so the run is measured from the tower, not from the grid.
    const risers = [];
    dates.forEach((dateStr) => {
      const cell = cellOf(dateStr);
      if (!cell) return;
      const topZ = (model.towerHours[dateStr] || 0) + g.overrun / g.unitH;
      const a = cell.col + FOOT_INSET;
      const b = cell.col + 1 - FOOT_INSET;
      const c = cell.row + FOOT_INSET;
      const d = cell.row + 1 - FOOT_INSET;
      [[b, d], [b, c], [a, d]].forEach(([cc, rr]) => {
        risers.push(line(project(cc, rr, 0), project(cc, rr, topZ)));
      });
    });
    layer.appendChild(svg("path", { class: "dr-axo-ray", d: risers.join("") }));

    // 2b. The scale's divisions, carried across. The plane's two back edges
    //     lifted to each major division of the vertical scale, overrunning at
    //     both ends: the levels a section is set out in. This is what ties the
    //     rule at the left to the towers it measures -- without it the scale
    //     is a ruler standing beside a model rather than part of the drawing.
    const levels = [];
    for (let h = 2; h <= Math.max(Math.ceil(maxTowerHours), MIN_SCALE_HOURS); h += 2) {
      levels.push(line(project(0, -over, h), project(0, g.rows + over, h)));
      levels.push(line(project(-over, 0, h), project(7 + over, 0, h)));
    }
    layer.appendChild(svg("path", { class: "dr-axo-setout", d: levels.join("") }));

    // 3. A deadline, struck. A circle on the base plane projects to an ellipse
    //    with semi-axes r*sqrt(2)*cos30*cellW and r*sqrt(2)*sin30*cellH --
    //    substitute (r cos t, r sin t) into the projection and the cross terms
    //    collapse to a single phase shift, so it is axis-aligned and exact.
    //    Struck WHOLE, with the centre marked and the radius drawn: an arc is
    //    only the part of a circle that got inked.
    const radii = [];
    Object.entries(model.deadlinesByDate).forEach(([dateStr, entries]) => {
      const cell = cellOf(dateStr);
      if (!cell) return;
      const centre = project(cell.col + 0.5, cell.row + 0.5, 0);
      const importance = Math.max(...entries.map((e) => e.importance));
      // The heavier hand-in casts the longer shadow back over its run-up --
      // the same scale rule the flat view's arcs use.
      const scale = 0.7 + importance * 0.12;
      [0.85, 1.5, 2.3].forEach((r) => {
        const rr = r * scale;
        layer.appendChild(svg("ellipse", {
          class: "dr-axo-arc",
          cx: round(centre.x),
          cy: round(centre.y),
          rx: round(rr * Math.SQRT2 * COS30 * g.cellW),
          ry: round(rr * Math.SQRT2 * SIN30 * g.cellH),
        }));
      });
      // The radius that struck the outermost one, back into the run-up weeks.
      const rOut = 2.3 * scale;
      radii.push(line(centre, project(cell.col + 0.5 - rOut * 0.86, cell.row + 0.5 - rOut * 0.5, 0)));
    });
    if (radii.length) layer.appendChild(svg("path", { class: "dr-axo-setout", d: radii.join("") }));

    // 4. The rays down to the plan. The plane's front edge (row = rows) has
    //    its column vertices spaced by exactly one column-width in x, and the
    //    plan below is sized to the same pitch -- so these eight rays land on
    //    its eight column edges and the two halves are demonstrably the same
    //    month rather than merely stacked. They cross the dividing rule and
    //    carry on, as the reference's do.
    const ties = [];
    for (let col = 0; col <= 7; col++) {
      const from = project(col, g.rows, 0);
      ties.push(line(from, { x: g.planLeft + col * COS30 * g.cellW, y: g.svgH }));
    }
    layer.appendChild(svg("path", { class: "dr-axo-ray", d: ties.join("") }));

    root.appendChild(layer);
  }

  /* --- The setting-out that crosses the drawing ---------------------------
   * The two axes through each deadline, run right across the plane and past
   * it -- section 15's flat view rules across the deadline's week and down its
   * column, and this is that same statement on the two axes the plane
   * actually has.
   *
   * Drawn IN FRONT of the towers, which is the one place on the sheet the
   * setting-out is allowed to be. It is also the single thing that stops this
   * reading as a model rendered onto paper: in the reference every projection
   * ray crosses the object, because the sheet is one layer of graphite and
   * nobody rubbed the construction out where the drawing landed on it. Same
   * ink, same weight, same `.dr-construction` group -- so the ratio that
   * matters is unchanged and the switch still takes all of it off. */
  function drawCrossing(root, g, project, model, cellOf) {
    const over = g.overrun / (COS30 * g.cellW);
    const rays = [];
    Object.keys(model.deadlinesByDate).forEach((dateStr) => {
      const cell = cellOf(dateStr);
      if (!cell) return;
      const cc = cell.col + 0.5;
      const rr = cell.row + 0.5;
      rays.push(line(project(-over, rr), project(7 + over, rr)));
      rays.push(line(project(cc, -over), project(cc, g.rows + over)));
    });
    if (!rays.length) return;
    const layer = svg("g", { class: "dr-axo-construction dr-construction", "aria-hidden": "true" });
    layer.appendChild(svg("path", { class: "dr-axo-setout", d: rays.join("") }));
    root.appendChild(layer);
  }

  /* --- The measured vertical scale ---------------------------------------
   * Section 5's hour axis, stood up and struck from the plane's left corner,
   * which is where the vertical axis actually begins. Without it "tall" is a
   * feeling; with it, it is four hours. */
  function drawScale(root, g, project, maxTowerHours) {
    const foot = project(0, g.rows, 0);
    const hours = Math.max(Math.ceil(maxTowerHours), MIN_SCALE_HOURS);
    const x = round(foot.x - 26);
    const layer = svg("g", { class: "dr-axo-scale-group", "aria-hidden": "true" });

    layer.appendChild(svg("path", {
      class: "dr-axo-scale",
      // The rule, plus a foot across to the plane's left corner -- without it
      // the scale floats beside the drawing instead of standing on the point
      // it is struck from.
      d: `M${x},${round(foot.y)}L${x},${round(foot.y - hours * g.unitH)}`
        + `M${x},${round(foot.y)}L${round(foot.x)},${round(foot.y)}`,
    }));

    const ticks = [];
    const minor = [];
    for (let h = 0; h <= hours; h++) {
      const y = round(foot.y - h * g.unitH);
      (h % 2 === 0 ? ticks : minor).push(`M${x},${y}L${x + (h % 2 === 0 ? 9 : 5)},${y}`);
      if (h % 2 === 0) {
        const t = svg("text", {
          class: h % 4 === 0 ? "dr-axo-figure dr-axo-figure--major" : "dr-axo-figure",
          x: x - 4,
          y: y + 3,
          "text-anchor": "end",
        });
        t.textContent = String(h);
        layer.appendChild(t);
      }
    }
    layer.appendChild(svg("path", { class: "dr-axo-scale", d: ticks.join("") }));
    layer.appendChild(svg("path", { class: "dr-axo-scale-minor", d: minor.join("") }));

    const label = svg("text", {
      class: "dr-axo-micro",
      x: x - 4,
      y: round(foot.y - hours * g.unitH - 9),
      "text-anchor": "end",
    });
    label.textContent = "Hours";
    layer.appendChild(label);
    root.appendChild(layer);
  }

  /* --- The month's totals, as marginal figures ---------------------------
   * Lettered down the right margin against short leader rules, the way a
   * sheet carries its quantities -- not a panel, not a card, and nothing that
   * needs a background to be read. */
  function drawTotals(root, g, totals) {
    const layer = svg("g", { class: "dr-axo-totals", "aria-hidden": "true" });
    const x = round(g.sheetW - 14);
    let y = 26;
    totals.forEach(([value, label]) => {
      const rule = svg("path", {
        class: "dr-axo-scale-minor",
        d: `M${round(x - 62)},${y - 15}L${x},${y - 15}`,
      });
      layer.appendChild(rule);
      const v = svg("text", { class: "dr-axo-total", x, y, "text-anchor": "end" });
      v.textContent = value;
      layer.appendChild(v);
      const l = svg("text", { class: "dr-axo-micro", x, y: y + 12, "text-anchor": "end" });
      l.textContent = label;
      layer.appendChild(l);
      y += 52;
    });
    root.appendChild(layer);
  }

  /* --- The drawing ------------------------------------------------------- */

  function drawSheet(payload) {
    const { dates, rows, model, data, deliverableIndex, todayStr, inMonth } = payload;
    const atRiskTaskIds = new Set(
      (data.schedule.at_risk || []).map((e) => e.task_id).filter(Boolean),
    );
    const stacks = buildStacks(dates, data, atRiskTaskIds);

    // Where each date sits on the plane, and how tall it stands.
    const cells = new Map();
    const towerHours = {};
    dates.forEach((dateStr, i) => {
      cells.set(dateStr, { col: i % 7, row: Math.floor(i / 7) });
      const items = stacks[dateStr];
      towerHours[dateStr] = items.length ? Math.max(...items.map((it) => it.z1)) : 0;
    });
    const cellOf = (dateStr) => cells.get(dateStr) || null;
    const maxTowerHours = Math.max(0, ...Object.values(towerHours));

    const g = layout(rows, dates.map((d) => ({ ...cells.get(d), hours: towerHours[d] })),
      maxTowerHours);
    const project = makeProjection(g);

    const root = svg("svg", {
      class: "dr-axo",
      width: g.sheetW,
      height: g.svgH,
      viewBox: `0 0 ${g.sheetW} ${g.svgH}`,
      role: "img",
      "aria-label": "The month drawn in axonometric projection: each day's work stacked as a tower.",
    });

    // The one paint server the sheet needs. Section 19's comment explains why
    // it restates hatch B rather than reusing --dr-hatch-b.
    const defs = svg("defs");
    const hatch = svg("pattern", {
      id: "dr-axo-hatch-b",
      width: 4, height: 4,
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(-45)",
    });
    hatch.appendChild(svg("path", { class: "dr-axo-hatch-line", d: "M0.5,0L0.5,4" }));
    defs.appendChild(hatch);
    root.appendChild(defs);

    drawConstruction(root, g, project, { ...model, towerHours }, dates, cellOf, maxTowerHours);
    drawScale(root, g, project, maxTowerHours);

    // --- the days, back to front ------------------------------------------
    // The whole hidden-surface algorithm: in this projection a cell's distance
    // from the viewer IS row + col, so painting in that order is correct and
    // complete. Within a day the stack is drawn bottom up, which is the order
    // it happens in -- and the order a tower is actually built.
    const daysLayer = svg("g", { class: "dr-axo-days" });
    const ordered = [...dates].sort((a, b) => {
      const ca = cellOf(a);
      const cb = cellOf(b);
      return (ca.row + ca.col) - (cb.row + cb.col);
    });

    ordered.forEach((dateStr) => {
      daysLayer.appendChild(drawDay(dateStr, cellOf(dateStr), project, {
        stacks, model, todayStr, inMonth,
      }));
    });
    root.appendChild(daysLayer);

    drawCrossing(root, g, project, model, cellOf);

    // --- annotation, over everything ---------------------------------------
    const annotation = svg("g", { class: "dr-axo-annotation" });
    drawEdgeScales(annotation, g, project, dates);
    drawDeadlineKeys(annotation, project, model, deliverableIndex, towerHours, cellOf, g);
    root.appendChild(annotation);

    // The hover callout, built once and moved, never rebuilt -- so identifying
    // a block costs one class change and three attributes.
    const callout = svg("g", { class: "dr-axo-callout", "aria-hidden": "true" });
    leaderPath = svg("path", { class: "dr-axo-leader", d: "", visibility: "hidden" });
    leaderText = svg("text", { class: "dr-axo-body", visibility: "hidden" });
    leaderTime = svg("text", { class: "dr-axo-micro", visibility: "hidden" });
    callout.append(leaderPath, leaderText, leaderTime);
    root.appendChild(callout);
    calloutWidth = g.sheetW;

    drawTotals(root, g, monthTotals(dates, stacks, model, inMonth));

    // The dividing rule: one structural line across the whole sheet, which the
    // setting-out crosses. Last, so it sits over the rays rather than under.
    root.appendChild(svg("path", {
      class: "dr-axo-divide",
      d: `M0,${round(g.divideY)}L${g.sheetW},${round(g.divideY)}`,
    }));

    upperEl.replaceChildren(root);
    return { geometry: g, stacks };
  }

  /** One day: its cell on the plane, whatever stands on it, and the marks the
   *  plane itself carries. One group, so the click target is the whole day and
   *  the painter's order above has one thing to sort. */
  function drawDay(dateStr, cell, project, ctx) {
    const { stacks, model, todayStr, inMonth } = ctx;
    const group = svg("g", { class: "dr-axo-day", "data-date": dateStr });
    const outside = dateStr.slice(0, 7) !== inMonth;

    const corners = [
      project(cell.col, cell.row), project(cell.col + 1, cell.row),
      project(cell.col + 1, cell.row + 1), project(cell.col, cell.row + 1),
    ];
    let groundClass = "dr-axo-ground";
    const buffer = model.bufferByDate[dateStr];
    if (outside) groundClass += " dr-axo-ground--outside";
    else if (buffer) groundClass += " dr-axo-ground--buffer";
    if (model.atRiskDates.has(dateStr) && !outside) groundClass += " dr-axo-ground--at-risk";
    if (dateStr === todayStr) groundClass += " dr-axo-ground--today";
    group.appendChild(svg("path", { class: groundClass, d: polygon(corners) }));

    // A deadline's point: the centre of the circle struck round it, marked
    // with the cross that says a point was constructed. Information, so it is
    // red and stays whatever the construction layer is doing.
    if ((model.deadlinesByDate[dateStr] || []).length) {
      const c = project(cell.col + 0.5, cell.row + 0.5);
      group.appendChild(svg("path", {
        class: "dr-axo-point",
        d: `M${round(c.x - 6)},${round(c.y)}L${round(c.x + 6)},${round(c.y)}`
          + `M${round(c.x)},${round(c.y - 4)}L${round(c.x)},${round(c.y + 4)}`,
      }));
    }

    stacks[dateStr].forEach((item, i) => {
      if (item.kind === "travel") {
        drawTravel(group, project, cell, item);
        return;
      }
      const faceClass = ["dr-axo-face"];
      if (item.kind === "ghost") faceClass.push("dr-axo-face--ghost");
      else if (item.kind === "timetabled") {
        faceClass.push(item.excluded ? "dr-axo-face--excluded" : "dr-axo-face--timetabled");
      }
      if (item.atRisk) faceClass.push("dr-axo-face--at-risk");

      const face = svg("path", {
        class: faceClass.join(" "),
        d: prismPath(project, cell.col, cell.row, item.z0, item.z1),
        "data-block": String(i),
      });
      group.appendChild(face);

      // The leading edge. A provisional or excluded block has none: it is set
      // out rather than inked, and a structural line would contradict that.
      if (item.kind === "ghost" || item.excluded) return;
      if (item.minutes < SPINE_MIN_MINUTES) return;
      const d = spineLine(project, cell.col, cell.row, item.z0, item.z1);
      const spineClass = ["dr-axo-spine"];
      if (item.kind === "timetabled") spineClass.push("dr-axo-spine--double");
      if (item.atRisk) spineClass.push("dr-axo-spine--at-risk");
      group.appendChild(svg("path", { class: spineClass.join(" "), d }));
      // Doubled, three pixels apart: `3px double` on the flat, in projection.
      if (item.kind === "timetabled") {
        group.appendChild(svg("path", {
          class: spineClass.join(" "),
          d,
          transform: "translate(-3.5 0)",
        }));
      }
    });

    return group;
  }

  /** Travel: the line between two things. A dashed riser through the height it
   *  takes, with the arrowhead where it arrives -- section 9's leader, turned
   *  up the vertical axis. Nothing is boxed. */
  function drawTravel(group, project, cell, item) {
    // Just OUTSIDE the footprint, not on it. On the front corner it lands
    // exactly under the spines of the blocks either side of it and is lost in
    // their run; beside the stack it reads as what it is -- the line between
    // two things, which is where the flat view puts its leader too.
    const b = cell.col + 1.07;
    const d = cell.row + 1.07;
    const from = project(b, d, item.z0);
    const to = project(b, d, item.z1);
    group.appendChild(svg("path", { class: "dr-axo-travel", d: line(from, to) }));
    group.appendChild(svg("path", {
      class: "dr-axo-travel-head",
      d: `M${round(to.x)},${round(to.y)}L${round(to.x - 3.5)},${round(to.y + 5)}`
        + `L${round(to.x + 3.5)},${round(to.y + 5)}Z`,
    }));
  }

  function firstDeliverableIndex(entries, deliverableIndex) {
    if (!entries) return null;
    const withId = entries.find((e) => e.deliverableId && deliverableIndex.has(e.deliverableId));
    return withId ? deliverableIndex.get(withId.deliverableId) : null;
  }

  /** The deliverable's key number, lettered clear of its tower with a leader
   *  down to the point on the plane. The circle and the cross can both be
   *  covered by a tall day; the number never is, so a hand-in is legible
   *  whatever is standing on it. */
  function drawDeadlineKeys(layer, project, model, deliverableIndex, towerHours, cellOf, g) {
    Object.entries(model.deadlinesByDate).forEach(([dateStr, entries]) => {
      const cell = cellOf(dateStr);
      if (!cell) return;
      const idx = firstDeliverableIndex(entries, deliverableIndex);
      if (!idx) return;
      const foot = project(cell.col + 0.5, cell.row + 0.5, 0);
      const head = project(cell.col + 0.5, cell.row + 0.5, (towerHours[dateStr] || 0) + g.overrun / g.unitH);
      layer.appendChild(svg("path", { class: "dr-axo-leader", d: line(foot, head) }));
      const t = svg("text", {
        class: "dr-axo-deadline-num",
        x: round(head.x), y: round(head.y - 4),
        "text-anchor": "middle",
      });
      t.textContent = String(idx).padStart(2, "0");
      layer.appendChild(t);
    });
  }

  /* --- The two edge scales -----------------------------------------------
   * A cell carries NO lettering, and that is deliberate: a tower stands on
   * every cell that has anything to say, so a date written there is either
   * hidden or written over the drawing. Both scales are therefore set out
   * along the edges of the plane, where a drawing puts its dimensions --
   * weekdays down one axis, the week's first date down the other -- and each
   * lies ALONG its own axis, because a label on an axonometric belongs to a
   * direction and rotating it to that direction is what says which.
   *
   * Which tower is the 17th is then a question for the plan below, which is
   * on the same sheet, aligned to the same columns, and carries every date.
   * That is a large part of why the two halves are one drawing. */
  function drawEdgeScales(layer, g, project, dates) {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    names.forEach((name, col) => {
      const p = project(col + 0.5, g.rows + 0.42);
      const t = svg("text", {
        class: "dr-axo-micro",
        x: round(p.x), y: round(p.y),
        "text-anchor": "middle",
        transform: `rotate(30 ${round(p.x)} ${round(p.y)})`,
      });
      t.textContent = name;
      layer.appendChild(t);
    });

    const fmt = (d) => new Date(`${d}T00:00:00`)
      .toLocaleDateString(undefined, { day: "numeric", month: "short" });
    for (let row = 0; row < g.rows; row++) {
      const p = project(7.5, row + 0.5);
      const t = svg("text", {
        class: "dr-axo-micro",
        x: round(p.x), y: round(p.y),
        "text-anchor": "start",
        transform: `rotate(-30 ${round(p.x)} ${round(p.y)})`,
      });
      t.textContent = fmt(dates[row * 7]);
      layer.appendChild(t);
    }
  }

  /** The month, in four figures. Quantities, not a dashboard: each is one
   *  number the drawing above cannot state precisely. */
  function monthTotals(dates, stacks, model, inMonth) {
    let minutes = 0;
    let busiest = { date: null, hours: 0 };
    let clear = 0;
    dates.forEach((dateStr) => {
      if (dateStr.slice(0, 7) !== inMonth) return;
      const items = stacks[dateStr].filter((it) => !it.excluded && it.kind !== "ghost");
      const dayMinutes = items.reduce((sum, it) => sum + it.minutes, 0);
      minutes += dayMinutes;
      if (dayMinutes / 60 > busiest.hours) busiest = { date: dateStr, hours: dayMinutes / 60 };
      if (!dayMinutes) clear += 1;
    });
    const deadlines = Object.keys(model.deadlinesByDate)
      .filter((d) => d.slice(0, 7) === inMonth).length;
    return [
      [formatHours(minutes), "Hours committed"],
      [String(deadlines), deadlines === 1 ? "Deadline" : "Deadlines"],
      [busiest.date ? String(new Date(`${busiest.date}T00:00:00`).getDate()) : "—", "Heaviest day"],
      [String(clear), "Days clear"],
    ];
  }

  /* --- The marginal studies ----------------------------------------------
   * Clustered in the gutters either side of the plan, the way the reference
   * clusters its details round the edges of the sheet: a legend of the marks
   * on the left, the numbered key of what is due on the right. Small drawings
   * with captions, on the same paper -- not a panel bolted to a chart. */
  function drawLegend() {
    const marks = [
      ["task", "Task", "A block in the day's stack, at its place in the day"],
      ["timetabled", "Timetabled", "A given: lighter lines, doubled leading edge"],
      ["travel", "Travel", "The line between two things, not a thing"],
      ["deadline", "Deadline", "A circle struck on the plane, its centre marked"],
    ];
    leftMarginEl.innerHTML = "";
    const study = document.createElement("div");
    study.className = "dr-axo-study";
    const cap = document.createElement("span");
    cap.className = "dr-micro";
    cap.textContent = "Marks";
    study.appendChild(cap);

    marks.forEach(([kind, term, value]) => {
      const row = document.createElement("div");
      row.className = "dr-axo-study-row";
      row.appendChild(miniStudy(kind));
      const text = document.createElement("span");
      text.className = "dr-key-term";
      text.textContent = term;
      text.title = value;
      row.appendChild(text);
      study.appendChild(row);
    });
    leftMarginEl.appendChild(study);

    // The sheet's scale, stated the way a title block states one. Its own
    // class rather than .dr-key-term, which is `nowrap` -- a term in a key is
    // one word and must not break, but a sentence in a margin must.
    const note = document.createElement("div");
    note.className = "dr-axo-study";
    const noteCap = document.createElement("span");
    noteCap.className = "dr-micro";
    noteCap.textContent = "Scale";
    const noteBody = document.createElement("span");
    noteBody.className = "dr-axo-note";
    noteBody.textContent = "Height is load — one hour of work to one unit up the vertical axis.";
    note.append(noteCap, noteBody);
    leftMarginEl.appendChild(note);
  }

  /** One of the reference's little edge studies: the same prism, the same
   *  projection, at a size that fits in a margin. Drawn through `project()`
   *  like everything else, so a legend can never drift from the drawing. */
  function miniStudy(kind) {
    const w = 40;
    const h = 30;
    const el = svg("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}`, "aria-hidden": "true" });
    const mini = makeProjection({ cellW: 15, cellH: 15, unitH: 13, originX: 20, originY: 12 });

    if (kind === "deadline") {
      el.appendChild(svg("ellipse", {
        class: "dr-axo-arc", cx: 20, cy: 15,
        rx: round(0.62 * Math.SQRT2 * COS30 * 15), ry: round(0.62 * Math.SQRT2 * SIN30 * 15),
      }));
      el.appendChild(svg("path", { class: "dr-axo-point", d: "M14,15L26,15M20,11L20,19" }));
      return el;
    }

    el.appendChild(svg("path", { class: "dr-axo-ground", d: polygon([
      mini(0, 0), mini(1, 0), mini(1, 1), mini(0, 1),
    ]) }));

    if (kind === "travel") {
      const from = mini(1 - FOOT_INSET, 1 - FOOT_INSET, 0);
      const to = mini(1 - FOOT_INSET, 1 - FOOT_INSET, 0.85);
      el.appendChild(svg("path", { class: "dr-axo-travel", d: line(from, to) }));
      el.appendChild(svg("path", {
        class: "dr-axo-travel-head",
        d: `M${round(to.x)},${round(to.y)}L${round(to.x - 3.5)},${round(to.y + 5)}`
          + `L${round(to.x + 3.5)},${round(to.y + 5)}Z`,
      }));
      return el;
    }

    const timetabled = kind === "timetabled";
    el.appendChild(svg("path", {
      class: timetabled ? "dr-axo-face dr-axo-face--timetabled" : "dr-axo-face",
      d: prismPath(mini, 0, 0, 0, 0.62),
    }));
    const d = spineLine(mini, 0, 0, 0, 0.62);
    el.appendChild(svg("path", {
      class: timetabled ? "dr-axo-spine dr-axo-spine--double" : "dr-axo-spine", d,
    }));
    if (timetabled) {
      el.appendChild(svg("path", {
        class: "dr-axo-spine dr-axo-spine--double", d, transform: "translate(-3.5 0)",
      }));
    }
    return el;
  }

  /** The numbered key, in the right-hand gutter. The same idiom the plan view
   *  puts under its grid -- a number, a term, a leader, a value. */
  function drawKey(deliverableIndex, data) {
    rightMarginEl.innerHTML = "";
    if (!deliverableIndex.size) return;
    const study = document.createElement("div");
    study.className = "dr-axo-study";
    const cap = document.createElement("span");
    cap.className = "dr-micro";
    cap.textContent = "Due in view";
    study.appendChild(cap);

    [...deliverableIndex.entries()].forEach(([id, idx]) => {
      const row = document.createElement("div");
      row.className = "dr-key-row";
      row.innerHTML = `
        <span class="dr-key-num"></span>
        <span class="dr-key-term">Deliverable</span>
        <span class="dr-key-leader"></span>
        <span class="dr-key-value dr-key-value--wide"></span>`;
      row.querySelector(".dr-key-num").textContent = String(idx).padStart(2, "0");
      row.querySelector(".dr-key-value").textContent =
        data.deliverablesById[id]?.title || "Untitled";
      study.appendChild(row);
    });
    rightMarginEl.appendChild(study);
  }

  /* --- Interaction: minimal, deliberately --------------------------------
   * Hover identifies; a click on a day opens it. No dragging, no editing, no
   * rotation -- each of those would cost the drawing more than it returned,
   * and the projection living in one function means adding orientation later
   * is an afternoon rather than a rewrite.
   *
   * Both are delegated to the sheet, so four hundred blocks carry no
   * listeners between them. */
  let hoverState = null;

  function onPointerOver(e) {
    const face = e.target.closest?.(".dr-axo-face");
    const day = e.target.closest?.(".dr-axo-day");
    if (!face || !day || !hoverState) return clearIdentify();
    const item = hoverState.stacks[day.dataset.date]?.[Number(face.dataset.block)];
    if (!item) return clearIdentify();
    identify(face, item);
  }

  function identify(face, item) {
    if (identified === face) return;
    clearIdentify();
    identified = face;
    face.classList.add("is-identified");

    // A leader out to the nearer margin, with the lettering on it -- a callout,
    // which is what a drawing does instead of a tooltip. A tooltip is gone the
    // moment you look away from it; a callout is part of the drawing. It runs
    // to whichever edge is nearer so it never has to cross the whole sheet,
    // and so it never lies across the vertical scale.
    const box = face.getBBox();
    const y = Math.round(box.y + box.height / 2);
    const left = box.x + box.width / 2 < calloutWidth / 2;
    const edge = left ? 12 : calloutWidth - 12;
    const from = left ? box.x : box.x + box.width;
    leaderPath.setAttribute("d", `M${round(from)},${y}L${left ? edge + 4 : edge - 4},${y}`);
    [leaderText, leaderTime].forEach((el) => {
      el.setAttribute("x", edge);
      el.setAttribute("text-anchor", left ? "start" : "end");
    });
    leaderText.setAttribute("y", y - 5);
    leaderText.textContent = item.title;
    leaderTime.setAttribute("y", y + 9);
    leaderTime.textContent = item.time || `${formatHours(item.minutes)} h`;
    [leaderPath, leaderText, leaderTime].forEach((el) => el.setAttribute("visibility", "visible"));
  }

  function clearIdentify() {
    if (identified) identified.classList.remove("is-identified");
    identified = null;
    if (!leaderPath) return;
    [leaderPath, leaderText, leaderTime].forEach((el) => el.setAttribute("visibility", "hidden"));
  }

  function onClick(e) {
    const day = e.target.closest?.(".dr-axo-day");
    if (day) onOpenDay(day.dataset.date);
  }

  upperEl.addEventListener("pointerover", onPointerOver);
  upperEl.addEventListener("pointerleave", clearIdentify);
  upperEl.addEventListener("click", onClick);

  return {
    /** Draw the sheet. `payload` is month.js's own model plus the range it
     *  covers -- deriving it twice would be two chances to disagree about
     *  which days are at risk. Returns the plan's width so the caller can
     *  size the grid below to the base plane's own column pitch. */
    draw(payload) {
      clearIdentify();
      const { geometry, stacks } = drawSheet(payload);
      hoverState = { stacks };
      drawLegend();
      drawKey(payload.deliverableIndex, payload.data);
      return geometry;
    },
    /** Where the plan goes: the slot between the two margins, under the rays. */
    planSlot: planEl,
    destroy() {
      upperEl.removeEventListener("pointerover", onPointerOver);
      upperEl.removeEventListener("pointerleave", clearIdentify);
      upperEl.removeEventListener("click", onClick);
      host.innerHTML = "";
    },
  };
}
