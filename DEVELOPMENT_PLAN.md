# Development Plan — Project Spaces, Widgets & Infinite Canvas

**Status: sessions 1–14 complete — the original plan is finished. Phase 8 (sessions 15–20, Part 9) covers post-completion bugs and changes.**

| Session | State |
|---|---|
| 1–10 | Done. |
| 11 — canvas edges + text | **Partly shipped in S10.** Remaining scope moved into 11b and 11c. |
| 11a — expanded appearance | **Done.** One gap found afterwards: button *text* colour, picked up in 11b. |
| 11b — text cleanup, highlight, undo | **Done** (`178cf9a`). `text` widget removed with a migration to notepad, canvas node renamed Simple text, highlight added to `rich-text.js`, button text colour added, canvas undo in `nodes.js`. |
| 11c — connection line editing | New/absorbed. |
| 12 — canvas widgets | **Part done.** `canvasEligible` shipped. Revised to add the colour palette widget (named `colour-palette.js`, since `canvas/palette.js` is taken), the analysis widget, and the canvas preview. |
| 13 — archive roll-up | Not started. No `/api/folders/rollup` route yet. |
| 14 — integrity + audit | Not started. |

Part 1 describes the codebase as it stood when this plan was written, before any session ran — it is kept as the starting-point record, so its line counts are deliberately historical. `CLAUDE.md` describes the code as it is *now* and is the source of truth for conventions.

---

## Part 0 — What has changed since this plan was written

Sessions 1, 2, 3, 4 and 4b are done. Three correction rounds and one editing redesign followed, and between them they reversed decisions this plan originally specified. Every reversal is recorded in `CLAUDE.md`, which is what Claude Code actually reads:

| Original spec | Now |
|---|---|
| S2: project shell has a header with the title top-left and nav top-right | **No header at all.** Grid starts at the top of the viewport, full width. Title is a widget; exiting is a widget. |
| S3: 12 columns; collision pushes widgets down, then compacts upward | **24 columns; free placement.** Nothing pushes, nothing compacts, gaps are preserved. Overlap is refused and the widget snaps back. |
| S3: a widget at rest uses `--raise-sm` | **Flat at rest.** Shadow is opt-in per widget via `config.shadow`, and forced on for all widgets in edit mode. Inner chrome follows the widget's shadow state. |
| S4: appearance sets background, ink and text scale | Unchanged, plus **`--light` / `--dark` are now derived from the chosen background** in `appearance.js`, so shadows stay legible as depth on any page colour. |
| S4: settings panel holds the edit-mode toggle | Entering edit mode **closes the panel**; a floating Save/Cancel sits bottom-right so the grid is reachable. |

### Built beyond the plan

The editing redesign added machinery no session specified. It is all recorded in `CLAUDE.md`'s project-shell module table:

- **`top-bar.js`** — a shared bar in normal document flow, with independently-shown sections (`appearance`, `format`). It does not violate the no-header rule: hiding it collapses the page back to the grid starting at the top of the viewport. **New transient chrome should mount into this rather than adding another floating bar.**
- **`widget-dock.js`** — the "+" Add Widget dock, bottom-right during edit mode. This replaces the "Add Widget palette" that sessions 4 and 5 describe. Any new widget type appears in it automatically via `shell.addableTypes()`.
- **`notepad` widget** and per-selection rich text (`rich-text.js`, `text-utils.js`) — beyond session 4b's plain-text spec.
- **`appearance-panel.js`** — the appearance controls, extracted out of the settings widget into the top bar.

### Knock-ons for the remaining sessions

- **Session 5** describes the sidebar's own "Add Widget list". That palette is now the widget dock — filter what the dock offers when the target is a sidebar, rather than building a second palette.
- **Session 7's** back arrow is a floating overlay control, since there is no header to put it in. *(Already applied to the prompt.)*
- **Session 9's** 3D widgets must read typography and `contentScale` through `project/typography.js` like every other widget, and will appear in the dock automatically.
- **Session 11's** canvas text node should reuse `rich-text.js` and `format-toolbar.js`, not just the session-4b text widget. The toolbar mounts into the top bar; the canvas will need it positioned in world coordinates.

**Verified against the code:** all six project-space tables exist and are registered in `init_db()`; all 20 planned routes are present; `tests/test_project_spaces.py` holds 39 tests; `typography.js` implements the per-widget contract with `contentScale`; `grid.js` is 24 columns with no compaction; `project.html` has no `<header>`.

---

## Part 1 — How the tool works today (at plan time)

### Backend

A Flask app (`app.py`, 829 lines) sitting on top of five domain modules. There is no ORM, no service layer, no blueprints — every route is a function in `app.py` that calls into a module and returns `jsonify`.

| Module | Responsibility |
|---|---|
| `db.py` | All SQLite access. Raw SQL, `sqlite3.Row`, schema constants at the top, `init_db()` creates tables and runs `ALTER TABLE` migrations in a try/except. |
| `ingest.py` | Add a reference: hash, dedupe, copy into `references/`, tag, embed, insert. |
| `tagging.py` | Claude API calls for title/tags/description. |
| `embeddings.py` | CLIP via `sentence-transformers`, vectors stored in Chroma. |
| `analyze.py` | Claude cross-reference write-ups. |
| `colour.py` | 930 lines. K-means palette extraction in CIELAB, versioned profiles cached in `colour_analysis`, LCh cylinder layout, colour similarity ranking. |
| `graph_layout.py` | K-means clustering of CLIP vectors into planes, radial placement, edge selection for the 3D graph. |
| `capture.py` | Durable queue for browser-extension captures, processed on a background worker thread. |

### Data model

Seven tables, all defined as string constants in `db.py`:

- `reference_items` — the library. `id`, `type`, `filepath`, `title`, `source`, `tags` (JSON string), `description`, `notes`, `content_hash`, `is_own_work`, `date_added`
- `projects` — `id`, `title`, `description`, `date_created`
- `project_references` — join table, composite PK `(project_id, reference_id)`
- `analyses` — saved Claude conversations, scoped to a project
- `similarity_scores` — pairwise CLIP similarity, wiped and recomputed wholesale
- `captures` — extension capture queue + provenance + URL dedupe index
- `colour_analysis` — one colour profile per reference, keyed by `(version, content_hash)`

### Frontend

Four standalone HTML documents, no build step, no framework:

- `index.html` + `app.js` (1615 lines) — the SPA. Four tabs (Add / Archive / Projects / Settings) toggled by `activateTab()`, plus a project detail view nested inside the Projects tab.
- `graph.html` + `graph.js` (832 lines) — the 3D similarity graph. **This is the homepage**; `GET /` serves `graph.html`, not `index.html`.
- `connections.html`, `colour-connections.html` — flat 2D views the 3D graph folds down into via a `sessionStorage` handoff.
- Shared: `graph-common.js` (Three.js constants, themes, sprite helpers), `theme.js` (dark mode, loaded synchronously in `<head>` to avoid a flash), `ui-effects.js` (button press pulse), `style.css` (1188 lines).

Three.js is vendored at `static/vendor/three/` and loaded through an `<script type="importmap">` in each 3D page. **There is no bundler and no `package.json`.**

### Conventions that must be preserved

No build step; the neumorphic CSS system; comments that explain *why*; derived data in its own versioned table; offline tests.

**Full detail lives in `CLAUDE.md`, which is the single source of truth.** It is auto-loaded by Claude Code at session start. Don't restate conventions here — they'll drift.

### Project pages today (the thing being replaced)

`openProjectDetail()` in `app.js` fetches `/api/projects/<id>`, sets a title and description, renders a flat grid, and offers a selection toolbar with Delete / Colour Similarity / Analyze. Two sidebars (`#analysis-sidebar` right, `#colour-sidebar` left) slide over it. That whole view becomes one *page inside* the new project shell — the "simple grid with selection and deletion and analysis" widget destination.

---

## Part 2 — Decisions taken

| Decision | Choice | Consequence |
|---|---|---|
| Frontend | Vanilla ES modules, no build step | ~700–1000 lines of hand-rolled grid + canvas interaction. Cheapest prompts, cleanest Three.js embedding, one less stage in desktop packaging. |
| Project shell | Standalone `/project.html?id=<uuid>` | Own JS entry, own appearance scope. Makes per-project OS windows trivial later. Costs a page load on entry. *(Revised: the shell has no header — see Part 0.)* |
| Shared code | Minimal extraction only | Card rendering, selection marking and the carousel move to `static/shared/`. No wholesale refactor of `app.js`. |
| Desktop | Constraints now, packaging later | No extra sessions. Rules below are binding from session 1. |
| Plan tier | Pro | Sonnet-dominant. Opus sessions flagged with fallbacks. |

### Decision record — why vanilla, and what it costs

Kept because this is the decision most likely to be revisited, and the reasoning is worth more than the conclusion.

**What the feature set actually demands:** a persisted drag/resize grid; a container widget nesting others one level deep; an infinite canvas with pan/zoom, free positioning, lock/unlock and line connections; and two widgets embedding live Three.js scenes. That last item is the crux — `graph.js` (832 lines) and `colour-map.js` (293 lines) are full-page applications that own the renderer, camera, `OrbitControls`, raycaster and a `window` resize listener. Every option below requires giving them a mount/unmount/resize contract.

**Vanilla ES modules — chosen**

*Benefits.* Zero toolchain, matching the repo's existing convention (`graph.js` already imports from `/vendor/three/` through an import map, no bundler). Claude Code prompts stay shorter because there is no framework idiom to explain — on Pro, roughly 15–20% fewer tokens per session. The neumorphic system in `style.css` stays untouched. The two 3D widgets embed cleanly, since Three.js has no opinion about who owns the surrounding DOM. Debugging is a plain stack trace against code the session just wrote. One less fragile stage in a future PyInstaller packaging chain.

*Drawbacks.* Roughly 700–1000 lines of hand-rolled interaction plumbing: pointer-based drag with grid snapping, resize handles, collision and compaction, canvas pan/zoom via a transform matrix, and connection lines that re-anchor as nodes move. That is the largest single chunk of work in the plan and the part most likely to need a follow-up window (sessions 3 and 10). State management stays manual — when a widget's data changes you re-render it yourself, so discipline comes from the widget contract rather than from a framework.

**React + Vite for project pages — rejected**

*Benefits.* `react-grid-layout` and `reactflow` deliver almost exactly the two hardest features as configured libraries rather than code, realistically removing 2–3 sessions. Declarative state makes the "settings-gated homepage vs. always-live canvas" distinction a single `isEditing` flag.

*Drawbacks.* A build step in a repo that has deliberately never had one, `node_modules` beside a Python venv, and a Flask route serving built assets with a dev-vs-prod story. Two mental models permanently: `app.js` stays imperative while project pages are declarative, so shared code is either duplicated or wrapped. Three.js in React is the known-awkward case — the renderer must live outside React state or it is recreated every render, so you write a `useRef` escape hatch anyway. React-idiom prompts are the most expensive per session on Pro; the setup session alone plausibly consumes a window before any feature ships. `react-grid-layout` also ships its own placeholder and resize-handle CSS that fights the neumorphic system.

**Vanilla + vendored grid library — rejected**

*Benefits.* No build step (Gridstack ships an ES module build that drops into `static/vendor/` exactly like Three.js). Skips the hardest hand-rolled part while keeping one mental model and cheap prompts.

*Drawbacks.* Grid libraries assume they own their DOM subtree, so nested widgets and the no-sidebars-in-sidebars rule fight the library's model instead of being a two-line check. Vendored copies are pinned by hand with no upgrade path. The canvas is the real weak spot: the good libraries (reactflow, tldraw) are framework-bound, so the vanilla options for connection-line editing are thin and you hand-roll the canvas regardless — taking on library friction while still writing most of the hard code.

**The deciding argument.** The 3D widgets are the technically riskiest part and are easiest in vanilla; the grid and canvas are laborious but well-understood. On Pro, cheaper prompts buy more sessions than the libraries save.

**When to revisit.** If session 3 or session 10 overruns by more than one extra window, the hand-rolled bet is not paying off — reconsider option C for the grid specifically, before building sessions 4–7 on top of it.

### Standing constraints

SQLite-not-localStorage, relative paths, no `file://` assumptions, no hard-coded port, no new `webkitdirectory` usage, `IF NOT EXISTS` table constants registered in `init_db()`.

