/* The Add Widget dock -- a "+" FAB, bottom-right, that appears while the
 * grid is being edited (main.js wires setVisible to the same shell.subscribe
 * the floating edit bar and appearance panel use). Not a widget itself --
 * this is page-level chrome parallel to the floating edit bar, so it talks
 * to main.js's own addWidget/grid geometry directly rather than through the
 * widget host contract.
 *
 * Each addable type (shell.addableTypes() -- already excludes permanent
 * types, so this naturally surfaces Title/Text/Notepad and nothing else)
 * gets a small stacked "deck" card. Dragging a card onto the grid places a
 * widget at the drop cell, falling back to the default bottom-of-grid
 * position (today's only placement) if that cell is already occupied;
 * clicking a card is the same fallback, for touch and keyboard use -- native
 * drag-and-drop suppresses the trailing click after a real drag completes,
 * so no click-vs-drag disambiguation is needed here.
 */

export function createWidgetDock({ gridEl, addableTypes, addWidget, cellFromPoint, wouldFit }) {
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "widget-dock-fab";
  fab.setAttribute("aria-label", "Add widget");
  fab.title = "Add widget";
  fab.hidden = true;
  fab.textContent = "+";

  const panel = document.createElement("div");
  panel.className = "widget-dock-panel";
  panel.hidden = true;

  const search = document.createElement("input");
  search.type = "search";
  search.className = "widget-dock-search";
  search.placeholder = "Search widgets…";
  search.setAttribute("aria-label", "Search widgets");
  panel.appendChild(search);

  const list = document.createElement("div");
  list.className = "widget-dock-list";
  panel.appendChild(list);

  const definitions = addableTypes();
  let dragType = null;

  for (const definition of definitions) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "widget-dock-card";
    card.draggable = true;
    card.dataset.label = definition.label.toLowerCase();

    // Two inert layers behind the real (top) one -- purely decorative, what
    // makes one card read as a deck instead of a single tile.
    const layerBack = document.createElement("div");
    layerBack.className = "widget-dock-card-layer";
    card.appendChild(layerBack);

    const layerMid = document.createElement("div");
    layerMid.className = "widget-dock-card-layer";
    card.appendChild(layerMid);

    const top = document.createElement("div");
    top.className = "widget-dock-card-top";
    // An extension point for future resource-heavy widgets (a Three.js
    // scene, say) -- nothing in the registry sets this yet, so cards fall
    // back to the label alone until one does.
    if (definition.thumbnail) {
      const img = document.createElement("img");
      img.src = definition.thumbnail;
      img.alt = "";
      top.appendChild(img);
    }
    const labelEl = document.createElement("span");
    labelEl.textContent = definition.label;
    top.appendChild(labelEl);
    card.appendChild(top);

    card.addEventListener("dragstart", (event) => {
      dragType = definition.type;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/plain", definition.type);
    });
    card.addEventListener("dragend", () => {
      dragType = null;
    });
    card.addEventListener("click", () => addWidget(definition.type));

    list.appendChild(card);
  }

  function onDragOver(event) {
    if (!dragType) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDrop(event) {
    if (!dragType) return;
    event.preventDefault();
    const definition = definitions.find((d) => d.type === dragType);
    const size = (definition && definition.defaultSize) || { w: 3, h: 2 };
    const { x, y } = cellFromPoint(event.clientX, event.clientY, size.w, size.h);
    const box = { x, y, w: size.w, h: size.h };
    addWidget(dragType, wouldFit(box) ? { x, y } : null);
    dragType = null;
  }

  gridEl.addEventListener("dragover", onDragOver);
  gridEl.addEventListener("drop", onDrop);

  fab.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    // The FAB sits above the panel (style.css) so it's always reachable,
    // even while the panel is open -- swapping the glyph to an × makes it
    // read as "close" instead of a second, confusing "+".
    fab.textContent = panel.hidden ? "+" : "×";
  });

  // Filters by label rather than closing the dock -- these are exactly the
  // widget types meant to be added more than once in a row, so the dock
  // stays open after every add too (see the click/drop handlers above).
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    for (const card of list.children) {
      card.hidden = query.length > 0 && !card.dataset.label.includes(query);
    }
  });

  document.body.appendChild(panel);
  document.body.appendChild(fab);

  return {
    setVisible(visible) {
      fab.hidden = !visible;
      // Edit mode ending is the one moment the dock has to close on its
      // own -- otherwise it's only ever the FAB's business.
      if (!visible) {
        panel.hidden = true;
        fab.textContent = "+";
      }
    },
  };
}
