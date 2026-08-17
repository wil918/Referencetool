"""SQLite storage for reference metadata (title, tags, notes, etc.)."""
import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS reference_items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    filepath TEXT NOT NULL,
    title TEXT,
    source TEXT,
    tags TEXT,
    description TEXT,
    notes TEXT,
    content_hash TEXT,
    is_own_work INTEGER NOT NULL DEFAULT 0,
    date_added TEXT NOT NULL
);
"""

PROJECTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    date_created TEXT NOT NULL
);
"""

PROJECT_REFERENCES_SCHEMA = """
CREATE TABLE IF NOT EXISTS project_references (
    project_id TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    date_added TEXT NOT NULL,
    PRIMARY KEY (project_id, reference_id)
);
"""

ANALYSES_SCHEMA = """
CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    reference_ids TEXT NOT NULL,
    transcript TEXT NOT NULL,
    date_created TEXT NOT NULL
);
"""

SIMILARITY_SCORES_SCHEMA = """
CREATE TABLE IF NOT EXISTS similarity_scores (
    reference_id_a TEXT NOT NULL,
    reference_id_b TEXT NOT NULL,
    score REAL NOT NULL,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (reference_id_a, reference_id_b)
);
"""

# Web captures from the browser extension.
#
# This table does three jobs at once, which is why it isn't just extra columns
# on reference_items:
#
#   1. Provenance. A reference_item has a single free-text `source`; a capture
#      has a whole chain (page URL, canonical URL, the direct image URL, and
#      sometimes an original source the page itself credits). `envelope` holds
#      the full capture JSON including per-field metadata provenance, so the
#      raw evidence survives even if a value is later normalised.
#   2. A durable work queue. Tagging + embedding takes seconds, far too long to
#      hold a browser popup open, so captures are queued and processed by a
#      background worker. Rows left mid-flight are re-queued on next boot.
#   3. A dedupe index. Content hashing can only happen once bytes are in hand;
#      matching on URL first lets the extension warn before anything downloads.
#
# reference_id is set once ingestion succeeds -- or, for a duplicate, to the
# existing reference that already held those bytes.
CAPTURES_SCHEMA = """
CREATE TABLE IF NOT EXISTS captures (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    reference_id TEXT,
    error TEXT,
    kind TEXT NOT NULL,
    source_url TEXT,
    canonical_url TEXT,
    image_url TEXT,
    domain TEXT,
    envelope TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

# Colour analysis, one row per reference.
#
# Separate from reference_items rather than extra columns on it, for the same
# reason `captures` is: it's a derived artefact with its own lifecycle. It can
# be recomputed from the image at any time, it's versioned independently of
# the reference, and a whole-archive backfill rewrites it wholesale without
# touching library data.
#
# `version` and `content_hash` together are the cache key. version identifies
# the algorithm (see colour.ANALYSIS_VERSION); content_hash is the reference's
# own file hash, so an image replaced on disk invalidates its analysis rather
# than silently keeping a profile of the old picture.
COLOUR_ANALYSIS_SCHEMA = """
CREATE TABLE IF NOT EXISTS colour_analysis (
    reference_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    content_hash TEXT,
    profile TEXT NOT NULL,
    computed_at TEXT NOT NULL
);
"""

# --- Project spaces ---------------------------------------------------------
#
# The workspace side of a project: how its references are filed (folders), what
# its homepage shows (widgets), its own settings, and the free-form canvas.
# Every one of these tables hangs off a project id and dies with the project --
# see delete_project().

# Folders file a project's references into named groups.
#
# A folder belongs to exactly one project; project_id is never null. There is
# deliberately no global folders table: the Archive's cross-project folder view
# is a roll-up by folder NAME, computed as a query at read time. That is what
# makes a "Texture" folder in three different projects aggregate in the Archive
# without any of them sharing a row. Storing global folders instead would force
# an answer to "which project owns this name", and the answer is that none of
# them do.
#
# is_default records origin -- one of the six folders every new project starts
# with -- not protection. Default folders rename and delete like any other.
FOLDERS_SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    date_created TEXT NOT NULL
);
"""

# Which references are filed in which folder.
#
# Many-to-many on purpose: one reference may sit in several folders at once,
# because a folder is a view over the project rather than an owner of its
# contents. Deleting a row here only unfiles the reference -- its project
# membership and its archive record are untouched. For the same reason folders
# never filter the project grid page, which always shows the whole project.
FOLDER_REFERENCES_SCHEMA = """
CREATE TABLE IF NOT EXISTS folder_references (
    folder_id TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    date_added TEXT NOT NULL,
    PRIMARY KEY (folder_id, reference_id)
);
"""

# Widgets on a project's homepage grid.
#
# parent_id is the container link: NULL means the widget sits on the grid
# itself, non-null means it sits inside that container widget. x/y/w/h are grid
# cells, measured within whichever of the two the widget lives in.
#
# Nesting is one level deep -- containers hold leaf widgets, never other
# containers -- but that rule lives in app.py rather than here, because it
# depends on which types count as containers, and that is an application
# concept the schema has no opinion about.
WIDGETS_SCHEMA = """
CREATE TABLE IF NOT EXISTS widgets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_id TEXT,
    x INTEGER,
    y INTEGER,
    w INTEGER,
    h INTEGER,
    locked INTEGER NOT NULL DEFAULT 0,
    config TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    date_created TEXT NOT NULL
);
"""

# One JSON blob of settings per project.
#
# A blob rather than columns because these are frontend preferences that come
# and go as the project page changes; adding a toggle shouldn't need a schema
# migration, and nothing ever queries across projects by a setting's value.
PROJECT_SETTINGS_SCHEMA = """
CREATE TABLE IF NOT EXISTS project_settings (
    project_id TEXT PRIMARY KEY,
    settings TEXT NOT NULL
);
"""

# Saved appearance presets, global rather than per project -- the point is
# reusing one look across projects, so there is no project_id here at all.
# `settings` is the exact same JSON shape project_settings stores; saving a
# style is a copy of the project's current settings blob, and applying one is
# a copy back. A project that applies a style then stores the copy as its own
# project_settings row -- deleting the style later must not change that
# project (see delete_style), so there is deliberately no foreign key from
# either table to the other.
STYLES_SCHEMA = """
CREATE TABLE IF NOT EXISTS styles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    settings TEXT NOT NULL,
    date_created TEXT NOT NULL
);
"""

# Saved colour palettes, global rather than per project -- same shape of idea
# as styles above: a name given to a snapshot that would otherwise vanish the
# moment the page that generated it is left. `profile` is a whole colour.py
# profile dict (palette entries with their Lab, rgb AND weight, plus the hue/
# lightness/saturation histograms), not just the swatch list -- style_gen.py
# needs the weights to map proportion to area, and a profile is cheap enough
# to store whole that there is no reason to keep only part of it. `source` is
# either "archive" (generated across every reference) or a folder id, exactly
# as it was chosen from when the palette was saved -- purely descriptive, it
# is never joined against or validated, so a deleted folder leaves a palette
# with a source that no longer resolves to anything, which is fine.
PALETTES_SCHEMA = """
CREATE TABLE IF NOT EXISTS palettes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    profile TEXT NOT NULL,
    source TEXT,
    date_created TEXT NOT NULL
);
"""