**These live in `CLAUDE.md` as hard rules 1–8** and are loaded automatically into every Claude Code session, so no session prompt needs to repeat them.

---

## Part 3 — Target architecture

**The schema, its semantics, and the widget contract are specified in `CLAUDE.md`** — six new tables (`folders`, `folder_references`, `widgets`, `project_settings`, `canvas_nodes`, `canvas_edges`), the anti-stacking and permanent-widget rules, and the widget factory signature.

Two design points worth restating here because they drive the build order:

- **The Archive's cross-project folder view is a roll-up by name**, computed as a query rather than stored. A folder always belongs to exactly one project. This is what lets Texture folders in different projects aggregate in the Archive without a second folder concept — and it's why session 13 is a query plus a filter strip, not a schema change.
- **The homepage grid and the infinite canvas have deliberately opposite editing models** — explicit save vs. immediate persistence, strong snapping vs. none. They share the widget registry and nothing else, which is why the canvas sessions can slip without affecting anything upstream.

### Backend gaps that must be closed

Two existing functions compute over the **whole archive** and have no scoping parameter. Both need one before the project-scoped 3D widgets can exist:

- `colour.colour_map(exclude_black_white=False)` — reads `db_list_colour_analyses(set())`, which only takes an *exclude* set. Needs an `include_ids` path.
- `graph_layout.build_graph()` — calls `db.list_references()` unconditionally. Needs `build_graph(reference_ids=None)`.

Neither is a rewrite; both are a parameter threaded through. Doing them in one dedicated session keeps the widget sessions purely frontend.

---

## Part 4 — Build order

Sequenced so that each session lands on foundations that already exist, and nothing later forces a rewrite of something earlier.

```
Phase 0  Foundations        S1  schema + API        S2  project shell
Phase 1  Widget kernel      S3  grid engine         S4  edit mode + theming
                            S4b typography + text widget
Phase 2  Containers         S5  sidebar widget
Phase 3  Folders            S6  folder backend      S7  grid + folder pages
Phase 4  Data widgets       S8  scoping refactor    S9  3D widgets
Phase 5  Canvas             S10 canvas core         S11 edges + text
                            S12 canvas widgets
Phase 6  Archive roll-up    S13 archive folders
Phase 7  Hardening          S14 integrity + audit
```

**Why this order.** The schema comes first because six features write to it and a late change to `widgets.parent_id` or `folders.project_id` would force edits across every session that touched them. The grid engine comes before any real widget so that widgets are written against a stable contract rather than retro-fitted. Folders come before the 3D widgets because folder pages reuse the grid-page component built in the same phase, whereas the 3D widgets depend only on the backend scoping work. The canvas is last among features because it is the most self-contained — it shares the widget registry but none of the grid layout logic — so a slip there costs nothing upstream.

---

## Part 5 — Sessions

Each session is scoped to fit one 5-hour Pro window. Format: what it delivers, the prompt to paste, model and thinking level, estimates, and exit criteria.

### How to run a session

1. `/clear` — never carry a previous session's context forward.
2. Set the model and thinking level named for that session.
3. Paste **only that session's prompt**. Nothing else.
4. Check the exit criteria yourself before committing.

`CLAUDE.md` is loaded automatically from the project root, so the constraints, schema and widget contract are already in context. You never paste it, and **you should not give Claude Code this plan file** — it's a planning document for you. Handed the whole thing, Claude Code tends to run ahead: starting session 4 inside session 3, or scaffolding files for features three sessions away.

### ⚠️ On models and the Pro plan

**Opus has historically been restricted to Max plans in Claude Code, with Pro getting Sonnet only.** I could not verify current availability — web search was rate-limited when this was written. **Check `/model` in Claude Code before relying on any Opus session below.** Every Opus session therefore carries a *Sonnet fallback*: a way to split it into two tighter-scoped Sonnet sessions that reach the same place. Fable 5 is excluded throughout per your instruction.

Thinking levels are the six Claude Code offers: `low` < `medium` < `high` < `extra` < `max` < `ultracode`. Higher levels cost tokens but pay for themselves on architectural and debugging work. How this plan uses them:

| Level | Used for |
|---|---|
| `low` | Nothing planned. Fine for one-line fixes and rename passes. |
| `medium` | Mechanical feature work against an existing contract — sessions 2, 4, 6, 12, 13. |
| `high` | Work with real design decisions inside it — sessions 4b, 5, 7, 8, 11a, 11b, 11c, 12, 14. |
| `extra` | Session 9 only. Refactoring renderer ownership out of `graph.js` and getting WebGL disposal right is fiddly and expensive to get wrong. |
| `max` | The two load-bearing architectural sessions, 3 and 10. |
| `ultracode` | Not scheduled. Reserve it for a debugging emergency — something subtly wrong that two ordinary attempts have failed to fix. Spending it on planned work wastes budget you'll want later. |

**Token estimates** are total window consumption including file reads, tool calls and iteration — not just the prompt. On Pro, a 5-hour window is roughly 10–40 Sonnet prompts depending on context size; a session below typically runs 15–30 exchanges. Treat these as planning ranges, not guarantees.

---

### Session 1 — Schema and API surface

**Delivers:** all six new tables, their `db.py` functions, their routes in `app.py`, default folders on project creation, and tests. No UI.

**Model:** Opus 5, `max`
**Fallback (Sonnet 5, `high`):** split into 1a (tables + `db.py` functions + tests) and 1b (routes + default folders + API tests).
**Estimate:** 3.5–4.5 h · 250–400k tokens · ~1 window

````
Read db.py, app.py, config.py and tests/conftest.py in full before writing anything.

Add persistence and an API for project spaces. Follow the existing conventions
exactly: schema string constants at the top of db.py, registered in init_db(),
raw sqlite3 with the get_conn() context manager, no ORM, comments that explain
why a decision was made rather than what the line does.

New tables:

  folders            id TEXT PK, project_id TEXT NOT NULL, name TEXT NOT NULL,
                     position INTEGER NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
                     date_created TEXT NOT NULL
  folder_references  folder_id TEXT, reference_id TEXT, date_added TEXT,
                     PRIMARY KEY (folder_id, reference_id)
  widgets            id TEXT PK, project_id TEXT NOT NULL, type TEXT NOT NULL,
                     parent_id TEXT, x INTEGER, y INTEGER, w INTEGER, h INTEGER,
                     locked INTEGER NOT NULL DEFAULT 0, config TEXT,
                     position INTEGER NOT NULL DEFAULT 0, date_created TEXT NOT NULL
  project_settings   project_id TEXT PK, settings TEXT NOT NULL
  canvas_nodes       id TEXT PK, project_id TEXT NOT NULL, kind TEXT NOT NULL,
                     reference_id TEXT, x REAL, y REAL, w REAL, h REAL,
                     locked INTEGER NOT NULL DEFAULT 0, content TEXT, config TEXT,
                     z_index INTEGER NOT NULL DEFAULT 0
  canvas_edges       id TEXT PK, project_id TEXT NOT NULL, source_node_id TEXT NOT NULL,
                     target_node_id TEXT NOT NULL, style TEXT

Add indexes on folders(project_id), folder_references(reference_id),
widgets(project_id), canvas_nodes(project_id), canvas_edges(project_id).

Key semantics, which the comments in db.py should state:

- A folder belongs to exactly one project. The Archive's cross-project folder
  view is a roll-up by folder NAME, computed as a query, not stored. Do not add
  a global folders concept.
- Removing a reference from a folder deletes only the folder_references row.
  The reference stays in the project and in the archive. A reference may sit in
  many folders at once.
- Deleting a project must also delete its folders, folder_references, widgets,
  project_settings, canvas_nodes and canvas_edges. Extend the existing
  delete_project(). Deleting a reference must delete its folder_references and
  any canvas_nodes pointing at it — extend delete_reference().
- widgets.parent_id NULL means the widget sits on the grid; non-null means it
  sits inside that container widget.

New API routes in app.py, matching the existing style (thin wrappers, jsonify,
abort(404) for missing parents):

  GET    /api/projects/<pid>/folders
  POST   /api/projects/<pid>/folders                    {name}
  PUT    /api/folders/<fid>                             {name} | {position}
  DELETE /api/folders/<fid>
  GET    /api/folders/<fid>/references
  POST   /api/folders/<fid>/references                  {reference_ids: []}
  DELETE /api/folders/<fid>/references/<rid>

  GET    /api/projects/<pid>/widgets
  POST   /api/projects/<pid>/widgets                    {type, parent_id?, x,y,w,h, config?}
  PUT    /api/projects/<pid>/widgets                    bulk layout save: {widgets: [...]}
  DELETE /api/widgets/<wid>

  GET    /api/projects/<pid>/settings
  PUT    /api/projects/<pid>/settings                   {settings: {...}}

  GET    /api/projects/<pid>/canvas                     {nodes: [], edges: []}
  PUT    /api/projects/<pid>/canvas                     full replace
  POST   /api/projects/<pid>/canvas/nodes
  PATCH  /api/canvas/nodes/<nid>
  DELETE /api/canvas/nodes/<nid>
  POST   /api/projects/<pid>/canvas/edges
  DELETE /api/canvas/edges/<eid>

Two rules the API must enforce, with a 400 and a clear message:

1. Anti-stacking. Reject creating a widget whose parent_id points at a widget
   that itself has a non-null parent_id, and reject nesting a container-type
   widget inside another container. Container types are declared server-side as
   a constant set: currently {"sidebar"}.
2. Permanent widgets. DELETE on a widget whose type is in
   {"settings", "exit", "canvas"} returns 400. They can be moved, never removed.

When a project is created via POST /api/projects, seed it with six default
folders in this order: Texture, Colour, Form, Vibe, Fashion, Narrative, each
is_default=1. They must be renameable and deletable like any other folder —
is_default is a record of origin, not a protection flag. Also seed the default
widget set: a "title" widget at the top, plus "settings", "exit" and "canvas"
widgets. Nothing else.

Write tests in tests/test_project_spaces.py using the existing archive and
client fixtures from conftest.py. Cover: default folders and widgets are seeded
on project creation; a reference in two folders appears in both; removing from a
folder leaves the project membership intact; deleting a project cascades to all
six new tables; the anti-stacking rule rejects a sidebar inside a sidebar and a
widget inside a nested widget; permanent widgets cannot be deleted; the bulk
layout PUT round-trips.

Run pytest and make the whole suite pass, including the existing tests.
````

**Exit criteria:** `pytest` green. `sqlite3 data/references.db ".schema"` shows all six tables. Creating a project through the API returns six folders and four widgets.

---

### Session 2 — Project shell and shared modules

**Delivers:** `/project.html?id=`, header swap, entry and exit, and the minimal shared-module extraction.

**Model:** Sonnet 5, `medium`
**Estimate:** 2.5–3.5 h · 150–250k tokens · ~0.75 window

````
Read static/index.html, static/app.js, static/style.css, static/graph.html and
app.py first.

Build the project shell as a standalone page, /project.html?id=<uuid>, in the
same way graph.html is standalone. Do not add a build step; use ES modules
served directly, and an import map only if Three.js is needed (it is not yet).

1. Extract the smallest useful shared surface out of app.js into
   static/shared/, as ES modules with no side effects on import:

     static/shared/cards.js      makeCard(ref, onClick), markSelectable(card, isSelected),
                                 textCard(ref), makeBarThumb(ref)
     static/shared/carousel.js   the carousel overlay: open(list, index), close()

   app.js must import these and delete its own copies, so there is exactly one
   implementation of each. app.js is a classic script today — convert only what
   is needed to make this work, changing its <script> tag to type="module" if
   required, and verify every existing tab still works afterwards. Do not
   refactor anything else in app.js.

2. project.html: reuse style.css rather than duplicating it, so the neumorphic
   system and dark mode carry over untouched. The header is the same shape as
   index.html's — same padding, same --header-bg strip, same hairline border —
   but:
     - top left: the project title, replacing "Fashion Reference Library"
     - top right: project navigation, replacing the Add/Archive/Projects/
       Settings tabs. For now this is a single "Exit Project" control; later
       sessions add to it.
   The document title should also become the project title.

3. static/project/main.js is the entry point. On load it reads ?id= from the
   URL, fetches /api/projects/<id>, /api/projects/<id>/widgets and
   /api/projects/<id>/settings in parallel, and renders a placeholder homepage
   listing the widget rows it got back as plain text. The real grid arrives in
   session 3 — this session only proves the shell, the routing and the data
   flow. A missing or unknown id shows a clear message and a link back to
   /index.html#projects.

