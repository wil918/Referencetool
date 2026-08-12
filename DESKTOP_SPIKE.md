# Desktop spike: running the app in pywebview instead of Chrome

Throwaway investigation, not packaging. Produced two files (`requirements-desktop.txt`,
`desktop.py`) and a `bootstrap()` extraction in `app.py`; everything else here is
findings, not changes.

## Method and a caveat up front

Testing ran headless-ish: this environment has no macOS Screen Recording permission
available to the shell, so `screencapture` cannot produce a screenshot of the native
window, and blindly automating native dialogs (the folder picker, the colour panel)
via AppleScript with no visual feedback risked mis-clicking into whatever window
happened to be frontmost on the live desktop. Given that, verification leaned on
`window.evaluate_js()` — pywebview's ability to run arbitrary JS inside the live
WKWebView and read the result back synchronously — plus direct HTTP calls against the
running Flask server from Python. This is more precise than eyeballing a screenshot for
most of the checklist (it can inspect DOM state, WebGL context objects, and
`isContextLost()` directly) but it means the native file/folder picker dialogs and a
real OS-level Finder drag were not driven end-to-end. Those two are called out
specifically below rather than guessed at.

All test projects/widgets/nodes created during this spike were deleted again through
the same API routes the UI uses; the one throwaway reference upload (see File APIs) was
deleted by diffing the archive before/after, since auto-tagging can rename a title away
from recognizing it. The pre-existing "3D Widgets" project (used for the widget/canvas
checks, since it already has colour-analysed and similarity-scored references) was left
exactly as found — same 8 widgets, no stray canvas nodes.

## WebGL

**Works, cleanly.** This build of WKWebView (macOS 26.2 / Tahoe) is a full WebGL2
implementation, not a fallback.

- `/graph.html`: canvas present, `canvas.getContext('webgl2')` returns `"WebGL 2.0"`.
  Import maps are supported (`HTMLScriptElement.supports('importmap')` → `true`), so the
  bare-specifier ES module setup loads with no shim. Synthetic pointer drag events
  (`pointerdown`/`pointermove`/`pointerup`) dispatched onto the canvas didn't throw,
  consistent with OrbitControls' event wiring working normally.
- **The fold into `/connections.html`**: the two calls `finishFold()` depends on —
  `sessionStorage.setItem` and `renderer.domElement.toDataURL('image/jpeg', 0.82)` —
  both work. A direct probe produced a 44,223-character data URL from the live canvas.
  Navigating to `/connections.html` loads correctly (title "Archive Connections", SVG
  present). Because `finishFold()` already wraps this in try/catch and falls back to a
  from-scratch flat view on failure, this path was low-risk even before testing — good
  design for a webview port, whether or not that was the intent.
- **Two 3D widgets on one project page** (colourspace + similarity, added to the
  existing "3D Widgets" project alongside its own two): 4 live canvases, all reporting
  `WebGL 2.0`. No page-level errors.
- **Repeated add/remove**: 10 cycles of creating and immediately deleting a 3D widget
  (colourspace/similarity alternating) on top of the 4 already on the page. All 4
  original contexts remained `alive` (`gl.isContextLost()` false) afterward — no
  accumulation, no crash. `scene-widget.js`'s dispose-on-destroy discipline holds up
  under WKWebView; the ~16-context cap mentioned in its comments was never approached
  in this run, so whether WKWebView's actual cap sits lower than Chrome's wasn't forced
  — 10 cycles of create+immediately-delete never had more than 4 contexts live at once.
  A more aggressive test (many widgets *simultaneously* live, not cycled) would be
  needed to find the real ceiling.
- A full page reload after the widget churn re-rendered correctly (title, widget count,
  and a fresh `WebGL 2.0` context all came back clean) — teardown isn't leaking state
  into the next load.

## Storage

**Theme persistence needed a one-line fix, and it's not obvious.**

`localStorage.setItem('theme', 'dark')` works fine inside a session. But across a full
process restart (new `python desktop.py`-equivalent process, new window), the value was
gone — `localStorage.getItem('theme')` came back `null`.

Root cause: `pywebview.webview.start()` defaults to `private_mode=True`. On the Cocoa
backend this explicitly wipes the WebKit website data store on startup (see
`webview/platforms/cocoa.py` — `if _state['private_mode']: ... removeDataOfTypes_...`).
It's effectively always launching in a fresh incognito profile. Confirmed the fix:
calling `webview.start(..., private_mode=False, storage_path=<some dir>)` made the same
set-then-restart-then-read test come back `"dark"` correctly. `desktop.py` as written
for this spike does **not** pass these — that's deliberate, since implementing the fix
wasn't in scope, but it's the single most important finding here for anyone picking this
up: without it, every localStorage-based feature (today, just the theme) silently
resets on every launch.

## Known-risky file APIs

**Feature surface is present and functional — better than the old assumption — but
full end-to-end coverage wasn't possible without native-dialog automation.**

- `'webkitdirectory' in document.createElement('input')` → `true`.
- `DataTransferItem.prototype.webkitGetAsEntry` → `true`, and it's not just a stub:
  calling it on a `DataTransferItem` returns a real `FileSystemFileEntry` with correct
  `isFile`/`isDirectory`/`name`. This is a meaningfully modern WebKit, not the
  older Safari that lacked these outright.
