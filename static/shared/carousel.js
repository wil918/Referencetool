// The full-screen reference viewer: media, metadata, "add to project" and
// the similar-items panel. No side effects on import -- the DOM is only
// queried and listeners only attached the first time open() is called, so
// importing this module on a page with no carousel markup is harmless.
//
// The module owns its own list/index rather than reaching for a page
// global: callers pass whatever list the clicked card came from (the
// archive grid, a project grid, an analysis preview, ...), and prev/next
// and the similar-items jump all operate on that same list.

import { makeCard } from "./cards.js";

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];

let list = [];
let index = -1;
let initialized = false;
let els = {};

// Set by the host page via configure() so the "+ New project..." option can
// reuse its existing create-project modal instead of this module growing a
// second one. Receives the same (onCreated) callback openNewProjectModal
// already expects.
let onCreateProject = null;

export function configure({ onCreateProject: cb } = {}) {
  onCreateProject = cb;
}

function ensureInit() {
  if (initialized) return;
  initialized = true;

  els.overlay = document.getElementById("carousel-overlay");
  els.media = document.getElementById("carousel-media");
  els.title = document.getElementById("info-title");
  els.type = document.getElementById("info-type");
  els.ownWork = document.getElementById("info-own-work");
  els.tags = document.getElementById("info-tags");
  els.description = document.getElementById("info-description");
  els.source = document.getElementById("info-source");
  els.notes = document.getElementById("info-notes");
  els.projectSelect = document.getElementById("carousel-project-select");
  els.projectStatus = document.getElementById("carousel-project-status");
  els.similarGrid = document.getElementById("similar-grid");

  document.getElementById("carousel-prev").addEventListener("click", () => {
    index = (index - 1 + list.length) % list.length;
    loadItem();
  });
  document.getElementById("carousel-next").addEventListener("click", () => {
    index = (index + 1) % list.length;
    loadItem();
  });
  document.getElementById("carousel-close").addEventListener("click", close);

  els.overlay.addEventListener("click", (e) => {
    if (e.target === els.overlay) close();
  });

  document.addEventListener("keydown", (e) => {
    if (els.overlay.hidden) return;
    if (e.key === "ArrowLeft") document.getElementById("carousel-prev").click();
    if (e.key === "ArrowRight") document.getElementById("carousel-next").click();
    if (e.key === "Escape") close();
  });

  els.projectSelect.addEventListener("change", () => {
    const value = els.projectSelect.value;
    if (!value) return;

    if (value === "__new__") {
      els.projectSelect.value = "";
      if (onCreateProject) {
        onCreateProject((project) => addCurrentReferenceToProject(project.id, project.title));
      }
      return;
    }

    const label = els.projectSelect.options[els.projectSelect.selectedIndex].textContent;
    addCurrentReferenceToProject(value, label);
  });
}

export function open(newList, newIndex) {
  ensureInit();
  list = newList;
  index = newIndex;
  els.overlay.hidden = false;
  loadItem();
}

export function close() {
  if (els.overlay) els.overlay.hidden = true;
}

async function populateProjectSelect() {
  const res = await fetch("/api/projects");
  const projects = await res.json();

  els.projectSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a project…";
  els.projectSelect.appendChild(placeholder);

  projects.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.title;
    els.projectSelect.appendChild(opt);
  });

  const newOpt = document.createElement("option");
  newOpt.value = "__new__";
  newOpt.textContent = "+ New project…";
  els.projectSelect.appendChild(newOpt);
  els.projectSelect.value = "";
}

async function addCurrentReferenceToProject(projectId, projectTitle) {
  const ref = list[index];
  if (!ref) return;
  els.projectStatus.textContent = "Adding...";
  try {
    const res = await fetch(`/api/projects/${projectId}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference_id: ref.id }),
    });
    if (!res.ok) {
      const data = await res.json();
      els.projectStatus.textContent = `Error: ${data.error}`;
      return;
    }
    els.projectStatus.textContent = `Added to "${projectTitle}".`;
  } catch (err) {
    els.projectStatus.textContent = `Error: ${err}`;
  } finally {
    els.projectSelect.value = "";
  }
}

async function loadItem() {
  const ref = list[index];
  if (!ref) return;
  const res = await fetch(`/api/references/${ref.id}`);
  if (!res.ok) return;
  const data = await res.json();

  els.media.innerHTML = "";

  if (data.ext === ".pdf") {
    const iframe = document.createElement("iframe");
    iframe.src = `/media/${data.id}`;
    els.media.appendChild(iframe);
  } else if (IMAGE_EXTS.includes(data.ext)) {
    const img = document.createElement("img");
    img.src = `/media/${data.id}`;
    els.media.appendChild(img);
  } else {
    const pre = document.createElement("pre");
    pre.className = "text-content";
    pre.textContent = "Loading...";
    els.media.appendChild(pre);
    fetch(`/media/${data.id}`)
      .then((r) => r.text())
      .then((t) => (pre.textContent = t));
  }

  els.title.textContent = data.title;
  els.type.textContent = `${data.type}${data.ext ? " · " + data.ext.slice(1) : ""}`;
  els.ownWork.hidden = !data.is_own_work;

  els.tags.innerHTML = "";
  (data.tags || []).forEach((t) => {
    const pill = document.createElement("span");
    pill.className = "tag-pill";
    pill.textContent = t;
    els.tags.appendChild(pill);
  });

  els.description.textContent = data.description || "";
  els.source.textContent = data.source ? `Source: ${data.source}` : "";
  els.notes.textContent = data.notes ? `Notes: ${data.notes}` : "";

  els.projectStatus.textContent = "";
  populateProjectSelect();

  els.similarGrid.innerHTML = "";
  (data.similar || []).forEach((s) => {
    const card = makeCard(s, () => {
      const targetIdx = list.findIndex((r) => r.id === s.id);
      if (targetIdx !== -1) {
        index = targetIdx;
        loadItem();
      }
    });
    els.similarGrid.appendChild(card);
  });
}
