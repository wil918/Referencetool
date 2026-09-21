// Reference cards shared by the Archive grid, the Project grid, project bar
// previews, analysis thumbnails and colour-search results. Pure DOM builders
// with no side effects on import -- every element and listener is created
// only when a caller invokes one of these.

const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
};

// The HTML5 "DownloadURL" drag-out (dataTransfer.setData with this specific
// type string, read by the OS drop target instead of the page) is a
// Chromium-only convention -- there's no DOM API to feature-detect, since
// Safari/WebKit happily accepts the setData call and then just does nothing
// with it on drop. Confirmed working in Chrome, Edge, Brave, Opera and other
// Chromium forks (all carry "Chrome/" or "Edg/" in the UA string); NOT
// WebKit -- real Safari, or the WKWebView desktop.py wraps -- which is why
// attachDownload() below always adds the plain download button but only
// wires up dragstart when this is true. Checked once at module load, not
// per drag.
const supportsDownloadURLDrag = /Chrome|Chromium|Edg\//.test(navigator.userAgent);

function safeDragFilename(title, ext) {
  const cleaned = (title || "reference").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
  return `${cleaned || "reference"}${ext || ""}`;
}

/** Adds a small "download this file" control to a card, always visible on
 *  hover, plus (where the engine supports it -- see supportsDownloadURLDrag
 *  above) a native drag-out straight into Finder/InDesign/Photoshop. Opt-in
 *  per grid rather than folded into makeCard itself: canvas reference nodes
 *  also build cards via makeCard, and already have their own pointer-driven
 *  drag for repositioning (project/canvas/nodes.js) that a native HTML5
 *  drag would compete with. Only the Archive grid and the project grid call
 *  this. When drag-out isn't supported, the card is left non-draggable --
 *  the download button is the fallback, not a gesture that silently does
 *  nothing (per CLAUDE.md session brief). */
export function attachDownload(card, ref) {
  const btn = document.createElement("a");
  btn.className = "card-download-btn";
  btn.href = `/media/${ref.id}/download`;
  btn.title = "Download";
  btn.setAttribute("aria-label", "Download");
  btn.textContent = "⤓"; // downwards arrow to bar
  btn.addEventListener("click", (e) => e.stopPropagation());
  card.appendChild(btn);

  if (!supportsDownloadURLDrag) return;
  card.draggable = true;
  card.addEventListener("dragstart", (e) => {
    const mime = MIME_BY_EXT[ref.ext] || "application/octet-stream";
    const filename = safeDragFilename(ref.title, ref.ext);
    const url = new URL(`/media/${ref.id}/download`, window.location.href).href;
    e.dataTransfer.setData("DownloadURL", `${mime}:${filename}:${url}`);
    e.dataTransfer.effectAllowed = "copy";
  });
}

/** A grid card: thumbnail (falling back to a text placeholder), title
 *  caption, own-work badge and optional match label. `onClick` is whatever
 *  the caller wants a click to do -- open the carousel, toggle selection. */
export function makeCard(ref, onClick) {
  const card = document.createElement("div");
  card.className = "card";
  card.addEventListener("click", onClick);

  if (ref.is_own_work) {
    const badge = document.createElement("span");
    badge.className = "own-work-badge card-badge";
    badge.textContent = "Own work";
    card.appendChild(badge);
  }

  // Always try a thumbnail first (works for images and PDFs); plain-text
  // references 404 on /thumb, so fall back to the text placeholder card.
  const img = document.createElement("img");
  img.src = `/media/${ref.id}/thumb`;
  img.alt = ref.title;
  img.onerror = () => {
    img.remove();
    card.prepend(textCard(ref));
  };
  card.appendChild(img);

  const caption = document.createElement("div");
  caption.className = "card-caption";
  caption.textContent = ref.title;
  card.appendChild(caption);

  if (ref.match_label) {
    const label = document.createElement("div");
    label.className = "match-label";
    label.textContent = ref.match_label;
    card.appendChild(label);
  }

  return card;
}

/** Adds the checkbox overlay + selected styling used by every selectable grid. */
export function markSelectable(card, isSelected) {
  card.classList.add("selectable");
  if (isSelected) card.classList.add("selected");
  const check = document.createElement("span");
  check.className = "card-select-check";
  card.appendChild(check);
}

/** The fallback shown in place of a thumbnail. A PDF lands here only if its
 *  own render failed (a corrupt file, say) -- there's no text to fall back
 *  to, so that case stays the plain icon-plus-description placeholder it
 *  always was. A genuine plain-text reference gets its actual contents
 *  instead, styled like a notepad. */
export function textCard(ref) {
  const div = document.createElement("div");
  div.className = "text-card";

  if (ref.ext === ".pdf") {
    div.classList.add("text-card-placeholder");
    const icon = document.createElement("span");
    icon.className = "text-card-icon";
    icon.textContent = "PDF";
    const desc = document.createElement("p");
    desc.textContent = ref.description || "";
    div.appendChild(icon);
    div.appendChild(desc);
    return div;
  }

  // Scrollable, clipped rather than expandable -- there is no expand
  // control, so a long file just clips instead of growing the card. The
  // reference's title is not repeated in here: makeCard's own .card-caption
  // already renders it as a sibling right after this element, which is what
  // keeps the title visible while this scrolls (on the grid it sits in the
  // card's normal flow below this fixed-size square; on the canvas,
  // .canvas-node-reference's flex layout pins it at a fixed height at the
  // bottom of the node -- style.css).
  //
  // READ ONLY. This looks like a notepad; it is not one. Editing a
  // reference's text here would mean rewriting an archive file, which
  // nothing else in the app does.
  div.classList.add("text-card-notepad");
  div.textContent = "Loading…";

  // Fetched lazily -- only once this card is actually built, not for every
  // text reference in a list -- and through the existing /media/<id> route
  // rather than a new one, so file contents never ride along in the
  // reference list payload itself.
  fetch(`/media/${ref.id}`)
    .then((res) => (res.ok ? res.text() : Promise.reject()))
    .then((text) => {
      div.textContent = text;
    })
    .catch(() => {
      div.textContent = ref.description || "";
    });

  return div;
}

/** The small square thumbnail used in project bars, colour results and
 *  analysis list previews -- an icon-only fallback rather than textCard's
 *  full description block, since these sit in a narrow row.
 *
 *  `showTitleForText` adds the reference's title under the icon, but only
 *  for a genuine text reference (a PDF's icon is already a rare fallback --
 *  its own render failed -- and doesn't need the same treatment). Off by
 *  default: every "TXT" icon otherwise looks identical, which is fine in a
 *  strip of thumbnails sized for a bare square (a project bar, a colour
 *  result row) but not in a picker where several text references sit side
 *  by side with nothing else distinguishing them -- canvas/palette.js's
 *  reference picker is the one caller that opts in. */
export function makeBarThumb(ref, { showTitleForText = false } = {}) {
  const thumb = document.createElement("div");
  thumb.className = "bar-thumb";
  const img = document.createElement("img");
  img.src = `/media/${ref.id}/thumb`;
  img.alt = ref.title;
  img.onerror = () => {
    img.remove();
    const isPdf = ref.ext === ".pdf";
    const icon = document.createElement("span");
    icon.className = "text-card-icon";
    icon.textContent = isPdf ? "PDF" : "TXT";
    thumb.appendChild(icon);
    if (showTitleForText && !isPdf) {
      thumb.classList.add("bar-thumb-titled");
      const label = document.createElement("span");
      label.className = "bar-thumb-title";
      label.textContent = ref.title;
      thumb.appendChild(label);
    }
  };
  thumb.appendChild(img);
  return thumb;
}
