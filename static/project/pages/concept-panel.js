/* Concept analysis on the infinite canvas.
 *
 * The canvas marquee is the picker (nodes.js's selection()): lasso a mix of
 * reference nodes -- the visual research -- and text nodes -- your own thinking
 * about it -- and Claude critiques whether the second is actually carried by
 * the first, against the project's imported brief. An empty selection analyses
 * the whole project's references, so this works before anything is on a canvas.
 *
 * Deliberately close to analysis-panel.js's Analyze overlay -- same transcript
 * rendering, same follow-up chat via the same /api/analyze/<id>/reply route
 * (the concept endpoint returns the same envelope). What is different: there is
 * no "save conversation" here. The output goes back onto the canvas as a text
 * node, so the critique lands beside the work it is about and can itself be
 * lassoed into the next round.
 */

import { linkifyReferences } from "./analysis-panel.js";

export function createConceptPanel({ project, placeNote }) {
  let sessionId = null;
  let refMap = {};
  let latestWriteup = "";

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

  async function run({ referenceIds = [], notes = [] } = {}) {
    sessionId = null;
    refMap = {};
    latestWriteup = "";
    transcriptEl.innerHTML = "";
    inputEl.value = "";
    placeBtn.disabled = true;
    overlay.hidden = false;

    const usingSelection = referenceIds.length || notes.length;
    scopeEl.textContent = usingSelection
      ? `${referenceIds.length} reference${referenceIds.length === 1 ? "" : "s"} and ` +
        `${notes.length} note${notes.length === 1 ? "" : "s"} from the canvas`
      : "Whole project — nothing selected on the canvas";
    appendTurn("Reading the research…", "status");

    try {
      const res = await fetch(`/api/projects/${project.id}/concept-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference_ids: referenceIds, notes }),
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
