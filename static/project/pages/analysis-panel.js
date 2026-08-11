/* The "Previous Analysis" sidebar and the Analyze flow (mode choice, live
 * transcript, follow-up chat, save) -- ported from the old project detail
 * view in app.js, parameterized instead of reaching for module-level
 * currentProject/currentList/selectedRefIds globals, so grid-page.js can
 * mount one of these per page instance (the project grid, or any folder).
 *
 * `getReferences` is a live getter, not a snapshot: a saved analysis's
 * "click to jump" needs whatever list is current on the page hosting this
 * panel right now, not whatever it was when the panel was built.
 */

import { makeCard } from "../../shared/cards.js";
import * as carousel from "../../shared/carousel.js";

export function createAnalysisPanel({ project, getReferences }) {
  let sessionId = null;
  let referenceIds = [];
  let turns = []; // {kind, text}, mirrors the transcript for saving -- "status" turns excluded
  let refMap = {}; // title -> reference id, for linkifying mentions in Claude's replies

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Wraps every mention of a known reference title in `text` with a hyperlink
  // back to that reference. Longest titles are matched first so a short title
  // that happens to be a substring of a longer one doesn't steal the match.
  function linkifyReferences(text, map = refMap) {
    const titles = Object.keys(map)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (!titles.length) return escapeHtml(text);

    const pattern = new RegExp(titles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");

    let html = "";
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      html += escapeHtml(text.slice(lastIndex, match.index));
      html += `<a href="#" class="ref-link" data-ref-id="${map[match[0]]}">${escapeHtml(match[0])}</a>`;
      lastIndex = match.index + match[0].length;
    }
    html += escapeHtml(text.slice(lastIndex));
    return html;
  }

  // --- Previous Analysis sidebar ---------------------------------------

  const sidebar = document.createElement("aside");
  sidebar.className = "analysis-sidebar";
  sidebar.hidden = true;
  sidebar.innerHTML = `
    <div class="analysis-sidebar-header">
      <h3>Previous Analysis</h3>
      <button type="button" class="btn analysis-sidebar-close">Close</button>
    </div>
    <div class="analysis-sidebar-list-view">
      <div class="analysis-list"></div>
      <p class="muted analysis-sidebar-empty" hidden>
        No saved analyses yet. Run Analyze and save the conversation to see it here.
      </p>
    </div>
    <div class="analysis-sidebar-detail" hidden>
      <button type="button" class="btn" id="analysis-detail-back">&larr; All analyses</button>
      <p class="muted" id="analysis-detail-date"></p>
      <div class="grid small" id="analysis-detail-refs"></div>
      <div class="analyze-transcript analysis-detail-transcript"></div>
    </div>
  `;
  document.body.appendChild(sidebar);

  const listView = sidebar.querySelector(".analysis-sidebar-list-view");
  const listEl = sidebar.querySelector(".analysis-list");
  const emptyEl = sidebar.querySelector(".analysis-sidebar-empty");
  const detailView = sidebar.querySelector(".analysis-sidebar-detail");
  const detailDate = sidebar.querySelector("#analysis-detail-date");
  const detailRefs = sidebar.querySelector("#analysis-detail-refs");
  const detailTranscript = sidebar.querySelector(".analysis-detail-transcript");

  sidebar.querySelector(".analysis-sidebar-close").addEventListener("click", () => {
    sidebar.hidden = true;
  });
  sidebar.querySelector("#analysis-detail-back").addEventListener("click", showAnalysisList);

  async function showAnalysisList() {
    detailView.hidden = true;
    listView.hidden = false;
    const res = await fetch(`/api/projects/${project.id}/analyses`);
    const analyses = await res.json();
    listEl.innerHTML = "";
    emptyEl.hidden = analyses.length > 0;
    analyses.forEach((a) => listEl.appendChild(makeAnalysisListItem(a)));
  }

  function makeAnalysisListItem(a) {
    const item = document.createElement("div");
    item.className = "analysis-list-item";
    item.addEventListener("click", () => openAnalysisDetail(a.id));

    const date = document.createElement("div");
    date.className = "analysis-list-date";
    date.textContent = new Date(a.date_created).toLocaleString();
    item.appendChild(date);

    const count = document.createElement("div");
    count.className = "muted";
    count.textContent = `${a.reference_count} reference${a.reference_count === 1 ? "" : "s"}`;
    item.appendChild(count);

    const refsRow = document.createElement("div");
    refsRow.className = "analysis-list-refs";
    a.preview.forEach((ref) => refsRow.appendChild(makeAnalysisThumb(ref)));
    item.appendChild(refsRow);

    return item;
  }

  function makeAnalysisThumb(ref) {
    const thumb = document.createElement("div");
    thumb.className = "analysis-thumb";
    const img = document.createElement("img");
    img.src = `/media/${ref.id}/thumb`;
    img.alt = ref.title;
    img.onerror = () => img.remove();
    thumb.appendChild(img);
    return thumb;
  }

  async function openAnalysisDetail(analysisId) {
    const res = await fetch(`/api/analyses/${analysisId}`);
    if (!res.ok) return;
    const data = await res.json();

    listView.hidden = true;
    detailView.hidden = false;
    detailDate.textContent = new Date(data.date_created).toLocaleString();

    detailRefs.innerHTML = "";
    data.references.forEach((ref) => {
      detailRefs.appendChild(
        makeCard(ref, () => {
          const list = getReferences();
          const idx = list.findIndex((r) => r.id === ref.id);
          if (idx !== -1) carousel.open(list, idx);
        })
      );
    });

    const detailRefMap = {};
    data.references.forEach((r) => {
      detailRefMap[r.title] = r.id;
    });

    detailTranscript.innerHTML = "";
    data.transcript.forEach((turn) => {
      const div = document.createElement("div");
      div.className = `analyze-turn analyze-${turn.kind}`;
      div.innerHTML = linkifyReferences(turn.text, detailRefMap);
      detailTranscript.appendChild(div);
    });
  }

  // --- Analyze: mode choice --------------------------------------------

  const modeOverlay = document.createElement("div");
  modeOverlay.className = "modal-overlay";
  modeOverlay.hidden = true;
  modeOverlay.innerHTML = `
    <div class="modal-box">
      <h3>Run analysis</h3>
      <p class="muted">How detailed should the write-up be?</p>
      <div class="mode-choice-actions">
        <button type="button" class="btn analyze-mode-summary">Summarised</button>
        <button type="button" class="btn primary analyze-mode-full">Full analysis</button>
      </div>
    </div>
  `;
  document.body.appendChild(modeOverlay);

  modeOverlay.addEventListener("click", (e) => {
    if (e.target === modeOverlay) modeOverlay.hidden = true;
  });

  let pendingIds = [];
  modeOverlay.querySelector(".analyze-mode-summary").addEventListener("click", () => {
    modeOverlay.hidden = true;
    openAnalyzeModal(pendingIds, "summary");
  });
  modeOverlay.querySelector(".analyze-mode-full").addEventListener("click", () => {
    modeOverlay.hidden = true;
    openAnalyzeModal(pendingIds, "full");
  });

  // --- Analyze: live transcript ------------------------------------------

  const analyzeOverlay = document.createElement("div");
  analyzeOverlay.id = "analyze-overlay"; // overlays.js's ref-link jump hides this by id
  analyzeOverlay.className = "modal-overlay";
  analyzeOverlay.hidden = true;
  analyzeOverlay.innerHTML = `
    <div class="modal-box analyze-box">
      <h3>Analysis</h3>
      <div class="analyze-transcript analyze-live-transcript"></div>
      <div class="analyze-input-row">
        <input type="text" class="analyze-followup-input" placeholder="Ask a follow-up...">
        <button type="button" class="btn primary analyze-followup-send">Send</button>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn analyze-save-btn" disabled>Save conversation</button>
        <button type="button" class="btn analyze-close-btn">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(analyzeOverlay);

  const transcriptEl = analyzeOverlay.querySelector(".analyze-live-transcript");
  const inputEl = analyzeOverlay.querySelector(".analyze-followup-input");
  const saveBtn = analyzeOverlay.querySelector(".analyze-save-btn");

  function appendTurn(text, kind) {
    const div = document.createElement("div");
    div.className = `analyze-turn analyze-${kind}`;
    if (kind === "writeup" || kind === "reply") {
      div.innerHTML = linkifyReferences(text);
    } else {
      div.textContent = text;
    }
    transcriptEl.appendChild(div);
    div.scrollIntoView({ block: "end" });
    if (kind !== "status") turns.push({ kind, text });
    return div;
  }

  async function openAnalyzeModal(ids, mode) {
    sessionId = null;
    referenceIds = ids;
    turns = [];
    refMap = {};
    transcriptEl.innerHTML = "";
    inputEl.value = "";
    saveBtn.disabled = true;
    saveBtn.textContent = "Save conversation";
    analyzeOverlay.hidden = false;
    appendTurn(`Analyzing ${ids.length} reference${ids.length === 1 ? "" : "s"}...`, "status");

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference_ids: ids, mode }),
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
      saveBtn.disabled = false;
    } catch (err) {
      transcriptEl.innerHTML = "";
      appendTurn(`Error: ${err}`, "status");
    }
  }

  saveBtn.addEventListener("click", async () => {
    if (!sessionId) return;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    try {
      const res = await fetch(`/api/analyses/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: project.id,
          reference_ids: referenceIds,
          transcript: turns,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        saveBtn.textContent = `Error: ${data.error}`;
        saveBtn.disabled = false;
        return;
      }
      // Saved -- the transcript now lives in the Previous Analysis sidebar,
      // so there's nothing left to do here but close.
      analyzeOverlay.hidden = true;
    } catch (err) {
      saveBtn.textContent = "Error saving";
      saveBtn.disabled = false;
    }
  });

  async function sendFollowup() {
    const message = inputEl.value.trim();
    if (!message || !sessionId) return;
    inputEl.value = "";
    appendTurn(message, "question");
    const thinking = appendTurn("Thinking...", "status");

    try {
      const res = await fetch(`/api/analyze/${sessionId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      thinking.remove();
      if (!res.ok) {
        appendTurn(`Error: ${data.error}`, "status");
        return;
      }
      appendTurn(data.reply, "reply");
    } catch (err) {
      thinking.remove();
      appendTurn(`Error: ${err}`, "status");
    }
  }

  analyzeOverlay.querySelector(".analyze-followup-send").addEventListener("click", sendFollowup);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendFollowup();
  });
  analyzeOverlay.querySelector(".analyze-close-btn").addEventListener("click", () => {
    analyzeOverlay.hidden = true;
  });
  analyzeOverlay.addEventListener("click", (e) => {
    if (e.target === analyzeOverlay) analyzeOverlay.hidden = true;
  });

  return {
    openSidebar() {
      sidebar.hidden = false;
      showAnalysisList();
    },
    startAnalysis(ids) {
      if (!ids.length) return;
      pendingIds = ids;
      modeOverlay.hidden = false;
    },
    destroy() {
      sidebar.remove();
      modeOverlay.remove();
      analyzeOverlay.remove();
    },
  };
}
