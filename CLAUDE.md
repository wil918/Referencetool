# CLAUDE.md

Standing context for every session in this repo. Kept deliberately short — it is loaded on every run.

Build order, estimates and per-session prompts live in `DEVELOPMENT_PLAN.md`. Do not read that file unless explicitly asked; it is a planning document for the human, not context for you.

---

## Git workflow

**Never commit to `main`, and never work directly in the user's main folder.** `main` — local and on GitHub — must stay untouched while a feature is being built and tested.

The user's folder `~/Desktop/fashion-reference-tool` is where they run and test the app. It sits on `test-widget-dock`, a disposable local-only preview branch that is never pushed. Treat that folder as theirs, not yours.

Your workflow for every piece of work:

1. Work in a **git worktree on your own branch**, named `claude/<worktree-name>`. Never in the user's main folder, never on `main`, never on `test-widget-dock`.
2. **Commit and push that branch to GitHub as you go**, so there is always something for the user to pull.
3. When there is something to try, **tell the user how to test it** — give them exactly this, to run from `~/Desktop/fashion-reference-tool`:

   ```
   git checkout test-widget-dock
   git merge claude/<your-branch-name>
   ```

   This is repeatable: every time you push more commits, they run the merge again.
4. **Only merge to `main` when the user explicitly confirms a feature is tested and approved.** Then fast-forward the feature branch onto `origin/main` and tell them, so they can switch their folder to `main` if they want.

If you are ever unsure whether something counts as approval, it does not. Ask.

---

## What this is

A local-first reference library for fashion design research. Images, PDFs and text notes are ingested, auto-tagged by Claude, embedded with CLIP, and explored through a 2D archive and several 3D visualisations. Flask serves both the API and the frontend at `127.0.0.1:5050`. Everything runs on the user's machine; the only outbound calls are to the Anthropic API for tagging and analysis.

---

## Hard rules

These are not preferences. Violating one means the change gets reverted.

1. **No build step.** No `package.json`, no bundler, no npm. The frontend is ES modules served directly by Flask. Bare specifiers resolve through an `<script type="importmap">` in each page that needs them (`static/graph.html`, `static/connections.html`, `static/colour-connections.html`, `static/project.html` — all the same map). Third-party code is vendored into `static/vendor/`, as Three.js already is.
2. **User data persists to SQLite through the API.** Never `localStorage` or `sessionStorage` for widget layouts, folders, canvas contents, project settings or anything else the user created. The only permitted uses are the existing ones: the theme preference in `theme.js`, and the graph→connections handoff in `graph-common.js`.
3. **Relative fetch paths only.** `fetch("/api/...")`. No absolute URLs, no hard-coded ports, no `http://` literals in client code. Only `app.py` knows the port. This keeps a desktop webview build viable later.
4. **Never assume `file://`.** ES modules and the import map break under it. Everything is served over the local HTTP origin.
5. **No new `webkitdirectory` / `webkitGetAsEntry` usage.** The existing two uses in `index.html` and `app.js` stay; don't add more.
   *Evidence update (desktop spike, `DESKTOP_SPIKE.md`):* the WKWebView on current macOS **does** implement both — `webkitdirectory` feature-detects true, and `webkitGetAsEntry` returns a real `FileSystemFileEntry`, not a stub. That is a genuine improvement on the older Safari behaviour this rule was written against. But neither the native folder picker nor a real Finder drag has been driven end to end, so the rule stands until a human confirms both. Don't relax it on feature detection alone.
6. **Respect the neumorphic CSS system.** Depth comes from paired shadows (`--raise-sm`, `--raise-md`, `--raise-lg`, `--press-sm`, `--press-md`) cast by surfaces that are *the same colour as the page*. Panel fills and borders are absent by design — adding `background: #fff` or `border: 1px solid …` to a surface breaks the illusion. Use the existing custom properties in `static/style.css`; do not introduce new colours.
   **The shadow pair is derived from the active background.** `--light` and `--dark` are tuned for the default page colour; a project that sets a custom background must recompute them from it, or the shadows stop reading as depth (a pale shadow on a dark surface, or a near-white highlight that glares). `appearance.js` derives both from `--project-bg` before first paint and redefines `--light` / `--dark` on the project root — because `--raise-*` and `--press-*` resolve `var(--light)` at point of use, every shadow in the subtree recomputes automatically. Never hard-code a shadow colour.
   **Exception — project widgets.** A widget on the project grid has **no shadow at rest**. Its content provides the structure; the container is invisible. Shadow is opt-in per widget (`config.shadow`), and edit mode forces it on for every widget so boxes are visible while arranging. Never compensate for the missing shadow with a border or a fill — flat means flat.
