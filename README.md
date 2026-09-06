# Fashion Reference Library

A local tool for collecting design references (images, essays, PDFs), auto-tagging
and embedding them, and searching across them semantically.

## How it works

- Files you add are copied into `references/images/` or `references/texts/`.
- **Claude** looks at each reference and generates tags + a short description.
  For PDFs, Claude sees both the extracted text *and* the PDF's most
  significant embedded images (up to 4, largest first) in the same call, so a
  lookbook or tearsheet isn't reduced to just its captions.
- **CLIP** (running locally, via `sentence-transformers`) generates an embedding
  for each reference. Images and text share the same embedding space, so you can
  later search images with a text query, or vice versa. For PDFs, the text
  embedding and any embedded images' embeddings are averaged together.
- Metadata lives in a local SQLite file (`data/references.db`).
- Embeddings live in a local Chroma vector store (`data/chroma_db/`) — just a
  folder on disk, no server required.

Nothing leaves your machine except the calls to Claude for tagging (one API call
per reference you add).

### A note on search scores

Search results are labeled "strong match" / "related" / "loose match" rather
than a raw similarity percentage. This is deliberate: CLIP's raw similarity
numbers run high for almost everything (a known quirk of its embedding space),
so a "0.85 similarity" on an unrelated item is common and not a bug. Instead,
each result is scored relative to the spread of scores across your own
library — a statistical outlier in the good direction gets labeled "strong
match." This gets more meaningful as your library grows; with only a handful
of references in total, treat the labels as rough ranking rather than a
confident verdict.

## Setup

```bash
cd fashion-reference-tool
python3 -m venv venv
source venv/bin/activate        # on Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# then open .env and paste in your Anthropic API key
```

The first time you add a reference, `sentence-transformers` will download the
CLIP model (~600MB) — after that it runs fully offline.

## Usage

**Add a reference:**
```bash
python cli.py add path/to/photo.jpg --title "Balenciaga, 1967" --source "V&A archive"
python cli.py add path/to/essay.pdf --title "On Ornament" --source "Adolf Loos"
```
`--title`, `--source`, and `--notes` are all optional. Supported files: images
(`.jpg .jpeg .png .gif .webp .bmp`), text (`.txt .md`), and `.pdf`.

**Add every file in a folder at once:**
```bash
python cli.py add-folder path/to/folder
python cli.py add-folder path/to/folder --source "Pinterest export" --recursive
```
Unsupported files in the folder are skipped. If one file fails (e.g. a corrupt
image), it's reported at the end and the rest of the batch still runs. Titles
are taken from each filename — rename files beforehand if you want specific
titles, or use `show`/edit the database afterward.

**List everything you've added:**
```bash
python cli.py list
```

**See full details for one reference:**
```bash
python cli.py show <id>          # a short prefix of the id works too
```

**Semantic search:**
```bash
python cli.py search "sculptural silhouettes, structured shoulders"
python cli.py search "romanticism vs minimalism" -n 10
```

**Analyze a handful of references:**
```bash
python cli.py analyze <id1> <id2> <id3>
python cli.py analyze <id1> <id2> --save writeup.md
```
For each reference given, this searches your library for related items already
in it, then has Claude write up the connections it sees across the whole set
(visual, historical, conceptual) and suggest new research directions. IDs can
be short prefixes, same as `show`.

After the write-up, you're dropped into a follow-up prompt (`>`) where you can
keep asking questions and steer the exploration — "which of these fits a
headpiece collection best?", "what era does that reference?" — with the full
conversation history and original references kept in context. Press enter on
an empty line to quit. `--save` writes the whole conversation (write-up plus
every follow-up) to a file.

## Web GUI

A local browser front end for everything above — drag-and-drop uploads, a
type-in text box, and a visual archive browser — running on top of the same
`db` / `ingest` / `embeddings` modules as the CLI.

```bash
python app.py
```
This opens `http://127.0.0.1:5050` in your browser automatically. The homepage
is the **Schedule** (below); the reference library lives under the Add / Archive
/ Projects / Settings tabs of `index.html`.

**Add tab:**
- Drag and drop files *or whole folders* onto the drop zone (folders are
  read recursively), or use the "Choose files" / "Choose folder" buttons.
  Each supported file is tagged, embedded, and added the same way `add`/
  `add-folder` would — duplicates are skipped and reported, not re-added.
- Type or paste text into the text box and click "Save as reference" to
  save it as its own `.txt` reference, tagged and embedded like any other
  text file.

**Archive tab:**
- Every reference in your library as a grid of thumbnails (images and PDF
  first pages render directly; plain text/markdown references show a
  placeholder card with a description snippet).
- Click any item to open it full-size in a carousel, with `‹`/`›` arrows
  (or the left/right arrow keys) to step through the whole archive, a panel
  of its title/type/tags/description/notes next to it, and a row of
  similar items (by embedding search) below — click one to jump straight to
  it.

## Schedule

