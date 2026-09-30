/* Supporting documents: a workshop and materials list, a reading list, a
 * technical handout -- attached to a project alongside its one brief, parsed,
 * proposed, reviewed and applied through the same shape brief-import.js uses
 * (session 15's path), but for a different family of document with two of
 * its own concerns: a session it names is informational only (never a task --
 * see supporting_docs.py's module docstring), and a group-split date is
 * reconciled against the user's own group before it's even offered.
 *
 * A project may carry several, unlike the one brief, so this owns a small
 * list (#supporting-doc-list) rather than a single banner.
 */
import { el, field, input, reviewRow, dateSuspectFlag, DATE } from "./brief-import.js";

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".pdf,.docx";
fileInput.hidden = true;
document.body.appendChild(fileInput);

let overlay = null;
let box = null;

function ensureOverlay() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  box = document.createElement("div");
  box.className = "modal-box brief-review-box";
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay && !overlay.hidden) overlay.hidden = true;
  });
  document.body.appendChild(overlay);
}

// group_match ("mine"/"unresolved") comes from supporting_docs.resolve_group_scope
// -- "other" is never sent to the browser at all, it was dropped server-side.
function groupMatchFlag(item) {
  if (item.group_match !== "unresolved") return null;
  const named = item.group ? `"${item.group}"` : "a group";
  return `couldn't match ${named} to your own group -- check before approving`;
}

// Sessions are informational only -- see the module docstring -- so this is a
// plain annotated line, never a reviewable/toggleable row.
function sessionRow(container, s) {
  const row = el("div", "brief-row brief-row--matched");
  const flags = [s.group, s.matched_commitment === false ? "not found on your timetable" : null]
    .filter(Boolean);
  flags.forEach((f) => row.append(el("span", "brief-flag dr-micro", f)));
  const body = el("div", "brief-row-body dr-body", `${s.label || "Session"} — ${DATE(s.date) || "no date given"}`);
  row.append(body);
  container.append(row);
}

function prepTaskRow(container, t) {
  const flags = [groupMatchFlag(t), dateSuspectFlag(t)];
  const { row, accepted, body } = reviewRow(true, flags);
  const title = input("text", t.title || "");
  const due = input("date", DATE(t.due_date));
  const grid = el("div", "brief-field-grid");
  grid.append(field("Task", title), field("Due date", due));
  body.append(grid);
  if (t.note) body.append(el("p", "brief-note dr-body", t.note));
  container.append(row);
  return () => {
    if (!accepted() || !title.value.trim() || !due.value) return null;
    return {
      source_key: t.source_key || null,
      title: title.value.trim(),
      description: (t.note || "").trim() || null,
      due_date: due.value,
    };
  };
}

