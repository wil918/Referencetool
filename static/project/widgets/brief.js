/* The project's imported assignment brief, rendered readably.
 *
 * A project has one brief (app.py's import route reuses the row on re-import).
 * This tile shows what Claude read out of that PDF -- the summary, key dates,
 * deliverables with their requirements and skeleton tasks, and the mandatory
 * activities -- straight from the stored extraction (briefs.analyse's shape,
 * see briefs.py), with a link to the original PDF.
 *
 * Read-only. Accepting, editing or discarding any of this happens in the
 * Deliverables tab's review sheet (schedule/brief-import.js); nothing here
 * writes. The extraction is the durable record of the brief as read, kept
 * separate from the deliverable rows it may have created, so this stays
 * truthful even after those rows are hand-edited.
 *
 * canvasEligible: false. A brief is a multi-section document that scrolls --
 * the same internal-scroll-versus-pan/zoom clash all-references.js opts out
 * for.
 *
 * config: unused -- the brief is project data, nothing here is this widget's
 * own state.
 */

function humanize(key) {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function formatDate(s) {
  if (!s) return null;
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

/* The spec is arbitrary JSON -- its shape is not ours to fix (see db.py's
 * DELIVERABLES_SCHEMA). Render what is present, skip what is not, never
 * assume a key. A trimmed-down cousin of schedule/deliverables.js's renderSpec
 * without the tick state that view layers on. */
function renderSpec(spec, into) {
  if (!spec || typeof spec !== "object") return;
  for (const [key, value] of Object.entries(spec)) {
    if (key.startsWith("__")) continue;
    if (Array.isArray(value)) {
      const heading = document.createElement("p");
      heading.className = "widget-brief-spec-key";
      heading.textContent = humanize(key);
      into.appendChild(heading);
      const ul = document.createElement("ul");
      ul.className = "widget-brief-list";
      for (const item of value) {
        const li = document.createElement("li");
        li.textContent = typeof item === "string" ? item : JSON.stringify(item);
        ul.appendChild(li);
      }
      into.appendChild(ul);
    } else if (value != null && value !== "") {
      const p = document.createElement("p");
      p.className = "widget-brief-fact";
      p.textContent = `${humanize(key)}: ${typeof value === "object" ? JSON.stringify(value) : value}`;
      into.appendChild(p);
    }
  }
}

function section(title) {
  const h = document.createElement("p");
  h.className = "widget-brief-heading";
  h.textContent = title;
  return h;
}

export default {
  type: "brief",
  label: "Brief",
  container: false,
  permanent: false,
  canvasEligible: false,
  defaultSize: { w: 6, h: 6 },
  minSize: { w: 3, h: 3 },

  create(host) {
    const projectId = host.project.id;

    const wrap = document.createElement("div");
    wrap.className = "widget-schedule widget-brief";
    host.el.appendChild(wrap);

    let cancelled = false;

    function message(text) {
      wrap.innerHTML = "";
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = text;
      wrap.appendChild(p);
    }

    function render(brief) {
      wrap.innerHTML = "";
      const extraction = (brief.extracted || {}).extraction || {};

      const banner = document.createElement("p");
      banner.className = "widget-brief-banner muted";
      banner.textContent = `Imported ${formatDate(brief.imported_at)}. `;
      const link = document.createElement("a");
      link.href = `/api/briefs/${brief.id}/file`;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Original PDF";
      banner.appendChild(link);
      wrap.appendChild(banner);

      if (extraction.summary) {
        const p = document.createElement("p");
        p.className = "widget-brief-summary";
        p.textContent = extraction.summary;
        wrap.appendChild(p);
      }

      const keyDates = extraction.key_dates || [];
      if (keyDates.length) {
        wrap.appendChild(section("Key dates"));
        const ul = document.createElement("ul");
        ul.className = "widget-brief-list";
        for (const kd of keyDates) {
          const li = document.createElement("li");
          const when = formatDate(kd.date);
          li.textContent = [kd.label || humanize(kd.kind || "date"), when && `— ${when}`]
            .filter(Boolean)
            .join(" ");
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
      }

      const deliverables = extraction.deliverables || [];
      if (deliverables.length) {
        wrap.appendChild(section("Deliverables"));
        for (const d of deliverables) {
          const box = document.createElement("div");
          box.className = "widget-brief-deliverable";

          const head = document.createElement("p");
          head.className = "widget-brief-deliverable-title";
          head.textContent = d.title || "Untitled";
          box.appendChild(head);

          const facts = [
            formatDate(d.due_date) && `due ${formatDate(d.due_date)}`,
            d.weighting != null && `${d.weighting}%`,
          ].filter(Boolean);
          if (facts.length) {
            const meta = document.createElement("p");
            meta.className = "widget-brief-fact";
            meta.textContent = facts.join(" · ");
            box.appendChild(meta);
          }

          if (d.description) {
            const desc = document.createElement("p");
            desc.className = "widget-brief-body";
            desc.textContent = d.description;
            box.appendChild(desc);
          }

          renderSpec(d.spec, box);

          const tasks = d.tasks || [];
          if (tasks.length) {
            const label = document.createElement("p");
            label.className = "widget-brief-spec-key";
            label.textContent = "Task skeleton";
            box.appendChild(label);
            const ol = document.createElement("ol");
            ol.className = "widget-brief-list";
            for (const t of tasks) {
              const li = document.createElement("li");
              li.textContent = t.title + (t.est_minutes ? ` (${t.est_minutes} min)` : "");
              ol.appendChild(li);
            }
            box.appendChild(ol);
          }

          wrap.appendChild(box);
        }
      }

      const activities = extraction.mandatory_activities || [];
      if (activities.length) {
        wrap.appendChild(section("Mandatory activities"));
        const ul = document.createElement("ul");
        ul.className = "widget-brief-list";
        for (const a of activities) {
          const li = document.createElement("li");
          li.textContent = [a.title, a.note && `— ${a.note}`].filter(Boolean).join(" ");
          if (a.location_bound) li.textContent += " (location-bound)";
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
      }
    }

    async function load() {
      let briefs;
      try {
        briefs = await fetch(`/api/projects/${projectId}/briefs`).then((r) => r.json());
      } catch {
        if (!cancelled) message("Couldn't load this project's brief.");
        return;
      }
      if (cancelled) return;
      if (!briefs || !briefs.length) {
        message("No brief imported. Add one on the Deliverables tab.");
        return;
      }
      render(briefs[0]);
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