# Saved widget arrangements, global rather than per project -- same shape of
# idea as styles above, but for layout instead of appearance. `widgets` is a
# JSON list of portable widget entries (see capture_layout_widgets): type,
# geometry, config and parent nesting, with nesting expressed as an index into
# this same list rather than a widget or project id, so a layout carries no
# reference back to the project it was captured from -- deleting that project
# leaves every layout saved from it fully usable.
LAYOUTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS layouts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    widgets TEXT NOT NULL,
    date_created TEXT NOT NULL
);
"""

# Nodes on a project's infinite canvas.
#
# One table for all three kinds (reference | text | widget) rather than three,
# because the canvas drags, locks, z-orders and connects all three identically.
# Only what gets drawn inside the box differs: reference_id points at the
# archive for a reference node, content holds the body of a text node, config
# holds a widget node's settings.
#
# x/y/w/h are REAL world coordinates, never screen coordinates -- a screen
# position stops meaning anything the moment the canvas is panned or zoomed.
CANVAS_NODES_SCHEMA = """
CREATE TABLE IF NOT EXISTS canvas_nodes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    reference_id TEXT,
    x REAL,
    y REAL,
    w REAL,
    h REAL,
    locked INTEGER NOT NULL DEFAULT 0,
    content TEXT,
    config TEXT,
    z_index INTEGER NOT NULL DEFAULT 0
);
"""

# Connections drawn between canvas nodes. `style` is a JSON blob for the same
# reason widgets.config is: how a line looks is a frontend decision.
CANVAS_EDGES_SCHEMA = """
CREATE TABLE IF NOT EXISTS canvas_edges (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    style TEXT
);
"""

PROJECT_SPACE_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_folders_project ON folders(project_id)",
    # The reverse lookup: which folders a given reference is filed in, and the
    # cleanup path when it's deleted from the archive.
    "CREATE INDEX IF NOT EXISTS idx_folder_references_reference ON folder_references(reference_id)",
    "CREATE INDEX IF NOT EXISTS idx_widgets_project ON widgets(project_id)",
    "CREATE INDEX IF NOT EXISTS idx_canvas_nodes_project ON canvas_nodes(project_id)",
    "CREATE INDEX IF NOT EXISTS idx_canvas_edges_project ON canvas_edges(project_id)",
)

# What a brand new project starts with. The folder names are the six lenses
# the tool thinks in. The widgets are a hand-frozen snapshot of what a project
# called "Default Project Layout" looked like when this was captured -- baked
# in as plain data rather than looked up at creation time, so deleting that
# project (or never having made one) can never change what a new project
# starts with; it was only ever a convenient place to arrange the default by
# eye. Positions are grid cells in the 24-column homepage grid.
#
# Each entry is the same portable shape a saved layout's `widgets` column
# holds (see capture_layout_widgets): type, geometry, config and a `parent`
# that is an index into this same tuple (never a widget id) for nesting --
# None here throughout, since this default has no container widgets.
DEFAULT_FOLDER_NAMES = ("Texture", "Colour", "Form", "Vibe", "Fashion", "Narrative")
DEFAULT_WIDGETS = (
    {"type": "title", "x": 9, "y": 0, "w": 6, "h": 2, "locked": False, "config": None, "parent": None},
    {"type": "settings", "x": 21, "y": 0, "w": 1, "h": 1, "locked": False, "config": None, "parent": None},
    {"type": "exit", "x": 22, "y": 0, "w": 2, "h": 1, "locked": False, "config": None, "parent": None},
    {"type": "grid-button", "x": 21, "y": 1, "w": 3, "h": 1, "locked": False, "config": None, "parent": None},
    {"type": "colourspace", "x": 0, "y": 2, "w": 9, "h": 12, "locked": False, "config": None, "parent": None},
    {"type": "notepad", "x": 9, "y": 2, "w": 6, "h": 12, "locked": False, "config": {"content": ""}, "parent": None},
    {"type": "canvas", "x": 15, "y": 2, "w": 9, "h": 12, "locked": False, "config": None, "parent": None},
)

COLOUR_ANALYSIS_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_colour_version ON colour_analysis(version)",
)

CAPTURES_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_captures_image_url ON captures(image_url)",
    "CREATE INDEX IF NOT EXISTS idx_captures_canonical_url ON captures(canonical_url)",
    "CREATE INDEX IF NOT EXISTS idx_captures_source_url ON captures(source_url)",
    "CREATE INDEX IF NOT EXISTS idx_captures_status ON captures(status)",
)

# A capture is only ever in one of these states.
CAPTURE_QUEUED = "queued"
CAPTURE_PROCESSING = "processing"
CAPTURE_DONE = "done"
CAPTURE_DUPLICATE = "duplicate"
CAPTURE_FAILED = "failed"
# Statuses that still need work doing on them -- used both to re-queue after a
# restart and to decide whether a capture counts as "already saved".
CAPTURE_PENDING_STATUSES = (CAPTURE_QUEUED, CAPTURE_PROCESSING)


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.execute(SCHEMA)
        conn.execute(PROJECTS_SCHEMA)
        conn.execute(PROJECT_REFERENCES_SCHEMA)
        conn.execute(ANALYSES_SCHEMA)
        conn.execute(SIMILARITY_SCORES_SCHEMA)
        conn.execute(CAPTURES_SCHEMA)
        for ddl in CAPTURES_INDEXES:
            conn.execute(ddl)
        conn.execute(COLOUR_ANALYSIS_SCHEMA)
        for ddl in COLOUR_ANALYSIS_INDEXES:
            conn.execute(ddl)
        conn.execute(FOLDERS_SCHEMA)
        conn.execute(FOLDER_REFERENCES_SCHEMA)
        conn.execute(WIDGETS_SCHEMA)
        conn.execute(PROJECT_SETTINGS_SCHEMA)
        conn.execute(STYLES_SCHEMA)
        conn.execute(PALETTES_SCHEMA)
        conn.execute(LAYOUTS_SCHEMA)
        conn.execute(CANVAS_NODES_SCHEMA)
        conn.execute(CANVAS_EDGES_SCHEMA)
        for ddl in PROJECT_SPACE_INDEXES:
            conn.execute(ddl)
        # Migrate older databases created before these columns existed.
        for ddl in (
            "ALTER TABLE reference_items ADD COLUMN content_hash TEXT",
            "ALTER TABLE reference_items ADD COLUMN is_own_work INTEGER NOT NULL DEFAULT 0",
        ):
            try:
                conn.execute(ddl)
            except sqlite3.OperationalError:
                pass  # column already exists
        _migrate_text_widget_to_notepad(conn)


# One-off: the `text` widget type was removed in favour of `notepad`, which
# offers the same per-selection rich text editing without the edit-mode
# gate that made the old widget unusable outside of layout editing. Their
# configs are the exact same shape -- { content, typography: { align },
# contentScale } -- so the conversion is a rename with nothing to carry
# across by hand: content, alignment and content scale all survive as-is.
# Nothing is lost.
#
# Not wrapped in try/except like the ALTER TABLE migrations above -- there is
# no operational error to guard against here, and the UPDATEs are naturally
# idempotent: once no row has type/config.type "text", both loops below find
# nothing and no-op, so this is safe to run on every boot rather than
# needing a one-time flag.
def _migrate_text_widget_to_notepad(conn):
    conn.execute("UPDATE widgets SET type = 'notepad' WHERE type = 'text'")

    rows = conn.execute(
        "SELECT id, config FROM canvas_nodes WHERE kind = 'widget' AND config IS NOT NULL"
    ).fetchall()
    for row in rows:
        try:
            config = json.loads(row["config"])
        except (TypeError, ValueError):
            continue
        if not isinstance(config, dict) or config.get("type") != "text":
            continue
        config["type"] = "notepad"
        conn.execute(
            "UPDATE canvas_nodes SET config = ? WHERE id = ?",
            (json.dumps(config), row["id"]),
        )


def insert_reference(
    ref_id, type_, filepath, title, source, tags, description, notes, content_hash=None, is_own_work=False
):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO reference_items
               (id, type, filepath, title, source, tags, description, notes, content_hash, is_own_work, date_added)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                ref_id,
                type_,
                filepath,
                title,
                source,
                json.dumps(tags),
                description,
                notes,
                content_hash,
                1 if is_own_work else 0,
                datetime.now(timezone.utc).isoformat(),
            ),
        )


def find_by_content_hash(content_hash):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM reference_items WHERE content_hash = ?", (content_hash,)
        ).fetchone()
        return _row_to_dict(row) if row else None


def get_reference(ref_id):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM reference_items WHERE id = ?", (ref_id,)
        ).fetchone()
        return _row_to_dict(row) if row else None


def find_by_id_prefix(prefix):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM reference_items WHERE id LIKE ?", (f"{prefix}%",)
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def list_references():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM reference_items ORDER BY date_added DESC"
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def get_references_by_ids(ids):
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM reference_items WHERE id IN ({placeholders})", ids
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def update_reference_title(ref_id, title):
    with get_conn() as conn:
        conn.execute("UPDATE reference_items SET title = ? WHERE id = ?", (title, ref_id))


def find_titles_like(title):
    """Every existing title that is `title` itself, or `title` with anything
    appended -- the raw material for picking the next free " (N)" suffix.

    Deliberately over-fetches (a title of "Sketch" also pulls back "Sketch of
    a coat", which isn't a collision) rather than trying to express the exact
    "or has a numeric suffix" condition in SQL; the caller filters precisely
    with a regex against this list instead.
    """
    with get_conn() as conn:
        pattern = title.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        rows = conn.execute(
            "SELECT title FROM reference_items WHERE title LIKE ? ESCAPE '\\'",
            (pattern,),
        ).fetchall()
        return [r["title"] for r in rows]


def delete_reference(ref_id):
    """Remove a reference and everything that points at it by id.

    Saved analyses keep their reference_ids as written, so an old transcript
    stays readable as the record of what was actually discussed -- deleted
    references simply drop out of the reference list it renders alongside.
    """
    with get_conn() as conn:
        conn.execute("DELETE FROM reference_items WHERE id = ?", (ref_id,))
        conn.execute("DELETE FROM project_references WHERE reference_id = ?", (ref_id,))
        conn.execute("DELETE FROM colour_analysis WHERE reference_id = ?", (ref_id,))
        conn.execute(
            "DELETE FROM similarity_scores WHERE reference_id_a = ? OR reference_id_b = ?",
            (ref_id, ref_id),
        )
        conn.execute("DELETE FROM folder_references WHERE reference_id = ?", (ref_id,))
        # A canvas node for a reference has nothing left to draw once the
        # reference is gone, so it goes too -- and its edges with it, before the
        # nodes disappear and leave the edges pointing at nothing.
        conn.execute(
            """DELETE FROM canvas_edges WHERE source_node_id IN
                   (SELECT id FROM canvas_nodes WHERE reference_id = ?)
               OR target_node_id IN
                   (SELECT id FROM canvas_nodes WHERE reference_id = ?)""",
            (ref_id, ref_id),
        )
        conn.execute("DELETE FROM canvas_nodes WHERE reference_id = ?", (ref_id,))


def _row_to_dict(row):
    d = dict(row)
    d["tags"] = json.loads(d["tags"]) if d["tags"] else []
    d["is_own_work"] = bool(d["is_own_work"])
    return d


def create_project(project_id, title, description=None):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO projects (id, title, description, date_created) VALUES (?, ?, ?, ?)",
            (project_id, title, description, datetime.now(timezone.utc).isoformat()),
        )


def list_projects():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM projects ORDER BY date_created DESC").fetchall()
        return [dict(r) for r in rows]


def get_project(project_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        return dict(row) if row else None


def update_project(project_id, title, description=None):
    with get_conn() as conn:
        conn.execute(
            "UPDATE projects SET title = ?, description = ? WHERE id = ?",
            (title, description, project_id),
        )


def delete_project(project_id):
    """Delete a project, the list of which references belonged to it, the
    analyses saved against it, and its whole project space.

    The references themselves are untouched -- a project is a grouping, so
    deleting one means "forget this grouping", not "delete this work". The
    project space is the opposite: folders, widget layout, settings and canvas
    only ever meant anything inside this project, so nothing about them can
    outlive it.
    """
    with get_conn() as conn:
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        conn.execute("DELETE FROM project_references WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM analyses WHERE project_id = ?", (project_id,))
        # Unfile before the folders go, since folder_references is only
        # reachable from the project through them.
        conn.execute(
            """DELETE FROM folder_references WHERE folder_id IN
                   (SELECT id FROM folders WHERE project_id = ?)""",
            (project_id,),
        )
        conn.execute("DELETE FROM folders WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM widgets WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM project_settings WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM canvas_nodes WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM canvas_edges WHERE project_id = ?", (project_id,))


def count_project_references(project_id):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM project_references WHERE project_id = ?", (project_id,)
        ).fetchone()
        return row["c"]


def list_project_references(project_id, limit=None):
    """References in a project, most-recently-added-to-the-project first.

    `limit` caps how many rows come back -- used to fetch just enough for
    the horizontal preview bar without pulling in a whole large project.
    """
    query = """
        SELECT reference_items.* FROM reference_items
        JOIN project_references ON reference_items.id = project_references.reference_id
        WHERE project_references.project_id = ?
        ORDER BY project_references.date_added DESC
    """
    params = [project_id]
    if limit is not None:
        query += " LIMIT ?"
        params.append(limit)
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [_row_to_dict(r) for r in rows]


def add_reference_to_project(project_id, reference_id):
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO project_references (project_id, reference_id, date_added) VALUES (?, ?, ?)",
            (project_id, reference_id, datetime.now(timezone.utc).isoformat()),
        )


def remove_reference_from_project(project_id, reference_id):
    """Drop a reference from a project, and from every one of that project's
    folders with it -- a folder is a view over its project's references, so a
    reference that's no longer in the project can't legitimately stay filed in
    a folder that belongs to it."""
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM project_references WHERE project_id = ? AND reference_id = ?",
            (project_id, reference_id),
        )
        conn.execute(
            """DELETE FROM folder_references WHERE reference_id = ? AND folder_id IN
                   (SELECT id FROM folders WHERE project_id = ?)""",
            (reference_id, project_id),
        )


def save_analysis(analysis_id, project_id, reference_ids, transcript):
    """Create or update a saved analysis conversation.

    Reuses the same id the live conversation was already assigned (from
    starting the analysis), so clicking Save again later in the same
    conversation just refreshes the saved snapshot rather than duplicating
    it -- date_created is left untouched by the update.
    """
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO analyses (id, project_id, reference_ids, transcript, date_created)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   reference_ids = excluded.reference_ids,
                   transcript = excluded.transcript""",
            (
                analysis_id,
                project_id,
                json.dumps(reference_ids),
                json.dumps(transcript),
                datetime.now(timezone.utc).isoformat(),
            ),
        )


