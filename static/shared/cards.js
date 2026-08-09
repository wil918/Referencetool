// Reference cards shared by the Archive grid, the Project grid, project bar
// previews, analysis thumbnails and colour-search results. Pure DOM builders
// with no side effects on import -- every element and listener is created
// only when a caller invokes one of these.

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

export function textCard(ref) {
  const div = document.createElement("div");
  div.className = "text-card";
  const icon = document.createElement("span");
  icon.className = "text-card-icon";
  icon.textContent = ref.ext === ".pdf" ? "PDF" : "TXT";
  const desc = document.createElement("p");
  desc.textContent = ref.description || "";
  div.appendChild(icon);
  div.appendChild(desc);
  return div;
}

/** The small square thumbnail used in project bars, colour results and
 *  analysis list previews -- an icon-only fallback rather than textCard's
 *  full description block, since these sit in a narrow row. */
export function makeBarThumb(ref) {
  const thumb = document.createElement("div");
  thumb.className = "bar-thumb";
  const img = document.createElement("img");
  img.src = `/media/${ref.id}/thumb`;
  img.alt = ref.title;
  img.onerror = () => {
    img.remove();
    const icon = document.createElement("span");
    icon.className = "text-card-icon";
    icon.textContent = ref.ext === ".pdf" ? "PDF" : "TXT";
    thumb.appendChild(icon);
  };
  thumb.appendChild(img);
  return thumb;
}
