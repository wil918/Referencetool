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
This opens `http://127.0.0.1:5050` in your browser automatically.

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

## Project layout

```
fashion-reference-tool/
├── cli.py            entry point — run all commands through this
├── app.py             local web GUI (Flask) over the same modules below
├── ingest.py          adds a reference: copy, tag, embed, store
├── tagging.py          Claude calls for auto-tagging / description
├── embeddings.py        CLIP embeddings + Chroma vector store
├── analyze.py           Claude call for cross-reference write-ups
├── db.py              SQLite metadata storage
├── config.py            paths & settings
├── static/             GUI front end (HTML/CSS/JS, served by app.py)
├── references/
│   ├── images/          your original image files
│   └── texts/            your original text/PDF files
└── data/
    ├── references.db      metadata (SQLite)
    └── chroma_db/          embeddings (Chroma)
```

## What's next

Phase 1 (ingest, auto-tag, embed, search) and phase 2 (`analyze`, for
cross-reference write-ups) are both done.
# Referencetool
# Referencetool
# Referencetool
