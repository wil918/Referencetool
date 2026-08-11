/* A container widget: a compact button on the grid that slides a panel in
 * from the page edge, holding whatever widgets are parented to it.
 *
 * container: true -- the only thing so far that can hold other widgets.
 * Containers may hold leaf widgets, never other containers, and nesting is
 * one level deep by design (app.py's CONTAINER_WIDGET_TYPES/_nesting_error
 * enforce this server-side; the two places below marked "anti-stacking"
 * enforce it in the UI as well, so a container never even appears as an
 * option where it isn't legal).
 *
 * The grid tile (host.el) is only ever the button -- the panel itself is
 * page-level chrome appended to <body>, the same way main.js's floating edit
 * bar and Add Widget dock live outside any widget's element. This isn't
 * optional here: grid.js moves a dragged widget with a CSS transform on its
 * wrapper, and a transform on an ancestor becomes the containing block for a
 * `position: fixed` descendant, so a full-height edge panel nested inside
 * host.el would track that box instead of the viewport and could never
 * "slide in from the edge of the page".
 *
 * config: { label, side: "left"|"right", width }
 */

import { definitionFor, mountWidget, all as allWidgetDefinitions } from "../registry.js";

const DEFAULT_WIDTH = 340;

// Panels open on the same edge stack outward from that edge instead of
// overlapping -- shared across every sidebar instance on the page, since
// that's the only scope in which "two sidebars on the same side" is even a
// question.
const openPanels = { left: [], right: [] };

function reflow(side) {
  let offset = 0;
  for (const panel of openPanels[side]) {
    panel.style[side] = `${offset}px`;
    offset += panel.getBoundingClientRect().width;
  }
}