def list_analyses_for_project(project_id):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM analyses WHERE project_id = ? ORDER BY date_created DESC", (project_id,)
        ).fetchall()
        return [_analysis_to_dict(r) for r in rows]


def get_analysis(analysis_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM analyses WHERE id = ?", (analysis_id,)).fetchone()
        return _analysis_to_dict(row) if row else None


def _analysis_to_dict(row):
    d = dict(row)
    d["reference_ids"] = json.loads(d["reference_ids"])
    d["transcript"] = json.loads(d["transcript"])
    return d


def save_similarity_scores(pairs):
    """Replace all stored pairwise similarity scores with a fresh full set.

    `pairs` is a list of (reference_id_a, reference_id_b, score) tuples.
    Always a full wipe-and-recompute, done in one transaction -- "similarity
    across the whole library right now" doesn't mean much as a partial
    update once references have been added or removed since the last run.
    """
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute("DELETE FROM similarity_scores")
        conn.executemany(
            """INSERT INTO similarity_scores (reference_id_a, reference_id_b, score, computed_at)
               VALUES (?, ?, ?, ?)""",
            [(a, b, score, now) for a, b, score in pairs],
        )


def get_similarity_scores_meta():
    """(count, most recent computed_at) -- a cheap summary for a status line
    without pulling every stored score back."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c, MAX(computed_at) AS latest FROM similarity_scores"
        ).fetchone()
        return row["c"], row["latest"]


def list_similarity_scores():
    """All stored pairwise scores. Not consumed anywhere in the app yet --
    kept accessible here for a future feature (e.g. a 3D similarity graph)."""
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM similarity_scores").fetchall()
        return [dict(r) for r in rows]


def create_capture(capture_id, kind, envelope, source_url=None, canonical_url=None,
                   image_url=None, domain=None):
    """Record an incoming capture as queued. Written before any slow work so
    the capture is durable from the moment the request is accepted."""
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO captures
               (id, status, reference_id, error, kind, source_url, canonical_url,
                image_url, domain, envelope, created_at, updated_at)
               VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                capture_id,
                CAPTURE_QUEUED,
                kind,
                source_url,
                canonical_url,
                image_url,
                domain,
                json.dumps(envelope),
                now,
                now,
            ),
        )


def get_capture(capture_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM captures WHERE id = ?", (capture_id,)).fetchone()
        return _capture_to_dict(row) if row else None


def update_capture(capture_id, status, reference_id=None, error=None):
    with get_conn() as conn:
        conn.execute(
            """UPDATE captures
               SET status = ?, reference_id = ?, error = ?, updated_at = ?
               WHERE id = ?""",
            (status, reference_id, error, datetime.now(timezone.utc).isoformat(), capture_id),
        )


def find_captures_by_urls(image_url=None, canonical_url=None, source_url=None):
    """Captures already recorded for any of these URLs, newest first.

    Only rows that actually got somewhere count as a prior capture -- a failed
    attempt shouldn't make the extension claim the reference already exists.
    """
    clauses, params = [], []
    if image_url:
        clauses.append("image_url = ?")
        params.append(image_url)
    if canonical_url:
        clauses.append("canonical_url = ?")
        params.append(canonical_url)
    if source_url:
        clauses.append("source_url = ?")
        params.append(source_url)
    if not clauses:
        return []

    keep = (CAPTURE_DONE, CAPTURE_DUPLICATE, *CAPTURE_PENDING_STATUSES)
    placeholders = ",".join("?" for _ in keep)
    query = (
        f"SELECT * FROM captures WHERE ({' OR '.join(clauses)}) "
        f"AND status IN ({placeholders}) ORDER BY created_at DESC"
    )
    with get_conn() as conn:
        rows = conn.execute(query, [*params, *keep]).fetchall()
        return [_capture_to_dict(r) for r in rows]


def list_pending_captures():
    """Captures still queued or mid-flight -- re-queued on boot so a restart
    part-way through ingestion doesn't silently drop them."""
    placeholders = ",".join("?" for _ in CAPTURE_PENDING_STATUSES)
    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM captures WHERE status IN ({placeholders}) ORDER BY created_at",
            CAPTURE_PENDING_STATUSES,
        ).fetchall()
        return [_capture_to_dict(r) for r in rows]