7. **Raw `sqlite3`, no ORM.** Schema as string constants at the top of `db.py`, registered in `init_db()`, accessed through the `get_conn()` context manager. No SQLAlchemy, no models, no service layer.
8. **Derived data gets its own table**, versioned and recomputable — never extra columns on `reference_items`. `colour_analysis` and `captures` both follow this.

---

## Architecture

### Backend

| File | Responsibility |
|---|---|
| `app.py` | Every HTTP route. Thin wrappers over the modules below — no business logic. |
| `db.py` | All SQLite access. |
| `ingest.py` | Add a reference: hash, dedupe, copy, tag, embed, insert. |
| `tagging.py` | Claude calls for title/tags/description. |
| `embeddings.py` | CLIP via `sentence-transformers`, vectors in Chroma. |
| `analyze.py` | Claude cross-reference write-ups. |
| `colour.py` | K-means palettes in CIELAB, versioned profiles, LCh cylinder layout, colour ranking. |
| `graph_layout.py` | K-means clustering of CLIP vectors into planes for the 3D graph. |
| `capture.py` | Durable queue for browser-extension captures, background worker thread. |
| `config.py` | Paths, API key, model name. |

### Frontend

| Page | Entry | Notes |
|---|---|---|
| `static/index.html` | `app.js` | The SPA: Add / Archive / Projects / Settings tabs. |
| `static/graph.html` | `graph.js` | 3D similarity graph. **This is the homepage** — `GET /` serves it, not `index.html`. |
| `static/connections.html` | `connections.js` | Flat 2D view the 3D graph folds into. |
| `static/colour-connections.html` | `colour-connections.js` | Flat colour view. |
| `static/project.html` | `project/main.js` | Project shell. Created in session 2. **Has no `<header>`** — see below. |

**The project shell has no page header.** Inside a project there is no app title, no nav strip and no permanent chrome — the widget grid starts at the top of the viewport and uses its full width. The project's name is the title widget; leaving a project is the exit widget. `document.title` still carries the project name for the browser tab. Any navigation a later session needs (e.g. the back control on folder and grid pages) must be a floating overlay control, not a reinstated header.

### Project shell modules

| Module | Responsibility |
|---|---|
| `project/main.js` | Shell entry: routing, data load, wiring the pieces below. |
| `project/grid.js` | Layout engine. 24 columns, free placement, no gravity. Pure layout — knows nothing about widget contents. |
| `project/registry.js` | Widget type registry and the `create(host)` lifecycle. |
| `project/appearance.js` | Project-wide ink/background/scale, applied synchronously before first paint. Derives `--light`/`--dark` from the background. |
| `project/appearance-panel.js` | The project-wide appearance controls, mounted into the top bar during edit mode. |
| `project/typography.js` | The shared typography contract — `applyTypography(el, typography, contentScale)`. Every text-rendering widget goes through this. |
| `project/format-toolbar.js` | Per-widget format controls, mounted into the top bar's `format` section. |
| `project/rich-text.js`, `text-utils.js` | Per-selection rich text editing. |
| `project/top-bar.js` | Shared bar at the top of the page. **In normal document flow, not fixed** — showing it pushes the grid down, hiding it collapses the page back to "grid starts at the top of the viewport". Sections are keyed (`appearance`, `format`) and shown independently. This is how transient chrome is added without reinstating a header; new chrome should use it rather than inventing another bar. |
| `project/widget-dock.js` | The "+" Add Widget dock, bottom-right, visible during edit mode. Page-level chrome, not a widget — it talks to `main.js` directly rather than through the widget host contract. Any session that adds a widget type gets it in the dock for free via `shell.addableTypes()`. |
| `project/scene-widget.js` | The frame every 3D widget is built in: on-demand Three.js import, empty state instead of a scene when there is nothing to draw, `host.onResize` → `resize()`, `destroy()` → `dispose()`, and the scene going inert during edit mode. A new 3D widget supplies `load()` and `build()`; it never touches a renderer. |