export default {
  type: "sidebar",
  label: "Sidebar",
  container: true,
  permanent: false,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },

  create(host) {
    let side = host.config?.side === "left" ? "left" : "right";
    let width = Number(host.config?.width) > 0 ? Number(host.config.width) : DEFAULT_WIDTH;
    let label = host.config?.label || "Sidebar";
    let open = false;

    function persist() {
      host.save({ ...host.config, label, side, width });
    }

    // --- the grid tile: a compact button, same footprint as settings/exit ---

    const wrap = document.createElement("div");
    wrap.className = "widget-sidebar";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn widget-sidebar-btn";
    btn.title = "Open sidebar";

    const icon = document.createElement("span");
    icon.className = "widget-sidebar-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▤";
    btn.appendChild(icon);

    const tileLabel = document.createElement("span");
    tileLabel.className = "widget-sidebar-label";
    tileLabel.textContent = label;
    btn.appendChild(tileLabel);

    wrap.appendChild(btn);
    host.el.appendChild(wrap);

    // --- the sliding panel -----------------------------------------------

    const panel = document.createElement("div");
    panel.className = "sidebar-panel";

    const header = document.createElement("div");
    header.className = "sidebar-panel-header";
    panel.appendChild(header);

    // A styled, always-present input rather than swapping in a heading --
    // readOnly outside edit mode keeps it looking like plain text (style.css)
    // without a second element to keep in sync.
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "sidebar-panel-label";
    labelInput.setAttribute("aria-label", "Sidebar label");
    labelInput.value = label;
    labelInput.readOnly = true;
    header.appendChild(labelInput);

    const flipBtn = document.createElement("button");
    flipBtn.type = "button";
    flipBtn.className = "btn sidebar-panel-flip";
    flipBtn.title = "Move to the other edge";
    flipBtn.setAttribute("aria-label", "Move to the other edge");
    flipBtn.textContent = "⇋";
    header.appendChild(flipBtn);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn sidebar-panel-close";
    closeBtn.setAttribute("aria-label", "Close sidebar");
    closeBtn.textContent = "×";
    header.appendChild(closeBtn);

    const errorEl = document.createElement("p");
    errorEl.className = "sidebar-panel-error muted";
    errorEl.hidden = true;
    panel.appendChild(errorEl);

    const list = document.createElement("div");
    list.className = "sidebar-panel-list";
    panel.appendChild(list);

    const addWrap = document.createElement("div");
    addWrap.className = "sidebar-panel-add";
    panel.appendChild(addWrap);

    const addToggle = document.createElement("button");
    addToggle.type = "button";
    addToggle.className = "btn sidebar-panel-add-toggle";
    addToggle.textContent = "+ Add widget";
    addWrap.appendChild(addToggle);

    const addList = document.createElement("div");
    addList.className = "sidebar-panel-add-list";
    addList.hidden = true;
    addWrap.appendChild(addList);

    document.body.appendChild(panel);

    function applyGeometry() {
      panel.classList.toggle("side-left", side === "left");
      panel.classList.toggle("side-right", side === "right");
      panel.style.width = `${width}px`;
    }
    applyGeometry();

    function showError(message) {
      errorEl.textContent = message || "Something went wrong.";
      errorEl.hidden = false;
      clearTimeout(showError.timer);
      showError.timer = setTimeout(() => {
        errorEl.hidden = true;
      }, 4000);
    }

    // --- open/close ---------------------------------------------------------

    function onOutsidePointer(event) {
      // "Outside" means outside every sidebar's chrome, not just this one --
      // otherwise opening a second sidebar would read as an outside click on
      // the first and close it, which defeats "two sidebars open at once".
      if (event.target.closest(".sidebar-panel, .widget-sidebar")) return;
      setOpen(false);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }

    function setOpen(next) {
      if (open === next) return;
      open = next;
      panel.classList.toggle("is-open", open);
      btn.classList.toggle("is-active", open);

      const bucket = openPanels[side];
      const at = bucket.indexOf(panel);
      if (open && at === -1) bucket.push(panel);
      else if (!open && at !== -1) bucket.splice(at, 1);
      reflow(side);

      if (open) {
        renderChildren();
        document.addEventListener("pointerdown", onOutsidePointer, true);
        document.addEventListener("keydown", onKeyDown);
      } else {
        document.removeEventListener("pointerdown", onOutsidePointer, true);
        document.removeEventListener("keydown", onKeyDown);
      }
    }

    btn.addEventListener("click", () => setOpen(!open));
    closeBtn.addEventListener("click", () => setOpen(false));

    labelInput.addEventListener("change", () => {
      label = labelInput.value.trim() || "Sidebar";
      labelInput.value = label;
      tileLabel.textContent = label;
      persist();
    });

    flipBtn.addEventListener("click", () => {
      const from = side;
      side = side === "left" ? "right" : "left";
      if (open) {
        const at = openPanels[from].indexOf(panel);
        if (at !== -1) openPanels[from].splice(at, 1);
        openPanels[side].push(panel);
        reflow(from);
      }
      panel.style.removeProperty(from);
      applyGeometry();
      reflow(side);
      persist();
    });

    // --- add widget -----------------------------------------------------

    // Anti-stacking, enforced here too, not just server-side: a sidebar's own
    // Add Widget list excludes every container (nesting is one level deep)
    // and every permanent widget (settings/exit/canvas are homepage fixtures,
    // not panel contents).
    function eligibleChildTypes() {
      return allWidgetDefinitions().filter((definition) => !definition.container && !definition.permanent);
    }

    function buildAddList() {
      addList.innerHTML = "";
      for (const definition of eligibleChildTypes()) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "btn sidebar-panel-add-item";
        item.textContent = definition.label;
        item.addEventListener("click", async () => {
          addList.hidden = true;
          const result = await host.children.add(definition.type);
          if (!result.ok) showError(result.error);
        });
        addList.appendChild(item);
      }
    }
    buildAddList();

    addToggle.addEventListener("click", () => {
      addList.hidden = !addList.hidden;
    });

    // --- children ---------------------------------------------------------

    const childInstances = new Map(); // id -> { row: <element>, handle }

    function mountChild(row) {
      const item = document.createElement("div");
      item.className = "sidebar-child";
      item.dataset.id = row.id;

      const grip = document.createElement("span");
      grip.className = "sidebar-child-grip";
      grip.setAttribute("aria-hidden", "true");
      grip.textContent = "⠿";
      item.appendChild(grip);

      const body = document.createElement("div");
      body.className = "widget-body sidebar-child-body";
      item.appendChild(body);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "sidebar-child-remove";
      removeBtn.setAttribute("aria-label", "Remove widget");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        const result = await host.children.remove(row.id);
        if (!result.ok) showError(result.error);
      });
      item.appendChild(removeBtn);

      const handle = mountWidget(definitionFor(row.type), body, {
        project: host.project,
        config: row.config,
        persist: (config) => host.children.persistConfig(row.id, config),
        shell: null,
        editMode: host.editMode,
      });

      grip.addEventListener("pointerdown", (event) => beginReorder(event, item));

      return { row: item, handle };
    }

    // A single-column swap-on-cross reorder, not the grid's cell-snapping
    // gesture -- this list is one column wide, so there is nothing to snap to
    // but "above" or "below" a neighbour.
    function beginReorder(event, item) {
      if (!host.editMode.isEditing()) return;
      event.preventDefault();
      item.classList.add("is-dragging");

      function onMove(moveEvent) {
        const siblings = [...list.children];
        const y = moveEvent.clientY;
        for (const sibling of siblings) {
          if (sibling === item) continue;
          const rect = sibling.getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          if (y < mid) {
            list.insertBefore(item, sibling);
            return;
          }
        }
        list.appendChild(item);
      }

      async function onUp() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        item.classList.remove("is-dragging");
        const order = [...list.children].map((el) => el.dataset.id);
        const result = await host.children.reorder(order);
        if (!result.ok) showError(result.error);
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }

    function renderChildren() {
      const children = host.children.list();
      const wanted = new Set(children.map((child) => child.id));

      for (const [id, instance] of [...childInstances]) {
        if (wanted.has(id)) continue;
        instance.handle.destroy();
        instance.row.remove();
        childInstances.delete(id);
      }

      let changed = children.length !== list.children.length;
      if (!changed) {
        changed = children.some((child, index) => list.children[index]?.dataset.id !== child.id);
      }

      for (const child of children) {
        if (!childInstances.has(child.id)) {
          childInstances.set(child.id, mountChild(child));
          changed = true;
        }
      }

      if (changed) {
        for (const child of children) list.appendChild(childInstances.get(child.id).row);
        for (const child of children) {
          const instance = childInstances.get(child.id);
          instance.handle.notifyResize(instance.row.clientWidth, instance.row.clientHeight);
        }
      }
    }

    const unsubscribeChildren = host.children.subscribe(() => {
      if (open) renderChildren();
    });

    const unsubscribeEditMode = host.editMode.subscribe((editing) => {
      panel.classList.toggle("is-editing", editing);
      labelInput.readOnly = !editing;
      if (!editing) addList.hidden = true;
    });

    // --- receiving a widget dragged out of the grid (grid.js's move handle) -

    panel.addEventListener("dragover", (event) => {
      if (!host.editMode.isEditing()) return;
      if (!event.dataTransfer.types.includes("application/x-widget-id")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });

    panel.addEventListener("drop", async (event) => {
      const widgetId = event.dataTransfer.getData("application/x-widget-id");
      if (!widgetId) return;
      event.preventDefault();
      const result = await host.children.moveIn(widgetId);
      if (!result.ok) showError(result.error);
    });

    host.onDestroy(() => {
      unsubscribeChildren();
      unsubscribeEditMode();
      document.removeEventListener("pointerdown", onOutsidePointer, true);
      document.removeEventListener("keydown", onKeyDown);
      const bucket = openPanels[side];
      const at = bucket.indexOf(panel);
      if (at !== -1) bucket.splice(at, 1);
      reflow(side);
      for (const instance of childInstances.values()) instance.handle.destroy();
      panel.remove();
    });

    return {
      destroy() {
        wrap.remove();
      },
    };
  },
};
