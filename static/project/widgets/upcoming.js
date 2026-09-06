/* This project's next scheduled work sessions -- a short agenda pulled from
 * the committed plan.
 *
 * GET /api/schedule returns every block the last plan committed, from today
 * to the horizon. This tile keeps the 'task' blocks whose task belongs to
 * this project, in start order, and shows the first handful: what to actually
 * do next for this project, without opening the schedule.
 *
 * Blocks come in two precisions (see db.py's SCHEDULED_BLOCKS_SCHEMA): a
 * near-term block carries a real time of day, a further-out one carries only
 * a date. `granularity` tells them apart, and this tile shows a time only
 * when there is one to show.
 *
 * canvasEligible: true. Unlike the other two schedule tiles this one is a
 * fixed, short list -- the next few sessions, nothing that scrolls -- so
 * pinning "what's next for this board" beside the references it concerns on
 * the canvas is a real use, with no internal-scroll clash against the
 * viewport transform.
 *
 * config: unused -- the agenda is derived from the committed plan, nothing
 * here is this widget's own state.
 */

const SHOWN = 8;

function startOfDay(iso) {
  return iso.slice(0, 10);
}

function dayLabel(dateStr, todayStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const today = new Date(`${todayStr}T00:00:00`);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function timeLabel(block) {
  if (block.granularity !== "slot") return null;
  const t = new Date(block.start);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export default {
  type: "upcoming",
  label: "Up Next",
  container: false,
  permanent: false,
  canvasEligible: true,
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 2, h: 2 },

  create(host) {
    const projectId = host.project.id;

    const wrap = document.createElement("div");
    wrap.className = "widget-schedule widget-upcoming";
    host.el.appendChild(wrap);

    let cancelled = false;

    function message(text) {
      wrap.innerHTML = "";
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = text;
      wrap.appendChild(p);
    }

    function render(agenda, todayStr) {
      wrap.innerHTML = "";
      if (!agenda.length) {
        message("Nothing scheduled for this project. Run a plan on the schedule.");
        return;
      }

      let lastDay = null;
      for (const { block, task } of agenda) {
        const day = startOfDay(block.start);
        if (day !== lastDay) {
          lastDay = day;
          const heading = document.createElement("p");
          heading.className = "widget-upcoming-day";
          heading.textContent = dayLabel(day, todayStr);
          wrap.appendChild(heading);
        }

        const row = document.createElement("div");
        row.className = "widget-upcoming-row";

        const time = timeLabel(block);
        if (time) {
          const t = document.createElement("span");
          t.className = "widget-upcoming-time";
          t.textContent = time;
          row.appendChild(t);
        }

        const title = document.createElement("span");
        title.className = "widget-upcoming-title";
        title.textContent = task.title;
        row.appendChild(title);

        wrap.appendChild(row);
      }
    }

    async function load() {
      let schedule, tasks;
      try {
        [schedule, tasks] = await Promise.all([
          fetch("/api/schedule").then((r) => (r.ok ? r.json() : {})),
          fetch(`/api/tasks?project_id=${projectId}`).then((r) => r.json()),
        ]);
      } catch {
        if (!cancelled) message("Couldn't load this project's schedule.");
        return;
      }
      if (cancelled) return;

      const tasksById = new Map(tasks.map((t) => [t.id, t]));
      const agenda = (schedule.blocks || [])
        .filter((b) => b.kind === "task" && tasksById.has(b.task_id))
        .sort((a, b) => a.start.localeCompare(b.start))
        .slice(0, SHOWN)
        .map((block) => ({ block, task: tasksById.get(block.task_id) }));

      render(agenda, schedule.start || new Date().toISOString().slice(0, 10));
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
