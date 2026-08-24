// The Working hours / Domestic hours weekly-pattern editor -- the UI
// SCHEDULE_PLAN.md's session 4 note says was always implied by
// GET/PUT /api/working-hours but never built (see CLAUDE.md's session
// prompt): with no rows, every weekday has zero available minutes and
// everything lands on the at-risk list. Reachable from the Schedule tab's
// toolbar.
//
// Same shape as locations.js's weekly-hours editor (a row per weekday, a
// "Closed"/"Not working" checkbox that disables the two time inputs, one
// wholesale Save) -- but a DIFFERENT CONCEPT, not a refactor of it:
// location_hours is when a PLACE is open, working_hours is when YOU are
// willing to work, and domestic_hours is when chores happen. All three are
// edited the same way because a weekly opening pattern is the same shape
// regardless of whose hours it is; they stay three separate tables and three
// separate routes (see CLAUDE.md's data model) because they mean different
// things and a later session must not merge them.
//
// Exports initHoursEditor(onChange) -- onChange fires after either band is
// saved, so the calendar redraws its background bands without polling.

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const openBtn = document.getElementById("manage-hours-btn");
const overlay = document.getElementById("hours-overlay");
const closeBtn = document.getElementById("hours-close-btn");

let onChange = () => {};

// A row's "Not working" checkbox and its two time inputs disable together --
// same wiring as locations.js's wireClosedToggle.
function wireOffToggle(offInput, opensInput, closesInput) {
  const sync = () => {
    opensInput.disabled = offInput.checked;
    closesInput.disabled = offInput.checked;
  };
  offInput.addEventListener("change", sync);
  sync();
}

function buildBandEditor({ gridEl, saveBtn, statusEl, getUrl, putUrl }) {
  async function render() {
    const hours = await fetch(getUrl).then((r) => r.json());
    const byWeekday = Object.fromEntries(hours.map((h) => [h.weekday, h]));
    gridEl.innerHTML = "";

    const rows = WEEKDAYS.map((label, weekday) => {
      const existing = byWeekday[weekday];
      const row = document.createElement("div");
      row.className = "location-hours-row";

      const dayLabel = document.createElement("span");
      dayLabel.className = "location-hours-day";
      dayLabel.textContent = label;
      row.appendChild(dayLabel);

      const offLabel = document.createElement("label");
      offLabel.className = "checkbox-label";
      const offInput = document.createElement("input");
      offInput.type = "checkbox";
      // No row at all reads the same as an explicit day off -- an
      // unconfigured weekday starts out not-working rather than guessing at
      // hours for it (same convention as locations.js and db.py's own
      // "absence is the closed case").
      offInput.checked = !existing || (!existing.opens && !existing.closes);
      offLabel.appendChild(offInput);
      offLabel.append("Not working");
      row.appendChild(offLabel);

      const opensInput = document.createElement("input");
      opensInput.type = "time";
      opensInput.value = existing?.opens || "";
      row.appendChild(opensInput);

      const closesInput = document.createElement("input");
      closesInput.type = "time";
      closesInput.value = existing?.closes || "";
      row.appendChild(closesInput);

      wireOffToggle(offInput, opensInput, closesInput);
      gridEl.appendChild(row);
      return { weekday, offInput, opensInput, closesInput };
    });

    saveBtn.onclick = async () => {
      const payload = rows.map(({ weekday, offInput, opensInput, closesInput }) => ({
        weekday,
        opens: offInput.checked ? null : opensInput.value || null,
        closes: offInput.checked ? null : closesInput.value || null,
      }));
      saveBtn.disabled = true;
      statusEl.textContent = "Saving...";
      try {
        const res = await fetch(putUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hours: payload }),
        });
        if (!res.ok) {
          const data = await res.json();
          statusEl.textContent = `Error: ${data.error}`;
          return;
        }
        statusEl.textContent = "Saved.";
        onChange();
      } catch (err) {
        statusEl.textContent = `Error: ${err}`;
      } finally {
        saveBtn.disabled = false;
      }
    };
  }

  return { render };
}

const workingEditor = buildBandEditor({
  gridEl: document.getElementById("working-hours-grid"),
  saveBtn: document.getElementById("working-hours-save-btn"),
  statusEl: document.getElementById("working-hours-status"),
  getUrl: "/api/working-hours",
  putUrl: "/api/working-hours",
});

const domesticEditor = buildBandEditor({
  gridEl: document.getElementById("domestic-hours-grid"),
  saveBtn: document.getElementById("domestic-hours-save-btn"),
  statusEl: document.getElementById("domestic-hours-status"),
  getUrl: "/api/domestic-hours",
  putUrl: "/api/domestic-hours",
});

openBtn.addEventListener("click", async () => {
  overlay.hidden = false;
  await Promise.all([workingEditor.render(), domesticEditor.render()]);
});
closeBtn.addEventListener("click", () => {
  overlay.hidden = true;
});
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeBtn.click();
});

export function initHoursEditor(onChangeCallback) {
  if (onChangeCallback) onChange = onChangeCallback;
}

export function openHoursEditor() {
  openBtn.click();
}