def _capture_to_dict(row):
    d = dict(row)
    d["envelope"] = json.loads(d["envelope"]) if d["envelope"] else {}
    return d


# --- Colour analysis --------------------------------------------------------


def save_colour_analysis(reference_id, version, content_hash, profile_json):
    """Store (or replace) one reference's colour profile."""
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO colour_analysis
                   (reference_id, version, content_hash, profile, computed_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(reference_id) DO UPDATE SET
                   version = excluded.version,
                   content_hash = excluded.content_hash,
                   profile = excluded.profile,
                   computed_at = excluded.computed_at""",
            (
                reference_id,
                version,
                content_hash,
                profile_json,
                datetime.now(timezone.utc).isoformat(),
            ),
        )


def get_colour_analysis(reference_id, version=None):
    """One reference's stored analysis, or None.

    Passing `version` returns nothing for a row computed by a different
    algorithm version -- a stale profile is not a usable cache hit, and
    quietly comparing across versions would produce meaningless scores.
    """
    query = "SELECT * FROM colour_analysis WHERE reference_id = ?"
    params = [reference_id]
    if version is not None:
        query += " AND version = ?"
        params.append(version)
    with get_conn() as conn:
        row = conn.execute(query, params).fetchone()
        return dict(row) if row else None


def get_colour_analyses(reference_ids, version=None):
    """Analyses for many references at once, as {reference_id: row}."""
    if not reference_ids:
        return {}
    placeholders = ",".join("?" for _ in reference_ids)
    query = f"SELECT * FROM colour_analysis WHERE reference_id IN ({placeholders})"
    params = list(reference_ids)
    if version is not None:
        query += " AND version = ?"
        params.append(version)
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return {r["reference_id"]: dict(r) for r in rows}


def list_colour_analyses(version=None, exclude_ids=None, include_ids=None):
    """Every stored analysis, for a whole-archive colour search.

    Returns rows rather than a generator because the caller scores all of
    them; the profiles are small (a handful of palette entries and short
    histograms), so this stays cheap at archive scale.

    `include_ids` narrows the set to those references (a project's own, say)
    and intersects with `exclude_ids` rather than overriding it, so a caller
    can scope and exclude at once. `None` means "no restriction"; an empty
    collection means an empty set, and correctly returns nothing -- the two
    are not the same question.
    """
    query = "SELECT reference_id, profile FROM colour_analysis"
    params = []
    if version is not None:
        query += " WHERE version = ?"
        params.append(version)
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()

    exclude = set(exclude_ids or [])
    include = None if include_ids is None else set(include_ids)
    return [
        (r["reference_id"], r["profile"])
        for r in rows
        if r["reference_id"] not in exclude and (include is None or r["reference_id"] in include)
    ]


def list_references_needing_colour(version, limit=None, image_exts=None):
    """Image references with no current-version analysis -- the backfill queue.

    A reference qualifies if it has no row at all, if its row was computed by
    an older algorithm version, or if its file hash has changed since (the
    image was replaced). Text and PDF references are skipped: colour search
    is about pictures, and a .txt has no palette.
    """
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT r.id, r.filepath, r.content_hash
               FROM reference_items r
               LEFT JOIN colour_analysis c ON c.reference_id = r.id
               WHERE r.type = 'image'
                 AND (c.reference_id IS NULL
                      OR c.version != ?
                      OR (r.content_hash IS NOT NULL AND c.content_hash IS NOT r.content_hash))
               ORDER BY r.date_added DESC""",
            (version,),
        ).fetchall()

    out = [dict(r) for r in rows]
    if image_exts:
        out = [r for r in out if Path(r["filepath"]).suffix.lower() in image_exts]
    return out[:limit] if limit else out


def count_colour_analyses(version=None):
    query = "SELECT COUNT(*) AS c FROM colour_analysis"
    params = []
    if version is not None:
        query += " WHERE version = ?"
        params.append(version)
    with get_conn() as conn:
        return conn.execute(query, params).fetchone()["c"]


def count_image_references():
    with get_conn() as conn:
        return conn.execute(
            "SELECT COUNT(*) AS c FROM reference_items WHERE type = 'image'"
        ).fetchone()["c"]


# --- Project spaces: seeding a new project -----------------------------------


def seed_project_defaults(project_id):
    """Give a brand new project its starting folders and widgets.

    The six folders are always the same starting lenses. Widgets always come
    from the baked-in DEFAULT_WIDGETS -- no project is consulted at creation
    time, so nothing a user does to any project (including deleting one
    called "Default Project Layout") can change what a new project starts
    with. Appearance is deliberately not seeded: a new project starts with no
    project_settings row and follows style.css's global theme, same as
    picking "Default" from the style picker (see appearance-panel.js).

    One transaction rather than many separate calls, so a project is never
    briefly visible with half a project space. Ids are minted here for the
    same reason -- the caller has no use for any of them.
    """
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.executemany(
            """INSERT INTO folders (id, project_id, name, position, is_default, date_created)
               VALUES (?, ?, ?, ?, 1, ?)""",
            [
                (str(uuid.uuid4()), project_id, name, position, now)
                for position, name in enumerate(DEFAULT_FOLDER_NAMES)
            ],
        )
        _insert_layout_widgets(conn, project_id, DEFAULT_WIDGETS, now)


def _insert_layout_widgets(conn, project_id, entries, now):
    """Insert a portable widget list (the shape DEFAULT_WIDGETS and a saved
    layout's `widgets` column both use) into a project, minting fresh ids and
    resolving each entry's `parent` -- an index into `entries` itself, never a
    real widget id -- to the newly minted id at that index.

    Only used for a brand new project (seed_project_defaults), which has no
    widgets yet to collide with. Loading a saved layout into a project that
    already has widgets is a client-side operation instead (see
    project/main.js's loadLayout) -- it has to decide what happens to the
    existing permanent widgets, which this helper has no notion of.
    """
    ids = [str(uuid.uuid4()) for _ in entries]
    conn.executemany(
        """INSERT INTO widgets
               (id, project_id, type, parent_id, x, y, w, h, locked, config,
                position, date_created)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            (
                ids[position],
                project_id,
                entry["type"],
                ids[entry["parent"]] if entry.get("parent") is not None else None,
                entry["x"],
                entry["y"],
                entry["w"],
                entry["h"],
                1 if entry.get("locked") else 0,
                json.dumps(entry["config"]) if entry.get("config") is not None else None,
                position,
                now,
            )
            for position, entry in enumerate(entries)
        ],
    )


# --- Project spaces: folders -------------------------------------------------


def _next_position(conn, table, project_id):
    """One past the last position in this project, for appending.

    `table` is always a literal from this module -- never anything that came in
    over the wire -- so interpolating it is safe here.
    """
    row = conn.execute(
        f"SELECT MAX(position) AS m FROM {table} WHERE project_id = ?", (project_id,)
    ).fetchone()
    return 0 if row["m"] is None else row["m"] + 1


def create_folder(folder_id, project_id, name, position=None, is_default=False):
    """Add a folder to a project, appended last unless a position is given."""
    with get_conn() as conn:
        if position is None:
            position = _next_position(conn, "folders", project_id)
        conn.execute(
            """INSERT INTO folders (id, project_id, name, position, is_default, date_created)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                folder_id,
                project_id,
                name,
                position,
                1 if is_default else 0,
                datetime.now(timezone.utc).isoformat(),
            ),
        )