function renderReview(doc, { onApplied }) {
  ensureOverlay();
  overlay.hidden = false;
  box.innerHTML = "";

  const extraction = (doc.extracted && doc.extracted.extraction) || {};

  const head = el("div", "dr-titleblock");
  const headField = el("div", "dr-titleblock-field");
  headField.append(el("span", "dr-micro", "Reviewing supporting document"));
  headField.append(el("h3", "dr-title panel-title", "Nothing enters the schedule unapproved"));
  head.append(headField);
  const fileLink = document.createElement("a");
  fileLink.className = "btn";
  fileLink.href = `/api/supporting-documents/${doc.id}/file`;
  fileLink.target = "_blank";
  fileLink.rel = "noopener";
  fileLink.textContent = "Original document";
  head.append(fileLink);
  box.append(head);

  if (extraction.summary) box.append(el("p", "brief-summary dr-body", extraction.summary));

  const sections = el("div", "brief-sections");

  const sessionsWrap = el("div", "brief-section");
  sessionsWrap.append(el("p", "dr-label", "Sessions this document mentions"));
  const sessionsList = el("div", "brief-list");
  sessionsWrap.append(sessionsList);
  const sessions = extraction.sessions || [];
  sessions.forEach((s) => sessionRow(sessionsList, s));
  if (!sessions.length) sessionsWrap.append(el("p", "muted", "None found."));
  sessionsWrap.append(el("p", "muted brief-reimport-note",
    "Informational only — a session already on your timetable is never turned into a task."));

  const prepWrap = el("div", "brief-section");
  prepWrap.append(el("p", "dr-label", "Preparation to do beforehand"));
  const prepList = el("div", "brief-list");
  prepWrap.append(prepList);
  const preparation = extraction.preparation_tasks || [];
  const prepBuilders = preparation.map((t) => prepTaskRow(prepList, t));
  if (!prepBuilders.length) prepWrap.append(el("p", "muted", "None found."));

  sections.append(sessionsWrap, prepWrap);
  box.append(sections);

  const status = el("p", "muted brief-status");
  box.append(status);

  const actions = el("div", "modal-actions");
  const discard = el("button", "btn", "Discard");
  discard.addEventListener("click", () => { overlay.hidden = true; });

  const approve = el("button", "btn primary", "Approve selected");
  approve.addEventListener("click", async () => {
    approve.disabled = true;
    status.textContent = "Applying…";
    const payload = { preparation_tasks: prepBuilders.map((b) => b()).filter(Boolean) };
    try {
      const res = await fetch(`/api/supporting-documents/${doc.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        status.textContent = `Error: ${data.error || res.status}`;
        approve.disabled = false;
        return;
      }
      overlay.hidden = true;
      onApplied();
    } catch (err) {
      status.textContent = `Error: ${err}`;
      approve.disabled = false;
    }
  });

  actions.append(discard, approve);
  box.append(actions);
}

async function openReview(docId, onApplied) {
  const doc = await fetch(`/api/supporting-documents/${docId}`).then((r) => r.json());
  if (!doc || doc.error) return;
  renderReview(doc, { onApplied });
}

// --- the list on the Deliverables tab ---------------------------------

const listEl = document.getElementById("supporting-doc-list");

function renderRow(doc, onChanged) {
  const row = el("p", "dr-micro supporting-doc-row");
  const when = new Date(doc.imported_at).toLocaleDateString();
  const applied = doc.extracted && doc.extracted.applied;
  row.append(document.createTextNode(`${doc.filename || "Supporting document"} — added ${when}. `));

  const review = document.createElement("button");
  review.className = "btn";
  review.textContent = applied ? "Review again" : "Review & approve";
  review.addEventListener("click", () => openReview(doc.id, onChanged));
  row.append(review, document.createTextNode(" "));

  const remove = document.createElement("button");
  remove.className = "btn";
  remove.textContent = "Remove";
  remove.addEventListener("click", async () => {
    if (!confirm(
      `Remove "${doc.filename || "this document"}"? Tasks already applied from it are kept -- ` +
      "only the document and its proposal go.",
    )) return;
    await fetch(`/api/supporting-documents/${doc.id}`, { method: "DELETE" });
    onChanged();
  });
  row.append(remove);
  return row;
}

export function initSupportingDocImport({ getProjectId, onApplied }) {
  const btn = document.getElementById("supporting-doc-import-btn");
  if (!btn || !listEl) return { setEnabled() {}, refresh() {} };

  btn.addEventListener("click", () => {
    if (!getProjectId()) return;
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    const projectId = getProjectId();
    if (!file || !projectId) return;

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Reading the document…";
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/supporting-documents`, {
        method: "POST", body,
      });
      const doc = await res.json();
      if (!res.ok) {
        alert(doc.error || `Couldn't read that document (${res.status})`);
        return;
      }
      renderReview(doc, { onApplied: () => { onApplied(); refreshList(projectId); } });
      refreshList(projectId);
    } catch (err) {
      alert(`Couldn't read that document: ${err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  async function refreshList(projectId) {
    if (!projectId) {
      listEl.innerHTML = "";
      return;
    }
    const docs = await fetch(`/api/projects/${projectId}/supporting-documents`).then((r) => r.json());
    listEl.innerHTML = "";
    docs.forEach((doc) => listEl.appendChild(
      renderRow(doc, () => { onApplied(); refreshList(projectId); }),
    ));
  }

  return {
    setEnabled(on) { btn.disabled = !on; },
    refresh: refreshList,
  };
}