- What could actually be driven: a synthetic `drop` event with a real in-memory `File`
  (built via `new File([...])`, not from a real filesystem path) reached the entry
  object correctly, but `entry.file()` failed with `NotFoundError: Path does not
  exist` — expected, since a Blob-backed File has no real path for the FileSystemEntry
  API to resolve. This confirms the API plumbing works but can't stand in for a real
  OS-level drag.
- **Not directly tested**: clicking "Choose folder" to open the native macOS folder
  picker, and dragging an actual Finder folder onto the dropzone. Both would pop a
  native modal (`NSOpenPanel` for the former) that this environment has no way to see
  or safely dismiss — doing it blind risked interacting with the wrong window on the
  live desktop. Given the feature-detection results above, these are now more likely to
  work than CLAUDE.md's existing "behave inconsistently across desktop webviews"
  assumption suggests, but that's an inference, not a confirmed result. **This needs a
  human to actually click through it once.**
- "Choose files" (`<input type="file" multiple>`) doesn't touch any of the above — it's
  a plain `change` handler reading `e.target.files`, which is universally supported.
  No reason to expect trouble; also not clicked through for the same native-dialog
  reason, but there's much less here that could plausibly break.
- Loose-file drag-and-drop (no folder) uses the same `webkitGetAsEntry` path as the
  folder case, just with `entry.isFile` instead of `isDirectory`. Same caveat: the
  plumbing is confirmed present and correct, a real drag wasn't driven.

## Everything else

- **`input[type=color]`**: fully supported (`el.type === 'color'` holds, value
  round-trips through `#336699`). The picker itself is a native `NSColorPanel`, so —
  same caveat as the folder dialog — opening and using it interactively wasn't driven,
  but there's no reason to expect an issue; this is one of the most standard native
  integrations WebKit has.
- **Infinite canvas**: `/project.html?id=<id>#page=canvas` loads (note: the project ID
  is a `?id=` query param, not a hash — the hash is for in-page routing like
  `#page=canvas`; got this wrong on the first pass of testing and it produced a "No
  project id was given" page, which was a test-harness bug, not an app one). SVG edge
  layer present. Synthetic pointer-drag (pan) and wheel (zoom) events dispatched onto
  the canvas viewport without throwing. Created two text nodes and an edge through the
  canvas API, reloaded the page, and both the nodes and the edge's SVG line reappeared —
  the debounced persistence and the SVG-edges-live-in-the-world-layer design both
  survived a real reload in this webview.
- **PDF thumbnails**: **not tested** — the local archive used for this spike has zero
  PDF references (`SELECT ... WHERE type='pdf'` returned nothing), and adding one would
  have required either a real PDF file plus the Anthropic API (no key configured in
  this worktree, tagging would 500) or hand-editing the DB, which felt like more
  contamination than the checklist item warranted. Worth noting for whoever does check
  it: PDF thumbnails are rendered server-side by PyMuPDF into a raster image
  (`PDF_THUMB_DPI` in `app.py`) and served as a normal image response — there's no
  client-side PDF rendering API involved, so there's no webview-specific mechanism here
  to actually break. Low risk, just unverified.
- **Right-click**: dispatching a synthetic `contextmenu` event didn't throw. The only
  code in the frontend that listens for it is OrbitControls (`preventDefault` during
  orbit, standard Three.js behavior) — the app has no custom context menu, so this is
  really just "does WKWebView's default context menu appear," which wasn't visually
  confirmable here but has no app-specific logic to fail.
- **Text selection**: `window.getSelection()` / `selectAllChildren` /
  `removeAllRanges()` all worked without error.
- **Window resize**: `window.resize(900, 650)` (pywebview's own API) worked;
  `window.innerWidth`/`innerHeight` updated to `900x630` (the height loss is the title
  bar, expected), and `document.documentElement.scrollWidth` matched `clientWidth`
  exactly after the resize — no horizontal overflow introduced by shrinking the window.

## Verdict

**pywebview is viable for this app.** The two things that actually mattered —
WebGL/Three.js and the ES module + import map setup — both work cleanly in the system
WebKit on a current macOS version, with no shimming needed. That was the real unknown
going in, and it resolved favorably.

Two things would need to change before this becomes real packaging, not three spike
files:

1. **`private_mode=False` plus a real `storage_path`** on `webview.start()`, or every
   piece of client-side persisted state (today: just the theme) silently resets on
   every launch. This is a one-line fix but an easy one to ship without noticing, since
   everything *appears* to work correctly within a single run.
2. **A human needs to actually click "Choose folder" and drag a real Finder folder
   onto the dropzone once.** Feature-detection strongly suggests both will work — this
   WKWebView build implements `webkitdirectory` and a functional `webkitGetAsEntry`,
   which is a real difference from the older Safari behavior CLAUDE.md's caution was
   presumably written against — but nothing here exercised the actual native picker or
   a real OS-level drag, and this spike's environment has no safe way to do that
   without risking a blind interaction with the wrong window. This is the one
   remaining unknown of consequence.

Everything else checked out or has no plausible webview-specific failure mode:
multiple/repeated 3D widgets, the graph→connections fold, the infinite canvas
(pan/zoom/drag/persistence), `input[type=color]`, right-click, text selection, and
window resizing.
