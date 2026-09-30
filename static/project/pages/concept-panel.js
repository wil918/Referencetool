/* Concept analysis on the infinite canvas.
 *
 * The canvas marquee is the picker (nodes.js's selection()): lasso a mix of
 * reference nodes -- the visual research -- and your own thinking about it --
 * plain text nodes, Notepad widgets, and any earlier Analysis widget -- and
 * Claude critiques whether the second is actually carried by the first,
 * against the project's imported brief. An empty selection analyses the whole
 * project's references and canvas text, so this works before anything is
 * lassoed. canvas-page.js does the splitting; this panel just forwards it.
 *
 * Deliberately close to analysis-panel.js's Analyze overlay -- same transcript
 * rendering, same follow-up chat via the same /api/analyze/<id>/reply route
 * (the concept endpoint returns the same envelope). What is different: there is
 * no "save conversation" here. The output goes back onto the canvas as a text
 * node, so the critique lands beside the work it is about and can itself be
 * lassoed into the next round.
 *
 * The critique's trailing NEXT ACTIONS bullets arrive as `next_actions`
 * (analyze._extract_next_actions), separately from the prose. They're offered
 * the same way a brief import's proposal is: a toggleable, editable row per
 * action, nothing becomes a task until "Add to tasks" is pressed. Plain
 * POST /api/tasks per accepted row -- no dedicated apply endpoint, since a
 * concept-analysis task carries no provenance to reconcile on a re-run the
 * way a brief's does.
 */

import { linkifyReferences } from "./analysis-panel.js";