4. Entry and exit. In app.js, clicking a project on the Projects tab navigates
   to /project.html?id=<id> instead of calling openProjectDetail(). Leave
   openProjectDetail and the existing project detail view in place and
   reachable in the code for now — session 7 turns it into the grid page and
   removes the dead path then. Exit Project returns to /index.html#projects.

Constraints: all state through the API, never localStorage; relative fetch
paths only; no assumptions about the port or about file://.
````

**Exit criteria:** clicking a project opens `project.html`, the title is top-left, Exit returns to the Projects tab, dark mode still works on both pages, and every existing tab in `index.html` still functions after the module extraction.

---

### Session 3 — Widget kernel and grid engine

The single most load-bearing session. Everything after it plugs into what this produces.

**Delivers:** widget registry, lifecycle contract, grid layout engine with drag/resize/snap/collision, persistence.

**Model:** Opus 5, `max`
**Fallback (Sonnet 5, `high`):** 3a = registry + contract + static grid rendering from saved layout; 3b = drag, resize, collision and the bulk save.
**Estimate:** 4–5 h · 300–500k tokens · 1–1.5 windows

````
Read static/project/main.js, static/style.css and the widgets API in app.py
before starting. Think hard about the layout algorithm before writing code.

Build the widget system for the project homepage. Vanilla ES modules, no
libraries, no build step.

1. static/project/registry.js — a registry mapping widget type to definition.
   Every widget is a module in static/project/widgets/ with a default export:

     { type, label, container, permanent, defaultSize:{w,h}, minSize:{w,h},
       create(host) -> { destroy() } }

   host is { el, config, project, save(config), onResize(cb), onDestroy(cb) }.
   el is the widget's own element — a widget never touches anything outside it.
   save(config) persists that widget's config through the API, debounced.
   onResize registers a callback fired when the widget's box changes size; this
   exists for the Three.js widgets in session 9, which must call
   renderer.setSize() and update the camera aspect. Document that in a comment.

2. static/project/grid.js — the layout engine. A fixed 12-column grid with a
   fixed row height. The homepage should read as deliberately gridlike, in
   contrast to the freeform canvas built later, so snapping is strong and
   always to whole cells.

   - Render widgets from their saved x,y,w,h.
   - Drag by pointer events (pointerdown/move/up with setPointerCapture — not
     mouse events, and not the HTML5 drag-and-drop API, which cannot give a
     live preview). Show a snapped placeholder under the dragged widget.
   - Resize from a bottom-right handle, clamped to minSize and to the grid.
   - Collision: when a widget is dropped onto occupied cells, push the
     displaced widgets downward and compact upward afterwards, so there are no
     floating gaps. Keep this deterministic — same drop, same result.
   - Locked widgets (locked=1) do not drag or resize.
   - The engine must be pure layout: it knows nothing about what any widget
     contains.

3. Persistence. The whole layout saves in one bulk
   PUT /api/projects/<pid>/widgets. Do not save per-widget on every pointer
   move. Save is explicit — session 4 wires it to the settings panel's Save.
   Expose grid.getLayout() and grid.setLayout(rows) for that.

4. Two real widgets to prove the contract, in static/project/widgets/:
     title.js  — renders the project title. config: { align, showDescription }.
     exit.js   — a button returning to /index.html#projects. permanent: true.
   Wire main.js to render the real grid from the API instead of the session-2
   placeholder.

5. Styling comes entirely from style.css's existing custom properties. A widget
   at rest uses --raise-sm; while dragging it uses --raise-lg to lift off the
   page; the drop placeholder uses --press-sm so it reads as a recess the
   widget will settle into. Do not introduce panel fills or borders — the
   neumorphic system depends on surfaces being the same colour as the page.

Verify by hand: drag a widget across another and confirm the displaced one
moves down and the layout compacts; reload and confirm the layout is unchanged;
resize below minSize and confirm it clamps.
````

**Exit criteria:** widgets drag, snap, resize, collide predictably, and survive a hard reload. No widget-specific logic anywhere in `grid.js`.

---

### Session 4 — Edit mode, settings panel, theming

**Delivers:** the settings-gated editing model, the settings widget, and per-project font/background control.

**Model:** Sonnet 5, `medium`
**Estimate:** 3–4 h · 200–300k tokens · ~1 window

````
Read static/project/grid.js, registry.js, main.js and static/style.css first.

1. Edit mode. The homepage is deliberately harder to change than the canvas
   will be: nothing on it moves until the user opens Settings, makes changes,
   and saves. Implement:
     - view mode (default): widgets are inert, no drag handles, no resize
       handles, clicks pass through to widget content.
     - edit mode: entered only from the settings widget. Drag and resize become
       live, an Add Widget palette appears, and non-permanent widgets get a
       remove control.
     - Save commits via the bulk widgets PUT and returns to view mode. Cancel
       restores the layout snapshot taken on entering edit mode and returns to
       view mode. Leaving the page with unsaved changes prompts via
       beforeunload.

2. static/project/widgets/settings.js — permanent: true, movable, not
   deletable. Clicking it opens a panel (an overlay, styled like the existing
   .modal-box in style.css) containing:
     - Enter/exit edit mode
     - Add Widget: a list built from the registry, filtered to what can legally
       be added here
     - Appearance: text colour, text size, background colour
     - Save / Cancel

3. Appearance is per project and persists through
   GET/PUT /api/projects/<pid>/settings. Implement it as CSS custom properties
   set on the project page's root element — --project-ink, --project-text-scale,
   --project-bg — with the page's own rules reading those with the existing
   globals as fallbacks, e.g. color: var(--project-ink, var(--ink)). Text size
   is a scale factor applied to a root font size, not a per-element pixel value,
   so every widget scales together.

   Important: these must not leak into index.html or the graph pages, which
   keep the global theme. Scope them to the project shell only.

   Apply saved settings before first paint the way theme.js does, to avoid a
   flash of the default appearance.

4. Add a small colour-picker control consistent with the neumorphic system —
   a native <input type="color"> inside a --press-sm recess is fine; do not
   build a custom picker.

Constraint: settings persist server-side, never localStorage.
````

**Exit criteria:** layout changes are impossible outside edit mode; Save persists across reload; Cancel truly reverts; appearance settings apply to the project page only.

---

### Session 4b — Per-widget typography, content scale, and the text widget

Added after session 4 ran. Project-wide appearance turned out to be too blunt: type choices belong to the widget, not the page.

**Delivers:** per-widget typography config, a floating format toolbar, content scale decoupled from widget footprint, and a rich text widget.

**Model:** Sonnet 5, `high`
**Estimate:** 3–4 h · 250–350k tokens · ~1 window

````
Read static/project/registry.js, grid.js, appearance.js, main.js,
widgets/title.js, and the project-space sections of static/style.css first.

Four related changes. They share one mechanism, so do them together.

1. Per-widget typography. Add config.typography to the widget contract:
     { family, size, colour, bold, italic, underline, align }
   Every field is optional; anything unset falls back to the project-wide
   appearance settings from session 4, which stay as the defaults. Apply it as
   CSS custom properties scoped to host.el — never as inline styles on inner
   elements, and never on :root — so it cascades to that widget's content and
   nothing else. Two widgets with different typography must not affect each
   other.

   Offer a small, sane font list rather than a system font enumeration: the
   three families already in style.css (--serif, --sans, --display) plus a
   monospace. Vendor nothing; add no webfonts.

2. A floating format toolbar, in the manner of Google Docs. When a widget is
   being edited it appears pinned directly above that widget, showing family,
   size, colour, bold, italic, underline and alignment. It edits only the
   widget it is attached to. It must not overlap the widget it is formatting —
   flip it below when there is no room above. Persist through host.save(config),
   debounced.

3. Content scale, separated from widget size. The session 4 text-size slider
   currently scales the whole project. Convert it into two distinct controls:
     - project-wide default content scale, in the settings panel (what the
       slider becomes)
     - per-widget config.contentScale, in the format toolbar, overriding it
   contentScale zooms what is INSIDE a widget — text, icons, padding — as one
   unit, implemented as a scale factor on a CSS custom property the widget's
   own rules read. It is completely independent of w/h, which size the
   widget's footprint on the grid. Resizing a widget must never change its
   content scale, and changing content scale must never resize the widget.
   Content that outgrows its box scrolls or clips per the widget's own rules;
   it does not push the grid around.

4. static/project/widgets/text.js — a user text widget. contenteditable,
   plain text only (strip HTML on paste), using the typography and content
   scale above. Config: { content, typography, contentScale }. Saves on blur
   and on a debounce.

5. Apply the typography controls to text in the existing widgets too — at
   minimum title.js, and any widget whose main content is text. A widget that
   renders text should read its typography from the same custom properties
   rather than hard-coding sizes.

Note for later: session 11 builds a canvas text node. It must reuse this
widget's typography and toolbar rather than growing a second implementation.

Verify: two text widgets with different fonts, sizes and colours coexist
without bleeding into each other; changing project-wide appearance still moves
every widget that has not overridden that field; content scale changes what is
inside a widget without changing its grid footprint, and vice versa; all of it
survives a reload.
````

**Exit criteria:** typography and scale are per widget, override project-wide settings cleanly, and never interact with grid sizing.

---

### Session 5 — Sidebar container widget

**Delivers:** a widget that holds other widgets and opens on a button press, with the anti-stacking rule enforced on both sides.

**Model:** Sonnet 5, `high`
**Estimate:** 2.5–3.5 h · 180–280k tokens · ~0.75 window

````
Read static/project/registry.js, grid.js, widgets/settings.js and the
anti-stacking validation in app.py first.

Build static/project/widgets/sidebar.js — container: true.

On the grid it renders as a compact button. Pressing it slides a panel in from
the edge of the page, containing the widgets whose parent_id is this widget's
id. Pressing again, clicking outside, or pressing Escape closes it. Use the
same slide-in treatment as the existing #analysis-sidebar in style.css so it
feels like part of the same app.

Inside the sidebar, child widgets stack vertically in their `position` order
rather than on a 12-column grid — the space is narrow and a second grid there
would fight itself. In edit mode children can be reordered by dragging
vertically and removed; their order saves as `position` through the same bulk
widgets PUT.

Anti-stacking, enforced in the UI as well as the API:
  - The sidebar's own Add Widget list must exclude every widget whose
    definition has container: true, and every widget with permanent: true
    (settings, exit and canvas belong on the homepage, not buried in a panel).
  - The grid's Add Widget list stays unrestricted.
  - If the API rejects a nesting attempt, surface its error message rather than
    failing silently.
  - Add a comment stating the rule plainly: containers may hold leaf widgets,
    never other containers, and nesting is one level deep by design.

Config on the sidebar widget: { label, side: "left"|"right", width }.

Verify: a sidebar cannot be added inside a sidebar from the UI; a widget dragged
into a sidebar loses its grid position and gains a parent_id; both survive a
reload; two sidebars on the same side do not overlap when both are open.
````

**Exit criteria:** nesting works one level deep, is impossible to abuse from the UI, and round-trips through the API.

---

### Session 6 — Folder backend and move-to-folder

**Delivers:** folder management UI primitives and the "move selected into folder" action on both grids.

**Model:** Sonnet 5, `medium`
**Estimate:** 2–3 h · 150–220k tokens · ~0.6 window

````
Read the folders API in app.py, db.py's folder functions, and the selection
toolbar code in static/app.js (setArchiveSelectionMode, addSelectionToProject
and the project detail selection toolbar) first.

1. static/project/folders.js — a small client module wrapping the folders API:
   list, create, rename, reorder, delete, addReferences, removeReference.
   No DOM. Every other folder feature imports this rather than calling fetch
   directly.

2. A folder management UI, opened from the settings panel: list the project's
   folders in order, create, rename inline, reorder by drag, delete with a
   confirmation that states plainly that deleting a folder does not delete any
   references — it only removes the grouping. Reuse the existing .modal-box
   styling.

3. Move-to-folder on selection. Add a "Move to folder…" control to the project
   selection toolbar, in the same style as the existing "Add to project…"
   select in index.html. Choosing a folder adds every selected reference to it
   via POST /api/folders/<fid>/references with the full id list in one request.
   The control must make clear this is additive: a reference can be in several
   folders at once, and adding it to one does not remove it from another or
   from the project.