# A folder always comes back with how much is filed in it, whether read one at
# a time or as a project's whole list -- the sidebar draws every folder with its
# count, and one grouped query beats a count call per folder.
_FOLDER_SELECT = """
    SELECT folders.*, COUNT(folder_references.reference_id) AS reference_count
    FROM folders
    LEFT JOIN folder_references ON folder_references.folder_id = folders.id
"""


def list_folders(project_id):
    """A project's folders in display order."""
    with get_conn() as conn:
        rows = conn.execute(
            _FOLDER_SELECT
            + """WHERE folders.project_id = ?
                 GROUP BY folders.id
                 ORDER BY folders.position, folders.date_created""",
            (project_id,),
        ).fetchall()
        return [_folder_to_dict(r) for r in rows]


def get_folder(folder_id):
    with get_conn() as conn:
        # The GROUP BY is what makes a missing folder come back as no row at
        # all; a bare aggregate would return one row of NULLs instead.
        row = conn.execute(
            _FOLDER_SELECT + "WHERE folders.id = ? GROUP BY folders.id", (folder_id,)
        ).fetchone()
        return _folder_to_dict(row) if row else None


def rename_folder(folder_id, name):
    with get_conn() as conn:
        conn.execute("UPDATE folders SET name = ? WHERE id = ?", (name, folder_id))


