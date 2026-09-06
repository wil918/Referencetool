/* Brief import: attach a brief PDF to a project, read it, review the proposal,
 * approve a filtered and edited subset into the schedule.
 *
 * briefs.py (server) does the reading and asks Claude for the structure; this
 * module is purely the review sheet. Nothing here writes a deliverable, task or
 * commitment -- POST /api/briefs/<id>/apply does, and only with the rows the
 * user left toggled on and whatever they edited.
 *
 * A misread brief that silently fills a schedule with wrong work is far worse
 * than one that proposes badly and is corrected in thirty seconds, so every
 * proposed item is opt-out: a toggle (on by default), inline editable fields,
 * discard = untoggle.
 *
 * Lives beside deliverables.js rather than inside it -- that file is already
 * long, and this is its own drawing. deliverables.js owns the button in the
 * toolbar and the "brief imported" banner; it calls initBriefImport once and
 * passes a getter for the selected project and a reload callback.
 */

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = "application/pdf";
fileInput.hidden = true;
document.body.appendChild(fileInput);

let overlay = null;
let box = null;

function ensureOverlay() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  box = document.createElement("div");
  box.className = "modal-box brief-review-box";
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay && !overlay.hidden) overlay.hidden = true;
  });
  document.body.appendChild(overlay);
}

// --- small builders -------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function field(labelText, control) {
  const wrap = el("label", "brief-field");
  wrap.append(el("span", null, labelText), control);
  return wrap;
}

function input(type, value) {
  const i = document.createElement("input");
  i.type = type;
  if (value != null && value !== "") i.value = value;
  return i;
}

function acceptToggle(checked = true) {
  const toggle = el("span", "dr-toggle brief-accept");
  const box_ = document.createElement("input");
  box_.type = "checkbox";
  box_.checked = checked;
  const drawn = el("span", "dr-toggle-box");
  toggle.append(box_, drawn);
  return { toggle, checkbox: box_ };
}

/** A reviewable row: an accept toggle down the left, an editable body on the
 *  right that dims when the row is toggled off. Returns { row, accepted(),
 *  body } -- body is where the caller hangs the fields. */
function reviewRow(accepted = true, flag = null) {
  const row = el("div", "brief-row");
  const { toggle, checkbox } = acceptToggle(accepted);
  const body = el("div", "brief-row-body");
  const sync = () => row.classList.toggle("is-off", !checkbox.checked);
  checkbox.addEventListener("change", sync);
  sync();
  row.append(toggle, body);
  if (flag) {
    const tag = el("span", "brief-flag dr-micro", flag);
    row.append(tag);
  }
  return { row, accepted: () => checkbox.checked, body };
}

// --- the three sections --------------------------------------------------

const DATE = (s) => (s && s.length >= 10 ? s.slice(0, 10) : "");

