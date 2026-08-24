// The Schedule tab: wires the reusable week calendar (calendar.js) together
// with the at-risk sidebar, the task detail panel a block opens into, and
// the working/domestic hours editor -- the pieces calendar.js deliberately
// doesn't own itself (see calendar.js's header comment). Its own module for
// the same reason tasks.js/locations.js are: self-contained state, app.js
// stays thin.
//
// Exports refreshSchedule(), called from app.js's tab-switch dispatcher the
// same way tasks.refreshTaskList() is -- the calendar is created lazily on
// first activation and just reloaded after that, matching how every other
// tab in this SPA works (sections are never torn down, only hidden).

import { createCalendar } from "./calendar.js";
import { openTaskPanel } from "./task-panel.js";
import { initHoursEditor, openHoursEditor } from "./hours-editor.js";

const calendarContainer = document.getElementById("schedule-calendar");
const atRiskPanel = document.getElementById("schedule-at-risk-panel");
const hoursBtn = document.getElementById("manage-hours-btn");

let calendar = null;

function makeAtRiskList(entries) {
  const ul = document.createElement("ul");
  entries.forEach((e) => {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = e.title;
    li.append(title, document.createTextNode(` — ${e.message}`));
    ul.appendChild(li);
  });
  return ul;
}

// Same shape as tasks.js's renderAtRiskPanel, deliberately not shared code
// with it -- see task-panel.js's header comment for why this module doesn't
// reach into tasks.js's internals. "Alongside, not buried" (CLAUDE.md's
// session prompt) is the whole point of this panel: it sits beside the
// calendar rather than needing a tab switch to see.
function renderAtRisk(schedule) {
  const atRisk = schedule.at_risk || [];
  const byDeliverable = schedule.at_risk_by_deliverable || [];
  const slipping = schedule.chronically_slipping || [];

  atRiskPanel.innerHTML = "";
  const nothingToShow = atRisk.length === 0 && slipping.length === 0;
  atRiskPanel.hidden = nothingToShow;
  if (nothingToShow) return;

  if (byDeliverable.length) {
    const section = document.createElement("div");
    section.className = "task-at-risk-section";
    const h = document.createElement("h4");
    h.textContent = "At risk, by deliverable";
    section.appendChild(h);
    byDeliverable.forEach((d) => {
      const p = document.createElement("p");
      p.textContent = `${d.title || "Untitled deliverable"}: ${d.at_risk_tasks} of ${d.total_tasks} tasks at risk`;
      section.appendChild(p);
    });
    atRiskPanel.appendChild(section);
  }

  const standalone = atRisk.filter((e) => !e.deliverable_id);
  if (standalone.length) {
    const section = document.createElement("div");
    section.className = "task-at-risk-section";
    const h = document.createElement("h4");
    h.textContent = "At risk";
    section.appendChild(h);
    section.appendChild(makeAtRiskList(standalone));
    atRiskPanel.appendChild(section);
  }

  if (slipping.length) {
    const section = document.createElement("div");
    section.className = "task-at-risk-section";
    const h = document.createElement("h4");
    h.textContent = "Slipping repeatedly";
    section.appendChild(h);
    const ul = document.createElement("ul");
    slipping.forEach((s) => {
      const li = document.createElement("li");
      li.textContent = `${s.title} — slipped ${s.slip_count} times`;
      ul.appendChild(li);
    });
    section.appendChild(ul);
    atRiskPanel.appendChild(section);
  }
}

function handleOpenTask(taskId) {
  openTaskPanel(taskId, {
    onChange: () => calendar?.reload(),
  });
}

hoursBtn.addEventListener("click", openHoursEditor);
initHoursEditor(() => calendar?.reload());

export function refreshSchedule() {
  if (!calendar) {
    calendar = createCalendar(calendarContainer, {
      numDays: 7,
      onOpenTask: handleOpenTask,
      onDataLoaded: (data) => renderAtRisk(data.schedule),
    });
  } else {
    calendar.reload();
  }
}