export function createConceptPanel({ project, placeNote }) {
  let sessionId = null;
  let refMap = {};
  let latestWriteup = "";
  let deliverablesPromise = null;

  function loadDeliverables() {
    if (!deliverablesPromise) {
      deliverablesPromise = fetch(`/api/projects/${project.id}/deliverables`)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []);
    }
    return deliverablesPromise;
  }

  const overlay = document.createElement("div");
  // Same id analysis-panel.js's live overlay uses, so overlays.js's ref-link
  // jump hides it before opening the carousel -- harmless here since the canvas
  // page never mounts both panels at once.
  overlay.id = "analyze-overlay";
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal-box analyze-box">
      <h3>Concept analysis</h3>
      <p class="muted concept-scope"></p>
      <div class="analyze-transcript analyze-live-transcript"></div>
      <div class="concept-actions" hidden>
        <p class="muted concept-actions-label">Proposed next actions -- nothing here becomes a task until you add it</p>
        <div class="concept-actions-list"></div>
        <div class="concept-actions-footer">
          <button type="button" class="btn concept-actions-add">Add to tasks</button>
        </div>
      </div>
      <div class="analyze-input-row">
        <input type="text" class="analyze-followup-input" placeholder="Push back, or ask for more…">
        <button type="button" class="btn primary analyze-followup-send">Send</button>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn primary concept-place-btn" disabled>Place on canvas</button>
        <button type="button" class="btn concept-close-btn">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const scopeEl = overlay.querySelector(".concept-scope");
  const transcriptEl = overlay.querySelector(".analyze-live-transcript");
  const inputEl = overlay.querySelector(".analyze-followup-input");
  const sendBtn = overlay.querySelector(".analyze-followup-send");
  const placeBtn = overlay.querySelector(".concept-place-btn");
  const actionsWrap = overlay.querySelector(".concept-actions");
  const actionsList = overlay.querySelector(".concept-actions-list");
  const actionsAddBtn = overlay.querySelector(".concept-actions-add");

  function renderActions(actions) {
    actionsList.innerHTML = "";
    actionsAddBtn.disabled = false;
    actionsAddBtn.textContent = "Add to tasks";
    if (!actions || !actions.length) {
      actionsWrap.hidden = true;
      return;
    }
    actionsWrap.hidden = false;

    const rows = actions.map((text) => {
      const row = document.createElement("div");
      row.className = "concept-action-row";

      const toggle = document.createElement("label");
      toggle.className = "checkbox-label";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = true;
      toggle.append(check, document.createTextNode("Include"));

      const titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.className = "concept-action-title";
      titleInput.value = text;

      const deliverableSelect = document.createElement("select");
      deliverableSelect.className = "concept-action-deliverable";
      deliverableSelect.append(new Option("No deliverable", ""));

      row.append(toggle, titleInput, deliverableSelect);
      actionsList.appendChild(row);

      return {
        accepted: () => check.checked,
        title: () => titleInput.value.trim(),
        deliverableSelect,
        row,
      };
    });

    loadDeliverables().then((deliverables) => {
      rows.forEach(({ deliverableSelect }) => {
        (deliverables || []).forEach((d) => {
          deliverableSelect.append(new Option(d.title || "Untitled deliverable", d.id));
        });
      });
    });

    actionsAddBtn.onclick = async () => {
      const chosen = rows.filter((r) => r.accepted() && r.title());
      if (!chosen.length) return;
      actionsAddBtn.disabled = true;
      actionsAddBtn.textContent = "Adding…";
      try {
        await Promise.all(
          chosen.map((r) =>
            fetch("/api/tasks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: r.title(),
                project_id: project.id,
                deliverable_id: r.deliverableSelect.value || null,
              }),
            })
          )
        );
        chosen.forEach((r) => r.row.remove());
        const remaining = rows.filter((r) => !chosen.includes(r));
        if (!remaining.length) {
          actionsWrap.hidden = true;
        } else {
          actionsAddBtn.disabled = false;
          actionsAddBtn.textContent = "Add to tasks";
        }
      } catch (err) {
        actionsAddBtn.disabled = false;
        actionsAddBtn.textContent = "Error adding -- try again";
      }
    };
  }

  function appendTurn(text, kind) {
    const div = document.createElement("div");
    div.className = `analyze-turn analyze-${kind}`;
    if (kind === "writeup" || kind === "reply") {
      div.innerHTML = linkifyReferences(text, refMap);
      latestWriteup = text;
      placeBtn.disabled = false;
    } else {
      div.textContent = text;
    }
    transcriptEl.appendChild(div);
    div.scrollIntoView({ block: "end" });
    return div;
  }

  async function run({ referenceIds = [], notes = [], noteHtml = [], priorAnalysisIds = [] } = {}) {
    sessionId = null;
    refMap = {};
    latestWriteup = "";
    transcriptEl.innerHTML = "";
    inputEl.value = "";
    placeBtn.disabled = true;
    renderActions([]);
    overlay.hidden = false;

    const noteCount = notes.length + noteHtml.length;
    const usingSelection = referenceIds.length || noteCount || priorAnalysisIds.length;
    scopeEl.textContent = usingSelection
      ? `${referenceIds.length} reference${referenceIds.length === 1 ? "" : "s"} and ` +
        `${noteCount} note${noteCount === 1 ? "" : "s"} from the canvas` +
        (priorAnalysisIds.length
          ? `, plus ${priorAnalysisIds.length} earlier critique${priorAnalysisIds.length === 1 ? "" : "s"}`
          : "")
      : "Whole project — nothing selected on the canvas";
    appendTurn("Reading the research…", "status");

    try {
      const res = await fetch(`/api/projects/${project.id}/concept-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference_ids: referenceIds,
          notes,
          note_html: noteHtml,
          prior_analysis_ids: priorAnalysisIds,
        }),
      });
      const data = await res.json();
      transcriptEl.innerHTML = "";
      if (!res.ok) {
        appendTurn(`Error: ${data.error}`, "status");
        return;
      }
      sessionId = data.analysis_id;
      refMap = data.references || {};
      appendTurn(data.writeup, "writeup");
      renderActions(data.next_actions || []);
    } catch (err) {
      transcriptEl.innerHTML = "";
      appendTurn(`Error: ${err}`, "status");
    }
  }

  async function sendFollowup() {
    const message = inputEl.value.trim();
    if (!message || !sessionId) return;
    inputEl.value = "";
    appendTurn(message, "question");
    const thinking = appendTurn("Thinking…", "status");
    try {
      const res = await fetch(`/api/analyze/${sessionId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      thinking.remove();
      appendTurn(res.ok ? data.reply : `Error: ${data.error}`, res.ok ? "reply" : "status");
    } catch (err) {
      thinking.remove();
      appendTurn(`Error: ${err}`, "status");
    }
  }

  sendBtn.addEventListener("click", sendFollowup);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendFollowup();
  });

  placeBtn.addEventListener("click", () => {
    if (!latestWriteup) return;
    placeNote(latestWriteup);
    overlay.hidden = true;
  });
  overlay.querySelector(".concept-close-btn").addEventListener("click", () => {
    overlay.hidden = true;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });

  return {
    run,
    destroy() {
      overlay.remove();
    },
  };
}
