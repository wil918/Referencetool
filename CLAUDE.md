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
   **Exception — the schedule surface does not use this system at all.** It is drawn in a
   technical-drafting language instead: paper ground, three media, four line weights, hatch
   and stipple for tone, two colours, uppercase letterspaced labels. Depth is *absent* there by design —
   a drawing has no depth — so borders and rules are not only allowed but are the entire
   hierarchy, and this rule's ban on them does not apply. The two systems are not to be
   reconciled; rule 6 still governs `index.html`, `project.html` and the graph pages exactly
   as written. A page opts in by carrying `class="drafting"` on `<body>`, linking
   `/drafting.css` after `/style.css`, and adding one `<div class="dr-grain">` as the
   first child of `<body>` — that div is the paper, and a page without it is a drawing
   floating on nothing.
   **Adoption:** `schedule.html` (all three tabs) and the specimen sheet. The archive SPA,
   the project shell and the three graph pages are untouched. Two consequences of the colour
   rule that are easy to mistake for oversights: a **deliverable is keyed by number**, not by
   hue — `calendar.js` builds a stable 1..n index over the visible range, marks each block
   with it and draws the key under the calendar, which is why `schedule/colour.js` is no
   longer imported anywhere — and **travel is a dashed leader line, not a block**, because it
   is the line between two things rather than a thing.
   **The month has two drawings and keeps both.** The plan (`.dr-month`, section 15) is the
   analytical one — a collision is read by looking along a week. The **axonometric**
   (`schedule/axonometric.js`, section 19) stands the day's work up the vertical axis so
   *height is load*: a heavy day is a tower, an empty one flat ground, a deadline week a
   ridge. Neither improves on the other, so the switch remembers which was last used, in
   SQLite (`schedule_settings.month_view`) and never in `localStorage`. Five things there are
   decisions, not omissions: it is **SVG, not Three.js** — a drawing wants exact sub-pixel
   hairlines and no lighting, and CLAUDE.md's fourth-caller rule is about 3D views of the
   *archive*; **one projection function** produces every point on the sheet, which is what
   makes an orientation control later an afternoon rather than a rewrite; days are painted
   **back to front by (row + col)**, which is the entire hidden-surface algorithm and the
   single most common way an isometric drawing goes wrong; **no cell is lettered**, because a
   tower stands on every cell that has anything to say — the weekday and week-date scales are
   set out along the plane's edges and the plan below carries every date, which is a large
   part of why the two halves are one sheet; and the plan below is sized to the base plane's
   **own column pitch in projection**, so the setting-out rays land on its column edges rather
   than near them. Its construction layer is **ruled, not toothed**: a ray runs along one of
   three axes at once, and section 1b's density masks are elongated along a single one, so a
   mask that suits one direction reads as a dashed border in the other two. The tone comes
   instead from a few hundred hairlines crossing, which is section 1b's own rule applied to
   the sheet rather than to the stroke. Specimen plate 14.
   **Where it lives:** every value — line weights, tones, hatch pitches, the two accents, the
   type scale, the measure — is defined once at the top of `static/drafting.css`, scoped under
   `.drafting`, and nothing further down that file may introduce a colour, weight or size of
   its own. That scope is the guarantee: a rule that cannot match outside those two documents
   cannot regress the archive. The file also blanks `--raise-*`/`--press-*` inside its scope,
   which is what switches the soft-UI off for everything `schedule.html` inherits from
   `style.css` without editing `style.css` at all. `static/schedule/specimen.html` is the
   specimen sheet: every primitive drawn once, in both themes, with the construction layer on
   and off and the texture on and off — the ink scale as a strip from solid to broken (02),
   the three media side by side (02b), and every texture ruled beside drawn (11). It is not linked from the app and ships as a design artefact — change a value in
   `drafting.css` and check it there first.
   **Three media, and the scale changes hands in the middle.** A drawing is not made with
   one pencil, and the first version of this language was: one `--dr-ink-rgb` at eight
   alphas, which is eight greys. There are now three base triplets — **ink** (warm, for
   object lines, cut lines and type), **graphite** (cool, for setting-out, the construction
   layer, hatching and stipple) and **wash** (warm dilute, for tonal areas and *never* a
   line). The difference is deliberately tiny — about six points warm, three points cool and
   five points warm at working strength — and the test is: name the hue of a hairline
   without an object line beside it. If you can, it has gone too far. Which medium a mark is
   drawn in says what *kind* of mark it is, which is the same thing its weight already says,
   so the two never disagree: there is no warm hairline and no cool cut. Dark mode re-mixes
   all three (the arithmetic inverts — on a plate the ink is the *brightest* mark), it does
   not reuse them. Specimen plate 02b.
   **Density, not alpha.** Graphite does not get lighter, it gets sparser. In
   `design-references/02` the palest ruled wall averages 222 and its darkest particle
   measures 0 — a black field with gaps, not a grey one. So the faint end of the scale is a
   full-strength graphite stroke under a near-binary noise mask (`feFuncA type='linear'`,
   slope 9; the **intercept** is the density control, and it selects the duty cycle that the
   flat alpha used to be), and the strong end stays solid, because a firm line *is* solid.
   The transition between the object line and the hairline is where the drawing comes alive.
   Three things this depends on: the noise is **elongated along the stroke** (isotropic noise
   on a hairline reads as a dashed border, which is a different mark); the **stroke stays at
   full opacity** and the mask decides how much survives, which is what makes the particles
   black rather than grey; and a **drawn rule's element must be as tall as its tile**, not as
   tall as its line, or antialiasing plus the mask leaves nothing visible. Duties are lifted
   about a third above the alpha they replace, because a broken line reads lighter than a
   solid one carrying the same mean. Specimen plate 02.
   **The construction layer is texture, never information.** The setting-out (quarter-hour
   rules, half-hour ticks, compass arcs struck from a deadline, ghosted repetitions of a
   recurring task) resolves its colour through the single `--dr-construction-ink` property;
   `.dr-no-construction` on the root blanks it and the whole layer goes with no re-render.
   Nothing that has to be read at 8am may live in that layer or carry `.dr-construction`.
   **Physicality is texture, and it comes off in one class too.** Paper tooth, toothed
   hatching and the ragged wash live in section 1b of `drafting.css` and are switched off
   by `.dr-no-texture`, which repoints the tones at their `--smooth` twins, the drawn rules
   at their flat ones, and the wash's mask at `none`. Those twins are not dead code: the
   ruled system underneath has to stand up on its own, and if the drawing only reads with
   texture on, the texture is doing work the system should be.
   **Three of the textures are vendored rasters** under `static/vendor/textures/`, with
   provenance, licence and the generator beside them the way the fonts are: `paper-tooth`
   and `plate-tooth` (the two grounds) and `graphite-tooth-light/-dark` (the stipple), plus
   `wash-bleed` as a mask. 160 KB total, seamless by construction (an inverse FFT of a
   periodic spectrum is periodic), **generated, not scanned** — if a real scan is ever made
   these are the files to replace, and the CSS cares about nothing but their size and their
   seams. The reason they are not procedural: turbulence is band-limited Perlin, so its
   features are round and its histogram symmetric, where paper has directional fibre, a slow
   pulp cloudiness and a heavy tail of flecks — the three things the eye recognises paper by.
   `generate.py` is **not a build step**; nothing in the app runs it and the app runs fine
   with it deleted. **Dark mode gets its own tile, designed as a different material** (a
   photographic plate: emulsion grain, development mottle, silver specks, no fibre at all,
   screened rather than multiplied) — an inverted scan of paper is a photographic negative
   and reads as one instantly.
   **Texture is never live.** Every hatch, setting-out line and density mask is an SVG data
   URI used as a `background-image`, so its `feTurbulence` runs once in the image decoder;
   the grounds and the stipple are decoded rasters. There is not one `filter:` in the file,
   and exactly one `mix-blend-mode` layer (the grain, plus a wash wherever one is drawn) —
   because a live filter or a blend is recomputed whenever the element moves, and this
   calendar re-renders on every drag. A `mask-image` now exists too, but only on the wash,
   and a week view renders **zero** of them. **A task block carries no filter, no blend and
   no mask, ever** — that is checkable, and a drag of 400 moves costs 6.4 ms of style and
   layout in total. Its edges are ruled lines, which is what the subject of a drawing is
   anyway. Every `feTurbulence` is seeded explicitly; an unseeded one may differ between
   renders and the drawing would shimmer.
   **Tone comes from pitch, and density from more passes.** A hatch stroke is near-solid
   graphite and the *spacing* carries the value — faint strokes at a tight pitch give the
   same average and read as a screen tint. Where a tone has to get heavier (the month view's
   load ramp) it is drawn **again**, as layered copies of the tile at different offsets,
   never by shrinking the tile: shrinking barely moves the density, and past about half size
   the particles fall under a device pixel and average into a smooth cloud, which is a flat
   fill arrived at by accident.
   **The drawing is set out before it is drawn.** Every principal line has a pencil line
   (`--dr-pencil-*`) that was ruled first, and three properties make it read as setting-out
   rather than as a sloppy second rule: it is **coincident** with what it constructs, never
   offset beside it; it **overruns** (`--dr-overrun`, 18px, against the object rules' own
   `--dr-extend` of 7px), so it visibly carries on past the object and under its neighbour;
   and a circle is struck **whole**, with its centre marked and its radius drawn — a compass
   arc is only the part of it that got inked. It is also **thinner and lighter** than what it
   constructs: half a pixel against the object line's one. It lives on `.dr-track::before`,
   one overrunning layer per column, which is why `.dr-col::after` carries the separator and
   today's left edge comes from `:has(+ .is-today)` rather than a second pseudo-element.
   **Pencil, not blur.** Do not displace these lines: displacement smears a hairline across
   three device pixels and reads as both blurry and fat. The geometry stays exact and a
   high-frequency stitched turbulence varies the *density* instead. Specimen plate 12.
   **Two traps in the SVG data URIs, both of which fail silently.** A filter region given
   in the default `objectBoundingBox` units is *zero* for a straight line (its bbox has no
   width or height), so the element does not render at all — every line filter here
   declares `filterUnits='userSpaceOnUse'` with explicit bounds. And `<`/`>` must be
   percent-encoded: Chrome's CSS parser accepts them raw, stricter engines do not, and the
   desktop spike targets WKWebView.
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
| `static/schedule.html` | `schedule/main.js` | Tasks + calendar, and the schedule's own settings (locations, calendar import, personal events, hours, suggested bedtime). **This is the homepage** — `GET /` serves it, not `index.html`. |
| `static/schedule/axonometric.js` | — | The month's second drawing: the grid on an isometric base plane, the day's work stacked up the vertical axis, the plan below under one dividing rule. Drawn by `month.js`, which owns the range, the data and the model for both views. |
| `static/schedule/specimen.html` | — | The drafting language's specimen sheet. Static, unlinked, no logic. Reached directly at `/schedule/specimen.html`. |
| `static/schedule/key.js` | — | The numbered key with leader lines that both detail panels open into, shared by `task-panel.js` and `commitment-panel.js`. |
| `static/graph.html` | `graph.js` | 3D similarity graph, reachable at `/graph.html`. |
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

`static/drafting.css` is the schedule surface's own system and is loaded **after** `style.css`, by `schedule.html` and the specimen sheet only — see hard rule 6's schedule exception. Its typeface, IBM Plex Sans Condensed, is vendored under `static/vendor/fonts/` with its OFL licence and provenance beside it, the same way Ballet is under `static/fonts/`; it is bound to `--dr-face`, never to `--display`.

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
- Refactor `app.js` beyond what the current task requires — it is ~870 lines and mostly working.
- Change the behaviour of an existing endpoint while adding a scoped variant of it.
- Break `/graph.html`, `/connections.html` or `/colour-connections.html` while extracting shared code from them. Verify by hand.