The homepage (`schedule.html`, served at `/`) is a planner for the work a
project actually involves — not just what to make, but when there is time to
make it. It runs on the same Flask app and the same SQLite file as the
reference library; the only outbound calls are still to Claude, for reading a
brief and classifying an imported timetable.

- **Deliverables and briefs.** A project owes deliverables, each with a due
  date, a weighting and a free-form `spec` (page counts, required items to tick
  off). Drop the assignment brief PDF in and Claude proposes the whole
  structure — key dates, deliverables with their requirements, a task skeleton
  per deliverable, the mandatory activities (shop visits, workshops) that imply
  location-bound tasks. Nothing is written until you approve it on a review
  sheet, item by item; re-importing a reissued brief shows a diff against what
  it already created rather than duplicating it.
- **Tasks and estimates.** Each task carries an estimate, an importance and a
  difficulty — either typed or guessed by Claude from similar past tasks — plus
  optional dependencies, a required location, and a "needs someone around"
  level. Finishing what you started is tracked: a task done part-way spawns a
  remainder that picks up where it left off.
- **The plan.** The scheduler walks from now to the furthest deadline, placing
  every outstanding task into the hours you actually have — around classes,
  shifts, appointments, travel between places, and a protected buffer before
  each deadline for finishing work. Near-term days get real times; further-out
  days get "this task, that day" and no more, because a time five weeks out
  would be fiction. Anything that cannot be reached in time is called out
  **at the deliverable level** ("4 of 6 tasks can't be placed — Part 2 will not
  be finished in time") rather than as scattered per-task warnings.
- **Your calendar.** Import an institutional `.ics` feed and its sessions
  become commitments, with rooms and teaching groups resolved from the feed's
  house format. Add personal events by hand. Set your regular working and
  domestic (chores) hours per weekday, with per-date overrides for a day that
  runs late. Locations carry travel times and opening hours; recurring tasks
  ("water the samples every 3 days") spawn themselves.
- **Views.** Week, day and month calendars, a Tasks list, and a Deliverables
  tab. The whole schedule surface is drawn in a **technical-drafting visual
  language** — paper ground, ruled line weights, hatch and stipple for tone,
  two accent colours — deliberately distinct from the soft-shadow look of the
  reference library. `static/schedule/specimen.html` is its specimen sheet.
- **On the project homepage.** Three read-only widgets echo the schedule onto a
  project's own grid: **Deliverables** (progress and risk), **Up Next** (the
  next few scheduled work sessions), and **Brief** (the imported brief rendered
  readably).

## Project layout

```
fashion-reference-tool/
├── cli.py            entry point — run all commands through this
├── app.py             local web GUI (Flask) over the same modules below
├── ingest.py          adds a reference: copy, tag, embed, store
├── tagging.py          Claude calls for auto-tagging / description
├── embeddings.py        CLIP embeddings + Chroma vector store
├── analyze.py           Claude call for cross-reference write-ups
├── briefs.py            reads an assignment brief PDF into a proposed structure
├── scheduling.py         the planner: places tasks into the hours you have
├── ics_import.py         parses an institutional timetable feed into commitments
├── db.py              SQLite metadata storage (library + schedule)
├── config.py            paths & settings
├── static/             GUI front end (HTML/CSS/JS, served by app.py)
│   ├── schedule/         the planner homepage, calendars and drafting language
│   └── project/          the per-project widget homepage and canvas
├── references/
│   ├── images/          your original image files
│   └── texts/            your original text/PDF files
└── data/
    ├── references.db      metadata (SQLite)
    └── chroma_db/          embeddings (Chroma)
```

## What's next

Phase 1 (ingest, auto-tag, embed, search) and phase 2 (`analyze`, for
cross-reference write-ups) are both done — and so is phase 3, project spaces.

Each project now has its own home (`project.html`, reached from the Projects
tab) instead of just a flat reference grid:

- **Folders** group a project's references under a name — Texture, Colour,
  Form, Vibe, Fashion and Narrative by default, freely renamed, added to, or
  deleted. A reference can sit in several folders at once, and a folder never
  filters the project's own grid — it only adds a view onto it. The Archive
  tab rolls folders up across every project by name, so "Texture" folders in
  three different projects show their combined, de-duplicated contents.
- **A widget-based homepage grid** — title, notepad, settings, canvas-entry
  and per-folder shortcut widgets, plus two 3D widgets (a colour space and a
  similarity graph) scoped to just that project's own references. Layout is
  free-placed with no compaction, and changes commit with an explicit Save.
- **An infinite canvas** — pan/zoom, reference/text/widget nodes, drag-to-
  connect edges with per-edge colour/arrowhead/shape styling, and colour-
  palette/analysis widgets you can drop onto it. Every change persists
  immediately; there's no save step.

Phase 4 is the **Schedule** (above): briefs, deliverables, tasks, the planner
and the timetable, drawn in their own technical-drafting language.

What's left is desktop packaging. The app is already built desktop-ready —
no `localStorage` for anything the user creates, no absolute URLs or
hard-coded ports, relative fetches only — but it isn't yet wrapped in a
native shell.