4. Wire the same control into index.html's archive selection toolbar, scoped to
   whichever project the user picks — reuse the existing project select
   pattern rather than inventing a second one.

Verify: a reference added to two folders appears in both; removing it from one
leaves the other and the project intact; deleting a folder leaves every
reference in the project.
````

**Exit criteria:** folders can be fully managed, multi-folder membership works, and no folder operation ever removes a reference from a project.

---

### Session 7 — Grid page and folder pages

**Delivers:** the "project page as it works today" widget destination, folder page widgets, and the back-arrow navigation.

**Model:** Sonnet 5, `high`
**Estimate:** 3–4 h · 250–350k tokens · ~1 window

````
Read static/app.js's project detail view in full (openProjectDetail,
renderProjectGrid, setSelectionMode, the analysis sidebar, the colour sidebar),
static/shared/cards.js, and static/project/folders.js first.

1. static/project/pages/grid-page.js — a reusable page component rendering a
   grid of references with the full selection toolbar: Delete, Colour
   Similarity, Analyze, Move to folder. It takes a reference list and a
   deleteBehaviour, because Delete means different things in different places:
     - project grid page: remove from the project
     - folder page: remove from the folder only, leaving the project membership
       and the archive untouched
   Make that difference explicit in the confirmation text the user sees, not
   just in the code.

   Port the analysis sidebar and the colour sidebar across so both pages have
   the same capabilities the current project detail view has. Reuse
   static/shared/cards.js and static/shared/carousel.js rather than
   reimplementing card rendering.

2. static/project/widgets/grid-button.js — a widget that navigates to the
   project's grid page, showing every reference in the project regardless of
   folder. Folders never filter this page; they only ever add a view.

3. static/project/widgets/folder.js — one widget per folder, config
   { folder_id }. Navigates to that folder's page. Include a way to create a
   folder widget for each existing folder from the Add Widget palette.