def move_folder(folder_id, position):
    """Move a folder to `position` among its siblings, renumbering them all.

    Positions are rewritten as a dense 0..n-1 run rather than nudged by one,
    because a drag that leaves gaps or ties makes the displayed order fall back
    on date_created -- which looks like the folder snapping back on reload.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT project_id FROM folders WHERE id = ?", (folder_id,)
        ).fetchone()
        if not row:
            return
        ids = [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM folders WHERE project_id = ? ORDER BY position, date_created",
                (row["project_id"],),
            ).fetchall()
        ]
        ids.remove(folder_id)
        ids.insert(max(0, min(int(position), len(ids))), folder_id)
        conn.executemany(
            "UPDATE folders SET position = ? WHERE id = ?",
            [(i, fid) for i, fid in enumerate(ids)],
        )


def delete_folder(folder_id):
    """Delete a folder, unfile everything in it, and remove any folder widget
    that pointed at it.

    A folder widget (widgets/folder.js) is a shortcut seeded with this
    folder's id at creation time; once the folder is gone the shortcut has
    nowhere to point, so it goes too rather than sitting on the grid as a
    dead "Folder deleted" tile forever.

    Only the filing and the shortcut go. The references stay in the project
    and in the archive, exactly as when one is removed from a folder
    individually.
    """
    with get_conn() as conn:
        row = conn.execute(
            "SELECT project_id FROM folders WHERE id = ?", (folder_id,)
        ).fetchone()
        conn.execute("DELETE FROM folder_references WHERE folder_id = ?", (folder_id,))
        conn.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        if row:
            candidates = conn.execute(
                "SELECT id, config FROM widgets WHERE project_id = ? AND type = 'folder'",
                (row["project_id"],),
            ).fetchall()
            stale_ids = [
                w["id"]
                for w in candidates
                if w["config"] and json.loads(w["config"]).get("folder_id") == folder_id
            ]
            conn.executemany(
                "DELETE FROM widgets WHERE id = ?", [(wid,) for wid in stale_ids]
            )


def list_folder_references(folder_id):
    """The references filed in one folder, most recently filed first."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT reference_items.* FROM reference_items
               JOIN folder_references ON reference_items.id = folder_references.reference_id
               WHERE folder_references.folder_id = ?
               ORDER BY folder_references.date_added DESC""",
            (folder_id,),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def add_references_to_folder(folder_id, reference_ids):
    """File references into a folder, ignoring any already there."""
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO folder_references (folder_id, reference_id, date_added)
               VALUES (?, ?, ?)""",
            [(folder_id, rid, now) for rid in reference_ids],
        )


def remove_reference_from_folder(folder_id, reference_id):
    """Unfile one reference. Deliberately touches nothing but this one row --
    the reference keeps its project membership and its archive record, and stays
    in any other folder it was filed in."""
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM folder_references WHERE folder_id = ? AND reference_id = ?",
            (folder_id, reference_id),
        )


def _folder_to_dict(row):
    d = dict(row)
    d["is_default"] = bool(d["is_default"])
    return d


def list_folder_rollup():
    """Folder names rolled up across every project: how many distinct
    references sit under that name anywhere, and which projects contribute.

    Computed at read time, not stored -- a folder still belongs to exactly
    one project (see the `folders` table notes above). This is what lets a
    "Texture" folder in three different projects aggregate here without any
    row being shared between them, and without a global folders table.
    """
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT folders.name AS name,
                      projects.id AS project_id, projects.title AS project_title,
                      folder_references.reference_id AS reference_id
               FROM folders
               JOIN projects ON projects.id = folders.project_id
               LEFT JOIN folder_references ON folder_references.folder_id = folders.id"""
        ).fetchall()

    by_name = {}
    for row in rows:
        entry = by_name.setdefault(
            row["name"], {"name": row["name"], "ref_ids": set(), "projects": {}}
        )
        project = entry["projects"].setdefault(
            row["project_id"], {"id": row["project_id"], "title": row["project_title"], "ref_ids": set()}
        )
        if row["reference_id"]:
            entry["ref_ids"].add(row["reference_id"])
            project["ref_ids"].add(row["reference_id"])

    result = []
    for entry in by_name.values():
        projects = sorted(
            (
                {"id": p["id"], "title": p["title"], "count": len(p["ref_ids"])}
                for p in entry["projects"].values()
            ),
            key=lambda p: p["title"].lower(),
        )
        result.append(
            {
                "name": entry["name"],
                "reference_count": len(entry["ref_ids"]),
                "projects": projects,
            }
        )
    result.sort(key=lambda e: e["name"].lower())
    return result


def list_folder_rollup_references(name):
    """Every reference filed in any folder with this name, across every
    project, de-duplicated by reference id -- a reference in two projects'
    "Texture" folders appears once here."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT DISTINCT reference_items.*
               FROM reference_items
               JOIN folder_references ON reference_items.id = folder_references.reference_id
               JOIN folders ON folders.id = folder_references.folder_id
               WHERE folders.name = ?
               ORDER BY reference_items.date_added DESC""",
            (name,),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


# --- Project spaces: widgets -------------------------------------------------


def create_widget(widget_id, project_id, type_, parent_id=None, x=0, y=0, w=1, h=1,
                  config=None, position=None, locked=False):
    with get_conn() as conn:
        if position is None:
            position = _next_position(conn, "widgets", project_id)
        conn.execute(
            """INSERT INTO widgets
                   (id, project_id, type, parent_id, x, y, w, h, locked, config,
                    position, date_created)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                widget_id,
                project_id,
                type_,
                parent_id,
                x,
                y,
                w,
                h,
                1 if locked else 0,
                json.dumps(config) if config is not None else None,
                position,
                datetime.now(timezone.utc).isoformat(),
            ),
        )


def list_widgets(project_id):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM widgets WHERE project_id = ? ORDER BY position, date_created",
            (project_id,),
        ).fetchall()
        return [_widget_to_dict(r) for r in rows]