// Which deliverable, if any, a hand-in date is for -- by distinctive word
// overlap between the date's label/note and each deliverable title ("deliverable"
// itself carries no information, so it is ignored). Returns an index or -1; a
// wrong auto-tie is worse than none, so a tie is only offered on a clear win.
function bestDeliverableMatch(text, titles) {
  const words = (s) =>
    new Set(
      (s || "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && w !== "deliverable"),
    );
  const want = words(text);
  if (!want.size) return -1;
  let best = -1;
  let bestScore = 0;
  titles.forEach((t, i) => {
    const have = words(t);
    let score = 0;
    want.forEach((w) => {
      if (have.has(w)) score += 1;
    });
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

function keyDateRows(container, dates, deliverableTitles) {
  const built = [];
  (dates || []).forEach((k) => {
    const { row, accepted, body } = reviewRow();
    const label = input("text", k.label || "");
    label.placeholder = "e.g. Briefing";
    const date = input("date", DATE(k.date));
    const time = input("time", "09:00");

    // "Tie to a deliverable" -> the date sets that deliverable's due date
    // instead of becoming a calendar event. Blank = a plain commitment.
    const tie = document.createElement("select");
    tie.append(new Option("— its own calendar event —", ""));
    deliverableTitles.forEach((t, i) => tie.append(new Option(t || `Deliverable ${i + 1}`, String(i))));
    if (k.kind === "hand-in") {
      const match = bestDeliverableMatch(`${k.label} ${k.note || ""}`, deliverableTitles);
      if (match >= 0) tie.value = String(match);
    }
    const syncTie = () => { time.disabled = tie.value !== ""; };
    tie.addEventListener("change", syncTie);
    syncTie();

    const grid = el("div", "brief-field-grid");
    grid.append(
      field("Label", label),
      field("Date", date),
      field("Time", time),
      field("Treat as", tie),
    );
    if (k.note) body.append(el("p", "brief-note dr-body", k.note));
    body.append(grid);
    container.append(row);

    built.push(() => {
      if (!accepted() || !date.value) return null;
      // Always carry start/end so that if the tied deliverable is discarded the
      // approve handler can just drop attach_to and this falls back to a plain
      // calendar event. attach_to here is the EXTRACTION index -- the handler
      // remaps it to the submitted-list index (deliverables shift when some are
      // discarded).
      const when = `${date.value}T${time.value || "09:00"}:00`;
      const out = { label: label.value.trim() || "Brief date", kind: k.kind, start: when, end: when };
      if (tie.value !== "") out.attach_to = Number(tie.value);
      return out;
    });
  });
  return built;
}

function taskRows(container, tasks) {
  const built = [];
  (tasks || []).forEach((t) => {
    const { row, accepted, body } = reviewRow();
    row.classList.add("brief-subrow");
    const title = input("text", t.title || "");
    const est = input("number", t.est_minutes ?? "");
    est.min = "0";
    est.step = "5";
    est.placeholder = "min";
    const grid = el("div", "brief-field-grid brief-field-grid--task");
    grid.append(field("Task", title), field("Est. minutes", est));
    body.append(grid);
    if (t.note) body.append(el("p", "brief-note dr-body", t.note));
    container.append(row);
    built.push(() => {
      if (!accepted() || !title.value.trim()) return null;
      return {
        title: title.value.trim(),
        description: (t.note || "").trim() || null,
        est_minutes: est.value === "" ? null : Number(est.value),
      };
    });
  });
  return built;
}

// A brand-new deliverable: fully editable, opt-out, carries its task skeleton.
function newDeliverableRow(container, d, priorTitles) {
  const flag = d.title && !priorTitles.has(d.title.trim().toLowerCase()) && priorTitles.size
    ? "new since last import"
    : null;
  const { row, accepted, body } = reviewRow(true, flag);
  row.classList.add("brief-row--block");

  const title = input("text", d.title || "");
  const due = input("date", DATE(d.due_date));
  const weighting = input("number", d.weighting ?? "");
  weighting.min = "0";
  weighting.step = "any";
  weighting.placeholder = "40 or 0.4";
  const description = document.createElement("textarea");
  description.rows = 2;
  description.value = d.description || "";
  const spec = document.createElement("textarea");
  spec.rows = 5;
  spec.className = "brief-spec-json";
  spec.spellcheck = false;
  spec.value = d.spec != null ? JSON.stringify(d.spec, null, 2) : "";
  spec.placeholder = '{\n  "pages": 20,\n  "required_items": ["…"]\n}';

  const grid = el("div", "brief-field-grid");
  grid.append(field("Title", title), field("Due date", due), field("Weighting", weighting));
  body.append(grid, field("Notes", description), field("Spec (JSON, from the brief)", spec));

  let taskBuilders = [];
  if (d.tasks && d.tasks.length) {
    body.append(el("p", "dr-label brief-subhead", "Task skeleton"));
    taskBuilders = taskRows(body, d.tasks);
  }
  container.append(row);

  return () => {
    if (!accepted() || !title.value.trim()) return null;
    let parsedSpec = null;
    if (spec.value.trim()) {
      try {
        parsedSpec = JSON.parse(spec.value);
      } catch {
        parsedSpec = null; // an invalid hand-edit is dropped rather than blocking approval
      }
    }
    const w = weighting.value === "" ? null : Number(weighting.value);
    return {
      source_key: d.source_key || null,
      title: title.value.trim(),
      due_at: due.value || null,
      weighting: w,
      description: description.value.trim() || null,
      spec: parsedSpec,
      tasks: taskBuilders.map((b) => b()).filter(Boolean),
    };
  };
}

// A deliverable already in the schedule that the reissued brief did not change:
// listed for completeness, no action, resubmitted verbatim so it stays a live
// target for a key date's "tie to a deliverable" and its task breakdown is left
// alone.
function unchangedDeliverableRow(container, d) {
  const row = el("div", "brief-row brief-row--matched");
  row.append(el("span", "brief-flag dr-micro", "unchanged"));
  row.append(el("span", "brief-row-body dr-body", d.title || d.source_key));
  container.append(row);
  return () => ({
    source_key: d.source_key || null,
    title: (d.title || "").trim(),
    due_at: DATE(d.due_date) || null,
    weighting: d.weighting ?? null,
    description: d.description || null,
    spec: d.spec ?? null,
  });
}

const CHANGED_FIELD_LABELS = {
  title: "Title",
  due_at: "Due date",
  weighting: "Weighting",
  description: "Notes",
  spec: "Spec",
};

function showValue(v) {
  if (v == null || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).length > 10 ? String(v).slice(0, 10) : String(v);
}

// A matched deliverable whose reissued values differ. One accept toggle per
// field (old struck through, new beside it); an unaccepted field keeps its
// current value. No task skeleton -- the breakdown under this deliverable is
// the user's work now, and a re-import must not disturb it.
function changedDeliverableRow(container, d, change) {
  const row = el("div", "brief-row brief-row--block brief-row--matched");
  row.append(el("span", "brief-flag dr-micro", "changed"));
  const body = el("div", "brief-row-body");
  body.append(el("p", "dr-label brief-subhead", d.title || d.source_key));

  const acceptors = {};
  Object.entries(change.fields || {}).forEach(([f, [oldV, newV]]) => {
    const line = el("label", "brief-inline-check brief-change");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    const text = el("span", null,
      `${CHANGED_FIELD_LABELS[f] || f}: `);
    const was = el("span", "brief-change-old", showValue(oldV));
    const now = el("span", "brief-change-new", showValue(newV));
    text.append(was, document.createTextNode(" → "), now);
    line.append(cb, text);
    body.append(line);
    acceptors[f] = { cb, newV, oldV };
  });

  row.append(body);
  container.append(row);

  const currentExtracted = {
    title: (d.title || "").trim(),
    due_at: DATE(d.due_date) || null,
    weighting: d.weighting ?? null,
    description: d.description || null,
    spec: d.spec ?? null,
  };

  return () => {
    const out = { source_key: d.source_key || null, ...currentExtracted };
    // For a field with a proposed change, honour the toggle: accepted -> new,
    // rejected -> keep what is stored (the "old" side of the diff).
    Object.entries(acceptors).forEach(([f, { cb, newV, oldV }]) => {
      out[f] = cb.checked ? newV : oldV;
    });
    return out;
  };
}

// The "gone" group: a deliverable the reissued brief no longer mentions.
// Removal is opt-in (toggle starts off) -- nothing is deleted silently.
function goneRows(container, gone) {
  const built = [];
  (gone || []).forEach((g) => {
    const line = el("label", "brief-inline-check brief-gone");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    line.append(cb, el("span", null, `Remove "${g.title}" — no longer in the brief`));
    container.append(line);
    built.push(() => (cb.checked ? g.source_key : null));
  });
  return built;
}

function activityRows(container, activities, priorTitles) {
  const built = [];
  (activities || []).forEach((a) => {
    const flag = a.title && !priorTitles.has(a.title.trim().toLowerCase()) && priorTitles.size
      ? "new since last import"
      : null;
    const { row, accepted, body } = reviewRow(true, flag);
    const title = input("text", a.title || "");
    const note = document.createElement("textarea");
    note.rows = 2;
    note.value = a.note || "";
    const bound = document.createElement("input");
    bound.type = "checkbox";
    bound.checked = a.location_bound !== false;
    const boundLabel = el("label", "brief-inline-check");
    boundLabel.append(bound, el("span", null, "Happens at a specific place"));

    const grid = el("div", "brief-field-grid");
    grid.append(field("Activity", title));
    body.append(grid, field("Notes", note), boundLabel);
    container.append(row);

    built.push(() => {
      if (!accepted() || !title.value.trim()) return null;
      return {
        source_key: a.source_key || null,
        title: title.value.trim(),
        description: note.value.trim() || null,
        location_bound: bound.checked,
      };
    });
  });
  return built;
}

// --- the sheet ---------------------------------------------------------

function renderReview(brief, { projectId, onApplied, priorApplied, diff }) {
  ensureOverlay();
  overlay.hidden = false;
  box.innerHTML = "";

  diff = diff || { unchanged: [], changed: [], new: [], gone: [] };
  const changedByKey = new Map((diff.changed || []).map((c) => [c.source_key, c]));
  const unchangedKeys = new Set((diff.unchanged || []).map((c) => c.source_key));
  const isReimport =
    (diff.changed || []).length + (diff.unchanged || []).length + (diff.gone || []).length > 0;

  const extraction = (brief.extracted && brief.extracted.extraction) || {};
  const deliverableTitles = (extraction.deliverables || []).map((d) => d.title || "");
  const priorTitles = new Set(
    [
      ...((priorApplied && priorApplied.deliverables) || []),
      ...((priorApplied && priorApplied.tasks) || []),
    ].map((x) => (x.title || "").trim().toLowerCase()),
  );

  const head = el("div", "dr-titleblock");
  const headField = el("div", "dr-titleblock-field");
  headField.append(el("span", "dr-micro", "Reviewing brief"));
  headField.append(el("h3", "dr-title panel-title", "Nothing enters the schedule unapproved"));
  head.append(headField);
  const pdfLink = document.createElement("a");
  pdfLink.className = "btn";
  pdfLink.href = `/api/briefs/${brief.id}/file`;
  pdfLink.target = "_blank";
  pdfLink.rel = "noopener";
  pdfLink.textContent = "Original PDF";
  head.append(pdfLink);
  box.append(head);

  if (extraction.summary) box.append(el("p", "brief-summary dr-body", extraction.summary));

  const status = el("p", "muted brief-status");

  const sections = el("div", "brief-sections");

  const keyDatesWrap = el("div", "brief-section");
  keyDatesWrap.append(el("p", "dr-label", "Key dates"));
  const keyDatesList = el("div", "brief-list");
  keyDatesWrap.append(keyDatesList);
  const keyDateBuilders = keyDateRows(keyDatesList, extraction.key_dates, deliverableTitles);
  if (!keyDateBuilders.length) keyDatesWrap.append(el("p", "muted", "None found in the brief."));

  const deliverablesWrap = el("div", "brief-section");
  deliverablesWrap.append(el("p", "dr-label", "Deliverables"));
  const deliverablesList = el("div", "brief-list");
  deliverablesWrap.append(deliverablesList);
  if (isReimport) {
    deliverablesWrap.insertBefore(
      el("p", "muted brief-reimport-note",
        "Re-import: matched deliverables keep their tasks. Only what moved needs approving."),
      deliverablesList,
    );
  }

  // Builders aligned to extraction.deliverables order, so a key date's
  // attach_to (an extraction index) still maps cleanly to the submitted list.
  const deliverableBuilders = (extraction.deliverables || []).map((d) => {
    if (changedByKey.has(d.source_key)) {
      return changedDeliverableRow(deliverablesList, d, changedByKey.get(d.source_key));
    }
    if (unchangedKeys.has(d.source_key)) {
      return unchangedDeliverableRow(deliverablesList, d);
    }
    return newDeliverableRow(deliverablesList, d, priorTitles);
  });
  if (!deliverableBuilders.length) deliverablesWrap.append(el("p", "muted", "None found in the brief."));

  const goneBuilders = goneRows(deliverablesList, diff.gone);

  const activitiesWrap = el("div", "brief-section");
  activitiesWrap.append(el("p", "dr-label", "Mandatory activities"));
  const activitiesList = el("div", "brief-list");
  activitiesWrap.append(activitiesList);
  const activityBuilders = activityRows(activitiesList, extraction.mandatory_activities, priorTitles);
  if (!activityBuilders.length) activitiesWrap.append(el("p", "muted", "None found in the brief."));

  sections.append(keyDatesWrap, deliverablesWrap, activitiesWrap);
  box.append(sections, status);

  const actions = el("div", "modal-actions");
  const discard = el("button", "btn", "Discard");
  discard.addEventListener("click", () => { overlay.hidden = true; });

  const approve = el("button", "btn primary", "Approve selected");
  approve.addEventListener("click", async () => {
    approve.disabled = true;
    status.textContent = "Applying…";

    // Deliverables first: discarding some shifts the rest, so a key date's
    // attach_to (an extraction index) has to be remapped to its position in the
    // submitted list -- or dropped, if the deliverable it pointed at is gone.
    const submittedDeliverables = [];
    const indexMap = new Map();
    deliverableBuilders.forEach((build, extractionIdx) => {
      const d = build();
      if (d) {
        indexMap.set(extractionIdx, submittedDeliverables.length);
        submittedDeliverables.push(d);
      }
    });

    const keyDates = keyDateBuilders
      .map((b) => b())
      .filter(Boolean)
      .map((k) => {
        if (k.attach_to == null) return k;
        const mapped = indexMap.get(k.attach_to);
        if (mapped == null) {
          const { attach_to, ...rest } = k; // its deliverable was discarded -> plain event
          return rest;
        }
        return { ...k, attach_to: mapped };
      });

    const payload = {
      deliverables: submittedDeliverables,
      remove: goneBuilders.map((b) => b()).filter(Boolean),
      key_dates: keyDates,
      mandatory_activities: activityBuilders.map((b) => b()).filter(Boolean),
    };
    try {
      const res = await fetch(`/api/briefs/${brief.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        status.textContent = `Error: ${data.error || res.status}`;
        approve.disabled = false;
        return;
      }
      overlay.hidden = true;
      onApplied();
    } catch (err) {
      status.textContent = `Error: ${err}`;
      approve.disabled = false;
    }
  });

  actions.append(discard, approve);
  box.append(actions);
}

// --- public ----------------------------------------------------------

async function priorAppliedFor(brief) {
  // What the last /apply on this brief recorded -- the review sheet flags a
  // deliverable or task as "new since last import" against it. The brief row is
  // reused across re-imports, so this is simply the brief's own applied
  // envelope (kept through re-extraction by api_import_brief).
  return (brief.extracted && brief.extracted.applied) || null;
}

async function diffFor(briefId) {
  // The four-group comparison of the current extraction against the rows this
  // brief already created. Empty groups (a first import) -> plain review sheet.
  try {
    const d = await fetch(`/api/briefs/${briefId}/diff`).then((r) => r.json());
    return d && !d.error ? d : null;
  } catch {
    return null;
  }
}

/** Re-open the review sheet for a brief -- reached from the Deliverables tab's
 *  banner, so a half-finished review (or a re-import diff) doesn't cost a second
 *  extraction. */
export async function openBriefReview(briefId, { onApplied } = {}) {
  const brief = await fetch(`/api/briefs/${briefId}`).then((r) => r.json());
  if (!brief || brief.error) return;
  const [prior, diff] = await Promise.all([priorAppliedFor(brief), diffFor(brief.id)]);
  renderReview(brief, {
    projectId: brief.project_id,
    onApplied: onApplied || (() => {}),
    priorApplied: prior,
    diff,
  });
}

export function initBriefImport({ getProjectId, onApplied }) {
  const btn = document.getElementById("brief-import-btn");
  if (!btn) return { setEnabled() {}, review: openBriefReview };

  btn.addEventListener("click", () => {
    if (!getProjectId()) return;
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    const projectId = getProjectId();
    if (!file || !projectId) return;

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Reading the brief…";
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/briefs`, { method: "POST", body });
      const brief = await res.json();
      if (!res.ok) {
        alert(`Couldn't read that brief: ${brief.error || res.status}`);
        return;
      }
      const [prior, diff] = await Promise.all([priorAppliedFor(brief), diffFor(brief.id)]);
      renderReview(brief, { projectId, onApplied, priorApplied: prior, diff });
    } catch (err) {
      alert(`Couldn't read that brief: ${err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  return {
    setEnabled(on) {
      btn.disabled = !on;
    },
    review: openBriefReview,
  };
}
