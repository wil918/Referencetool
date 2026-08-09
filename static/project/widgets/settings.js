/* The settings widget: permanent, movable, never deletable.
 *
 * Everything about changing the homepage -- entering edit mode, adding a
 * widget, saving or cancelling a layout, and the project's appearance -- is
 * triggered from here, but none of it happens here. The grid, the edit-mode
 * flag and the widget rows all live in main.js, outside this widget's own
 * element, so this module still only ever touches host.el (per the widget
 * contract in CLAUDE.md) plus host.shell -- the narrow controller main.js
 * hands specifically to this widget for the page-level actions nothing else
 * needs. See registry.js's mountWidget for where host.shell comes from.
 *
 * config: unused. What this widget edits (layout, appearance) is project-wide
 * state with its own persistence, not a per-widget config blob.
 */

export default {
  type: "settings",
  label: "Settings",
  container: false,
  permanent: true,
  defaultSize: { w: 1, h: 1 },
  minSize: { w: 1, h: 1 },

  create(host) {
    const wrap = document.createElement("div");
    wrap.className = "widget-settings";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn widget-settings-btn";
    openBtn.setAttribute("aria-label", "Project settings");
    openBtn.title = "Project settings";
    openBtn.textContent = "⚙";
    wrap.appendChild(openBtn);
    host.el.appendChild(wrap);

    // Appended to <body>, not host.el. position:fixed only escapes the
    // viewport when there is no transformed ancestor, and every .widget
    // carries an inline transform (grid.js's place() sets it for
    // positioning), so a panel nested inside this tile's own tree would be
    // confined to the tile's box instead of covering the page like every
    // other modal in the app.
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.hidden = true;

    const box = document.createElement("div");
    box.className = "modal-box settings-modal";
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    box.innerHTML = `
      <h3>Project Settings</h3>
      <div class="settings-modal-section">
        <button type="button" class="btn settings-edit-toggle" data-role="edit-toggle">Edit Layout</button>
      </div>
      <div class="settings-modal-section" data-role="add-section" hidden>
        <h4>Add Widget</h4>
        <div class="settings-add-widget-list" data-role="add-list"></div>
      </div>
      <div class="settings-modal-section">
        <h4>Appearance</h4>
        <div class="settings-appearance">
          <div class="colour-control">
            <label for="settings-ink">Text colour</label>
            <input type="color" id="settings-ink" data-role="ink">
          </div>
          <div class="colour-control">
            <label for="settings-scale">Default content scale</label>
            <input type="range" id="settings-scale" data-role="scale" min="0.8" max="1.6" step="0.05">
          </div>
          <div class="colour-control">
            <label for="settings-bg">Background</label>
            <input type="color" id="settings-bg" data-role="bg">
          </div>
        </div>
      </div>
      <p class="muted" data-role="status"></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-role="cancel">Cancel</button>
        <button type="button" class="btn primary" data-role="save">Save</button>
      </div>
    `;

    const editToggleBtn = box.querySelector('[data-role="edit-toggle"]');
    const addSection = box.querySelector('[data-role="add-section"]');
    const addList = box.querySelector('[data-role="add-list"]');
    const inkInput = box.querySelector('[data-role="ink"]');
    const scaleInput = box.querySelector('[data-role="scale"]');
    const bgInput = box.querySelector('[data-role="bg"]');
    const statusEl = box.querySelector('[data-role="status"]');
    const cancelBtn = box.querySelector('[data-role="cancel"]');
    const saveBtn = box.querySelector('[data-role="save"]');

    // --- appearance ---------------------------------------------------------
    //
    // style.css's --ink/--bg custom properties are plain #rrggbb, so they
    // drop straight into <input type="color"> with no conversion.

    const computed = getComputedStyle(document.documentElement);
    const defaultInk = computed.getPropertyValue("--ink").trim() || "#46545f";
    const defaultBg = computed.getPropertyValue("--bg").trim() || "#eff2f9";

    function savedAppearance() {
      return (window.projectAppearance && window.projectAppearance.get()) || {};
    }

    function fillAppearanceForm() {
      const saved = savedAppearance();
      inkInput.value = saved.ink || defaultInk;
      bgInput.value = saved.bg || defaultBg;
      scaleInput.value = saved.contentScale || 1;
    }

    function formAppearance() {
      return { ink: inkInput.value, bg: bgInput.value, contentScale: Number(scaleInput.value) };
    }

    // Applied immediately as the controls move, same as the theme toggle
    // elsewhere in the app, but nothing is persisted until Save.
    function previewAppearance() {
      window.projectAppearance?.apply(formAppearance());
    }

    inkInput.addEventListener("input", previewAppearance);
    bgInput.addEventListener("input", previewAppearance);
    scaleInput.addEventListener("input", previewAppearance);

    async function saveAppearance() {
      const res = await fetch(`/api/projects/${host.project.id}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: formAppearance() }),
      });
      if (!res.ok) return false;
      const body = await res.json();
      window.projectAppearance?.set(body.settings);
      return true;
    }

    // --- edit mode / layout --------------------------------------------------

    function renderAddList() {
      addList.innerHTML = "";
      for (const { type, label } of host.shell.addableTypes()) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn";
        btn.textContent = `+ ${label}`;
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          const ok = await host.shell.addWidget(type);
          btn.disabled = false;
          if (!ok) statusEl.textContent = "Couldn't add that widget.";
        });
        addList.appendChild(btn);
      }
    }

    function render(state) {
      addSection.hidden = !state.editing;
      editToggleBtn.disabled = state.editing;
      editToggleBtn.textContent = state.editing
        ? "Editing layout — use Save / Cancel in the corner"
        : "Edit Layout";
    }

    // Entering edit mode closes the panel outright -- the panel is a
    // fixed-position overlay covering the whole page, so leaving it open
    // would sit on top of the grid the user just asked to rearrange. The
    // floating Save/Cancel control (main.js) takes over from here; this
    // panel's own Save/Cancel below only ever touch appearance now.
    editToggleBtn.addEventListener("click", () => {
      close();
      host.shell.enterEdit();
    });

    // --- panel lifecycle -------------------------------------------------

    function open() {
      fillAppearanceForm();
      renderAddList();
      render(host.shell.getState());
      statusEl.textContent = "";
      overlay.hidden = false;
    }

    function close() {
      overlay.hidden = true;
    }

    openBtn.addEventListener("click", open);

    // A click on the backdrop itself (not the box) is the same as Cancel,
    // matching the other modal-overlays in the app (e.g. app.js's
    // analyze-mode-overlay).
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) cancelBtn.click();
    });

    // Appearance and layout are different commits with different lifetimes
    // (see main.js's floating Save/Cancel for layout), so this button only
    // ever saves appearance -- even when a layout edit is in progress
    // underneath.
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      const ok = await saveAppearance();
      saveBtn.disabled = false;
      if (ok) {
        close();
      } else {
        statusEl.textContent = "Couldn't save appearance -- try again.";
      }
    });

    cancelBtn.addEventListener("click", () => {
      // Discard the live appearance preview and go back to what's actually
      // saved. A layout edit in progress is untouched -- this only dismisses
      // the panel, it does not cancel editing.
      window.projectAppearance?.apply(savedAppearance());
      close();
    });

    const unsubscribe = host.shell.subscribe(render);

    return {
      destroy() {
        unsubscribe();
        overlay.remove();
        wrap.remove();
      },
    };
  },
};
