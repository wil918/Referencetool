/* A saved analysis, put on the canvas or the homepage grid.
 *
 * Reads exactly like the "Previous Analysis" sidebar's detail view
 * (pages/analysis-panel.js) -- date, reference thumbnails, transcript --
 * because it's built from the same renderTranscript()/buildAnalysisRefMap()
 * helpers that view uses, rather than a second copy of that rendering.
 *
 * The transcript supports the same per-selection rich text as Notepad
 * (same rich-text.js, same shared toolbar, same highlight field), but with
 * one structural difference: rich-text.js's model is one flat contentEditable
 * root per formattable region, and a transcript is several turns, each its
 * own paragraph-like block -- sanitizeHtml only ever keeps <span> and text,
 * so a single editable region spanning every turn would collapse their
 * dividing <div>s into one run on the first edit. Each turn is therefore its
 * own small contentEditable root, and the shared toolbar (which expects one
 * fixed root per widget, per makeFormattable's contract) is instead told
 * which one is active by asking the live selection at the moment it's asked,
 * via activeTurnRoot() below.
 *
 * Editing the display must never alter the saved analysis: the transcript
 * text and structure always come from GET /api/analyses/<id>, read-only.
 * Styling is kept entirely in this widget's own config (`turnHtml`, sanitized
 * HTML per turn index) and layered on top at render time -- the analyses
 * table stays a record of what Claude actually said.
 *
 * config: { analysis_id, turnHtml, contentScale }
 */

import { makeCard } from "../../shared/cards.js";
import * as carousel from "../../shared/carousel.js";
import { buildAnalysisRefMap, renderTranscript } from "../pages/analysis-panel.js";
import { applyTypography } from "../typography.js";
import { makeFormattable } from "../format-toolbar.js";
import { insertPlainText } from "../text-utils.js";
import {
  sanitizeHtml,
  getSelectionStyle,
  applySelectionStyle,
  clearSelectionStyle,
  pruneEmptySpans,
} from "../rich-text.js";