def get_widget(widget_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM widgets WHERE id = ?", (widget_id,)).fetchone()
        return _widget_to_dict(row) if row else None


def save_widget_layout(project_id, entries):
    """Commit a whole homepage layout in one transaction.

    Layout only. Widgets are created and deleted through their own routes, so an
    id that isn't already in this project is skipped rather than inserted --
    otherwise a stale editor tab could resurrect a widget the user had deleted,
    or write one project's widget into another. Returns how many were updated.
    """
    with get_conn() as conn:
        known = {
            r["id"]
            for r in conn.execute(
                "SELECT id FROM widgets WHERE project_id = ?", (project_id,)
            ).fetchall()
        }
        updated = 0
        for index, entry in enumerate(entries):
            widget_id = entry.get("id")
            if widget_id not in known:
                continue
            conn.execute(
                """UPDATE widgets
                   SET parent_id = ?, x = ?, y = ?, w = ?, h = ?, locked = ?, position = ?
                   WHERE id = ?""",
                (
                    entry.get("parent_id"),
                    entry.get("x"),
                    entry.get("y"),
                    entry.get("w"),
                    entry.get("h"),
                    1 if entry.get("locked") else 0,
                    # Falling back to the payload's own order means the editor
                    # doesn't have to renumber before saving.
                    entry.get("position", index),
                    widget_id,
                ),
            )
            # A widget's config belongs to the widget, not the layout editor, so
            # it's only touched when the payload actually carries one.
            if "config" in entry:
                config = entry["config"]
                conn.execute(
                    "UPDATE widgets SET config = ? WHERE id = ?",
                    (json.dumps(config) if config is not None else None, widget_id),
                )
            updated += 1
        return updated


def delete_widget(widget_id):
    """Delete a widget, and anything inside it if it was a container.

    Children go rather than falling back to the grid: their x/y are cells within
    the container, so on the grid they would land somewhere arbitrary and
    overlap whatever is already there.
    """
    with get_conn() as conn:
        conn.execute("DELETE FROM widgets WHERE parent_id = ?", (widget_id,))
        conn.execute("DELETE FROM widgets WHERE id = ?", (widget_id,))


def _widget_to_dict(row):
    d = dict(row)
    d["config"] = json.loads(d["config"]) if d["config"] else None
    d["locked"] = bool(d["locked"])
    return d


# --- Project spaces: settings ------------------------------------------------


def get_project_settings(project_id):
    """A project's settings, or {} for a project that has never saved any."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT settings FROM project_settings WHERE project_id = ?", (project_id,)
        ).fetchone()
        return json.loads(row["settings"]) if row else {}


def save_project_settings(project_id, settings):
    """Replace a project's settings wholesale.

    A whole-blob write rather than a merge: the frontend holds the complete
    settings object anyway, and merging would make removing a key impossible.
    """
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO project_settings (project_id, settings) VALUES (?, ?)
               ON CONFLICT(project_id) DO UPDATE SET settings = excluded.settings""",
            (project_id, json.dumps(settings)),
        )


# --- Styles: saved appearance presets, global ---------------------------------


def _style_to_dict(row):
    d = dict(row)
    d["settings"] = json.loads(d["settings"]) if d["settings"] else {}
    return d


def list_styles():
    """Every saved style, newest first."""
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM styles ORDER BY date_created DESC").fetchall()
        return [_style_to_dict(r) for r in rows]


def get_style(style_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM styles WHERE id = ?", (style_id,)).fetchone()
        return _style_to_dict(row) if row else None


def create_style(style_id, name, settings):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO styles (id, name, settings, date_created) VALUES (?, ?, ?, ?)""",
            (style_id, name, json.dumps(settings), datetime.now(timezone.utc).isoformat()),
        )


def update_style(style_id, name=None, settings=None):
    """Rename a style, replace its settings, or both."""
    with get_conn() as conn:
        if name is not None:
            conn.execute("UPDATE styles SET name = ? WHERE id = ?", (name, style_id))
        if settings is not None:
            conn.execute(
                "UPDATE styles SET settings = ? WHERE id = ?",
                (json.dumps(settings), style_id),
            )


def delete_style(style_id):
    """Delete a style. Projects store their own resolved settings copy in
    project_settings, not a reference to this row, so nothing else needs
    cleaning up -- a project that was using this style keeps looking exactly
    as it did."""
    with get_conn() as conn:
        conn.execute("DELETE FROM styles WHERE id = ?", (style_id,))


# --- Palettes: saved colour palettes, global -----------------------------------


def _palette_to_dict(row):
    d = dict(row)
    d["profile"] = json.loads(d["profile"]) if d["profile"] else {}
    return d


def list_palettes():
    """Every saved palette, newest first."""
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM palettes ORDER BY date_created DESC").fetchall()
        return [_palette_to_dict(r) for r in rows]


def get_palette(palette_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM palettes WHERE id = ?", (palette_id,)).fetchone()
        return _palette_to_dict(row) if row else None


def create_palette(palette_id, name, profile, source=None):
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO palettes (id, name, profile, source, date_created)
               VALUES (?, ?, ?, ?, ?)""",
            (palette_id, name, json.dumps(profile), source, datetime.now(timezone.utc).isoformat()),
        )


def delete_palette(palette_id):
    """Delete a palette. A style already generated from it keeps its own
    resolved settings copy (style_gen.generate_style's output, saved through
    create_style same as any hand-made style), so nothing else needs
    cleaning up."""
    with get_conn() as conn:
        conn.execute("DELETE FROM palettes WHERE id = ?", (palette_id,))


# --- Layouts: saved widget arrangements, global -------------------------------
#
# A layout is a named, portable snapshot of one project's widgets -- type,
# geometry, config and parent nesting -- captured at save time and never
# touched again by anything that happens to the source project afterwards.
# There is deliberately no project_id column and no widget id anywhere in
# `widgets`: nesting is expressed as an index into the entry list itself (see
# capture_layout_widgets), so a layout stays fully usable after the project it
# came from is deleted. Applying a layout to a project (as opposed to saving
# or renaming one) is a client-side operation -- see project/main.js's
# loadLayout -- because it has to decide what happens to the destination
# project's existing permanent widgets, which no amount of data modelling
# here can express.


def capture_layout_widgets(project_id):
    """This project's widgets, in the portable shape a layout stores.

    Each entry carries what the widget looks like (type, x/y/w/h, locked,
    config) and where it sits in the nesting -- `parent`, the index of its
    parent *within this same list*, or None on the grid. That index is the
    only thing standing in for parent_id: it means nothing outside the list
    it was built from, which is exactly what makes the result independent of
    both this project and these widgets' real ids.
    """
    rows = list_widgets(project_id)
    index_by_id = {row["id"]: position for position, row in enumerate(rows)}
    return [
        {
            "type": row["type"],
            "x": row["x"],
            "y": row["y"],
            "w": row["w"],
            "h": row["h"],
            "locked": row["locked"],
            "config": row["config"],
            "parent": index_by_id.get(row["parent_id"]),
        }
        for row in rows
    ]


def _layout_to_dict(row):
    d = dict(row)
    d["widgets"] = json.loads(d["widgets"]) if d["widgets"] else []
    return d


def list_layouts():
    """Every saved layout, newest first."""
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM layouts ORDER BY date_created DESC").fetchall()
        return [_layout_to_dict(r) for r in rows]


