// Entry point for the standalone schedule page (/schedule.html), same shape
// as app.js is for index.html: wires up tab switching and the modules each
// tab depends on. Tasks and the calendar are one workflow -- see CLAUDE.md --
// so they and the schedule's own settings (working/domestic hours, personal
// events, calendar import, locations, suggested bedtime) live here together,
// split out of the archive SPA rather than rewritten.

import * as tasks from "../tasks.js";
import { initLocationsManager } from "../locations.js";
import { initCalendarImport } from "../calendar-import.js";
import { initCommitments } from "../commitments.js";
import { refreshSchedule } from "./schedule.js";
import { refreshDay } from "./day.js";
import { initScheduleSettings } from "./settings.js";
import { startBedtimeWatch } from "./bedtime-watch.js";

// --- Tabs ---

function activateTab(name) {
  const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (!btn) return false;

  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById(`tab-${name}`).classList.add("active");

  if (name === "today") refreshDay();
  if (name === "tasks") tasks.refreshTaskList();
  if (name === "schedule") refreshSchedule();
  return true;
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

// Deep links, so the other pages can point at a specific tab here, the same
// way index.html's #archive/#projects links work: /schedule.html#schedule.
function activateTabFromHash() {
  return activateTab(location.hash.replace("#", ""));
}
window.addEventListener("hashchange", activateTabFromHash);

// --- Init ---

// Locations affect the Tasks tab's "Location" dropdowns, so a change made
// while the manager is open (adding, renaming, deleting) refreshes the task
// list once the overlay closes rather than leaving those selects stale.
initLocationsManager(() => tasks.refreshTaskList());
initCalendarImport();
initCommitments();
initScheduleSettings();
startBedtimeWatch();

// A hash deep link picks its own tab; failing that, the Today tab is the one
// marked active in the markup -- it is the most-opened screen -- so prime it.
if (!activateTabFromHash()) activateTab("today");