export default {
  type: "analysis",
  label: "Analysis",
  container: false,
  permanent: false,
  defaultSize: { w: 5, h: 4 },
  minSize: { w: 2, h: 2 },
  // analysis_id means nothing outside the project it was set in -- see
  // registry.js's projectScopedConfig.
  projectScopedConfig: ["analysis_id"],

  create(host) {
    const projectId = host.project.id;
    let analysisId = host.config?.analysis_id || null;
    let turnHtml = [...(host.config?.turnHtml || [])];
    // This analysis's own reference list -- what the thumbnail row's click
    // jumps within. Self-contained on purpose: unlike the sidebar (which
    // walks whatever list the hosting page already has loaded), this widget
    // has no page-level reference list to borrow, so a click pages through
    // just the references this analysis actually used.
    let references = [];

    const wrap = document.createElement("div");
    wrap.className = "widget-analysis";

    const view = document.createElement("div");
    view.className = "widget-analysis-view";
    wrap.appendChild(view);

    const changeBtn = document.createElement("button");
    changeBtn.type = "button";
    changeBtn.className = "btn widget-chrome-btn widget-analysis-change";
    changeBtn.title = "Choose a saved analysis";
    changeBtn.textContent = analysisId ? "Change" : "Choose";
    wrap.appendChild(changeBtn);

    const picker = document.createElement("div");
    picker.className = "widget-analysis-picker";
    picker.hidden = true;
    wrap.appendChild(picker);

    host.el.appendChild(wrap);

    function applyScale() {
      // Only the zoom control -- no whole-widget font override makes sense
      // for a transcript that's mostly per-selection styled already.
      applyTypography(host.el, {}, host.config?.contentScale);
    }
    applyScale();

    function persistTurn(turnEl) {
      const idx = Number(turnEl.dataset.turnIndex);
      turnHtml[idx] = sanitizeHtml(turnEl.innerHTML);
      host.save({ ...host.config, analysis_id: analysisId, turnHtml });
    }

    /* Which per-turn editable root (if any) the current selection sits in --
     * see the module comment for why there are several roots instead of one. */
    function activeTurnRoot() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const node = sel.getRangeAt(0).commonAncestorContainer;
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return el?.closest('.analyze-turn[contenteditable="true"]') || null;
    }

    function wireTurnEditing(turnEl, index) {
      turnEl.dataset.turnIndex = String(index);
      turnEl.contentEditable = "true";
      turnEl.spellcheck = false;

      // Same plain-text-in, plain-text-out discipline as notepad.js: raw HTML
      // is never trusted in from the clipboard or the browser's own Enter
      // behaviour, only what rich-text.js's sanitizeHtml explicitly allows.
      turnEl.addEventListener("paste", (event) => {
        event.preventDefault();
        insertPlainText(event.clipboardData.getData("text/plain"));
        persistTurn(turnEl);
      });
      turnEl.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        insertPlainText("\n");
        persistTurn(turnEl);
      });
      turnEl.addEventListener("input", () => {
        pruneEmptySpans(turnEl);
        persistTurn(turnEl);
      });
      turnEl.addEventListener("blur", () => persistTurn(turnEl));
    }

    makeFormattable(host, {
      // No whole-widget typography channel -- every one of the seven rich
      // fields here goes through richText below instead, same split
      // notepad.js uses. contentScale is the one field that isn't
      // per-selection, so it still goes through get/set.
      get: () => ({ contentScale: host.config?.contentScale }),
      set: ({ contentScale }) => {
        host.save({ ...host.config, contentScale });
        applyScale();
      },
      richText: {
        getSelectionStyle: () => {
          const root = activeTurnRoot();
          return root ? getSelectionStyle(root) : {};
        },
        applySelectionStyle: (patch) => {
          const root = activeTurnRoot();
          if (!root) return;
          applySelectionStyle(root, patch);
          persistTurn(root);
        },
        clearSelectionStyle: () => {
          const root = activeTurnRoot();
          if (!root) return;
          clearSelectionStyle(root);
          persistTurn(root);
        },
      },
    });

    async function loadAnalysis() {
      view.innerHTML = "";
      if (!analysisId) {
        const p = document.createElement("p");
        p.className = "muted";
        p.textContent = "Choose a saved analysis to show it here.";
        view.appendChild(p);
        return;
      }

      let data;
      try {
        const res = await fetch(`/api/analyses/${analysisId}`);
        if (!res.ok) throw new Error(res.status === 404 ? "This analysis was deleted." : "Couldn't load this analysis.");
        data = await res.json();
      } catch (err) {
        const p = document.createElement("p");
        p.className = "muted";
        p.textContent = err.message;
        view.appendChild(p);
        return;
      }

      references = data.references;

      const date = document.createElement("p");
      date.className = "muted widget-analysis-date";
      date.textContent = new Date(data.date_created).toLocaleString();
      view.appendChild(date);

      const refsRow = document.createElement("div");
      refsRow.className = "grid small widget-analysis-refs";
      for (const ref of data.references) {
        refsRow.appendChild(
          makeCard(ref, () => {
            const idx = references.findIndex((r) => r.id === ref.id);
            if (idx !== -1) carousel.open(references, idx);
          })
        );
      }
      view.appendChild(refsRow);

      const transcriptEl = document.createElement("div");
      transcriptEl.className = "analyze-transcript widget-analysis-transcript";
      renderTranscript(transcriptEl, data.transcript, buildAnalysisRefMap(data.references));

      // Upgrade each read-only turn to editable, overriding its content with
      // whatever styling this widget has saved for it -- display only, the
      // analyses row above was never touched.
      [...transcriptEl.children].forEach((turnEl, index) => {
        if (turnHtml[index] != null) turnEl.innerHTML = sanitizeHtml(turnHtml[index]);
        wireTurnEditing(turnEl, index);
      });

      view.appendChild(transcriptEl);
    }

    async function openPicker() {
      picker.hidden = false;
      view.hidden = true;
      changeBtn.hidden = true;
      picker.innerHTML = "";

      const loading = document.createElement("p");
      loading.className = "muted";
      loading.textContent = "Loading…";
      picker.appendChild(loading);

      const res = await fetch(`/api/projects/${projectId}/analyses`);
      const analyses = res.ok ? await res.json() : [];
      picker.innerHTML = "";

      if (!analyses.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No saved analyses in this project yet.";
        picker.appendChild(empty);
      }

      for (const a of analyses) {
        picker.appendChild(makePickerItem(a));
      }

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn widget-analysis-picker-cancel";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", closePicker);
      picker.appendChild(cancelBtn);
    }

    function makePickerItem(a) {
      const item = document.createElement("div");
      item.className = "analysis-list-item widget-analysis-picker-item";
      item.addEventListener("click", () => {
        analysisId = a.id;
        turnHtml = [];
        host.save({ ...host.config, analysis_id: analysisId, turnHtml });
        changeBtn.textContent = "Change";
        closePicker();
      });

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
      for (const ref of a.preview) {
        const thumb = document.createElement("div");
        thumb.className = "analysis-thumb";
        const img = document.createElement("img");
        img.src = `/media/${ref.id}/thumb`;
        img.alt = ref.title;
        img.onerror = () => img.remove();
        thumb.appendChild(img);
        refsRow.appendChild(thumb);
      }
      item.appendChild(refsRow);

      return item;
    }

    function closePicker() {
      picker.hidden = true;
      view.hidden = false;
      changeBtn.hidden = false;
      loadAnalysis();
    }

    changeBtn.addEventListener("click", openPicker);

    loadAnalysis();

    return {
      destroy() {
        wrap.remove();
      },
    };
  },
};