4. Navigation. Every page reached from the project homepage gets a back control
   in the top right: a simple back-arrow icon returning to the project
   homepage. The project shell has no header (see CLAUDE.md), so this is a
   floating overlay control pinned to the top right of the viewport — do not
   reinstate a header to hold it. Use an inline SVG arrow, sized and coloured
   from the existing custom properties — no icon font, no external asset. Implement
   pages as hash routes on project.html (#page=grid, #page=folder&id=<fid>) so
   the browser back button agrees with the on-screen arrow.

5. Now remove the old project detail view from index.html and app.js — the
   markup in #project-detail-view and its handlers — since the project shell
   fully replaces it. Keep the Projects list view. Make sure nothing else in
   app.js still references the removed ids.

Verify: deleting from a folder page leaves the reference on the project grid
page; deleting from the project grid page removes it from the project and from
every folder; Analyze and Colour Similarity work identically on both.
````

**Exit criteria:** both page types work with full parity to today's project view, delete semantics differ correctly, back-arrow and browser back agree, and no dead code remains in `app.js`.

---

### Session 8 — Scoping refactor for colour and similarity

Backend only. Isolating it here keeps session 9 purely visual.

**Model:** Opus 5, `high`
**Fallback (Sonnet 5, `high`):** 8a = `colour.py` scoping; 8b = `graph_layout.py` scoping. They are independent.
**Estimate:** 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read colour.py (particularly colour_map, db_list_colour_analyses and
map_colour), graph_layout.py (build_graph), db.py's list_colour_analyses, and
the /api/colour/map and /api/similarity/graph routes in app.py first.

Both layout functions currently compute over the whole archive with no way to
scope them, which blocks per-project versions of either view. Add scoping
without changing any existing behaviour.

1. colour.colour_map(exclude_black_white=False, include_ids=None).
   db.list_colour_analyses(version=None, exclude_ids=None) needs an include_ids
   parameter alongside the existing exclude_ids, applied as an intersection.
   colour.db_list_colour_analyses(exclude_ids) is the thin wrapper that pins
   ANALYSIS_VERSION — thread include_ids through it too. When include_ids is
   None every call site behaves exactly as it does now.

   Be careful with the radius ranking. Radius is the chroma RANK across the set
   being laid out, not an absolute value, so a scoped map ranks within its own
   subset. That is the correct behaviour — a project's colour space should
   spend its full radius on the range that project actually occupies, which is
   the same argument the existing docstring makes for the archive. State this
   in a comment so it is not later "fixed" into an absolute scale.

2. graph_layout.build_graph(reference_ids=None). When given ids, cluster and
   lay out only those references and only the similarity_scores rows whose
   endpoints are both in the set. Keep the cluster-count heuristic
   (len(ids)//8, clamped 2..6) but ensure it degrades sanely for small sets —
   a project with five references must not fail or produce empty planes.

3. New routes, mirroring the existing ones:
     GET /api/projects/<pid>/colour/map
     GET /api/projects/<pid>/similarity/graph
   Both scope to that project's references. The similarity route should return
   the same "no scores saved yet" 400 the archive route does when
   similarity_scores is empty.

4. Add tests to tests/test_colour.py and a new tests/test_graph_layout.py:
   a scoped map contains only the requested ids; an empty subset returns empty
   rather than raising; a two-reference project produces a valid graph; the
   unscoped calls return exactly what they did before.

Do not change any existing call site's behaviour. Run the full suite.
````

**Exit criteria:** scoped endpoints return correct subsets, unscoped behaviour is byte-identical, small projects degrade gracefully, suite green.

---

### Session 9 — Colourspace and similarity widgets

**Delivers:** the two 3D widgets, running inside resizable grid cells.

**Model:** Sonnet 5, `extra`
**Estimate:** 3.5–4.5 h · 280–400k tokens · ~1 window

````
Read static/graph.js, static/colour-map.js, static/graph-common.js, the
import map in static/graph.html, and static/project/registry.js first.

Build two widgets that embed live Three.js scenes:

  static/project/widgets/colourspace.js  — the LCh cylinder, project-scoped,
                                           from /api/projects/<pid>/colour/map
  static/project/widgets/similarity.js   — the 3D similarity graph,
                                           project-scoped, from
                                           /api/projects/<pid>/similarity/graph

These currently exist as full-page applications that own the renderer, camera,
OrbitControls, raycaster and a window resize listener. The work is to make them
embeddable without duplicating them.

1. Extract a reusable scene host into static/shared/scene-host.js:
   createSceneHost(el) returning { scene, camera, renderer, controls, start(),
   stop(), resize(), dispose() }. It sizes to its container element rather than
   the window, uses a ResizeObserver rather than a window listener, and pulls
   every visual constant from graph-common.js so the widgets look like the
   full-page views. Pause the render loop when the element is not visible
   (IntersectionObserver) — several 3D widgets on one page must not all render
   continuously.

2. Refactor graph.js and colour-map.js to build their objects into a provided
   scene rather than one they create. colour-map.js already takes (scene, theme)
   and is close; graph.js is not and needs the renderer/camera ownership lifted
   out. The full-page /graph.html must keep working identically — verify it by
   hand before finishing.

3. Each widget subscribes to host.onResize and calls sceneHost.resize(), and
   calls dispose() in destroy() so geometries, materials, textures and the
   WebGL context are released when a widget is removed. Leaking contexts will
   break the page after a few add/remove cycles — this is not optional.

4. Add project.html's import map for three and three/addons, copied from
   graph.html.

5. Widget config: colourspace { exclude_black_white }, similarity
   { show_labels }. Both widgets need a sensible empty state — a project with
   no colour-analysed images, or no saved similarity scores, must say so and
   point at where to fix it, not render an empty box.

The similarity widget should support being driven from either a single
reference or several, per the same combined-profile semantics the existing
colour search uses.

Verify: two 3D widgets on one homepage at once; resize both; remove one and
confirm via the browser's WebGL context count that it was released; reload;
confirm /graph.html is unchanged.
````

**Exit criteria:** both widgets render scoped data, resize correctly, dispose cleanly, and the standalone graph pages are unaffected.

---

### Session 10 — Infinite canvas core

**Model:** Opus 5, `max`
**Fallback (Sonnet 5, `high`):** 10a = viewport transform, pan, zoom, render nodes; 10b = drag, lock, persistence.
**Estimate:** 4–5 h · 300–500k tokens · 1–1.5 windows

````
Read the canvas API in app.py, static/project/main.js, static/shared/cards.js
and static/style.css first. Think carefully about the coordinate system before
writing code.

Build the infinite canvas at #page=canvas on project.html. It must feel
markedly looser than the homepage grid: free positioning, no snapping, and
direct editing with no save step.

1. static/project/canvas/viewport.js — the coordinate system. A single
   transform (scale + translate) applied to one absolutely-positioned world
   layer, so panning and zooming move one element rather than every node.
     - pan: drag on empty space, and space+drag anywhere
     - zoom: wheel, zooming toward the pointer, clamped roughly 0.1x to 4x
     - helpers screenToWorld / worldToScreen, used by everything else
   Store node positions in world coordinates only. Never store screen
   coordinates — they are meaningless after a pan.

2. static/project/canvas/nodes.js — rendering and interaction for
   canvas_nodes. Three kinds, all draggable, lockable and connectable:
     reference — a saved reference from this project, rendered via
                 shared/cards.js
     text      — a user-editable text box, contenteditable, saving on blur
     widget    — a widget instance from the registry, restricted to widgets
                 that make sense free-floating. Container widgets (sidebar) and
                 permanent widgets (settings, exit, canvas) must be excluded;
                 reuse the same container/permanent flags the grid uses rather
                 than a second list.
   Lock/unlock per node via a control on the node. Locked nodes do not move but
   remain connectable and editable.

3. Editing is direct and immediate, in deliberate contrast to the homepage:
     - add from a palette, or by dragging a reference from a picker
     - delete with the Delete key or a control on the node
     - drag to move, with no snapping
     - z-order: bring a node to the front when it is grabbed
   Every change persists straight away, debounced by about 400ms, through
   PATCH /api/canvas/nodes/<nid> for moves and the POST/DELETE routes for
   structure. Do not require an explicit save. Do not use the bulk PUT for
   incremental edits.

4. Performance: only re-render nodes whose data changed. Panning and zooming
   must touch the transform only, never re-render nodes. Use CSS transform,
   not left/top, for node positioning.

5. static/project/widgets/canvas.js — the homepage widget that opens the
   canvas. permanent: true, movable, never removable.

Verify: pan and zoom stay stable through many operations with no drift; a node
dropped, then panned away from and back to, is exactly where it was left;
reload restores positions precisely; a locked node cannot be dragged.
````

**Exit criteria:** pan/zoom/drag are stable and drift-free, every change persists without a save step, locked nodes hold.

---

### Session 11 — Canvas connections and text

> **Partly shipped.** `canvas/edges.js` delivered the edge layer inside the session-10 commit. The rest of this session's scope is superseded by **11a / 11b / 11c** below, which also absorb the new requirements. Kept for the record.

**Model:** Sonnet 5, `high`
**Estimate:** 3–4 h · 250–350k tokens · ~1 window

````
Read static/project/canvas/viewport.js and nodes.js first.

Add Padlet-style linking between canvas nodes.

1. static/project/canvas/edges.js — an SVG layer inside the same transformed
   world element as the nodes, so edges pan and zoom with them automatically
   rather than needing their own transform maths.
     - draw an edge from a handle on a node to another node; show a live
       preview line while dragging
     - edges re-anchor as either endpoint moves, attaching to the nearest point
       on each node's border rather than its centre, so lines do not disappear
       under the nodes
     - bezier curves, not straight lines, so crossing edges stay readable
     - select an edge to delete it; deleting a node deletes its edges
     - persist through POST /api/projects/<pid>/canvas/edges and
       DELETE /api/canvas/edges/<eid>

2. Refine the text node: contenteditable, plain text only (strip pasted HTML),
   auto-growing height, saving on blur and on a debounce. Reuse the text widget
   and its format toolbar from session 4b rather than writing a second
   implementation — same typography config, same contentScale, same toolbar
   component repositioned for the canvas. If the toolbar needs to work in
   canvas world coordinates, adapt it; do not fork it.

3. Edge style config: colour and thickness, stored in canvas_edges.style.
   Default to the existing --accent red the graph threads use, so the canvas
   reads as part of the same tool.

4. Keyboard: Escape cancels an in-progress edge drag; Delete removes the
   selection; Cmd/Ctrl+Z undoes the last structural change (add, delete,
   connect) — keep the undo stack in memory and cap it at around 50 entries.
   Do not attempt undo for text edits; the browser handles those natively.

Verify: an edge follows both endpoints while dragging at several zoom levels;
edges survive a reload; deleting a node removes its edges from the database,
not just the screen.
````

**Exit criteria:** edges anchor correctly at any zoom, persist, and cascade on node deletion.

---

---

### Session 11a — Expanded project appearance

**Delivers:** the full project-wide palette and type controls, an Advanced drop-down when the bar fills, and appearance yielding to the format section when a widget is selected.

**Why this comes first:** accent colour is the default for connection lines in 11c, and the palette affects every widget added in 12. Building those against a colour system that then changes means doing them twice.

**Model:** Sonnet 5, `high`
**Estimate:** 3–4 h · 250–350k tokens · ~1 window

````
Read static/project/appearance.js, appearance-panel.js, top-bar.js,
typography.js, style.css's :root block, and graph-common.js's THEMES first.

Expand project-wide appearance from three controls to a full palette.

1. Settings to add, alongside the existing background, text colour and content
   scale:
     - primary text colour   (what --project-ink already is; label it
                              "Primary text", keep the stored key)
     - secondary text colour (the muted tone -- overrides --muted)
     - accent colour         (overrides --accent; default stays #c23b2e)
     - button colour         (the surface controls sit on)
     - primary font          (headings and titles)
     - secondary font        (body and UI text)
     - 3D graph background   (see item 4 -- not a CSS variable)
   Each is optional and falls back to the current global exactly as
   --project-ink does now. Apply them as scoped custom properties in
   appearance.js's apply(), before first paint, beside the existing ones. Keep
   the derived --light/--dark logic working from the background.

   Fonts: offer the families already in style.css (--serif, --sans, --display)
   plus a monospace. Vendor nothing, add no webfonts.

2. These are project-wide DEFAULTS. A widget with its own config.typography
   still wins. The fallback chain is: widget typography -> project appearance
   -> style.css globals. Do not let the new settings override an explicit
   per-widget choice.

3. Top bar behaviour.
   - When a widget is selected, hide the appearance section entirely and show
     only format -- project-wide defaults are not what you want while
     formatting one widget. Restore it when the selection clears. top-bar.js
     already shows sections independently by key; drive it from the selection
     rather than adding a third section.
   - The bar will not hold this many controls. Keep the most-used in the bar
     (background, primary text, accent, content scale) and put the rest behind
     an "Advanced" control that drops down from it. The drop-down overlays --
     it must not push the grid down the way the bar itself does.

4. The 3D graph background is not a CSS variable. graph-common.js's THEMES
   hard-code it as a hex number per theme, read by the WebGL scenes, which do
   not inherit custom properties. Thread the project's value in instead:
   scene-host.js (or the widget creating it) takes a background override and
   falls back to currentTheme() when there is none. Never call getComputedStyle
   inside the render loop. /graph.html has no project context and must keep
   using the theme value -- verify by hand.

Verify: every setting persists and survives a reload; a widget with its own
typography ignores the project defaults while its neighbours follow them;
selecting a widget hides the appearance controls and deselecting restores them;
the colourspace and similarity widgets pick up the 3D background while
/graph.html does not.
````

**Exit criteria:** the full palette persists, per-widget typography still wins, and the 3D widgets recolour without touching the standalone graph pages.

---

### Session 11b — Text widget cleanup, highlight, undo

**Revised after 11a.** The original scope assumed the canvas had no rich text. It does — Notepad already works there. The real problem turned out to be three overlapping text things on the canvas, one of them broken.

**Delivers:** one plain text option and one rich one, highlight colour, a button-text-colour setting missed in 11a, and canvas undo.

**Model:** Sonnet 5, `high`
**Estimate:** 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read static/project/widgets/text.js, widgets/notepad.js, canvas/palette.js,
canvas/nodes.js, rich-text.js, appearance-panel.js and appearance.js first.

The canvas currently offers three text things, which is two too many:
  - "Text box"  -- the canvas's own text node (canvas_nodes.kind = "text").
                   Inherits the project text colour, no per-selection editing.
  - "Text"      -- widgets/text.js dropped as a widget node. Broken.
  - "Notepad"   -- widgets/notepad.js. Already has full rich text and works.

1. Delete the `text` widget: remove static/project/widgets/text.js and its
   registry entry. Notepad covers everything it was for.

   Migrate existing data rather than leaving broken widgets behind. Anything
   already placed will otherwise render registry.js's missing-widget state:
     - `widgets` rows with type = 'text'
     - `canvas_nodes` rows with kind = 'widget' and config type 'text'
   Convert them to `notepad`, carrying the content across if the two config
   shapes allow it. Compare them first and say in a comment what was preserved
   and what could not be. Write it as a guarded one-off migration in
   db.py's init_db(), following the existing ALTER TABLE try/except pattern.

2. Rename the canvas text node from "Text box" to "Simple text", in
   canvas/palette.js and anywhere else it is surfaced. The comment there
   explaining why it is not called "Text" is obsolete once the Text widget is
   gone -- replace it with the new distinction:

   Simple text stays deliberately plain. It takes the project's typography and
   has no per-selection formatting. Notepad is the rich one. Do not add rich
   text to Simple text -- having one of each is the point. Record that in the
   comment so a later session does not "fix" it.

3. Highlight colour, on everything that already uses rich text -- Notepad now,
   and the analysis widget when session 12 adds it. Works like the existing
   colour control.
   rich-text.js's ALLOWED_PROPS is ["color", "font-family", "font-size",
   "font-weight", "font-style", "text-decoration"] -- add background-color, and
   extend the abstract style shape ({ family, size, colour, bold, italic,
   underline }) with a highlight field, through styleOf(), applyStyle(),
   getSelectionStyle(), applySelectionStyle() and clearSelectionStyle().
   Sanitisation keeps accepting only allowed properties.

   Highlight needs a "none" distinct from "white": clearing it removes the
   property rather than painting the background white, which would look wrong
   on any custom project background.

4. Add "button text colour" to the Advanced appearance options from 11a,
   alongside the existing button colour. Same pattern as every other setting:
   optional, scoped custom property, falls back to the current global.

5. Canvas undo, still outstanding from session 11. Cmd/Ctrl+Z undoes the last
   structural change (add node, delete node, connect, disconnect). In-memory
   stack, capped around 50. Do not attempt undo for text edits --
   contenteditable has native undo and fighting it behaves worse.

Verify: the canvas Add menu offers Simple text and Notepad and no third text
option; an existing text widget on a homepage or canvas became a notepad with
its content intact; highlight applies to a selection in a notepad, clears
cleanly and survives a reload; button text colour persists; undo reverses an
add, a delete and a connection.
````

**Exit criteria:** one plain text option and one rich one, no orphaned `text` rows, highlight round-trips, undo covers canvas structure.

---

### Session 11c — Connection line editing

**Delivers:** click-to-edit connection styling — colour, arrowhead, straight vs curved — per edge.

**Depends on 11a** for the accent colour default.

**Model:** Sonnet 5, `high`
**Estimate:** 3–4 h · 250–350k tokens · ~1 window

````
Read static/project/canvas/edges.js, viewport.js, nodes.js, the canvas_edges
schema in db.py, and the canvas edge routes in app.py first.

edges.js already tracks selection (select(), getSelected(), an .is-selected
class) and draws a visible hairline plus a fat transparent hit line per edge.
Build on that rather than restructuring it.

1. Clicking a connection selects it and opens a small style editor anchored to
   the line, editing only that edge. Clicking empty canvas, another node, or
   pressing Escape dismisses it.

2. Per-edge style persisted in canvas_edges.style. The column exists and the
   POST route accepts it -- add a PATCH route for updating an existing edge if
   one is missing.
     - colour: defaults to the project accent from session 11a, itself
       defaulting to #c23b2e. An edge that has never been styled must FOLLOW
       the project accent when it changes; only an explicitly coloured edge
       keeps its own value. Store the difference -- absent means "follow the
       accent", not a copied hex.
     - arrowhead: none | target end | source end. Use an SVG marker, and make
       it inherit the edge's colour rather than being painted separately, or a
       recoloured edge keeps a stale arrowhead.
     - shape: straight (what is drawn now) or curved. Curved is the bezier the
       original session 11 spec described -- a cubic with control points offset
       along the connection's dominant axis, so crossing edges stay readable.
       Both re-anchor correctly as either endpoint moves.
   Keep vector-effect="non-scaling-stroke" on the visible and hit lines for
   every shape, so a thread stays a thread at 4x and findable at 0.1x.

3. Style applies to the selected edge only. Do not add a global edge style.

Verify: two edges with different colours, arrow directions and shapes coexist;
an unstyled edge follows a changed project accent and a styled one does not;
arrowheads point correctly after switching shape; everything survives a reload;
edges re-anchor while dragging either endpoint at several zoom levels.
````

**Exit criteria:** per-edge styling persists, unstyled edges track the accent, both shapes anchor correctly.

---

### Session 12 — Canvas widgets, analysis widget, canvas preview

**Delivers:** the colour palette widget, a saved-analysis widget, and a live preview inside the homepage canvas widget.

**Model:** Sonnet 5, `high`
**Estimate:** 3–4 h · 250–350k tokens · ~1 window

````
Read static/project/registry.js, canvas/nodes.js, canvas/palette.js,
widgets/canvas.js, pages/analysis-panel.js, widgets/colourspace.js and
shared/cards.js first.

1. canvasEligible already exists in registry.js, defaulting to
   (!container && !permanent), and nodes.js enforces it. Verify it, don't
   rebuild it.

2. static/project/widgets/colour-palette.js -- a colour palette widget showing
   the combined palette of a chosen set of references, via the existing
   /api/colour/search combined-profile semantics. Do not compute a palette
   client-side. config: { reference_ids }.

   NAME CARE: canvas/palette.js already exists and is a different thing -- the
   add-to-canvas UI. Do not call this widgets/palette.js; the two would read as
   the same module.

3. static/project/widgets/analysis.js -- puts a saved analysis on the canvas.
   Analyses are already per project in the analyses table, listed by
   /api/projects/<pid>/analyses and fetched by /api/analyses/<aid>.
   pages/analysis-panel.js renders them in the sidebar today.
     - config: { analysis_id }
     - it should read like the sidebar version: date, reference thumbnails,
       transcript. Reuse analysis-panel.js's rendering rather than writing a
       second one; extract what it needs into a shared function if the panel
       is too coupled to its own container.
     - the transcript supports the same per-selection text editing as
       everything else, including the highlight colour from session 11b. Same
       rich-text.js, same toolbar. Editing the display must not alter the
       stored analysis -- persist any styling in the widget's own config, not
       back into the analyses row, which is a record of what Claude actually
       said.
     - canvasEligible, and usable on the homepage grid too.

4. Give widgets/canvas.js a preview of the canvas's current contents. It is a
   plain navigation link today. Add a non-interactive miniature: fetch
   /api/projects/<pid>/canvas, draw nodes as simple blocks at their world
   positions scaled to fit the widget, with edges as thin lines. Reference
   nodes can show a thumbnail; text and widget nodes are blocks.
     - Not interactable: no pan, no zoom, no drag, no click targets inside it.
       The whole widget stays one link to #page=canvas.
     - Cheap: no Three.js, no live subscription. Render once on load, and
       again on host.onResize. An empty canvas shows an empty state, not a
       blank box.
     - It must not fight the widget's flat-at-rest rule: no border, no fill
       around the preview.

5. Confirm the colourspace widget works as a canvas node -- it resizes with the
   node and pauses rendering when scrolled out of view, which scene-host.js
   already supports. Verify the IntersectionObserver still fires correctly
   inside the transformed canvas world layer; a CSS transform on an ancestor
   can affect intersection calculations, so test rather than assume.

Verify: a colour palette node and a reference node can be connected; an
analysis widget renders on both the canvas and the grid, and styling its text
does not change the saved analysis; the canvas widget preview matches the
canvas after adding and moving a node; a colourspace node pauses when panned
off screen.
````

**Exit criteria:** three new widgets, all first-class canvas citizens, no duplicated widget infrastructure, and the canvas preview stays cheap.

---

### Session 13 — Archive folder roll-up

**Model:** Sonnet 5, `medium`
**Estimate:** 2–3 h · 150–250k tokens · ~0.6 window

````
Read the folders queries in db.py, the archive tab in static/index.html and
refreshArchive/renderGrid in static/app.js first.

Add a cross-project folder view to the Archive page.

1. Backend: GET /api/folders/rollup returns folder names grouped across every
   project, each with a total reference count and the projects contributing:

     [{ name: "Texture", reference_count: 7,
        projects: [{id, title, count}, ...] }, ...]

   And GET /api/folders/rollup/<name>/references returns every reference in any
   folder of that name, across all projects, de-duplicated by reference id,
   using the existing _ref_summary shape so the archive grid can render it
   unchanged.

   The roll-up is by name and is computed, not stored — a folder still belongs
   to exactly one project.

2. Frontend: a folder strip on the Archive tab listing the rolled-up folder
   names. Selecting one filters the archive grid to that roll-up. It composes
   with the existing search, own-work and type filters rather than replacing
   them — this is a gradual narrowing, so the controls must stack. Selecting
   none shows everything, which is the current behaviour.

   Crucially, filtering by folder never hides anything permanently: every
   reference stays on the main archive grid when no folder is selected. A
   folder shows a subset, it does not own it. Make that clear in the UI copy.

3. Show which projects contribute to a selected roll-up, so it is obvious that
   "Texture" is an aggregate rather than one folder.

Verify with two projects that each have a Texture folder with different
references: the roll-up shows the union; clearing the filter restores the full
archive; a reference in both projects' Texture folders appears once.
````

**Exit criteria:** the roll-up unions correctly across projects, de-duplicates, and composes with existing filters.

---

### Session 14 — Integrity pass and desktop audit

**Model:** Sonnet 5, `high`
**Estimate:** 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read DEVELOPMENT_PLAN.md's constraints section, then audit the whole codebase
against it.

1. Persistence integrity. Verify every cascade actually fires:
     - deleting a project removes its folders, folder_references, widgets,
       project_settings, canvas_nodes and canvas_edges
     - deleting a reference removes its folder_references and canvas_nodes, and
       any canvas_edges attached to those nodes
     - deleting a folder removes its folder_references and any folder widgets
       pointing at it, without touching any reference
   Add tests for anything not already covered. Look specifically for orphan
   rows — write a query that finds rows in each new table whose parent no
   longer exists, and assert it returns nothing after a delete.

2. Desktop-readiness audit. Grep the whole static/ tree for:
     - localStorage or sessionStorage used for anything other than the theme
       preference and the existing graph handoff
     - absolute URLs, hard-coded ports, or any http:// literal
     - new webkitdirectory / webkitGetAsEntry usage
     - anything that would break if the app were served from a webview at a
       different origin
   Fix what you find. Report anything you decide not to fix, and why.

3. Regression check by hand, listing the result of each: every tab in
   index.html; /graph.html; /connections.html; /colour-connections.html; the
   browser extension's capture endpoints (run the existing capture tests);
   dark mode on every page.

4. Run the full pytest suite. Then update README.md's "What's next" section to
   describe the project spaces feature accurately.
````

**Exit criteria:** no orphan rows, no constraint violations, full suite green, every pre-existing page still works.

---

## Part 6 — Scheduling against 5-hour Pro windows

| # | Session | Model | Thinking | Hours | Tokens | Windows |
|---|---|---|---|---|---|---|
| 1 | Schema + API | Opus 5 | max | 3.5–4.5 | 250–400k | 1 |
| 2 | Project shell | Sonnet 5 | medium | 2.5–3.5 | 150–250k | 0.75 |
| 3 | Grid engine | Opus 5 | max | 4–5 | 300–500k | 1–1.5 |
| 4 | Edit mode + theming | Sonnet 5 | medium | 3–4 | 200–300k | 1 |
| 4b | Typography + text widget | Sonnet 5 | high | 3–4 | 250–350k | 1 |
| 5 | Sidebar widget | Sonnet 5 | high | 2.5–3.5 | 180–280k | 0.75 |
| 6 | Folder backend | Sonnet 5 | medium | 2–3 | 150–220k | 0.6 |
| 7 | Grid + folder pages | Sonnet 5 | high | 3–4 | 250–350k | 1 |
| 8 | Scoping refactor | Opus 5 | high | 2.5–3.5 | 200–300k | 0.75 |
| 9 | 3D widgets | Sonnet 5 | extra | 3.5–4.5 | 280–400k | 1 |
| 10 | Canvas core | Opus 5 | max | 4–5 | 300–500k | 1–1.5 |
| 11 | Canvas edges + text | Sonnet 5 | high | — | — | *partly shipped in S10* |
| 11a | Expanded project appearance | Sonnet 5 | high | — | — | *done* |
| 11b | Text cleanup, highlight, undo | Sonnet 5 | high | — | — | *done* |
| 11c | Connection line editing | Sonnet 5 | high | 3–4 | 250–350k | 1 |
| 12 | Canvas + analysis widgets, preview | Sonnet 5 | high | 3–4 | 250–350k | 1 |
| 13 | Archive roll-up | Sonnet 5 | medium | 2–3 | 150–250k | 0.6 |
| 14 | Integrity + audit | Sonnet 5 | high | 2.5–3.5 | 200–300k | 0.75 |
| | **Remaining (11c–14)** | | | **8–10.5 h** | **650k–950k** | **2.6–3.2** |

**Realistic calendar:** at one window a day, a little over three weeks. At two windows a day, eight to ten days. Add roughly 20% for the debugging sessions that always appear — sessions 3, 9 and 10 are the likeliest to need a follow-up window.

### If Opus is unavailable on Pro

Sessions 1, 3, 8 and 10 split as described in their fallbacks, adding roughly 3 windows. Total becomes 16–18 windows. The splits are clean — each half has its own exit criteria — so nothing is lost beyond elapsed time.

### Window discipline on Pro

- **Start each session with `/clear`.** Carrying a previous session's context into a new one is the single biggest avoidable token cost.
- **Let the prompt do the file reading.** Each prompt above opens by naming the files to read. That is deliberate: one directed read beats five exploratory greps.
- **Don't ask for a summary at the end.** Exit criteria are the summary.
- **Reserve `max` for sessions 3 and 10, and `ultracode` for emergencies.** Using either on session 6 wastes a third of a window for no benefit. If a session feels over-served — it finishes fast with no backtracking, as session 1 did — step it down one level next time.
- **If a session overruns its window, stop at a working state and commit** rather than pushing into the next window mid-feature. Every session above is scoped to leave the app runnable.

### Checkpoints worth committing

Commit at the end of every session. Four points are worth tagging, because they are the natural rollback targets:

- after **S2** — shell works, nothing else changed
- after **S4** — homepage is fully functional and editable
- after **S9** — every homepage feature is complete
- after **S12** — canvas complete

---

## Part 7 — Requirements traceability

Every item you specified, and where it lands.

| Requirement | Session |
|---|---|
| Project becomes its own site | 2 |
| Project title replaces "Fashion Reference Library" top-left | 2 |
| Top-right navigation replaced | 2, 7 |
| Modular build | 3 (registry + contract) |
| Arrangement editor, grid-based | 3, 4 |
| Colourspace widget (3D colour graph) | 8, 9 |
| Similarity 3D graph widget, single or multiple images | 8, 9 |
| Title widget | 3 |
| Sidebar widget holding other widgets, opens on button press | 5 |
| No sidebars inside sidebars | 1 (API), 5 (UI) |
| First entry shows only title + settings + exit | 1 (seeding) |
| Settings and exit widgets permanent but movable | 1, 3, 4 |
| Font colour and size configurable | 4 (project-wide), 4b (per widget) |
| Background colour configurable | 4 |
| Widget linking to the current-style project page | 7 |
| Selection can move images into folders | 6 |
| Project page shows all references regardless of folder | 7 |
| Images can be in multiple folders | 1, 6 |
| Each folder is a widget leading to its own page | 7 |
| Folder pages support selection, deletion, analysis | 7 |
| Deleting from a folder keeps it in the project | 1, 6, 7 |
| Default folders: Texture, Colour, Form, Vibe, Fashion, Narrative | 1 |
| Default folders removable and renameable | 1, 6 |
| Archive folder roll-up across projects | 13 |
| Anything in a folder stays on the main page | 13 |
| Back arrow, top right, on every sub-page | 7 |
| Per-widget font, size, colour, style with a floating toolbar | 4b |
| Content scale independent of widget footprint | 4b |
| Infinite canvas with references, text boxes and widgets | 10, 12 |
| Line connections between canvas items | 11 |
| Canvas entry widget, permanent but movable | 10 |
| Canvas drag, lock and unlock | 10 |
| Canvas feels loose, homepage feels gridlike | 3 (grid), 10 (canvas) |
| Canvas easy to edit; homepage requires settings + save | 4, 10 |
| Project palette: primary/secondary text, accent, button, fonts, 3D background | 11a |
| Advanced settings drop-down when the bar fills | 11a |
| Appearance controls hide when a widget is selected | 11a |
| One plain text option (Simple text) and one rich (Notepad) | 11b |
| Button text colour | 11b |
| Highlight colour in text editing | 11b |
| Click a connection to edit its style | 11c |
| Per-edge colour, arrowhead, straight vs curved | 11c |
| Saved-analysis widget | 12 |
| Canvas widget shows a preview of its contents | 12 |
| Everything persists | 1, and every session after |

---

## Part 8 — Risks

**The grid collision algorithm (S3).** Push-down-and-compact is easy to get subtly wrong in ways that only show up after several drags. Mitigation: the prompt demands determinism, and the exit criteria name the specific manual test. If it misbehaves, fix it before session 4 — every later widget inherits the bug.

**Three.js context leaks (S9).** Browsers cap live WebGL contexts, typically around 16. Adding and removing 3D widgets without disposing will silently break the page. Mitigation: `dispose()` is called out explicitly and the exit criteria require verifying context release.

**`app.js` module conversion (S2).** Converting a 1615-line classic script to a module changes the timing of top-level code and the scoping of its many `const` declarations at file scope. Mitigation: the prompt limits the change to what the extraction requires, and the exit criteria require checking every tab.

**Canvas coordinate drift (S10).** Mixing screen and world coordinates produces slow drift that is very hard to trace later. Mitigation: the prompt mandates world coordinates in storage and a single transform, and the exit criteria test for drift specifically.

**Scope creep in the widget palette.** Each new widget is cheap once the kernel exists, which is exactly why the plan should be finished before more are added. Build the eight specified widgets, complete session 14, then add more.

---

## Part 9 — Phase 8: post-completion work

Sessions 1–14 are done. This phase covers three bugs and eight changes raised after the app went into real use. Order is by dependency and by how much each is blocking day-to-day use: the editing bugs first because they break the core loop, then canvas interaction, then the style system, which is the largest single addition.

```
S15  grid editing bugs
S16  canvas selection, widget drag-in, webview drag fix
S17  colour analysis at ingest + default layout template
S18  style presets
S18b layout presets + baked-in default
S19  generate a style from a palette
S20  all-references widget + text reference rendering
S21  constellation: metric 3D archive view
```

---

### Desktop packaging prerequisites

The pywebview spike (`DESKTOP_SPIKE.md`) resolved the big unknown favourably: WebGL2 and the ES module import map both work in the system WebKit with no shimming, multiple 3D widgets coexist, and `scene-widget.js`'s dispose discipline holds under repeated add/remove. **pywebview is viable.**

Two items must be handled before real packaging. Neither is a session; both are small enough to fold into whichever session touches that area.

1. **`private_mode=False` plus a real `storage_path` on `webview.start()`.** pywebview defaults to `private_mode=True`, which on the Cocoa backend wipes the WebKit data store at every launch. Everything works within a run, so this is easy to ship without noticing — but the theme preference (and anything else client-side persisted) silently resets every time the app opens. `desktop.py` does not currently pass these.
2. **A human must click through the native folder picker and drag a real Finder folder onto the dropzone, once.** Feature detection says both should work; nothing has exercised the actual `NSOpenPanel` or an OS-level drag. Until someone does, treat hard rule 5 as still binding.

Also unverified, but low risk: PDF thumbnails, which are rendered server-side by PyMuPDF and served as an ordinary image — there is no client-side PDF API for a webview to break.

---

### Session 15 — Grid editing bugs

**Delivers:** the move handle works; adding a widget stops discarding unsaved layout edits.

**Model:** Sonnet 5, `medium`
**Estimate:** 1.5–2.5 h · 120–200k tokens · ~0.5 window

````
Read static/project/grid.js (particularly onPointerDown and the move-handle
creation around line 236), main.js's addWidget path, and widget-dock.js first.

Two bugs in homepage edit mode.

1. The six-dot move handle does nothing. grid.js's onPointerDown returns early
   when the event target is inside `.widget-move-handle` -- it sits in the same
   ignore list as `.widget-remove` and `.widget-shadow-toggle`, which are click
   targets that must not start a drag. But the move handle is the opposite: it
   is the one element that SHOULD start a drag.

   Take it out of that list and make a pointerdown on it begin a move gesture
   for its widget. Leave the genuine click targets ignored. Add a comment
   distinguishing the two kinds of inner control, since the list will grow
   again and the next person will make the same mistake.

   While you are there: check whether dragging from the widget body still
   starts a move, and decide deliberately whether the handle is the only way to
   move a widget or merely one way. Say which in a comment.

2. Adding a widget sometimes reverts unsaved changes to other widgets. The
   likely cause is that adding re-reads the layout from the server (or from a
   stale snapshot) and overwrites the in-memory positions the user has just
   dragged but not yet saved. Find the actual path before changing anything.

   The rule: adding a widget must splice the new widget into the CURRENT
   in-memory layout and leave every other widget's unsaved position untouched.
   Nothing in edit mode should re-fetch layout from the server -- edit mode owns
   the layout until Save or Cancel.

Verify: enter edit mode, drag three widgets without saving, add a fourth from
the dock, and confirm the first three are still where you dropped them; save
and reload and confirm all four persist; the move handle drags from its first
pixel with no lag.
````

**Exit criteria:** the handle moves widgets, and no add operation can lose an unsaved drag.

---

### Session 16 — Canvas selection, widget drag-in, and the webview drag bug

**Delivers:** box-select and multi-drag, widgets dragged onto the canvas like references, and reference-adding fixed in the desktop wrapper.

**Why together:** all three live in `canvas/palette.js` and `canvas/nodes.js` and all three are about the same pointer machinery. Doing them separately means touching the same two files three times.

**Model:** Sonnet 5, `high`
**Estimate:** 3–4 h · 250–350k tokens · ~1 window

````
Read static/project/canvas/nodes.js, palette.js, viewport.js and edges.js
first.

1. Adding a non-text reference to the canvas fails in the desktop webview.
   palette.js drags references in using native HTML5 drag and drop
   (dataTransfer.setData), which WKWebView supports inconsistently. Reproduce
   in the wrapper before changing anything, and check whether the failure is
   the dragstart, the drop, or the dataTransfer payload.

   Replace the native HTML5 drag with the same pointer-event gesture nodes.js
   already uses for moving nodes (pointerdown/move/up with setPointerCapture).
   Pointer events behave identically in Chrome and WKWebView, and the canvas
   already depends on them working. Keep a click-to-add fallback for every
   item, so nothing is drag-only -- that is also the keyboard and touch path.

2. Widgets should drop onto the canvas the way references do. palette.js
   currently adds a widget on click, landing it in the middle of the view,
   with a comment reasoning that a widget "has no particular place it belongs".
   That reasoning no longer holds -- make widgets draggable from the palette to
   an exact drop point, using the same pointer gesture as item 1. Click-to-add
   stays as the fallback.

3. Box selection and multi-drag. Dragging on empty canvas currently pans.
   Add a marquee: hold the middle mouse button (or a modifier with the primary
   button, since not every mouse or trackpad has a middle click -- support both
   and say so in a comment) and drag to draw a selection rectangle. Every node
   whose box intersects it becomes selected.
     - selected nodes get a visible state that does not rely on a border or
       fill, per the neumorphic rule
     - dragging any selected node moves all of them together, preserving
       relative positions
     - Delete removes all selected; Escape and a click on empty canvas clear
       the selection
     - locked nodes inside the marquee are selected but do not move
     - persistence is per node through the existing PATCH route, one request
       per moved node, debounced as now -- do not add a bulk endpoint
   The marquee is drawn in screen space but selection is tested in world
   coordinates. Do not store screen coordinates anywhere.

Verify in BOTH Chrome and the pywebview wrapper: dragging an image reference
onto the canvas works in both; dragging a widget lands it where dropped;
marquee-selecting five nodes and dragging moves all five with relative spacing
intact; undo (from 11b) reverses a multi-node move.
````

**Exit criteria:** references and widgets both drag in, in both runtimes; multi-select moves as one.

---

### Session 17 — Colour analysis at ingest, and a default layout template

**Delivers:** colour profiles computed when a reference is added, a settings button to fill gaps, and new projects seeded from a template project.

**Model:** Sonnet 5, `medium`
**Estimate:** 2–3 h · 150–250k tokens · ~0.6 window

````
Read ingest.py's add_reference, colour.py (analyse_image, backfill, coverage),
the /api/colour/* routes in app.py, db.py's DEFAULT_WIDGETS and the project
creation path, and the Settings tab in static/index.html first.

1. Analyse colour at ingest. Image references currently get a colour profile
   only via the backfill; nothing computes one when a reference is added, so a
   fresh library has no colour data until someone runs a backfill. Call the
   analysis from ingest.add_reference for image references, storing through the
   existing colour_analysis table.

   It must not make adding a reference fail: analysis is derived data, so a
   failure logs and moves on, exactly as a missing profile does today. It is
   local computation (~40ms an image, no network), so it does not need the
   capture queue.

2. Add a "Colour analysis" section to the Settings tab in index.html, beside
   the existing similarity-scores section and following its pattern exactly:
   a status line from /api/colour/coverage showing how many images have a
   current-version profile, and a button that runs /api/colour/backfill until
   coverage is complete.

   Be accurate in the copy about what this does. Positions in the colourspace
   graph are DERIVED from stored profiles at query time by colour.colour_map()
   -- there is no stored position to recompute. So the button's real job is to
   fill in references that have no current profile: ones added before item 1
   existed, ones whose file changed, and ones analysed under an older
   ANALYSIS_VERSION. Say that plainly rather than implying it recomputes the
   graph.

3. Seed new projects from a template project instead of the hard-coded
   DEFAULT_WIDGETS tuple. The user maintains a project called "Default Project
   Layout"; creating a project should copy that project's widgets (types,
   positions, sizes, config, and any parent_id nesting) rather than the four
   hard-coded rows.
     - fall back to the existing DEFAULT_WIDGETS if no such project exists, so
       a fresh install still works
     - copy widgets and project_settings (the appearance). Do not copy its
       references, folders or canvas.
     - make the template project's name a constant in db.py, not a literal
       scattered around

   NOTE A REAL BUG WHILE YOU ARE HERE: DEFAULT_WIDGETS holds 12-column
   coordinates -- ("title", 0, 0, 12, 2) -- but the grid has been 24 columns
   since the free-placement change. Every seeded layout is currently half
   width. Fix the fallback values to 24-column coordinates.

Verify: a newly added image has a colour profile immediately; the settings
button reports accurate coverage and completes; a new project matches "Default
Project Layout" including appearance; deleting the template project still
leaves project creation working, at full width.
````

**Exit criteria:** colour data exists from ingest onward, and new projects inherit the template.

---

### Session 18 — Style presets

**Delivers:** named styles saved from the appearance controls and loadable into any project, plus a Default entry that hands control back to light/dark mode.

**Model:** Sonnet 5, `high`
**Estimate:** 3–4 h · 250–350k tokens · ~1 window

````
Read static/project/appearance.js, appearance-panel.js, top-bar.js, db.py's
schema constants and project_settings handling, and the settings routes in
app.py first.

1. New table, following the existing conventions exactly (constant at the top
   of db.py, registered in init_db()):

     styles   id TEXT PK, name TEXT NOT NULL, settings TEXT NOT NULL,
              date_created TEXT NOT NULL

   Styles are GLOBAL, not per project -- the whole point is reusing one across
   projects. `settings` is the same JSON shape project_settings already stores,
   so saving a style is a copy of the current appearance and loading one is a
   copy back. Do not invent a second shape.

   Routes: GET /api/styles, POST /api/styles {name, settings},
   PUT /api/styles/<id>, DELETE /api/styles/<id>.

2. In the page-wide appearance section of the top bar, add:
   - "Save current style" -- prompts for a name and stores the project's
     current appearance. Saving over an existing name updates it, after
     confirming.
   - a dropdown of saved styles. Selecting one applies it to the current
     project immediately, through the existing appearance apply path, and
     persists to that project's project_settings. It must go through
     appearance.js's apply() -- do not write a second application path.

3. A permanent "Default" entry at the top of the dropdown, which is not a row
   in the table. Selecting it CLEARS the project's appearance overrides
   entirely, so the page falls back to style.css's globals and therefore
   follows the light/dark toggle again. This is the only entry whose appearance
   changes when the theme changes; every saved style is a fixed set of colours
   and stays put.

   Make that distinction explicit in the UI copy and in a comment -- "Default"
   meaning "follow the theme" rather than "a style called Default" is exactly
   the sort of thing a later session will misread.

4. Deleting a style must not alter any project that was using it: a project
   stores its own resolved settings, not a reference to a style id. Confirm
   that is true of your implementation and say so in a comment.

Verify: save a style in one project and apply it in another; the theme toggle
moves a Default-styled project and leaves a styled one alone; deleting a style
leaves projects untouched; everything survives a reload.
````

**Exit criteria:** styles round-trip across projects, and Default genuinely restores theme-following.

---

### Session 18b — Layout presets and a baked-in default

**Added after session 17 shipped.** S17 seeds new projects by copying a live "Default Project Layout" project at creation time. That makes the default depend on a project continuing to exist. The default should instead be *baked in*, with the template project reduced to a one-time source for capturing it — and layouts should be saveable and reusable in their own right, exactly as styles are.

**Runs after session 18**, and deliberately mirrors it: a layout preset is the same kind of object as a style preset, so it should copy that pattern rather than invent a second one.

**Model:** Sonnet 5, `high`
**Estimate:** 3–4 h · 250–350k tokens · ~1 window

````
Read db.py's DEFAULT_WIDGETS, TEMPLATE_PROJECT_TITLE and
seed_project_defaults(), session 18's styles table and its save/load controls
in appearance-panel.js, top-bar.js, and the widget config shapes in
widgets/folder.js, analysis.js, colour-palette.js and sidebar.js first.

1. Bake in the default. Read the current "Default Project Layout" project's
   widget rows and hard-code them as DEFAULT_WIDGETS -- types, positions,
   sizes, config and any parent_id nesting. Then remove the live lookup:
   seed_project_defaults() should no longer query TEMPLATE_PROJECT_TITLE at
   creation time.

   The point is that deleting that project must not change what a new project
   looks like. It exists only as a convenient way to SHOW what the default
   should be; once captured, it is an ordinary project.

   Keep the referencing idea, though -- it becomes item 2's "save this
   project's layout", which is the same operation performed on demand rather
   than at every project creation.

2. New table, following session 18's styles table exactly:

     layouts  id TEXT PK, name TEXT NOT NULL, widgets TEXT NOT NULL,
              date_created TEXT NOT NULL

   `widgets` is the serialised widget list. A layout is INDEPENDENT of the
   project it came from: deleting that project must leave the layout usable.
   Store the widget data itself, never project or widget ids pointing back.

   Routes mirroring the styles ones: GET /api/layouts,
   POST /api/layouts {name, project_id}, PUT /api/layouts/<id>,
   DELETE /api/layouts/<id>.

3. What a layout captures, and what it must not:
     captures  -- widget types, x/y/w/h, config, locked, position, parent_id
                  nesting
     excludes  -- references, folders, canvas nodes and edges, and appearance
   Appearance is session 18's job and stays separate. A project should be able
   to take a layout from one source and a style from another.

4. Save and load controls beside session 18's style controls in the top bar:
   "Save current layout" (prompts for a name) and a dropdown of saved layouts.
   A permanent "Default" entry at the top loads the baked-in DEFAULT_WIDGETS --
   it is not a row in the table, exactly as "Default" is not a row in styles.
   Default remains what a newly created project gets.

5. Two things loading a layout must get right:

   PERMANENT WIDGETS. settings, exit and canvas cannot be deleted, and a
   project must never end up without them. Loading a layout replaces the
   arrangement, so decide deliberately: reposition the existing permanent
   widgets to match the layout's entries for those types, and if the layout
   has no entry for one, leave it where it is rather than dropping it. Do not
   delete and recreate them -- the API refuses, and it would break the
   canvas's only door.

   PROJECT-SCOPED CONFIG. Several widget configs carry ids that mean nothing
   in another project: folder.js's folder_id, analysis.js's analysis_id,
   colour-palette.js's reference_ids. Carrying them across would produce
   widgets pointing at another project's data. Strip these on load, leaving
   the widget in its unconfigured state, and say in a comment which fields are
   project-scoped so a new widget type gets added to that list rather than
   quietly breaking. Consider whether saving should strip them instead --
   pick one, and be consistent.

Verify: capture the default, delete the "Default Project Layout" project, and
confirm a new project still gets the right layout at full width; save a layout
from one project and load it in another; delete the source project and confirm
the layout still loads; a loaded layout leaves settings/exit/canvas present;
a folder widget arriving via a layout does not point at the source project's
folder; loading a layout does not change appearance, and loading a style does
not change layout.
````

**Exit criteria:** the default survives deleting its source project, layouts round-trip independently, and layout and appearance stay separable.

---

### Session 19 — Generate a style from a colour palette

The most speculative session in the plan. The output is a *suggestion* the user previews and accepts, so err toward legible and dull over clever.

**Model:** Sonnet 5, `extra`
**Estimate:** 3.5–4.5 h · 300–400k tokens · ~1 window

````
Read colour.py (profile shape, palette entries with rgb and weight,
rgb_to_lab, lab_to_rgb), static/project/widgets/colour-palette.js, the
/api/colour/search combined-profile path, session 18's styles table, and
appearance.js first.

1. Saved palettes. A palette generated on the all-references page or a folder
   page can currently be seen but not kept. Add:

     palettes  id TEXT PK, name TEXT NOT NULL, profile TEXT NOT NULL,
               source TEXT, date_created TEXT NOT NULL

   `profile` is the combined colour profile colour.py already produces --
   store it whole, not just the swatches, because generation needs the weights.
   `source` records where it came from (archive-wide, or a folder id) for the
   user's benefit only. Routes: GET/POST /api/palettes, DELETE /api/palettes/<id>.
   Add a save control wherever a palette is currently displayed.

2. Style generation, in a new module `style_gen.py`. Input: a stored palette.
   Output: the same settings JSON shape project_settings and styles use.

   Map by PROPORTION -- a palette entry's `weight` is the fraction of the image
   it covers, so the heaviest colour should occupy the largest area of the page:
     - heaviest      -> background
     - next          -> button surface
     - a mid weight  -> accent
     - text colours are NOT taken from the palette by proportion; they are
       chosen for contrast (see below)

   Then enforce contrast, which overrides proportion every time:
     - primary text against background: aim for WCAG AA on body text (4.5:1);
       never go below 4.5:1
     - secondary text against background: at least 3:1
     - button text against the button surface: at least 4.5:1
     - accent against background: at least 3:1, since it is used for focus and
       small marks
   Compute contrast with the standard WCAG relative-luminance ratio. When a
   palette colour cannot meet a threshold, do not fail -- walk its lightness in
   CIELAB toward black or white until it does, keeping hue and chroma. That
   keeps the generated style recognisably from the palette rather than
   collapsing to black on white. colour.py already has rgb_to_lab/lab_to_rgb;
   use them rather than adding a second colour space.

   Fonts are NOT derived from a palette. Leave them unset so the project's own
   or the global defaults apply.

3. UI: choose a saved palette, generate, and PREVIEW the result live on the
   current project before committing -- apply through appearance.js's existing
   path with an explicit Cancel that restores what was there before. Accepting
   saves it as a named style through session 18's styles table, so generated
   and hand-made styles are the same kind of thing afterwards.

4. Show the computed contrast ratios in the preview. If a value had to be
   adjusted to meet a threshold, say so. The user should be able to see why a
   colour is not exactly the one in the palette.

Add tests in tests/test_style_gen.py: a palette of near-identical mid greys
still produces a readable style; every generated style meets every threshold;
the same palette always produces the same style.

Verify by eye on three real palettes -- a dark moody one, a pale neutral one,
and a high-chroma one -- that the result is legible in every case.
````

**Exit criteria:** generation is deterministic, always meets its contrast floors, and previews before it commits.

---

### Session 20 — All-references widget and text reference rendering

**Delivers:** the reference grid embedded as a homepage widget, and text references shown as readable text rather than a placeholder.

**Model:** Sonnet 5, `high`
**Estimate:** 2.5–3.5 h · 200–300k tokens · ~0.75 window

````
Read static/project/pages/grid-page.js, widgets/grid-button.js,
shared/cards.js (makeCard and textCard), canvas/nodes.js's
buildReferenceBody, and widgets/notepad.js first.

1. static/project/widgets/all-references.js -- the project's reference grid as
   a widget rather than a page. grid-button.js navigates to the grid page;
   this embeds the same thing.
     - reuse pages/grid-page.js. If it is too coupled to being a full page,
       extract the grid and its selection toolbar into something both can
       mount, rather than writing a second copy.
     - selection, delete, analyse, colour similarity and move-to-folder all
       behave as they do on the page
     - defaultSize should be large -- this is meant to dominate a homepage.
       Something like 16x8 on the 24-column grid.
     - canvasEligible: false. This is a homepage widget; the canvas has its own
       ways of holding references and an embedded scrolling grid there would
       fight the viewport transform.
     - it scrolls internally; it must never resize the widget or push the grid

2. Text references currently render as a placeholder card -- an icon plus a
   description snippet -- because /media/<id>/thumb 404s for a .txt. Show the
   actual text instead, styled like a notepad: the file's contents in a
   scrollable body, with the reference TITLE pinned at the BOTTOM so it stays
   visible while the text scrolls.

   Apply this wherever a text reference is rendered as a card or node:
   shared/cards.js's textCard, and the canvas's reference nodes.

   - serve the text through the existing /media/<id> route; do not add a new
     one, and do not put file contents in the reference list payload, which
     would bloat every grid load
   - fetch lazily, only when a text card is actually rendered
   - long files clip rather than growing the card; there is no expand control
   - it is READ ONLY. It looks like a notepad; it is not one. Editing a
     reference's text would rewrite an archive file, which nothing else in the
     app does. Say so in a comment.
   - PDFs keep their rendered first-page thumbnail and are unaffected

Verify: the all-references widget on a homepage supports the same selection
and actions as the page; a text reference shows its text with the title pinned
at the bottom in both the grid and on the canvas; a very long text file clips
without changing the card size; PDFs are unchanged.
````

**Exit criteria:** the widget matches the page's capabilities, and text references read as text.

---

### Session 21 — Constellation: a metric 3D view of the whole archive

**Delivers:** a third archive-wide 3D view where distance in space genuinely approximates distance in CLIP space, on a modality-corrected similarity matrix.

**Why this exists.** The existing similarity view places a node's angle within its plane as `(idx / len) * 2π`, where `idx` is just its rank in degree order. Only the radius — distance from the cluster hub — carries meaning, so two references sitting next to each other have no reason to be alike. The colour cylinder is fully metric on all three axes; the similarity view is not. This is the missing view: one where being near means being similar.

**Measured on the real archive before writing this** (131 references, 8,515 pairs). Numbers are from that run and are what the implementation should roughly reproduce:

| Layout | Stress | True NN in top 5 | Core density | Axis 1 = modality |
|---|---|---|---|---|
| MDS raw | 0.372 | 0.344 | 0.710 | 2.69 |
| MDS corrected | 0.320 | 0.336 | 0.313 | 0.54 |
| Force raw | 0.220 | 0.443 | 0.191 | 2.14 |
| **Force corrected** | 0.255 | 0.321 | 0.069 | 0.24 |

**Model:** Sonnet 5, `high`
**Estimate:** 3.5–4.5 h · 300–400k tokens · ~1 window

````
Read graph_layout.py (build_graph and its k-means), embeddings.py
(compute_all_pairwise_similarities), static/graph.js, static/similarity-map.js,
static/colour-map.js, static/shared/scene-host.js, static/graph-common.js
(especially disposeSubtree and the userData.shared rule), and
static/project/scene-widget.js first.

Build a third archive-wide 3D view. Per CLAUDE.md, it is a fourth CALLER of
scene-host.js, not a fourth renderer.

1. Modality correction, in graph_layout.py. CLIP text and image embeddings
   occupy separate cones, so text-image cosine similarity is systematically
   lower than image-image regardless of meaning. Measured on the real archive,
   this dominates: the raw first axis separates the 10 text references from
   the 116 images, spending the single most valuable dimension on a
   distinction the file extension already gives you.

   Correct it by standardising the similarity matrix in three blocks --
   image-image, text-text, image-text -- to a common mean and standard
   deviation taken from the whole matrix, then clipping to [0,1] with a
   unit diagonal. That is pure numpy over data you already store.

   This must NOT touch the stored similarity_scores table, and must NOT change
   what /api/similarity/graph or /api/similarity return. It is a layout-time
   transform for this view only. A reference type other than image or text
   (there are none today) must not crash it.

2. Force-directed 3D layout, in a new function in graph_layout.py.
   Springs proportional to corrected similarity, repulsion between all pairs,
   cooling step size. Do NOT use MDS: measured on the real archive it gives
   worse stress (0.320 vs 0.255) and eight times the core concentration once
   the modality correction is applied.

   Determinism is required -- the same archive must always produce the same
   map, exactly as colour_map() guarantees. Seed the RNG with a constant, and
   iterate references in a stable id-sorted order so the input never varies.
   State both in a comment.

   Performance: this is O(n^2) per iteration. At 131 references it is well
   under a second; it will not stay that way. Scale the iteration count down
   as n grows and document the point at which this needs to become a stored,
   versioned table (hard rule 8) rather than an on-demand computation. Follow
   build_graph()'s on-demand precedent for now.

3. Report the projection's honesty alongside the positions:
     - Kruskal stress: how much the 3D distances distort the true ones
     - neighbour retention: for what fraction of references the true nearest
       neighbour is among the five nearest on the map
   Measured, these land around 0.26 and 0.32. That second number matters: this
   view is a BROWSING surface, not a precise neighbour finder. It sits
   alongside the existing exact search and never replaces it. Surface both
   figures in the UI in plain language, in the same spirit as the README's
   note about CLIP similarity scores running high. Do not round them away or
   bury them.

4. New route GET /api/similarity/constellation returning nodes with x/y/z and
   the same _ref_summary shape the other views use, plus the two quality
   figures and the cluster id per node. Return the existing 400 when
   similarity_scores is empty, matching /api/similarity/graph.

   Reuse build_graph()'s existing k-means cluster labels to COLOUR nodes, so
   this view and the plane view visibly agree about what groups exist. Do not
   run a second clustering.

5. static/constellation-map.js -- builds into a scene handed in, exactly as
   colour-map.js does with createColourMap(scene, theme). Every visual
   constant comes from graph-common.js. Add it as a third mode in graph.js
   beside the similarity and colour modes.

   Density is the main visual risk: a cloud of 131 thumbnails is mush, and
   more will be worse. Reuse the existing distance-based thumbnail LOD
   (THUMBNAIL_DISTANCE) so zoomed-out shows dots and thumbnails resolve as you
   move in. Draw only the strongest threads, if any -- the positions carry the
   similarity information here, so heavy edges would just be noise.

   Disposal: follow graph-common.js's disposeSubtree rule and leave anything
   marked userData.shared alone. A leaked WebGL context breaks the page after
   a handful of mode switches.

6. If the window allows, add a `constellation` widget in
   static/project/widgets/, scoped to the project's references, built on
   scene-widget.js like colourspace.js and similarity.js. It reaches the
   widget dock automatically via shell.addableTypes(). Drop this item rather
   than rushing it -- the archive-wide view is the deliverable.

Add tests in tests/test_graph_layout.py: the correction leaves the stored
similarity_scores untouched; the same input twice produces identical
positions; an archive of two references does not crash; an all-image archive
(no text block) is handled; stress and neighbour retention are returned and
are in [0,1].

Verify by hand: /graph.html offers three modes and switching between them
repeatedly does not leak WebGL contexts; the constellation's clusters agree in
colour with the plane view's; the quality figures are visible and honest;
zooming in resolves thumbnails.
````

**Exit criteria:** distance on screen means distance in embedding space, the modality gap no longer owns an axis, positions are reproducible, and the view states its own error.