| `project/folders.js`, `folders-panel.js` | Folder API client (no DOM) and the folder management UI. |
| `project/pages/*` | Hash-routed pages inside the shell: `grid-page.js` (the reference grid, used by both the project grid and folder pages), `canvas-page.js`, plus `analysis-panel.js`, `colour-panel.js` and `overlays.js` ported from `app.js`. |
| `project/canvas/*` | The infinite canvas: `viewport.js` (single world transform, pan/zoom, screen↔world), `nodes.js` (reference/text/widget nodes, drag, lock, z-order), `edges.js` (one SVG inside the world layer, so edges need no separate projection), `store.js` (debounced per-node persistence), `palette.js` (how things get added). |

Widgets so far: `title`, `notepad`, `settings`, `exit`, `canvas`, `sidebar`, `folders`, `grid-button`, `folder`, `colourspace`, `similarity`.

**Two kinds of text, deliberately.** The canvas's own text node (`canvas_nodes.kind = "text"`, labelled **Simple text**) is plain: it inherits the project's typography and has no per-selection formatting. **Notepad** is the rich one — per-selection family, size, colour, bold, italic, underline and highlight through `rich-text.js`. This is a real distinction, not an oversight; do not add rich text to Simple text. There was once a third, a `text` widget, which was broken on the canvas and has been removed — don't reintroduce it.

### The 3D scenes

Three modules, none of which own a page:

| Module | Responsibility |
|---|---|
| `shared/scene-host.js` | `createSceneHost(el)` → renderer, camera, OrbitControls and the render loop, **sized to an element, not the window** (ResizeObserver, not a resize listener). Pauses when its element is off screen (IntersectionObserver) so several scenes on one page don't all render at once. Every visual constant comes from `graph-common.js`. `dispose()` releases the WebGL context — a widget that leaks one per add/remove cycle breaks the page after a handful. |
| `similarity-map.js` | The plane stack, nodes, tag captions and threads, built into a scene handed in. |
| `colour-map.js` | The LCh cylinder, same deal. |

`graph.js`, and the two 3D widgets, are all callers of these — the full-page view adds the intro choreography and the fold into the flat Connections canvas; a widget adds a caption, a toggle and nothing else. Any new view of the archive in 3D should be a fourth caller, not a fourth renderer.

**Textures and geometries are shared across scenes.** `graph-common.js`'s `disposeSubtree` frees what a subtree genuinely owns and skips anything marked `userData.shared` (the page-wide plane geometries and tag-label cache, and a view's own dot/ring textures, which it disposes itself). Disposing a shared resource from one widget's teardown breaks every other scene still on the page.

Shared: `graph-common.js` (Three.js constants, themes, sprite helpers, the dispose rule), `theme.js` (dark mode, loaded synchronously in `<head>` to avoid a flash of the wrong theme), `ui-effects.js` (button press pulse), `style.css`.

---

## Data model

Existing tables in `db.py`: `reference_items`, `projects`, `project_references`, `analyses`, `similarity_scores`, `captures`, `colour_analysis`.

Project-space tables — **created in session 1; verify they exist before assuming**:

```
folders            id, project_id, name, position, is_default, date_created
folder_references  folder_id, reference_id, date_added        PK (folder_id, reference_id)
widgets            id, project_id, type, parent_id, x, y, w, h,
                   locked, config (JSON), position, date_created
project_settings   project_id PK, settings (JSON)
canvas_nodes       id, project_id, kind, reference_id, x, y, w, h,
                   locked, content, config (JSON), z_index
canvas_edges       id, project_id, source_node_id, target_node_id, style (JSON)
```

Semantics that are easy to get wrong, and must not be "fixed":

