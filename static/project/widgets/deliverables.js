/* This project's deliverables, with progress and risk -- the homepage
 * answer to "how close am I to owing what I owe".
 *
 * A read-only echo of the Deliverables tab (schedule/deliverables.js), not a
 * second implementation of it: the numbers come from the same three endpoints
 * that tab reads (project deliverables, project tasks, GET /api/schedule) and
 * the at-risk sentence is worded the same way. Editing a due date, moving a
 * task between deliverables, replanning -- all of that still happens on the
 * schedule surface; this tile only shows where things stand.
 *
 * At-risk data is recomputed fresh on every GET /api/schedule (see
 * scheduling.plan / _at_risk), so this tile is current the moment it loads --
 * it does not need a replan to have been run.
 *
 * canvasEligible: false. Deadline tracking is a homepage-dashboard concern;
 * the infinite canvas is for arranging references in space, not for watching
 * dates, and a deliverable's task list makes this a scroller -- the same
 * internal-scroll-versus-pan/zoom clash all-references.js opts out for.
 *
 * config: unused -- everything shown is derived from the project's schedule
 * data, nothing here is this widget's own state to persist.
 */

const RESOLVED = new Set(["done", "partial"]);
const OUTSTANDING = new Set(["pending", "scheduled"]);

function formatDate(s) {
  if (!s) return null;
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

function formatWeighting(w) {
  if (w == null) return null;
  // Stored as a fraction (0.6) or a percentage (60) -- treat <= 1 as a fraction,
  // same rule schedule/deliverables.js uses.
  return w <= 1 ? `${Math.round(w * 100)}%` : `${w}%`;
}

export default {
  type: "deliverables",
  label: "Deliverables",
  container: false,
  permanent: false,
  canvasEligible: false,
  defaultSize: { w: 5, h: 5 },
  minSize: { w: 3, h: 3 },

  create(host) {
    const projectId = host.project.id;

    // .widget-body clips to the rounded box; this wrapper scrolls inside it,
    // so a project with many deliverables never grows the tile.
    const wrap = document.createElement("div");
    wrap.className = "widget-schedule widget-deliverables";
    host.el.appendChild(wrap);

    let cancelled = false;

    function message(text) {
      wrap.innerHTML = "";
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = text;
      wrap.appendChild(p);
    }

    function render(deliverables, tasksByDeliverable, riskByDeliverable) {
      wrap.innerHTML = "";

      if (!deliverables.length) {
        message("No deliverables yet. Import a brief or add one on the Deliverables tab.");
        return;
      }

      const atRiskCount = deliverables.filter(
        (d) => (riskByDeliverable.get(d.id) || {}).at_risk_tasks,
      ).length;

      const summary = document.createElement("p");
      summary.className = "widget-schedule-summary";
      summary.textContent =
        `${deliverables.length} deliverable${deliverables.length === 1 ? "" : "s"}` +
        (atRiskCount ? ` · ${atRiskCount} at risk` : " · on track");
      if (atRiskCount) summary.classList.add("is-risk");
      wrap.appendChild(summary);

      for (const d of deliverables) {
        const tasks = tasksByDeliverable.get(d.id) || [];
        const done = tasks.filter((t) => RESOLVED.has(t.status)).length;
        const remaining = tasks.filter((t) => OUTSTANDING.has(t.status)).length;
        const risk = riskByDeliverable.get(d.id);

        const row = document.createElement("div");
        row.className = "widget-deliverable-row";

        const head = document.createElement("div");
        head.className = "widget-deliverable-head";
        const title = document.createElement("span");
        title.className = "widget-deliverable-title";
        title.textContent = d.title;
        const meta = document.createElement("span");
        meta.className = "widget-deliverable-meta";
        const due = formatDate(d.due_at);
        const weighting = formatWeighting(d.weighting);
        meta.textContent = [due && `due ${due}`, weighting].filter(Boolean).join(" · ");
        head.append(title, meta);
        row.appendChild(head);

        const prog = document.createElement("div");
        prog.className = "widget-deliverable-progress";
        prog.textContent = tasks.length
          ? `${done}/${tasks.length} done · ${remaining} to go`
          : "No tasks yet";
        row.appendChild(prog);

        if (risk && risk.at_risk_tasks) {
          const sentence = document.createElement("p");
          sentence.className = "widget-deliverable-risk";
          sentence.textContent =
            `${risk.at_risk_tasks} of ${risk.total_tasks} ` +
            `${risk.total_tasks === 1 ? "task" : "tasks"} cannot be placed` +
            `${due ? ` before ${due}` : ""}. As planned, this will not be finished in time.`;
          row.appendChild(sentence);
        }

        wrap.appendChild(row);
      }
    }

    async function load() {
      let deliverables, tasks, schedule;
      try {
        [deliverables, tasks, schedule] = await Promise.all([
          fetch(`/api/projects/${projectId}/deliverables`).then((r) => r.json()),
          fetch(`/api/tasks?project_id=${projectId}`).then((r) => r.json()),
          fetch("/api/schedule").then((r) => (r.ok ? r.json() : {})),
        ]);
      } catch {
        if (!cancelled) message("Couldn't load this project's schedule.");
        return;
      }
      if (cancelled) return;

      const tasksByDeliverable = new Map();
      for (const t of tasks) {
        if (!t.deliverable_id) continue;
        if (!tasksByDeliverable.has(t.deliverable_id)) tasksByDeliverable.set(t.deliverable_id, []);
        tasksByDeliverable.get(t.deliverable_id).push(t);
      }
      const riskByDeliverable = new Map(
        (schedule.at_risk_by_deliverable || []).map((r) => [r.deliverable_id, r]),
      );

      render(deliverables, tasksByDeliverable, riskByDeliverable);
    }

    message("Loading…");
    load();

    return {
      destroy() {
        cancelled = true;
        wrap.remove();
      },
    };
  },
};