def get_layout(layout_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM layouts WHERE id = ?", (layout_id,)).fetchone()
        return _layout_to_dict(row) if row else None


def create_layout(layout_id, name, project_id):
    """Save project_id's current widgets as a new named layout."""
    widgets = capture_layout_widgets(project_id)
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO layouts (id, name, widgets, date_created) VALUES (?, ?, ?, ?)""",
            (layout_id, name, json.dumps(widgets), datetime.now(timezone.utc).isoformat()),
        )


def update_layout(layout_id, name=None, project_id=None):
    """Rename a layout, re-capture its widgets from project_id, or both."""
    widgets = capture_layout_widgets(project_id) if project_id is not None else None
    with get_conn() as conn:
        if name is not None:
            conn.execute("UPDATE layouts SET name = ? WHERE id = ?", (name, layout_id))
        if widgets is not None:
            conn.execute(
                "UPDATE layouts SET widgets = ? WHERE id = ?",
                (json.dumps(widgets), layout_id),
            )


def delete_layout(layout_id):
    """Delete a layout. Nothing references it back -- a project that was
    built from this layout keeps its widgets exactly as they are."""
    with get_conn() as conn:
        conn.execute("DELETE FROM layouts WHERE id = ?", (layout_id,))


# --- Project spaces: canvas --------------------------------------------------

# The columns a PATCH may touch. project_id and id are absent on purpose: a node
# can't move between projects or change identity, only what it holds and where
# it sits. app.py filters incoming bodies against this same list, so the two
# can't drift apart.
CANVAS_NODE_PATCH_COLUMNS = (
    "kind", "reference_id", "x", "y", "w", "h", "locked", "content", "config", "z_index",
)

# An edge has exactly one mutable column: source_node_id/target_node_id are
# fixed at creation (reconnecting an edge means deleting and remaking it, not
# patching it), so this exists mainly to keep the same
# app.py-filters-against-this-list pattern CANVAS_NODE_PATCH_COLUMNS uses.
CANVAS_EDGE_PATCH_COLUMNS = ("style",)


def list_canvas_nodes(project_id):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM canvas_nodes WHERE project_id = ? ORDER BY z_index, id",
            (project_id,),
        ).fetchall()
        return [_canvas_node_to_dict(r) for r in rows]


def list_canvas_edges(project_id):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM canvas_edges WHERE project_id = ? ORDER BY id", (project_id,)
        ).fetchall()
        return [_canvas_edge_to_dict(r) for r in rows]


def get_canvas_node(node_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM canvas_nodes WHERE id = ?", (node_id,)).fetchone()
        return _canvas_node_to_dict(row) if row else None


def get_canvas_edge(edge_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM canvas_edges WHERE id = ?", (edge_id,)).fetchone()
        return _canvas_edge_to_dict(row) if row else None


def create_canvas_node(node_id, project_id, kind, reference_id=None, x=0.0, y=0.0,
                       w=None, h=None, locked=False, content=None, config=None,
                       z_index=0):
    with get_conn() as conn:
        _insert_canvas_node(
            conn, node_id, project_id, kind, reference_id, x, y, w, h, locked,
            content, config, z_index,
        )


def update_canvas_node(node_id, **fields):
    """Patch whichever of a node's columns were actually sent.

    A partial update, unlike the grid's bulk save, because the canvas persists
    every drag as it happens: a drag sends x and y, and must not overwrite the
    node's content with a stale copy it happened to be holding.
    """
    sets, params = [], []
    for column in CANVAS_NODE_PATCH_COLUMNS:
        if column not in fields:
            continue
        value = fields[column]
        if column == "locked":
            value = 1 if value else 0
        elif column == "config":
            value = json.dumps(value) if value is not None else None
        sets.append(f"{column} = ?")
        params.append(value)
    if not sets:
        return
    with get_conn() as conn:
        conn.execute(
            f"UPDATE canvas_nodes SET {', '.join(sets)} WHERE id = ?", [*params, node_id]
        )


def delete_canvas_node(node_id):
    """Delete a node and every edge that touched it -- an edge to nothing has
    no meaning, and would be drawn as a line into empty space."""
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM canvas_edges WHERE source_node_id = ? OR target_node_id = ?",
            (node_id, node_id),
        )
        conn.execute("DELETE FROM canvas_nodes WHERE id = ?", (node_id,))


def create_canvas_edge(edge_id, project_id, source_node_id, target_node_id, style=None):
    with get_conn() as conn:
        _insert_canvas_edge(conn, edge_id, project_id, source_node_id, target_node_id, style)


def update_canvas_edge(edge_id, **fields):
    """Patch whichever of an edge's columns were actually sent -- style only,
    today, but the shape mirrors update_canvas_node's so a future mutable
    column doesn't need a new function."""
    sets, params = [], []
    for column in CANVAS_EDGE_PATCH_COLUMNS:
        if column not in fields:
            continue
        value = fields[column]
        if column == "style":
            value = json.dumps(value) if value is not None else None
        sets.append(f"{column} = ?")
        params.append(value)
    if not sets:
        return
    with get_conn() as conn:
        conn.execute(
            f"UPDATE canvas_edges SET {', '.join(sets)} WHERE id = ?", [*params, edge_id]
        )


def delete_canvas_edge(edge_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM canvas_edges WHERE id = ?", (edge_id,))


def replace_canvas(project_id, nodes, edges):
    """Swap a project's whole canvas for a new one, in a single transaction.

    The bulk import/export path. Whole-canvas rather than a diff because the
    caller sends the complete state it wants to exist, and a half-applied
    canvas -- nodes replaced but old edges still pointing at gone nodes --
    would be worse than either outcome.
    """
    with get_conn() as conn:
        conn.execute("DELETE FROM canvas_edges WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM canvas_nodes WHERE project_id = ?", (project_id,))
        for node in nodes:
            _insert_canvas_node(
                conn,
                node["id"],
                project_id,
                node.get("kind"),
                node.get("reference_id"),
                node.get("x", 0.0),
                node.get("y", 0.0),
                node.get("w"),
                node.get("h"),
                node.get("locked"),
                node.get("content"),
                node.get("config"),
                node.get("z_index", 0),
            )
        for edge in edges:
            _insert_canvas_edge(
                conn,
                edge["id"],
                project_id,
                edge.get("source_node_id"),
                edge.get("target_node_id"),
                edge.get("style"),
            )


def _insert_canvas_node(conn, node_id, project_id, kind, reference_id, x, y, w, h,
                        locked, content, config, z_index):
    conn.execute(
        """INSERT INTO canvas_nodes
               (id, project_id, kind, reference_id, x, y, w, h, locked, content,
                config, z_index)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            node_id,
            project_id,
            kind,
            reference_id,
            x,
            y,
            w,
            h,
            1 if locked else 0,
            content,
            json.dumps(config) if config is not None else None,
            z_index or 0,
        ),
    )


def _insert_canvas_edge(conn, edge_id, project_id, source_node_id, target_node_id, style):
    conn.execute(
        """INSERT INTO canvas_edges
               (id, project_id, source_node_id, target_node_id, style)
           VALUES (?, ?, ?, ?, ?)""",
        (
            edge_id,
            project_id,
            source_node_id,
            target_node_id,
            json.dumps(style) if style is not None else None,
        ),
    )


def _canvas_node_to_dict(row):
    d = dict(row)
    d["config"] = json.loads(d["config"]) if d["config"] else None
    d["locked"] = bool(d["locked"])
    return d


def _canvas_edge_to_dict(row):
    d = dict(row)
    d["style"] = json.loads(d["style"]) if d["style"] else None
    return d
