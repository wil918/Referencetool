/* The portfolio's management view (#page=portfolio): every page staged for this
 * project, which slot each one fills if any, and per-page replace, delete and
 * add-to-archive. The Portfolio widget (widgets/portfolio.js) opens it.
 *
 * It does not reuse grid-page.js. That page is built around reference objects
 * -- titles, tags, similarity, colour analysis, folders -- and a staged page
 * has none of them: it is a working file with a filename and a size.
 * Feeding one through a component that expects a reference is how the
 * archive got polluted in the first place, so these are their own cards.
 *
 * Three things are done here that the canvas doesn't:
 *   - STAGING without placing: upload (or drop) any number of files, then
 *     fill a spread's empty pages from what is waiting. That is how a
 *     portfolio actually arrives -- thirty exports at once.
 *   - EARLIER VERSIONS: a replaced page stays in the store, unplaced. They
 *     are listed apart from pages that are merely waiting, because only the
 *     latter are what "fill" uses.
 *   - EXPORT, with the Portfolio widget's resolution as its default and a
 *     one-off override, a plan of what each page will get, and -- unticked
 *     -- an offer to add the exported pages to the archive once the export
 *     has finished. A working export archives nothing; three exports in a
 *     week must not be three sets.
 */

import {
  deletePage,
  exportPdf,
  exportPlan,
  describePlan,
  fillSpread,
  loadPortfolio,
  placePage,
  promotePage,
  replacePage,
  stagePages,
  thumbUrl,
} from "../portfolio.js";
import { IMAGE_EXTS, extOf } from "../canvas/file-types.js";

const ACCEPT = [...IMAGE_EXTS].join(",");
const PLAN_DELAY = 300;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className = "", title = "") {
  const btn = el("button", `btn portfolio-btn ${className}`.trim(), label);
  btn.type = "button";
  if (title) btn.title = title;
  return btn;
}