- **A folder belongs to exactly one project.** `folders.project_id` is never null. The Archive's cross-project folder view is a **roll-up by folder name**, computed as a query — not a stored global folder. This is what makes Texture folders from different projects aggregate in the Archive.
- **A reference may sit in many folders at once.** Removing it from a folder deletes only the `folder_references` row; project membership and the archive record are untouched.
- **Folders never filter the project grid page**, which always shows every reference in the project. A folder adds a view; it does not own its contents.
- **`widgets.parent_id`** is the container link. `NULL` = on the grid; non-null = inside that container widget.
- **Anti-stacking:** containers may hold leaf widgets, never other containers. Nesting is one level deep by design. Enforced server-side in `app.py` and mirrored in the UI's Add Widget lists.
- **Permanent widgets** (`settings`, `exit`, `canvas`) can be moved but never deleted. `DELETE` returns 400.
- **`canvas_nodes.kind`** is `reference` | `text` | `widget`. One table rather than three, because the canvas drags, locks and connects all three identically.
- **Canvas positions are world coordinates**, never screen coordinates — the latter are meaningless after a pan.
- **`is_default` on a folder records origin, not protection.** Default folders (Texture, Colour, Form, Vibe, Fashion, Narrative) are renameable and deletable like any other.

---

## Widget contract

Every widget is a module in `static/project/widgets/` with a single default export:

```js
export default {
  type: "colourspace",
  label: "Colour Space",
  container: false,      // true only for sidebar
  permanent: false,      // true for settings, exit, canvas
  canvasEligible: true,  // defaults to (!container && !permanent)
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 2, h: 2 },
  create(host) {
    // host: { el, config, project, save(config), onResize(cb), onDestroy(cb) }
    return { destroy() {} };
  },
};
```

- A widget only ever touches `host.el`. It never reaches outside its own element.
- **Typography and content scale are per widget.** `config.typography` (`{ family, size, colour, bold, italic, underline, align }`) and `config.contentScale` override the project-wide appearance settings for that widget alone. Both are applied as CSS custom properties scoped to `host.el`, so they cascade to the widget's content and nothing else. `contentScale` zooms what is *inside* a widget; it is independent of `w`/`h`, which size the widget's footprint on the grid. Never make one adjust the other.
- **Chrome is never shadowed when the widget is flat.** A control rendered inside a widget (a button, an icon) must not carry `--raise-sm` from the global `.btn` style while the widget itself is unshadowed — that reintroduces the card look through the back door. Inner chrome follows the widget's shadow state.
- `host.save(config)` persists that widget's config through the API, debounced.
- `host.onResize(cb)` fires when the widget's box changes size. The Three.js widgets **must** subscribe and call `renderer.setSize()` plus update the camera aspect.
- `destroy()` **must** dispose Three.js geometries, materials, textures and the WebGL context. Browsers cap live contexts at around 16; leaking them breaks the page after a few add/remove cycles.

**Two editing models, deliberately different:**

- **Homepage grid** — 24 columns, strong snapping, feels gridlike. Nothing moves until the user opens Settings, edits, and saves explicitly. Layout commits in one bulk `PUT /api/projects/<pid>/widgets`.
  **Free placement: no gravity, no pushing.** A widget snaps to whole cells but otherwise stays exactly where it is dropped. Widgets never displace each other and the layout is never compacted upward — deliberate gaps are a layout choice, not a defect to be closed. Do not reintroduce collision push-down or auto-compaction.
- **Infinite canvas** — free positioning, no snapping, feels loose. Every change persists immediately (~400ms debounce) via the per-node routes. No save step.

Do not make these consistent with each other. The difference is the point.

---

## Conventions

- **Comments explain *why*, not *what*.** The existing code is unusually well-commented in this style — match it. A comment restating the line below it is worse than none.
- **Tests are offline.** `tests/conftest.py` monkeypatches `db.DB_PATH`, `ingest.IMAGES_DIR`, `capture.PENDING_DIR` and `config.REFERENCES_DIR`, and stubs every Claude and CLIP call. New backend work must be testable the same way. Use the `archive` and `client` fixtures.
- **Run `pytest` before finishing.** The whole suite, not just new tests.
- **British spelling in user-facing copy and in the colour code** (`colour`, not `color`), matching `colour.py` and the existing UI. CSS properties are obviously still `color`.

---

## Never

- Add a build step, `package.json`, or an npm dependency.
- Use `localStorage` for anything the user created.
- Give a surface a background fill or a border.
- Refactor `app.js` beyond what the current task requires — it is ~1380 lines and mostly working.
- Change the behaviour of an existing endpoint while adding a scoped variant of it.
- Break `/graph.html`, `/connections.html` or `/colour-connections.html` while extracting shared code from them. Verify by hand.