export function createPortfolioPage(container, { project }) {
  container.innerHTML = "";

  const root = el("div", "portfolio-page");
  container.appendChild(root);

  // --- chrome ----------------------------------------------------------------

  const head = el("div", "project-detail-header");
  const row = el("div", "project-detail-heading-row");
  row.appendChild(el("h2", "", "Portfolio"));
  const actions = el("div", "project-detail-actions");
  const uploadBtn = button("Upload pages…", "primary", "Stage images without putting them on a page yet");
  actions.appendChild(uploadBtn);
  row.appendChild(actions);
  head.append(
    row,
    el(
      "p",
      "muted",
      `Pages staged for ${project.title}. They are working files — not tagged, not searchable and not in the ` +
        "archive — until you add one."
    )
  );
  root.appendChild(head);

  const picker = el("input");
  picker.type = "file";
  picker.accept = ACCEPT;
  picker.multiple = true;
  picker.hidden = true;
  root.appendChild(picker);

  const status = el("p", "muted portfolio-status");
  status.setAttribute("aria-live", "polite");
  root.appendChild(status);

  const spreadsEl = el("div", "portfolio-spreads");
  const pagesEl = el("div", "portfolio-groups");
  root.append(spreadsEl, pagesEl);

  // --- state -----------------------------------------------------------------

  let overview = null;
  let destroyed = false;
  let busy = new Set(); // page ids (and "export:<node>") with a request in flight
  // Typed-but-not-yet-sent values survive the re-render that every status
  // change causes: which export panel is open, its resolution, and the tick.
  const exportDraft = { nodeId: null, dpi: "", promote: false, plan: null, planFor: null };
  let planTimer = null;

  function say(message) {
    status.textContent = message || "";
  }

  async function reload() {
    try {
      overview = await loadPortfolio(project.id);
    } catch (err) {
      if (!destroyed) say(`Couldn't load the portfolio — ${err.message}.`);
      return;
    }
    if (!destroyed) render();
  }

  // --- uploading ----------------------------------------------------------------

  async function stageFiles(files) {
    const images = files.filter((file) => IMAGE_EXTS.has(extOf(file.name)));
    const refused = files.length - images.length;
    if (!images.length) {
      say("Pages take JPEG, PNG, GIF, WebP or BMP images.");
      return;
    }
    say(images.length === 1 ? "Staging 1 page…" : `Staging ${images.length} pages…`);
    let result;
    try {
      result = await stagePages(project.id, images);
    } catch (err) {
      say(`Nothing was staged — ${err.message}.`);
      return;
    }
    const fresh = result.pages.filter((p) => p.created).length;
    const again = result.pages.length - fresh;
    const notes = [`Staged ${plural(fresh, "page")}.`];
    if (again) notes.push(`${plural(again, "file")} ${again === 1 ? "was" : "were"} already staged.`);
    if (result.errors.length) notes.push(`${plural(result.errors.length, "file")} couldn't be staged.`);
    if (refused) notes.push(`${plural(refused, "file")} ${refused === 1 ? "wasn't an image" : "weren't images"}.`);
    if (fresh && overview?.spreads.length) notes.push("Use “Fill empty pages” on a spread to place them.");
    say(notes.join(" "));
    await reload();
  }

  uploadBtn.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    const files = [...picker.files];
    picker.value = "";
    if (files.length) stageFiles(files);
  });

  // A drop anywhere on the page stages, the way a drop on a canvas page does.
  const onDragOver = (event) => {
    if ([...(event.dataTransfer?.types || [])].includes("Files")) event.preventDefault();
  };
  const onDrop = (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    stageFiles([...event.dataTransfer.files]);
  };
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);

  // --- one page's actions --------------------------------------------------------

  async function run(key, label, work) {
    if (busy.has(key)) return;
    busy.add(key);
    say(label);
    render();
    try {
      await work();
    } catch (err) {
      say(`${err.message}.`);
    } finally {
      busy.delete(key);
      await reload();
    }
  }

  function replace(page, file) {
    if (!IMAGE_EXTS.has(extOf(file.name))) {
      say("Pages take JPEG, PNG, GIF, WebP or BMP images.");
      return;
    }
    run(page.id, `Replacing ${page.filename || "page"}…`, async () => {
      const result = await replacePage(page.id, file);
      say(
        result.slots
          ? `Replaced. The previous version is still staged, under Earlier versions.`
          : "That file is the one already staged, so nothing changed."
      );
    });
  }

  function remove(page) {
    const name = page.filename || "this page";
    const where = page.placements.length
      ? ` It will be taken off ${placementLabel(page)} — the page stays, empty.`
      : "";
    const archived = page.in_archive ? " The copy in the archive is not touched." : " It is not in the archive.";
    if (!window.confirm(`Delete ${name}?${where}${archived} Its file is deleted.`)) return;
    run(page.id, "Deleting…", async () => {
      await deletePage(page.id);
      say("Deleted.");
    });
  }

  function promote(page) {
    run(page.id, `Adding ${page.filename || "page"} to the archive…`, async () => {
      const result = await promotePage(page.id);
      say(result.created ? "Added to the archive." : "The archive already had this one.");
    });
  }

  function place(page, value) {
    const [nodeId, index] = value.split(":");
    run(page.id, "Placing…", async () => {
      await placePage(page.id, nodeId, Number(index));
      say("Placed.");
    });
  }

  function fill(spread) {
    run(`fill:${spread.node_id}`, "Filling…", async () => {
      const result = await fillSpread(project.id, spread.node_id);
      if (!result.placed) say("Nothing is waiting to be placed.");
      else {
        const n = result.left_over;
        const left = n ? ` ${plural(n, "page")} didn't fit and ${n === 1 ? "stays" : "stay"} staged.` : "";
        say(`Placed ${plural(result.placed, "page")}.${left}`);
      }
    });
  }

  // --- export ----------------------------------------------------------------------

  function openExport(spread) {
    exportDraft.nodeId = exportDraft.nodeId === spread.node_id ? null : spread.node_id;
    exportDraft.dpi = String(overview.export_dpi);
    exportDraft.promote = false; // never carried over from the last export
    exportDraft.plan = null;
    render();
    if (exportDraft.nodeId) refreshPlan();
  }

  function currentDpi() {
    const [lo, hi] = overview.dpi_range;
    const n = Math.round(Number(exportDraft.dpi));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  }

  function refreshPlan() {
    clearTimeout(planTimer);
    planTimer = setTimeout(async () => {
      const dpi = currentDpi();
      const nodeId = exportDraft.nodeId;
      if (!nodeId || !dpi) return;
      try {
        const plan = await exportPlan(nodeId, dpi);
        if (destroyed || exportDraft.nodeId !== nodeId || currentDpi() !== dpi) return;
        exportDraft.plan = plan;
        renderPlanNotes();
      } catch {
        /* the export will say if something is wrong */
      }
    }, PLAN_DELAY);
  }

  let planNotesEl = null;
  let exportGoBtn = null;
  let promoteBox = null;
  let promoteLabelEl = null;

  function renderPlanNotes() {
    if (!planNotesEl) return;
    const plan = exportDraft.plan;
    planNotesEl.replaceChildren();
    if (!plan) return;
    for (const note of describePlan(plan, { future: true })) planNotesEl.appendChild(el("p", "", note));
    const count = plan.page_ids.length;
    if (promoteLabelEl) {
      promoteLabelEl.textContent = count
        ? `Also add ${plural(count, "exported page")} to the archive when it finishes — this tags and embeds each one`
        : "Nothing placed to add to the archive";
    }
    if (promoteBox) promoteBox.disabled = !count;
  }

  async function startExport(spread) {
    const dpi = currentDpi();
    if (!dpi) return;
    const wantArchive = exportDraft.promote;
    const key = `export:${spread.node_id}`;
    if (busy.has(key)) return;
    busy.add(key);
    render();

    let plan;
    try {
      plan = await exportPlan(spread.node_id, dpi);
    } catch (err) {
      busy.delete(key);
      say(`Can't export — ${err.message}.`);
      render();
      return;
    }
    say("Exporting…");
    const state = await exportPdf(spread.node_id, { dpi });
    if (destroyed) return;

    const outcome = {
      done: `Exported ${plural(plan.pages.length, "page")} at ${dpi} dpi.`,
      cancelled: "The export was cancelled.",
      failed: "The export failed.",
      timeout: "The export is taking a while — it will land in your downloads.",
    }[state];
    const notes = state === "done" ? describePlan(plan) : [];
    say([outcome, ...notes].join(" "));

    // Only a finished export offers anything, and only if it was asked for.
    if (state === "done" && wantArchive && plan.page_ids.length) {
      await promoteAll(plan.page_ids, [outcome, ...notes].join(" "));
    }
    exportDraft.promote = false;
    busy.delete(key);
    await reload();
  }

  async function promoteAll(pageIds, prefix) {
    let created = 0;
    let existing = 0;
    let failed = 0;
    for (const [i, id] of pageIds.entries()) {
      if (destroyed) return;
      say(`${prefix} Adding to the archive… ${i + 1} of ${pageIds.length}`);
      try {
        const result = await promotePage(id);
        if (result.created) created++;
        else existing++;
      } catch {
        failed++;
      }
    }
    const parts = [`Added ${plural(created, "page")} to the archive.`];
    if (existing) parts.push(`${plural(existing, "page")} ${existing === 1 ? "was" : "were"} already there.`);
    if (failed) parts.push(`${plural(failed, "page")} couldn't be added — try them one at a time below.`);
    say(`${prefix} ${parts.join(" ")}`);
  }

  // --- drawing ---------------------------------------------------------------------

  const several = () => overview.spreads.length > 1;

  function slotLabel(spread, slot) {
    return `${several() ? `Spread ${spread.ordinal} · ` : ""}page ${slot.number}`;
  }

  function placementLabel(page) {
    return page.placements
      .map((p) => `${several() ? `spread ${p.spread} · ` : ""}page ${p.number}`)
      .join(", ");
  }

  function renderSpread(spread) {
    const box = el("section", "portfolio-spread");
    const top = el("div", "portfolio-spread-head");
    top.appendChild(
      el(
        "h3",
        "",
        `${several() ? `Spread ${spread.ordinal} — ` : ""}${spread.filled} of ${plural(spread.total, "page")} placed`
      )
    );
    const tools = el("div", "portfolio-spread-tools");

    const waiting = overview.pages.filter((p) => !p.placements.length && !p.ever_placed).length;
    const emptySlots = spread.total - spread.filled;
    const fillBtn = button(
      "Fill empty pages",
      "",
      "Place the pages that are waiting into this spread's empty pages, in filename order"
    );
    fillBtn.disabled = !waiting || !emptySlots || busy.has(`fill:${spread.node_id}`);
    fillBtn.addEventListener("click", () => fill(spread));

    const exportBtn = button(exportDraft.nodeId === spread.node_id ? "Close export" : "Export PDF…", "");
    exportBtn.addEventListener("click", () => openExport(spread));
    tools.append(fillBtn, exportBtn);
    top.appendChild(tools);
    box.appendChild(top);

    if (exportDraft.nodeId === spread.node_id) box.appendChild(renderExportPanel(spread));
    return box;
  }

  function renderExportPanel(spread) {
    const panel = el("div", "portfolio-export");
    const exporting = busy.has(`export:${spread.node_id}`);

    const field = el("label", "portfolio-export-field");
    field.appendChild(el("span", "", "Resolution"));
    const dpiInput = el("input", "portfolio-export-dpi");
    dpiInput.type = "number";
    dpiInput.min = String(overview.dpi_range[0]);
    dpiInput.max = String(overview.dpi_range[1]);
    dpiInput.step = "1";
    dpiInput.value = exportDraft.dpi;
    dpiInput.disabled = exporting;
    dpiInput.addEventListener("input", () => {
      exportDraft.dpi = dpiInput.value;
      exportGoBtn.disabled = !currentDpi();
      refreshPlan();
    });
    field.append(dpiInput, el("span", "", "dpi"));
    const sourceNote = el(
      "span",
      "muted portfolio-export-hint",
      String(overview.export_dpi) === exportDraft.dpi
        ? "from the Portfolio widget"
        : `this export only — the widget says ${overview.export_dpi}`
    );
    field.appendChild(sourceNote);
    dpiInput.addEventListener("input", () => {
      sourceNote.textContent =
        String(overview.export_dpi) === dpiInput.value
          ? "from the Portfolio widget"
          : `this export only — the widget says ${overview.export_dpi}`;
    });

    planNotesEl = el("div", "portfolio-export-notes muted");

    const archiveRow = el("label", "portfolio-export-archive");
    promoteBox = el("input");
    promoteBox.type = "checkbox";
    promoteBox.checked = exportDraft.promote;
    promoteBox.disabled = exporting;
    promoteBox.addEventListener("change", () => {
      exportDraft.promote = promoteBox.checked;
    });
    promoteLabelEl = el("span", "", "Also add the exported pages to the archive when it finishes");
    archiveRow.append(promoteBox, promoteLabelEl);

    exportGoBtn = button(exporting ? "Exporting…" : "Export", "primary");
    exportGoBtn.disabled = exporting || !currentDpi();
    exportGoBtn.addEventListener("click", () => startExport(spread));

    panel.append(field, planNotesEl, archiveRow, exportGoBtn);
    renderPlanNotes();
    return panel;
  }

  function renderCard(page) {
    const card = el("article", "portfolio-card");
    const working = busy.has(page.id);
    card.classList.toggle("is-busy", working);

    const frame = el("div", "portfolio-card-frame");
    // The page's own proportions, so a card is as big as its page can be at
    // this width instead of a small image floating in a fixed box.
    frame.style.setProperty("--ratio", `${page.width} / ${page.height}`);
    const img = el("img", "portfolio-card-img");
    img.src = thumbUrl(page.id, "large");
    img.alt = page.filename || "Staged page";
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    frame.appendChild(img);
    card.appendChild(frame);

    card.appendChild(el("p", "portfolio-card-name", page.filename || "Untitled page"));

    const facts = [`${page.width}×${page.height} px`];
    if (page.print) facts.push(`${page.print.dpi} dpi at A4`);
    const factsEl = el("p", "portfolio-card-facts muted", facts.join(" · "));
    card.appendChild(factsEl);
    if (page.print?.low_resolution) {
      card.appendChild(
        el("p", "portfolio-card-warn", `Soft on paper — aim for at least ${overview.min_print_dpi} dpi.`)
      );
    }

    let where;
    if (page.placements.length) where = `On ${placementLabel(page)}`;
    else where = page.ever_placed ? "Not placed — an earlier version" : "Not placed — waiting";
    card.appendChild(el("p", "portfolio-card-where", where));
    if (page.in_archive) {
      card.appendChild(
        el(
          "p",
          "portfolio-card-archived muted",
          page.in_archive.is_own_work ? "In the archive as own work" : "In the archive"
        )
      );
    }

    const tools = el("div", "portfolio-card-tools");

    if (page.placements.length) {
      const fileInput = el("input");
      fileInput.type = "file";
      fileInput.accept = ACCEPT;
      fileInput.hidden = true;
      fileInput.addEventListener("change", () => {
        const [file] = fileInput.files;
        fileInput.value = "";
        if (file) replace(page, file);
      });
      const replaceBtn = button("Replace…", "", "Put a new file in this page's place; this one stays as an earlier version");
      replaceBtn.disabled = working;
      replaceBtn.addEventListener("click", () => fileInput.click());
      tools.append(replaceBtn, fileInput);
    } else {
      const empties = overview.spreads.flatMap((s) => s.slots.filter((x) => !x.page_id).map((x) => ({ s, x })));
      const select = el("select", "portfolio-place");
      select.disabled = working || !empties.length;
      select.appendChild(new Option(empties.length ? "Place on…" : "No empty pages", ""));
      for (const { s, x } of empties) {
        select.appendChild(new Option(slotLabel(s, x).replace(/^./, (c) => c.toUpperCase()), `${s.node_id}:${x.index}`));
      }
      select.addEventListener("change", () => {
        if (select.value) place(page, select.value);
      });
      tools.appendChild(select);
    }

    const archiveBtn = button(page.in_archive ? "In archive" : "Add to archive", "", "Tag, embed and add this page to the archive as your own work");
    archiveBtn.disabled = working || Boolean(page.in_archive);
    archiveBtn.addEventListener("click", () => promote(page));

    const deleteBtn = button("Delete", "danger", "Delete this staged page and its file");
    deleteBtn.disabled = working;
    deleteBtn.addEventListener("click", () => remove(page));

    tools.append(archiveBtn, deleteBtn);
    card.appendChild(tools);
    return card;
  }

  function group(title, hint, pages) {
    if (!pages.length) return null;
    const box = el("section", "portfolio-group");
    box.appendChild(el("h3", "", `${title} (${pages.length})`));
    if (hint) box.appendChild(el("p", "muted portfolio-group-hint", hint));
    const grid = el("div", "portfolio-cards");
    for (const page of pages) grid.appendChild(renderCard(page));
    box.appendChild(grid);
    return box;
  }

  function render() {
    if (!overview) return;
    spreadsEl.replaceChildren(...overview.spreads.map(renderSpread));
    if (!overview.spreads.length) {
      spreadsEl.replaceChildren(
        el("p", "muted", "There is no spread yet. Draw one on the canvas; pages staged here can be placed on it.")
      );
    }

    const byPlace = (a, b) =>
      a.placements[0].spread - b.placements[0].spread || a.placements[0].index - b.placements[0].index;
    const byName = (a, b) =>
      (a.filename || "").localeCompare(b.filename || "", undefined, { numeric: true, sensitivity: "base" });
    const newest = (a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1);

    const placed = overview.pages.filter((p) => p.placements.length).sort(byPlace);
    const waiting = overview.pages.filter((p) => !p.placements.length && !p.ever_placed).sort(byName);
    const earlier = overview.pages.filter((p) => !p.placements.length && p.ever_placed).sort(newest);

    const groups = [
      group("On the pages", null, placed),
      group("Waiting to be placed", "Uploaded, but not on a page yet.", waiting),
      group(
        "Earlier versions",
        "Pages that were replaced or taken off a spread. They cost nothing to keep and never reach the archive unless you add one.",
        earlier
      ),
    ].filter(Boolean);
    pagesEl.replaceChildren(
      ...(groups.length ? groups : [el("p", "muted", "Nothing staged yet. Upload pages, or drop image files here.")])
    );
  }

  reload();

  return {
    destroy() {
      destroyed = true;
      clearTimeout(planTimer);
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("drop", onDrop);
      container.innerHTML = "";
    },
  };
}
