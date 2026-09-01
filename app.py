"""Local web GUI for the fashion reference library.

A thin Flask layer over the existing db/ingest/embeddings/analyze modules --
no separate storage or logic, it just gives the CLI a browser front end:
drag-and-drop (or type-in-text) to add references, and a grid + carousel to
browse the archive with similar-item suggestions.

Run with:
    python app.py
then open the printed URL in a browser.
"""
import json
import mimetypes
import tempfile
import threading
import uuid
import webbrowser
from datetime import date, datetime, timedelta
from io import BytesIO
from pathlib import Path

import fitz  # PyMuPDF
from flask import Flask, abort, jsonify, request, send_file, send_from_directory

import analyze
import capture
import colour
import db
import embeddings
import graph_layout
import ics_import
import ingest
import scheduling
import style_gen
import task_ai
from config import ARCHIVE_API_TOKEN, REFERENCES_DIR

app = Flask(__name__, static_folder="static", static_url_path="")

PORT = 5050
PDF_THUMB_DPI = 72
# More than enough thumbnails to fill one row of the project preview bar on
# any reasonable screen width; the bar's CSS (nowrap + overflow hidden) clips
# whatever doesn't fit, so this only needs to be a generous upper bound.
PROJECT_BAR_PREVIEW_LIMIT = 30
# Deleted reference files are moved here (next to references/) instead of
# being unlinked, so deleting from the Archive stays recoverable on disk.
DELETED_DIR_NAME = "deleted"
# Shared by the archive and project graph routes so the two can't drift into
# telling the user to do different things about the same missing table.
NO_SIMILARITY_SCORES = "No similarity scores saved yet -- run Calculate Similarity Scores in Settings first."

# Widget types that can hold other widgets. Nesting is one level deep by
# design, so this set does double duty: it's both what may be a parent and what
# may never be a child.
CONTAINER_WIDGET_TYPES = {"sidebar"}
# Widgets the project page can't do without. They can be moved anywhere the
# user likes, but DELETE on one is refused rather than silently ignored -- a
# 400 tells the UI its Add Widget list is out of step, where a 200 would leave
# a phantom deletion on screen until the next reload.
PERMANENT_WIDGET_TYPES = {"settings", "exit", "canvas"}
# What a canvas node can be. See db.CANVAS_NODES_SCHEMA for why all three
# share one table.
CANVAS_NODE_KINDS = {"reference", "text", "widget"}

# In-memory only -- an analysis conversation is a live chat with Claude, not
# library data, so it doesn't belong in SQLite and doesn't need to survive a
# server restart. Keyed by analysis_id -> the running message history.
_analysis_sessions = {}


# --- Browser extension access ---------------------------------------------
#
# The extension runs on a chrome-extension:// origin, so its calls are
# cross-origin and need CORS headers the rest of the app has never needed.
# Kept deliberately narrow rather than reaching for flask-cors: only requests
# that actually come from an extension, and only on /api/ paths, get any
# Access-Control headers at all. The static file routes and the local web UI
# behave exactly as before.

EXTENSION_ORIGIN_PREFIX = "chrome-extension://"
# Firefox uses its own scheme; listed now so the port is a manifest change
# rather than a backend one.
EXTENSION_ORIGIN_PREFIXES = (EXTENSION_ORIGIN_PREFIX, "moz-extension://")


def _extension_origin():
    """The requesting extension's origin, or None if this isn't one."""
    origin = request.headers.get("Origin", "")
    return origin if origin.startswith(EXTENSION_ORIGIN_PREFIXES) else None


def _capture_auth_ok():
    """True unless a token is configured and the request didn't present it."""
    if not ARCHIVE_API_TOKEN:
        return True
    header = request.headers.get("Authorization", "")
    return header == f"Bearer {ARCHIVE_API_TOKEN}"


@app.after_request
def _allow_extension_origin(response):
    origin = _extension_origin()
    if origin and request.path.startswith("/api/"):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Vary"] = "Origin"
    return response


@app.route("/api/<path:_subpath>", methods=["OPTIONS"])
def _api_preflight(_subpath):
    """Answer CORS preflights. The headers themselves come from the
    after_request hook above, so this only needs to not 405."""
    return ("", 204)


def _resolve_ref_path(ref):
    return REFERENCES_DIR / ref["filepath"]


def _ref_summary(ref, match_label=None):
    summary = {
        "id": ref["id"],
        "title": ref["title"],
        "type": ref["type"],
        "tags": ref["tags"],
        "description": ref["description"],
        "ext": Path(ref["filepath"]).suffix.lower(),
        "is_own_work": ref["is_own_work"],
    }
    if match_label:
        summary["match_label"] = match_label
    return summary


def _require_project(project_id):
    """404 unless this project exists -- every project-space route hangs off
    one, and none of them mean anything without it."""
    if not db.get_project(project_id):
        abort(404)


def _find_reference(ref_id):
    ref = db.get_reference(ref_id)
    if ref:
        return ref
    matches = db.find_by_id_prefix(ref_id)
    return matches[0] if len(matches) == 1 else None


def _file_kind(ext):
    """Bucket an extension into the three type filters the GUI offers."""
    if ext in ingest.IMAGE_EXTS:
        return "image"
    if ext == ".pdf":
        return "pdf"
    return "text"


@app.get("/")
def index():
    # The 3D similarity graph is the homepage; the library app itself is
    # still reachable (static serving already exposes every file under
    # static/ at its own path, so /index.html works with no extra route).
    return send_from_directory(app.static_folder, "graph.html")


@app.get("/api/references")
def api_list_references():
    """List references, optionally ranked/filtered by a search query and/or
    filtered by ownership and file type -- backs both the plain archive grid
    and the search bar on the Archive page.

    When a query is given, `search_by` (comma-separated: distance, tags,
    description) picks which of those three signals count as a match; a
    reference is included if ANY selected signal matches (OR), but results
    stay ordered by semantic relevance throughout, since that ranking is
    computed for the whole library regardless of which signals are active.
    """
    query = (request.args.get("q") or "").strip()
    own_work = request.args.get("own_work", "any")  # any | only | exclude
    # Comma-separated, e.g. "image,pdf" -- checking multiple type boxes is an OR filter.
    file_types = {t for t in request.args.get("type", "").split(",") if t}
    search_by = {s for s in request.args.get("search_by", "distance").split(",") if s}

    if query:
        model = embeddings.get_model()
        query_embedding = model.encode(query).tolist()
        total = embeddings.get_collection().count()
        results = embeddings.query_index(query_embedding, n_results=max(total, 1)) if total else []

        q_lower = query.lower()
        refs = []
        for m in results:
            ref = db.get_reference(m["id"])
            if not ref:
                continue
            z_score = m["relative_score"]
            matched = (
                ("distance" in search_by and embeddings.match_label(z_score) != "loose / weak match")
                or ("tags" in search_by and q_lower in ", ".join(ref["tags"]).lower())
                or ("description" in search_by and q_lower in (ref["description"] or "").lower())
            )
            if matched:
                refs.append(_ref_summary(ref, match_label=embeddings.match_label(z_score)))
    else:
        refs = [_ref_summary(r) for r in db.list_references()]

    if own_work == "only":
        refs = [r for r in refs if r["is_own_work"]]
    elif own_work == "exclude":
        refs = [r for r in refs if not r["is_own_work"]]

    if file_types:
        refs = [r for r in refs if _file_kind(r["ext"]) in file_types]

    return jsonify(refs)


@app.get("/api/references/<ref_id>")
def api_get_reference(ref_id):
    ref = _find_reference(ref_id)
    if not ref:
        abort(404)

    similar = []
    collection = embeddings.get_collection()
    embedded = collection.get(ids=[ref["id"]], include=["embeddings"])
    if embedded["ids"]:
        for m in embeddings.query_index(embedded["embeddings"][0], n_results=6, exclude_ids=[ref["id"]]):
            similar.append({"id": m["id"], **m["metadata"]})

    data = dict(ref)
    data["ext"] = Path(ref["filepath"]).suffix.lower()
    data["similar"] = similar
    return jsonify(data)


@app.delete("/api/references/<ref_id>")
def api_delete_reference(ref_id):
    """Delete a reference outright: its stored file, its embedding, and its
    row (plus any project memberships and similarity scores that referred to
    it). This is the Archive page's Delete action -- unlike the project
    page's Delete, which only removes a reference from that project.

    The file goes to a `.deleted` folder beside the library rather than being
    unlinked, so a mis-click stays recoverable from disk even though the
    metadata is gone.
    """
    ref = _find_reference(ref_id)
    if not ref:
        abort(404)

    path = _resolve_ref_path(ref)
    if path.exists():
        trash_dir = REFERENCES_DIR.parent / DELETED_DIR_NAME
        trash_dir.mkdir(parents=True, exist_ok=True)
        destination = trash_dir / path.name
        if destination.exists():
            destination = trash_dir / f"{path.stem}-{uuid.uuid4().hex[:8]}{path.suffix}"
        path.rename(destination)

    embeddings.remove_from_index(ref["id"])
    db.delete_reference(ref["id"])
    return jsonify({"ok": True, "id": ref["id"]})


def _project_summary(project, preview_limit=PROJECT_BAR_PREVIEW_LIMIT):
    preview = db.list_project_references(project["id"], limit=preview_limit)
    return {
        "id": project["id"],
        "title": project["title"],
        "description": project["description"],
        "reference_count": db.count_project_references(project["id"]),
        "preview": [_ref_summary(r) for r in preview],
    }


@app.get("/api/projects")
def api_list_projects():
    return jsonify([_project_summary(p) for p in db.list_projects()])


@app.post("/api/projects")
def api_create_project():
    body = request.get_json(force=True, silent=True) or {}
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"error": "a title is required"}), 400
    description = (body.get("description") or "").strip() or None

    project_id = str(uuid.uuid4())
    db.create_project(project_id, title, description)
    # A project space is part of what a project is, not something the user opts
    # into later, so a new project arrives with its six folders and its
    # starting widgets already in place.
    db.seed_project_defaults(project_id)
    return jsonify(db.get_project(project_id))


@app.get("/api/projects/<project_id>")
def api_get_project(project_id):
    project = db.get_project(project_id)
    if not project:
        abort(404)
    refs = [_ref_summary(r) for r in db.list_project_references(project_id)]
    data = dict(project)
    data["references"] = refs
    return jsonify(data)


@app.put("/api/projects/<project_id>")
def api_update_project(project_id):
    if not db.get_project(project_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"error": "a title is required"}), 400
    description = (body.get("description") or "").strip() or None
    db.update_project(project_id, title, description)
    return jsonify(db.get_project(project_id))


@app.delete("/api/projects/<project_id>")
def api_delete_project(project_id):
    """Delete a project (and its saved analyses). The references it grouped
    stay in the archive -- only the grouping goes."""
    if not db.get_project(project_id):
        abort(404)
    db.delete_project(project_id)
    return jsonify({"ok": True, "id": project_id})


@app.post("/api/projects/<project_id>/references")
def api_add_project_reference(project_id):
    if not db.get_project(project_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    reference_id = body.get("reference_id")
    ref = _find_reference(reference_id) if reference_id else None
    if not ref:
        return jsonify({"error": "reference not found"}), 404
    db.add_reference_to_project(project_id, ref["id"])
    return jsonify({"ok": True})


@app.delete("/api/projects/<project_id>/references/<reference_id>")
def api_remove_project_reference(project_id, reference_id):
    if not db.get_project(project_id):
        abort(404)
    db.remove_reference_from_project(project_id, reference_id)
    return jsonify({"ok": True})


# --- Project space: folders -------------------------------------------------
#
# A folder is a view over its project's references, never an owner of them.
# Filing and unfiling only ever writes folder_references, so nothing here can
# remove a reference from the project or from the archive.


@app.get("/api/projects/<project_id>/folders")
def api_list_folders(project_id):
    _require_project(project_id)
    return jsonify(db.list_folders(project_id))


@app.post("/api/projects/<project_id>/folders")
def api_create_folder(project_id):
    _require_project(project_id)
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "a name is required"}), 400
    # Duplicate names are allowed: the Archive rolls folders up by name across
    # projects, so two projects both having a "Texture" is the normal case, and
    # within one project the user may have their own reason.
    folder_id = str(uuid.uuid4())
    db.create_folder(folder_id, project_id, name)
    return jsonify(db.get_folder(folder_id))


@app.get("/api/folders/rollup")
def api_folder_rollup():
    """Folder names rolled up across every project, for the Archive's
    cross-project folder strip. A computed view, not a stored one -- see
    db.list_folder_rollup."""
    return jsonify(db.list_folder_rollup())


@app.get("/api/folders/rollup/<name>/references")
def api_folder_rollup_references(name):
    """Every reference filed under this folder name in any project,
    de-duplicated -- backs the Archive grid when a roll-up is selected."""
    return jsonify([_ref_summary(r) for r in db.list_folder_rollup_references(name)])


@app.get("/api/folders/<folder_id>")
def api_get_folder(folder_id):
    folder = db.get_folder(folder_id)
    if not folder:
        abort(404)
    return jsonify(folder)


@app.put("/api/folders/<folder_id>")
def api_update_folder(folder_id):
    """Rename or reorder a folder.

    is_default is deliberately not writable: it records that the folder came
    from the default set, and renaming or moving it doesn't change where it
    came from.
    """
    if not db.get_folder(folder_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}

    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "a name is required"}), 400
        db.rename_folder(folder_id, name)

    if "position" in body:
        try:
            position = int(body["position"])
        except (TypeError, ValueError):
            return jsonify({"error": "position must be a whole number"}), 400
        db.move_folder(folder_id, position)

    return jsonify(db.get_folder(folder_id))


@app.delete("/api/folders/<folder_id>")
def api_delete_folder(folder_id):
    """Delete a folder, default ones included -- is_default is a record of
    origin, not a protection flag. What was filed in it stays in the project."""
    if not db.get_folder(folder_id):
        abort(404)
    db.delete_folder(folder_id)
    return jsonify({"ok": True, "id": folder_id})


@app.get("/api/folders/<folder_id>/references")
def api_list_folder_references(folder_id):
    if not db.get_folder(folder_id):
        abort(404)
    return jsonify([_ref_summary(r) for r in db.list_folder_references(folder_id)])


@app.post("/api/folders/<folder_id>/references")
def api_add_folder_references(folder_id):
    """File references into a folder, one or many.

    Anything not already in the folder's project is added to it as well: a
    folder shows a slice of its project, so a reference filed in the folder but
    absent from the project would appear in the sidebar and nowhere on the
    project page it belongs to.
    """
    folder = db.get_folder(folder_id)
    if not folder:
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    requested = body.get("reference_ids") or []
    if not requested:
        return jsonify({"error": "no references given"}), 400

    # Resolved through _find_reference so short ids work here as everywhere else.
    resolved = []
    for reference_id in requested:
        ref = _find_reference(reference_id)
        if ref:
            resolved.append(ref["id"])
    if not resolved:
        return jsonify({"error": "none of those references exist"}), 404

    for reference_id in resolved:
        db.add_reference_to_project(folder["project_id"], reference_id)
    db.add_references_to_folder(folder_id, resolved)
    return jsonify({"ok": True, "added": len(resolved), "reference_ids": resolved})


@app.delete("/api/folders/<folder_id>/references/<reference_id>")
def api_remove_folder_reference(folder_id, reference_id):
    """Unfile one reference. It keeps its place in the project, in the archive,
    and in every other folder it was filed in."""
    if not db.get_folder(folder_id):
        abort(404)
    db.remove_reference_from_folder(folder_id, reference_id)
    return jsonify({"ok": True})


# --- Project space: widgets -------------------------------------------------


def _widget_states(project_id):
    """{widget id: (type, parent_id)} for one project -- what the nesting rules
    are checked against."""
    return {w["id"]: (w["type"], w["parent_id"]) for w in db.list_widgets(project_id)}


def _nesting_error(widget_type, parent_id, states):
    """Why this widget can't sit inside that parent, or None if it can.

    `states` describes the widgets as they will be once the request is applied,
    not as they are on disk, so a bulk layout save is judged against its own
    outcome rather than the rows it is about to overwrite.
    """
    if not parent_id:
        return None  # on the grid, which is always allowed
    parent = states.get(parent_id)
    if not parent:
        return "that parent widget isn't in this project"
    parent_type, parent_parent_id = parent
    if parent_parent_id:
        return "widgets nest one level deep: that parent is itself inside a container"
    if parent_type not in CONTAINER_WIDGET_TYPES:
        return f"a '{parent_type}' widget cannot contain other widgets"
    if widget_type in CONTAINER_WIDGET_TYPES:
        return f"a '{widget_type}' is a container and cannot go inside another container"
    return None


def _layout_nesting_error(project_id, entries):
    """Check a whole proposed layout, since a bulk save can re-parent several
    widgets at once and each has to be legal in the layout's final state."""
    existing = {w["id"]: w for w in db.list_widgets(project_id)}
    states = {wid: (w["type"], w["parent_id"]) for wid, w in existing.items()}
    for entry in entries:
        widget_id = entry.get("id")
        if widget_id in existing:
            # Type isn't the layout editor's to change, so it comes from the row.
            states[widget_id] = (existing[widget_id]["type"], entry.get("parent_id") or None)
    # Every widget, not just the ones in the payload: re-parenting a container
    # pushes whatever was already inside it a level too deep.
    for widget_type, parent_id in states.values():
        error = _nesting_error(widget_type, parent_id, states)
        if error:
            return error
    return None


@app.get("/api/projects/<project_id>/widgets")
def api_list_widgets(project_id):
    _require_project(project_id)
    return jsonify(db.list_widgets(project_id))


@app.post("/api/projects/<project_id>/widgets")
def api_create_widget(project_id):
    _require_project(project_id)
    body = request.get_json(force=True, silent=True) or {}
    widget_type = (body.get("type") or "").strip()
    if not widget_type:
        return jsonify({"error": "a widget type is required"}), 400

    parent_id = body.get("parent_id") or None
    error = _nesting_error(widget_type, parent_id, _widget_states(project_id))
    if error:
        return jsonify({"error": error}), 400

    widget_id = str(uuid.uuid4())
    db.create_widget(
        widget_id,
        project_id,
        widget_type,
        parent_id=parent_id,
        x=body.get("x", 0),
        y=body.get("y", 0),
        w=body.get("w", 1),
        h=body.get("h", 1),
        config=body.get("config"),
        locked=bool(body.get("locked")),
    )
    return jsonify(db.get_widget(widget_id))


@app.put("/api/projects/<project_id>/widgets")
def api_save_widget_layout(project_id):
    """The homepage grid's explicit Save: one bulk commit of the whole layout.

    Layout only, and all-or-nothing on the nesting rules -- a partly applied
    layout is a scrambled homepage, which is worse than a rejected save.
    """
    _require_project(project_id)
    body = request.get_json(force=True, silent=True) or {}
    entries = body.get("widgets")
    if not isinstance(entries, list):
        return jsonify({"error": "widgets must be a list"}), 400

    error = _layout_nesting_error(project_id, entries)
    if error:
        return jsonify({"error": error}), 400

    db.save_widget_layout(project_id, entries)
    return jsonify(db.list_widgets(project_id))


@app.delete("/api/widgets/<widget_id>")
def api_delete_widget(widget_id):
    """Delete a widget, and whatever was inside it if it was a container."""
    widget = db.get_widget(widget_id)
    if not widget:
        abort(404)
    if widget["type"] in PERMANENT_WIDGET_TYPES:
        return jsonify({
            "error": f"the {widget['type']} widget can be moved but not removed"
        }), 400
    db.delete_widget(widget_id)
    return jsonify({"ok": True, "id": widget_id})


# --- Project space: settings ------------------------------------------------


@app.get("/api/projects/<project_id>/settings")
def api_get_project_settings(project_id):
    _require_project(project_id)
    return jsonify({"settings": db.get_project_settings(project_id)})


@app.put("/api/projects/<project_id>/settings")
def api_save_project_settings(project_id):
    _require_project(project_id)
    body = request.get_json(force=True, silent=True) or {}
    settings = body.get("settings")
    if not isinstance(settings, dict):
        return jsonify({"error": "settings must be an object"}), 400
    db.save_project_settings(project_id, settings)
    return jsonify({"settings": db.get_project_settings(project_id)})


# --- Styles: saved appearance presets, global ---------------------------------
#
# A style is a named copy of a project_settings blob, reusable across
# projects. There is deliberately no id linking a project back to the style
# it was applied from -- applying one just writes its settings into that
# project's own project_settings row, so deleting the style afterwards can
# never change a project that used it.


@app.get("/api/styles")
def api_list_styles():
    return jsonify(db.list_styles())


@app.post("/api/styles")
def api_create_style():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "a name is required"}), 400
    settings = body.get("settings")
    if not isinstance(settings, dict):
        return jsonify({"error": "settings must be an object"}), 400
    style_id = str(uuid.uuid4())
    db.create_style(style_id, name, settings)
    return jsonify(db.get_style(style_id))


@app.put("/api/styles/<style_id>")
def api_update_style(style_id):
    if not db.get_style(style_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    name = None
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "a name is required"}), 400
    settings = None
    if "settings" in body:
        settings = body.get("settings")
        if not isinstance(settings, dict):
            return jsonify({"error": "settings must be an object"}), 400
    db.update_style(style_id, name=name, settings=settings)
    return jsonify(db.get_style(style_id))


@app.delete("/api/styles/<style_id>")
def api_delete_style(style_id):
    if not db.get_style(style_id):
        abort(404)
    db.delete_style(style_id)
    return jsonify({"ok": True, "id": style_id})


# --- Palettes: saved colour palettes, global -----------------------------------
#
# A palette is a named copy of a colour.py profile -- generated on a project's
# All References or folder page, or the archive-wide colour map, and kept here
# so it can be reused without re-running the colour search that built it.
# style_gen.py is the only thing that reads a saved palette's profile back.


@app.get("/api/palettes")
def api_list_palettes():
    return jsonify(db.list_palettes())


@app.post("/api/palettes")
def api_create_palette():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "a name is required"}), 400
    profile = body.get("profile")
    if not isinstance(profile, dict) or not profile.get("palette"):
        return jsonify({"error": "profile must be a colour profile with a palette"}), 400
    source = body.get("source")
    source = source if isinstance(source, str) else None
    palette_id = str(uuid.uuid4())
    db.create_palette(palette_id, name, profile, source)
    return jsonify(db.get_palette(palette_id))


@app.delete("/api/palettes/<palette_id>")
def api_delete_palette(palette_id):
    if not db.get_palette(palette_id):
        abort(404)
    db.delete_palette(palette_id)
    return jsonify({"ok": True, "id": palette_id})


@app.get("/api/palettes/<palette_id>/style")
def api_generate_style_from_palette(palette_id):
    """A project settings dict generated from a saved palette -- see
    style_gen.py. Computed fresh on every call rather than stored: it's cheap
    (a handful of contrast checks over at most a few palette colours) and the
    caller is always about to preview it, never polling for it.
    """
    palette = db.get_palette(palette_id)
    if not palette:
        abort(404)
    try:
        return jsonify(style_gen.generate_style(palette["profile"]))
    except ValueError as err:
        return jsonify({"error": str(err)}), 400


# --- Layouts: saved widget arrangements, global -------------------------------
#
# A layout is a named, portable snapshot of one project's widgets (db.py's
# capture_layout_widgets), reusable across projects the same way a style is.
# Unlike a style, creating or refreshing one takes a project_id rather than
# the data itself -- the client has no easy way to build the portable,
# index-based nesting a layout stores, so the server reads the project fresh
# and captures it. Applying a saved layout to a project is not a route here at
# all: it has to reconcile the destination project's existing permanent
# widgets, which is main.js's job (loadLayout), done entirely through the
# ordinary widget routes above.


@app.get("/api/layouts")
def api_list_layouts():
    return jsonify(db.list_layouts())


@app.get("/api/layouts/default")
def api_default_layout():
    """The baked-in DEFAULT_WIDGETS, in the same shape a saved layout's
    `widgets` field has -- not a row in the table, exactly as "Default" is not
    a row in styles, but the layout picker still needs the actual data to
    apply, unlike style's "Default" which just clears to {}."""
    return jsonify({"widgets": list(db.DEFAULT_WIDGETS)})


@app.post("/api/layouts")
def api_create_layout():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "a name is required"}), 400
    project_id = body.get("project_id")
    if not project_id:
        return jsonify({"error": "a project_id is required"}), 400
    _require_project(project_id)
    layout_id = str(uuid.uuid4())
    db.create_layout(layout_id, name, project_id)
    return jsonify(db.get_layout(layout_id))


@app.put("/api/layouts/<layout_id>")
def api_update_layout(layout_id):
    if not db.get_layout(layout_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    name = None
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "a name is required"}), 400
    project_id = body.get("project_id")
    if project_id is not None:
        _require_project(project_id)
    db.update_layout(layout_id, name=name, project_id=project_id)
    return jsonify(db.get_layout(layout_id))


@app.delete("/api/layouts/<layout_id>")
def api_delete_layout(layout_id):
    if not db.get_layout(layout_id):
        abort(404)
    db.delete_layout(layout_id)
    return jsonify({"ok": True, "id": layout_id})


# --- Project space: canvas --------------------------------------------------
#
# Positions here are canvas world coordinates. The per-node routes are what the
# canvas actually edits through -- it saves continuously, so a drag PATCHes one
# node rather than resending everything.


def _canvas_payload(project_id):
    return {
        "nodes": db.list_canvas_nodes(project_id),
        "edges": db.list_canvas_edges(project_id),
    }


@app.get("/api/projects/<project_id>/canvas")
def api_get_canvas(project_id):
    _require_project(project_id)
    return jsonify(_canvas_payload(project_id))


@app.put("/api/projects/<project_id>/canvas")
def api_replace_canvas(project_id):
    """Replace the whole canvas at once.

    Edges are validated against the nodes in the same payload rather than
    against what's already stored, because by the time this is applied the old
    nodes are gone -- an edge that referred to one would be a line to nowhere.
    """
    _require_project(project_id)
    body = request.get_json(force=True, silent=True) or {}
    nodes, edges = body.get("nodes"), body.get("edges") or []
    if not isinstance(nodes, list) or not isinstance(edges, list):
        return jsonify({"error": "nodes and edges must be lists"}), 400

    # Ids may be supplied (a round-trip of an existing canvas) or left out (an
    # import of new content); either way every row needs one.
    nodes = [{**n, "id": n.get("id") or str(uuid.uuid4())} for n in nodes]
    for node in nodes:
        if node.get("kind") not in CANVAS_NODE_KINDS:
            return jsonify({"error": f"unknown node kind: {node.get('kind')!r}"}), 400

    node_ids = {n["id"] for n in nodes}
    edges = [{**e, "id": e.get("id") or str(uuid.uuid4())} for e in edges]
    for edge in edges:
        ends = (edge.get("source_node_id"), edge.get("target_node_id"))
        if any(end not in node_ids for end in ends):
            return jsonify({"error": "every edge must join two nodes in this canvas"}), 400

    db.replace_canvas(project_id, nodes, edges)
    return jsonify(_canvas_payload(project_id))


@app.post("/api/projects/<project_id>/canvas/nodes")
def api_create_canvas_node(project_id):
    _require_project(project_id)
    body = request.get_json(force=True, silent=True) or {}
    kind = body.get("kind")
    if kind not in CANVAS_NODE_KINDS:
        return jsonify({"error": f"kind must be one of {', '.join(sorted(CANVAS_NODE_KINDS))}"}), 400

    reference_id = body.get("reference_id")
    if kind == "reference":
        ref = _find_reference(reference_id) if reference_id else None
        if not ref:
            return jsonify({"error": "reference not found"}), 404
        reference_id = ref["id"]

    node_id = str(uuid.uuid4())
    db.create_canvas_node(
        node_id,
        project_id,
        kind,
        reference_id=reference_id,
        x=body.get("x", 0.0),
        y=body.get("y", 0.0),
        w=body.get("w"),
        h=body.get("h"),
        locked=bool(body.get("locked")),
        content=body.get("content"),
        config=body.get("config"),
        z_index=body.get("z_index", 0),
    )
    return jsonify(db.get_canvas_node(node_id))


@app.patch("/api/canvas/nodes/<node_id>")
def api_update_canvas_node(node_id):
    """Update only the fields that were sent -- most calls are a drag, and
    carry nothing but x and y."""
    if not db.get_canvas_node(node_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    fields = {k: v for k, v in body.items() if k in db.CANVAS_NODE_PATCH_COLUMNS}
    if "kind" in fields and fields["kind"] not in CANVAS_NODE_KINDS:
        return jsonify({"error": f"unknown node kind: {fields['kind']!r}"}), 400
    db.update_canvas_node(node_id, **fields)
    return jsonify(db.get_canvas_node(node_id))


@app.delete("/api/canvas/nodes/<node_id>")
def api_delete_canvas_node(node_id):
    if not db.get_canvas_node(node_id):
        abort(404)
    db.delete_canvas_node(node_id)
    return jsonify({"ok": True, "id": node_id})


@app.post("/api/projects/<project_id>/canvas/edges")
def api_create_canvas_edge(project_id):
    _require_project(project_id)
    body = request.get_json(force=True, silent=True) or {}
    source_node_id = body.get("source_node_id")
    target_node_id = body.get("target_node_id")

    node_ids = {n["id"] for n in db.list_canvas_nodes(project_id)}
    if source_node_id not in node_ids or target_node_id not in node_ids:
        return jsonify({"error": "both ends must be nodes on this project's canvas"}), 400

    edge_id = str(uuid.uuid4())
    db.create_canvas_edge(
        edge_id, project_id, source_node_id, target_node_id, style=body.get("style")
    )
    return jsonify(db.get_canvas_edge(edge_id))


@app.patch("/api/canvas/edges/<edge_id>")
def api_update_canvas_edge(edge_id):
    """Update an edge's style -- the connections panel's colour, arrowhead
    and shape controls. Mirrors api_update_canvas_node."""
    if not db.get_canvas_edge(edge_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    fields = {k: v for k, v in body.items() if k in db.CANVAS_EDGE_PATCH_COLUMNS}
    db.update_canvas_edge(edge_id, **fields)
    return jsonify(db.get_canvas_edge(edge_id))


@app.delete("/api/canvas/edges/<edge_id>")
def api_delete_canvas_edge(edge_id):
    if not db.get_canvas_edge(edge_id):
        abort(404)
    db.delete_canvas_edge(edge_id)
    return jsonify({"ok": True, "id": edge_id})


@app.post("/api/analyze")
def api_analyze():
    """Start an analysis conversation over a chosen set of references (the
    same underlying feature as `cli.py analyze`, just driven from the GUI's
    selection toolbar instead of ids typed on a command line).
    """
    body = request.get_json(force=True, silent=True) or {}
    reference_ids = body.get("reference_ids") or []
    mode = body.get("mode") if body.get("mode") in ("full", "summary") else "full"
    if not reference_ids:
        return jsonify({"error": "no references selected"}), 400
    try:
        writeup, messages, reference_map = analyze.start_conversation(reference_ids, mode=mode)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    analysis_id = str(uuid.uuid4())
    _analysis_sessions[analysis_id] = messages
    return jsonify({"analysis_id": analysis_id, "writeup": writeup, "references": reference_map})


@app.post("/api/analyze/<analysis_id>/reply")
def api_analyze_reply(analysis_id):
    messages = _analysis_sessions.get(analysis_id)
    if messages is None:
        return jsonify({"error": "this analysis session is gone (the server may have restarted)"}), 404
    body = request.get_json(force=True, silent=True) or {}
    message = (body.get("message") or "").strip()
    if not message:
        return jsonify({"error": "empty message"}), 400
    try:
        reply = analyze.continue_conversation(messages, message)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"reply": reply})


def _analysis_summary(a):
    refs = db.get_references_by_ids(a["reference_ids"])
    return {
        "id": a["id"],
        "date_created": a["date_created"],
        "reference_count": len(a["reference_ids"]),
        "preview": [_ref_summary(r) for r in refs[:6]],
    }


@app.put("/api/analyses/<analysis_id>")
def api_save_analysis(analysis_id):
    """Persist the current state of an analysis conversation, keyed by the
    same analysis_id the live session already has -- saving again later in
    the same conversation just refreshes the snapshot instead of
    duplicating it.
    """
    body = request.get_json(force=True, silent=True) or {}
    project_id = body.get("project_id")
    reference_ids = body.get("reference_ids") or []
    transcript = body.get("transcript") or []
    if not project_id or not db.get_project(project_id):
        return jsonify({"error": "project not found"}), 404
    if not reference_ids or not transcript:
        return jsonify({"error": "nothing to save yet"}), 400
    db.save_analysis(analysis_id, project_id, reference_ids, transcript)
    return jsonify({"ok": True})


@app.get("/api/projects/<project_id>/analyses")
def api_list_project_analyses(project_id):
    if not db.get_project(project_id):
        abort(404)
    return jsonify([_analysis_summary(a) for a in db.list_analyses_for_project(project_id)])


@app.get("/api/analyses/<analysis_id>")
def api_get_analysis(analysis_id):
    a = db.get_analysis(analysis_id)
    if not a:
        abort(404)
    refs = db.get_references_by_ids(a["reference_ids"])
    data = dict(a)
    data["references"] = [_ref_summary(r) for r in refs]
    return jsonify(data)


@app.get("/api/similarity/estimate")
def api_similarity_estimate():
    """Status/estimate for the Settings page: how many references and pairs
    are involved, what's already saved, and the cost of running it. Pairwise
    similarity is computed from embeddings every reference already has --
    pure local vector math, so this is always free.
    """
    reference_count = len(db.list_references())
    pair_count = reference_count * (reference_count - 1) // 2
    saved_count, last_computed_at = db.get_similarity_scores_meta()
    return jsonify(
        {
            "reference_count": reference_count,
            "pair_count": pair_count,
            "estimated_cost_usd": 0.0,
            "saved_count": saved_count,
            "last_computed_at": last_computed_at,
        }
    )


@app.post("/api/similarity/calculate")
def api_similarity_calculate():
    pairs = embeddings.compute_all_pairwise_similarities()
    db.save_similarity_scores(pairs)
    return jsonify({"pair_count": len(pairs), "reference_count": len(db.list_references())})


@app.get("/api/similarity")
def api_similarity_list():
    """Every stored pairwise score, raw -- mainly for the /graph.html page,
    which computes its own layout server-side via graph_layout.py instead.
    """
    return jsonify(db.list_similarity_scores())


@app.get("/api/similarity/graph")
def api_similarity_graph():
    if not db.list_similarity_scores():
        return jsonify({"error": NO_SIMILARITY_SCORES}), 400
    return jsonify(graph_layout.build_graph())


@app.get("/api/projects/<project_id>/similarity/graph")
def api_project_similarity_graph(project_id):
    """The same graph as /api/similarity/graph, over one project's own
    references -- clustered among themselves, and threaded only by the scores
    whose both endpoints are in the project.

    The scores are archive-wide, so the emptiness check is too: a project
    can't have its own scores to be missing, and the fix is the same
    archive-wide Calculate Similarity Scores run either way.
    """
    _require_project(project_id)
    if not db.list_similarity_scores():
        return jsonify({"error": NO_SIMILARITY_SCORES}), 400
    ids = [r["id"] for r in db.list_project_references(project_id)]
    return jsonify(graph_layout.build_graph(reference_ids=ids))


@app.get("/api/similarity/constellation")
def api_similarity_constellation():
    """Every reference placed by CLIP similarity alone, via the force-directed
    layout in graph_layout.build_constellation() -- a third archive-wide 3D
    view, alongside the cluster-plane graph above and the colour cylinder
    below. Same emptiness check as /api/similarity/graph: both read the same
    similarity_scores table.
    """
    if not db.list_similarity_scores():
        return jsonify({"error": NO_SIMILARITY_SCORES}), 400
    return jsonify(_constellation_response(graph_layout.build_constellation()))


@app.get("/api/projects/<project_id>/similarity/constellation")
def api_project_similarity_constellation(project_id):
    """The same map as /api/similarity/constellation, over one project's own
    references -- see api_project_similarity_graph on why the emptiness check
    stays archive-wide."""
    _require_project(project_id)
    if not db.list_similarity_scores():
        return jsonify({"error": NO_SIMILARITY_SCORES}), 400
    ids = [r["id"] for r in db.list_project_references(project_id)]
    return jsonify(_constellation_response(graph_layout.build_constellation(reference_ids=ids)))


def _constellation_response(layout):
    refs = {r["id"]: r for r in db.get_references_by_ids([n["id"] for n in layout["nodes"]])}
    nodes = []
    for node in layout["nodes"]:
        ref = refs.get(node["id"])
        if not ref:
            continue  # deleted between layout and now
        nodes.append({
            **_ref_summary(ref),
            "cluster": node["cluster"],
            "color": node["color"],
            "x": node["x"], "y": node["y"], "z": node["z"],
        })

    return {
        "nodes": nodes,
        "edges": layout["edges"],
        "cluster_count": layout["cluster_count"],
        "stress": layout["stress"],
        "neighbour_retention": layout["neighbour_retention"],
    }


@app.get("/media/<ref_id>")
def media(ref_id):
    ref = _find_reference(ref_id)
    if not ref:
        abort(404)
    path = _resolve_ref_path(ref)
    if not path.exists():
        abort(404)
    mime, _ = mimetypes.guess_type(str(path))
    return send_file(path, mimetype=mime or "application/octet-stream")


@app.get("/media/<ref_id>/thumb")
def media_thumb(ref_id):
    ref = _find_reference(ref_id)
    if not ref:
        abort(404)
    path = _resolve_ref_path(ref)
    if not path.exists():
        abort(404)
    ext = path.suffix.lower()

    if ext in ingest.IMAGE_EXTS:
        mime, _ = mimetypes.guess_type(str(path))
        return send_file(path, mimetype=mime or "image/jpeg")

    if ext == ".pdf":
        try:
            doc = fitz.open(path)
            pix = doc[0].get_pixmap(dpi=PDF_THUMB_DPI)
            doc.close()
            return send_file(BytesIO(pix.tobytes("png")), mimetype="image/png")
        except Exception:
            abort(404)

    abort(404)  # plain text references have no image thumbnail


@app.post("/api/add-file")
def api_add_file():
    if "file" not in request.files:
        return jsonify({"error": "no file uploaded"}), 400
    upload = request.files["file"]
    title = request.form.get("title") or Path(upload.filename).stem
    source = request.form.get("source") or None
    notes = request.form.get("notes") or None
    is_own_work = request.form.get("own_work") == "true"

    suffix = Path(upload.filename).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        upload.save(tmp.name)
        tmp_path = Path(tmp.name)

    try:
        result = ingest.add_reference(tmp_path, title=title, source=source, notes=notes, is_own_work=is_own_work)
        return jsonify(result)
    except ingest.DuplicateReferenceError as e:
        return jsonify({"error": str(e), "duplicate": True}), 409
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        tmp_path.unlink(missing_ok=True)


@app.post("/api/add-text")
def api_add_text():
    body = request.get_json(force=True, silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        return jsonify({"error": "no text provided"}), 400
    title = body.get("title") or f"Note {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    source = body.get("source") or None
    notes = body.get("notes") or None
    is_own_work = bool(body.get("own_work"))

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as tmp:
        tmp.write(text)
        tmp_path = Path(tmp.name)

    try:
        result = ingest.add_reference(tmp_path, title=title, source=source, notes=notes, is_own_work=is_own_work)
        return jsonify(result)
    except ingest.DuplicateReferenceError as e:
        return jsonify({"error": str(e), "duplicate": True}), 409
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        tmp_path.unlink(missing_ok=True)


# --- Colour similarity ------------------------------------------------------
#
# Colour is a separate search dimension from the existing CLIP embeddings,
# which rank by shape and semantics rather than colour (measured -- see the
# header of colour.py). These endpoints never mix the two: ranking here is
# colour only, so the sliders fully explain the result order.


@app.get("/api/colour/coverage")
def api_colour_coverage():
    """How much of the archive can currently be searched by colour."""
    return jsonify(colour.coverage())


@app.post("/api/colour/backfill")
def api_colour_backfill():
    """Analyse images that don't have a current colour profile.

    Synchronous and bounded by `limit` rather than queued: analysis runs at
    roughly 40ms an image with no network calls, so a few hundred finish well
    within a request. It's also idempotent, so the UI can simply call it
    again to continue rather than tracking a job.
    """
    body = request.get_json(force=True, silent=True) or {}
    limit = body.get("limit")
    analysed, failed = colour.backfill(limit=limit if isinstance(limit, int) else None)
    return jsonify({"analysed": analysed, "failed": failed, **colour.coverage()})


@app.get("/api/colour/map")
def api_colour_map():
    """Every analysed reference positioned in the LCh cylinder the Colour mode
    of the 3D graph draws.

    Serves positions and the archive detail needed to draw a node, and nothing
    about ranking: picking references off this map and searching from them goes
    through /api/colour/search like every other colour search, so the map and
    the Project Space sidebar can't drift into disagreeing about which
    references are close in colour.
    """
    return jsonify(_colour_map_response())


@app.get("/api/projects/<project_id>/colour/map")
def api_project_colour_map(project_id):
    """The same cylinder as /api/colour/map, drawn from one project's own
    references -- see colour.colour_map() on why a scoped map ranks radius
    within its own subset rather than against the archive.

    `coverage` stays archive-wide, because the backfill it exists to prompt
    is archive-wide: there is one Analyse Colour button, in Settings, and it
    works through every unanalysed image regardless of project.
    """
    _require_project(project_id)
    ids = [r["id"] for r in db.list_project_references(project_id)]
    return jsonify(_colour_map_response(include_ids=ids))


def _colour_map_response(include_ids=None):
    exclude_black_white = request.args.get("exclude_black_white") in ("1", "true", "yes")
    layout = colour.colour_map(exclude_black_white=exclude_black_white, include_ids=include_ids)

    refs = {r["id"]: r for r in db.get_references_by_ids([n["id"] for n in layout["nodes"]])}
    nodes = []
    for node in layout["nodes"]:
        ref = refs.get(node["id"])
        if not ref:
            continue  # deleted between analysis and now
        nodes.append({**_ref_summary(ref), **node})

    return {
        "nodes": nodes,
        "radius": layout["radius"],
        "height": layout["height"],
        "hue_ticks": layout["hue_ticks"],
        "coverage": colour.coverage(),
    }


@app.post("/api/colour/search")
def api_colour_search():
    """Find references whose colour character resembles the selected ones.

    Several selected references produce one combined profile describing the
    group, not one search per reference -- "what looks like this collection"
    rather than "what looks like any one of these".
    """
    body = request.get_json(force=True, silent=True) or {}
    reference_ids = body.get("reference_ids") or []
    if not reference_ids:
        return jsonify({"error": "select at least one reference"}), 400

    project_id = body.get("project_id")
    exclude = set(body.get("exclude_ids") or [])
    if project_id:
        # A colour search inside a project is for discovering things that
        # aren't in it yet, so its own references are excluded by default.
        exclude |= {r["id"] for r in db.list_project_references(project_id)}

    weights = body.get("weights") or {}
    weights = {k: v for k, v in weights.items() if k in colour.DEFAULT_WEIGHTS}
    exclude_black_white = bool(body.get("exclude_black_white"))

    limit = body.get("limit")
    outcome = colour.search(
        reference_ids,
        weights=weights,
        exclude_ids=exclude,
        limit=limit if isinstance(limit, int) else 40,
        exclude_black_white=exclude_black_white,
    )

    if not outcome["profile"]:
        return jsonify({
            "profile": None,
            "used_ids": [],
            "results": [],
            "coverage": colour.coverage(),
            "reason": "no_colour_data",
        })

    # Attach the archive detail each result needs to render, reusing the same
    # summary shape the rest of the app renders references from.
    refs = {r["id"]: r for r in db.get_references_by_ids([r["reference_id"] for r in outcome["results"]])}
    stored = db.get_colour_analyses(list(refs), version=colour.ANALYSIS_VERSION)

    results = []
    for row in outcome["results"]:
        ref = refs.get(row["reference_id"])
        if not ref:
            continue  # deleted between analysis and now
        profile = colour.profile_from_json((stored.get(ref["id"]) or {}).get("profile"))
        # The displayed palette must go through the same filter as the one
        # actually ranked, or the swatch strip would show colours that had no
        # bearing on the score -- defeating the point of showing it at all.
        if profile and exclude_black_white:
            profile = colour.remove_black_and_white(profile)
        results.append({
            **_ref_summary(ref),
            "score": round(row["score"], 4),
            "palette": (profile or {}).get("palette", []),
        })

    return jsonify({
        "profile": outcome["profile"],
        "used_ids": outcome["used_ids"],
        "results": results,
        "coverage": colour.coverage(),
    })


# --- Capture API (browser extension) ---------------------------------------
#
# Thin HTTP wrappers over capture.py. These accept a capture, write it down,
# and return -- the actual ingestion happens on capture.py's worker, because
# tagging and embedding take seconds and a browser popup is destroyed the
# moment it loses focus. The extension polls GET /api/captures/<id> (or just
# trusts the queue) rather than holding a request open.


def _parse_envelope(raw):
    """Envelopes arrive as a JSON string in multipart, or as a dict in JSON."""
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        raise capture.CaptureError("capture envelope is not valid JSON")
    if not isinstance(parsed, dict):
        raise capture.CaptureError("capture envelope must be an object")
    return parsed


def _accept_one(envelope, upload=None):
    """Accept a single capture, returning (payload, status_code)."""
    text = None
    if upload is None:
        content = envelope.get("content") or {}
        text = content.get("selected_text") or content.get("text")
        if envelope.get("type") == "page" and not text:
            # A page capture with no excerpt still deserves to be a reference:
            # store what the page said about itself so it's searchable.
            source = envelope.get("source") or {}
            meta = envelope.get("metadata") or {}
            parts = [
                source.get("page_title"),
                meta.get("description"),
                source.get("url"),
            ]
            text = "\n\n".join(p for p in parts if p)

    row = capture.accept(envelope, upload=upload, text=text)
    return capture.summary(row), 202


# --- Schedule: tasks ---------------------------------------------------------
#
# See db.py's "Schedule" section for the full data model and cascade rules.
# app.py stays a thin validation layer over it, same as everywhere else in
# this file.


@app.get("/api/tasks")
def api_list_tasks():
    """List tasks, optionally narrowed by project, deliverable and/or status
    -- any combination given at once is an AND, same as list_tasks."""
    project_id = request.args.get("project_id")
    deliverable_id = request.args.get("deliverable_id")
    status = request.args.get("status")
    if status is not None and status not in db.TASK_STATUSES:
        return jsonify({"error": f"status must be one of {', '.join(db.TASK_STATUSES)}"}), 400
    return jsonify(
        db.list_tasks(project_id=project_id, deliverable_id=deliverable_id, status=status)
    )


@app.post("/api/tasks")
def api_create_task():
    body = request.get_json(force=True, silent=True) or {}
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"error": "a title is required"}), 400

    status = body.get("status", "pending")
    if status not in db.TASK_STATUSES:
        return jsonify({"error": f"status must be one of {', '.join(db.TASK_STATUSES)}"}), 400
    support_level = body.get("support_level", "independent")
    if support_level not in db.TASK_SUPPORT_LEVELS:
        return jsonify({
            "error": f"support_level must be one of {', '.join(db.TASK_SUPPORT_LEVELS)}"
        }), 400

    task_id = str(uuid.uuid4())
    db.create_task(
        task_id,
        title,
        project_id=body.get("project_id"),
        deliverable_id=body.get("deliverable_id"),
        description=body.get("description"),
        measurable_goal=body.get("measurable_goal"),
        deadline=body.get("deadline"),
        required_location_id=body.get("required_location_id"),
        support_level=support_level,
        est_minutes=body.get("est_minutes"),
        importance=body.get("importance"),
        difficulty=body.get("difficulty"),
        is_finishing=bool(body.get("is_finishing")),
        is_domestic=bool(body.get("is_domestic")),
        status=status,
        recurrence_id=body.get("recurrence_id"),
        continues_task_id=body.get("continues_task_id"),
        est_minutes_source=body.get("est_minutes_source"),
        importance_source=body.get("importance_source"),
        difficulty_source=body.get("difficulty_source"),
    )
    return jsonify(db.get_task(task_id))


@app.get("/api/tasks/<task_id>")
def api_get_task(task_id):
    task = db.get_task(task_id)
    if not task:
        abort(404)
    return jsonify(task)


@app.put("/api/tasks/<task_id>")
def api_update_task(task_id):
    if not db.get_task(task_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    fields = {k: v for k, v in body.items() if k in db.TASK_PATCH_COLUMNS}

    if "status" in fields and fields["status"] not in db.TASK_STATUSES:
        return jsonify({"error": f"status must be one of {', '.join(db.TASK_STATUSES)}"}), 400
    if "support_level" in fields and fields["support_level"] not in db.TASK_SUPPORT_LEVELS:
        return jsonify({
            "error": f"support_level must be one of {', '.join(db.TASK_SUPPORT_LEVELS)}"
        }), 400

    db.update_task(task_id, **fields)
    return jsonify(db.get_task(task_id))


@app.delete("/api/tasks/<task_id>")
def api_delete_task(task_id):
    if not db.get_task(task_id):
        abort(404)
    db.delete_task(task_id)
    return jsonify({"ok": True, "id": task_id})


@app.post("/api/tasks/<task_id>/dependencies")
def api_add_task_dependency(task_id):
    """Add a dependency edge, refusing anything that would close a cycle."""
    if not db.get_task(task_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    depends_on_task_id = body.get("depends_on_task_id")
    if not depends_on_task_id or not db.get_task(depends_on_task_id):
        return jsonify({"error": "depends_on_task_id must be an existing task"}), 400

    cycle = db.task_dependency_cycle(task_id, depends_on_task_id)
    if cycle:
        # Name the tasks involved rather than just their ids, so the rejection
        # is legible without a follow-up lookup.
        titles = {t["id"]: t["title"] for t in db.get_tasks_by_ids(cycle)}
        chain = " -> ".join(titles.get(tid, tid) for tid in cycle)
        return jsonify({
            "error": f"would create a dependency cycle: {chain}",
            "task_ids": cycle,
        }), 400

    db.add_task_dependency(task_id, depends_on_task_id)
    return jsonify({"ok": True, "depends_on": db.list_task_dependencies(task_id)})


@app.delete("/api/tasks/<task_id>/dependencies")
def api_remove_task_dependency(task_id):
    if not db.get_task(task_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    depends_on_task_id = body.get("depends_on_task_id")
    if not depends_on_task_id:
        return jsonify({"error": "depends_on_task_id is required"}), 400
    db.remove_task_dependency(task_id, depends_on_task_id)
    return jsonify({"ok": True})


@app.post("/api/tasks/generate")
def api_generate_task_fields():
    """Given the one sentence a quick-added task requires, ask Claude to
    suggest whatever else the entry form left blank. Pure generation -- this
    persists nothing. The caller (the Tasks tab's save flow) merges the
    result with whatever the user actually typed and posts that to
    POST /api/tasks like any other task, tagging each field's *_source
    accordingly. A scoped addition alongside /api/tasks, not a change to it."""
    body = request.get_json(force=True, silent=True) or {}
    description = (body.get("description") or "").strip()
    if not description:
        return jsonify({"error": "a description is required"}), 400
    try:
        return jsonify(task_ai.generate_task_fields(description))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/api/tasks/<task_id>/actual")
def api_get_task_actual(task_id):
    """The recorded actuals for a done task, so the Tasks tab can render them
    as the same editable chips the estimate started as. None (not 404) when
    the task exists but hasn't been completed yet -- absent-because-not-done
    is a normal state, not an error."""
    if not db.get_task(task_id):
        abort(404)
    return jsonify(db.get_task_actual(task_id))


@app.get("/api/tasks/<task_id>/blocks")
def api_get_task_blocks(task_id):
    """Every scheduled block this task has ever had, oldest first -- what the
    calendar's task panel (schedule/task-panel.js) reads to find the task's
    current slot after opening it from a click, the same way tasks.js's own
    card finds it from GET /api/schedule's blocks list. A dedicated route
    rather than making the caller fetch and filter the whole schedule, which
    has no notion of "just this task" and needs a bounded date range."""
    if not db.get_task(task_id):
        abort(404)
    blocks = db.list_scheduled_blocks_for_task(task_id)
    for block in blocks:
        block["granularity"] = scheduling.block_granularity(block)
    return jsonify(blocks)


@app.post("/api/tasks/<task_id>/complete")
def api_complete_task(task_id):
    """One-tap completion -- the COMPLETED outcome (see
    scheduling.resolve_completed). With no body at all, every actual defaults
    per the rule in db.py's Schedule section (block length or estimate; the
    task's own difficulty/importance) -- that default path is what makes Done
    a single tap. Any of actual_minutes/actual_difficulty/actual_importance/
    notes may be sent to correct a value, either at completion time or later;
    a field left out of a later correction keeps what was already recorded
    rather than falling back to the default again, so fixing one actual can
    never silently reset another."""
    task = db.get_task(task_id)
    if not task:
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    existing = db.get_task_actual(task_id)

    def resolve(key, default):
        if key in body:
            return body[key]
        if existing and existing.get(key) is not None:
            return existing[key]
        return default

    actual_minutes = resolve("actual_minutes", _default_actual_minutes(task))
    actual_difficulty = resolve("actual_difficulty", task["difficulty"])
    actual_importance = resolve("actual_importance", task["importance"])
    notes = body.get("notes", existing["notes"] if existing else None)

    result = scheduling.resolve_completed(
        task_id,
        actual_minutes=actual_minutes,
        actual_difficulty=actual_difficulty,
        actual_importance=actual_importance,
        notes=notes,
    )
    return jsonify(result)


@app.post("/api/tasks/<task_id>/partial")
def api_partial_task(task_id):
    """The PARTIALLY COMPLETED outcome (see scheduling.resolve_partial): the
    original is closed with the time actually spent, and a remainder task is
    spawned to pick up where it left off. `est_minutes` is required -- a
    fresh estimate for what remains, never inherited from the original.
    `actual_minutes` defaults the same way completion does (the current
    block's length, or the estimate if it was never scheduled). Any field in
    scheduling.REMAINDER_INHERITED_COLUMNS sent in the body overrides what the
    remainder would otherwise inherit from the original -- everything else
    (title, description, project, deliverable, location, support level,
    importance, difficulty, is_finishing, is_domestic) carries over as-is."""
    task = db.get_task(task_id)
    if not task:
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    est_minutes = body.get("est_minutes")
    if not isinstance(est_minutes, (int, float)) or est_minutes <= 0:
        return jsonify({"error": "a positive est_minutes is required for what remains"}), 400

    actual_minutes = body.get("actual_minutes")
    if actual_minutes is None:
        actual_minutes = _default_actual_minutes(task)
    overrides = {
        k: v for k, v in body.items() if k in scheduling.REMAINDER_INHERITED_COLUMNS
    }

    result = scheduling.resolve_partial(
        task_id,
        actual_minutes=actual_minutes,
        est_minutes=est_minutes,
        actual_difficulty=body.get("actual_difficulty", task["difficulty"]),
        actual_importance=body.get("actual_importance", task["importance"]),
        notes=body.get("notes"),
        **overrides,
    )
    return jsonify(result)


@app.post("/api/tasks/<task_id>/not-completed")
def api_not_completed_task(task_id):
    """The NOT COMPLETED outcome (see scheduling.resolve_not_completed): the
    task returns to the pool unchanged, slip_count goes up by one, and no
    actual is recorded -- never starting a task says nothing about how long
    it takes."""
    if not db.get_task(task_id):
        abort(404)
    return jsonify(scheduling.resolve_not_completed(task_id))


def _default_actual_minutes(task):
    """The length of this task's current scheduled block, or its estimate if
    it was never scheduled -- travel blocks the scheduler inserted around the
    task don't count as the task's own duration."""
    blocks = [
        b for b in db.list_scheduled_blocks_for_task(task["id"])
        if b["kind"] == "task" and scheduling.block_granularity(b) == "slot"
    ]
    if blocks:
        block = blocks[-1]
        start = datetime.fromisoformat(block["start"])
        end = datetime.fromisoformat(block["end"])
        return round((end - start).total_seconds() / 60)
    # A day-granularity block says which day, not how long (see
    # SCHEDULED_BLOCKS_SCHEMA), so a task placed that far out falls back to
    # its estimate rather than to a length the block never claimed.
    return task["est_minutes"]


# --- Schedule: deliverables ---------------------------------------------------


@app.get("/api/projects/<project_id>/deliverables")
def api_list_deliverables(project_id):
    _require_project(project_id)
    return jsonify(db.list_deliverables(project_id))


@app.post("/api/projects/<project_id>/deliverables")
def api_create_deliverable(project_id):
    _require_project(project_id)
    body = request.get_json(force=True, silent=True) or {}
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"error": "a title is required"}), 400
    deliverable_id = str(uuid.uuid4())
    db.create_deliverable(
        deliverable_id,
        project_id,
        title,
        description=body.get("description"),
        due_at=body.get("due_at"),
        weighting=body.get("weighting"),
        spec=body.get("spec"),
    )
    return jsonify(db.get_deliverable(deliverable_id))


@app.put("/api/deliverables/<deliverable_id>")
def api_update_deliverable(deliverable_id):
    if not db.get_deliverable(deliverable_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    fields = {k: v for k, v in body.items() if k in db.DELIVERABLE_PATCH_COLUMNS}
    if "title" in fields and not (fields["title"] or "").strip():
        return jsonify({"error": "a title is required"}), 400
    db.update_deliverable(deliverable_id, **fields)
    return jsonify(db.get_deliverable(deliverable_id))


@app.delete("/api/deliverables/<deliverable_id>")
def api_delete_deliverable(deliverable_id):
    if not db.get_deliverable(deliverable_id):
        abort(404)
    db.delete_deliverable(deliverable_id)
    return jsonify({"ok": True, "id": deliverable_id})


# --- Schedule: locations -------------------------------------------------------


@app.get("/api/locations")
def api_list_locations():
    return jsonify(db.list_locations())


@app.post("/api/locations")
def api_create_location():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "a name is required"}), 400
    location_id = str(uuid.uuid4())
    db.create_location(
        location_id,
        name,
        address=body.get("address"),
        travel_minutes_from_home=body.get("travel_minutes_from_home"),
        notes=body.get("notes"),
    )
    return jsonify(db.get_location(location_id))


@app.put("/api/locations/<location_id>")
def api_update_location(location_id):
    if not db.get_location(location_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    fields = {k: v for k, v in body.items() if k in db.LOCATION_PATCH_COLUMNS}
    if "name" in fields and not (fields["name"] or "").strip():
        return jsonify({"error": "a name is required"}), 400
    db.update_location(location_id, **fields)
    return jsonify(db.get_location(location_id))


@app.delete("/api/locations/<location_id>")
def api_delete_location(location_id):
    if not db.get_location(location_id):
        abort(404)
    db.delete_location(location_id)
    return jsonify({"ok": True, "id": location_id})


@app.get("/api/locations/<location_id>/hours")
def api_get_location_hours(location_id):
    if not db.get_location(location_id):
        abort(404)
    return jsonify(db.get_location_hours(location_id))


@app.put("/api/locations/<location_id>/hours")
def api_save_location_hours(location_id):
    """Replace a location's whole weekly schedule at once -- see
    db.save_location_hours for why this is wholesale, not per-day."""
    if not db.get_location(location_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    hours = body.get("hours")
    if not isinstance(hours, list):
        return jsonify({"error": "hours must be a list"}), 400
    db.save_location_hours(location_id, hours)
    return jsonify(db.get_location_hours(location_id))


@app.get("/api/locations/<location_id>/overrides")
def api_list_location_overrides(location_id):
    if not db.get_location(location_id):
        abort(404)
    return jsonify(db.list_location_overrides(location_id))


@app.post("/api/locations/<location_id>/overrides")
def api_create_location_override(location_id):
    if not db.get_location(location_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    date = body.get("date")
    if not date:
        return jsonify({"error": "a date is required"}), 400
    override_id = str(uuid.uuid4())
    db.create_location_override(
        override_id,
        location_id,
        date,
        opens=body.get("opens"),
        closes=body.get("closes"),
        closed=bool(body.get("closed")),
    )
    return jsonify(db.list_location_overrides(location_id))


@app.delete("/api/locations/<location_id>/overrides")
def api_delete_location_override(location_id):
    """Deletes one override, named by id in the body -- there's no override id
    in the URL, since an override only ever makes sense in the context of the
    location it belongs to."""
    if not db.get_location(location_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    override_id = body.get("id")
    if not override_id:
        return jsonify({"error": "an override id is required"}), 400
    db.delete_location_override(override_id)
    return jsonify(db.list_location_overrides(location_id))


# --- Schedule: travel -----------------------------------------------------------


@app.get("/api/travel")
def api_list_travel():
    return jsonify(db.list_travel())


@app.put("/api/travel")
def api_save_travel():
    """Replace the whole location-to-location travel matrix at once -- see
    db.save_travel."""
    body = request.get_json(force=True, silent=True) or {}
    entries = body.get("travel")
    if not isinstance(entries, list):
        return jsonify({"error": "travel must be a list"}), 400
    db.save_travel(entries)
    return jsonify(db.list_travel())


# --- Schedule: commitments -------------------------------------------------------


@app.get("/api/commitments")
def api_list_commitments():
    return jsonify(db.list_commitments())


@app.post("/api/commitments")
def api_create_commitment():
    body = request.get_json(force=True, silent=True) or {}
    title = (body.get("title") or "").strip()
    start, end = body.get("start"), body.get("end")
    if not title or not start or not end:
        return jsonify({"error": "title, start and end are required"}), 400
    support_level = body.get("support_level", "none")
    if support_level not in db.COMMITMENT_SUPPORT_LEVELS:
        return jsonify({
            "error": f"support_level must be one of {', '.join(db.COMMITMENT_SUPPORT_LEVELS)}"
        }), 400
    commitment_id = str(uuid.uuid4())
    db.create_commitment(
        commitment_id,
        title,
        start,
        end,
        kind=body.get("kind"),
        location_id=body.get("location_id"),
        support_level=support_level,
        source=body.get("source"),
        external_uid=body.get("external_uid"),
        energy_cost=body.get("energy_cost"),
        home_first=bool(body.get("home_first")),
        prep_minutes=body.get("prep_minutes"),
        location_name=body.get("location_name"),
        travel_minutes=body.get("travel_minutes"),
    )
    return jsonify(db.get_commitment(commitment_id))


@app.put("/api/commitments/<commitment_id>")
def api_update_commitment(commitment_id):
    if not db.get_commitment(commitment_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    fields = {k: v for k, v in body.items() if k in db.COMMITMENT_PATCH_COLUMNS}
    if "support_level" in fields and fields["support_level"] not in db.COMMITMENT_SUPPORT_LEVELS:
        return jsonify({
            "error": f"support_level must be one of {', '.join(db.COMMITMENT_SUPPORT_LEVELS)}"
        }), 400
    db.update_commitment(commitment_id, **fields)
    return jsonify(db.get_commitment(commitment_id))


@app.delete("/api/commitments/<commitment_id>")
def api_delete_commitment(commitment_id):
    if not db.get_commitment(commitment_id):
        abort(404)
    db.delete_commitment(commitment_id)
    return jsonify({"ok": True, "id": commitment_id})


@app.put("/api/commitments/classify")
def api_classify_commitments():
    """Reclassify several commitments' support_level and/or location_id at
    once -- import can't know either reliably from a title (see
    ics_import.py), so this is the fast way to set both together after
    selecting a run of sessions. Survives a later re-sync, since sync_feed
    never touches these two fields on a row it updates.
    """
    body = request.get_json(force=True, silent=True) or {}
    ids = body.get("ids")
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "ids must be a non-empty list"}), 400

    fields = {}
    if "support_level" in body:
        if body["support_level"] not in db.COMMITMENT_SUPPORT_LEVELS:
            return jsonify({
                "error": f"support_level must be one of {', '.join(db.COMMITMENT_SUPPORT_LEVELS)}"
            }), 400
        fields["support_level"] = body["support_level"]
    if "location_id" in body:
        fields["location_id"] = body["location_id"]
    if not fields:
        return jsonify({"error": "support_level and/or location_id is required"}), 400

    updated = []
    for commitment_id in ids:
        if db.get_commitment(commitment_id):
            db.update_commitment(commitment_id, **fields)
            updated.append(db.get_commitment(commitment_id))
    return jsonify(updated)


@app.post("/api/commitments/import")
def api_import_commitments():
    """Import, or re-sync, commitments from an ICS feed -- an uploaded .ics
    file (multipart, field "file") or a feed URL (JSON body {"feed_url": ...}).

    Sync scope is `source`: for a URL that's the URL itself; for an upload
    it's an explicit "source" field if given, else the uploaded filename --
    either way, re-running the same import with the same source updates and
    prunes the same set of commitments rather than starting a second,
    unrelated one. See ics_import.sync_feed for the update/insert/delete
    rules.
    """
    if "file" in request.files:
        upload = request.files["file"]
        source = request.form.get("source") or upload.filename
        try:
            ics_text = upload.read().decode("utf-8")
        except UnicodeDecodeError:
            return jsonify({"error": "not a valid .ics file"}), 400
    else:
        body = request.get_json(force=True, silent=True) or {}
        feed_url = (body.get("feed_url") or "").strip()
        if not feed_url:
            return jsonify({"error": "a file upload or feed_url is required"}), 400
        if not feed_url.startswith(("http://", "https://")):
            return jsonify({"error": "feed_url must be http:// or https://"}), 400
        source = body.get("source") or feed_url
        # Remembered as soon as the user submits it, not only once it works --
        # a transient fetch failure shouldn't mean retyping the URL to retry.
        db.save_ics_feed_url(feed_url)
        try:
            ics_text = ics_import.fetch_feed(feed_url)
        except ics_import.FeedFetchError as e:
            return jsonify({"error": str(e)}), 502

    try:
        summary = ics_import.sync_feed(source, ics_text)
    except ics_import.InvalidICSError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(summary)


@app.get("/api/commitments/feed")
def api_get_ics_feed():
    """The last feed URL the user configured, if any -- lets the calendar
    import UI prefill the field and offer Re-sync without asking the user to
    paste the URL again."""
    return jsonify({"feed_url": db.get_ics_feed_url()})


# --- Schedule: working hours and daily capacity -------------------------------


@app.get("/api/working-hours")
def api_get_working_hours():
    return jsonify(db.get_working_hours())


@app.put("/api/working-hours")
def api_save_working_hours():
    """Replace the whole weekly working-hours template at once -- see
    db.save_working_hours for why this is wholesale, not per-day."""
    body = request.get_json(force=True, silent=True) or {}
    hours = body.get("hours")
    if not isinstance(hours, list):
        return jsonify({"error": "hours must be a list"}), 400
    db.save_working_hours(hours)
    return jsonify(db.get_working_hours())


@app.get("/api/domestic-hours")
def api_get_domestic_hours():
    return jsonify(db.get_domestic_hours())


@app.put("/api/domestic-hours")
def api_save_domestic_hours():
    """Replace the whole weekly domestic-hours template at once -- same
    wholesale contract as working hours, and a separate band from it."""
    body = request.get_json(force=True, silent=True) or {}
    hours = body.get("hours")
    if not isinstance(hours, list):
        return jsonify({"error": "hours must be a list"}), 400
    db.save_domestic_hours(hours)
    return jsonify(db.get_domestic_hours())


@app.get("/api/hours-overrides")
def api_list_hours_overrides():
    """Every per-date resize on file, optionally narrowed to one band via
    ?band=working|domestic -- the week/month views (session 9) read this to
    render both bands' calendars."""
    band = request.args.get("band")
    if band is not None and band not in db.HOURS_BANDS:
        return jsonify({"error": f"band must be one of {', '.join(db.HOURS_BANDS)}"}), 400
    return jsonify(db.list_hours_overrides(band))


@app.post("/api/hours-overrides")
def api_create_hours_override():
    body = request.get_json(force=True, silent=True) or {}
    date_str = body.get("date")
    band = body.get("band")
    if not date_str or not _is_valid_date(date_str):
        return jsonify({"error": "date must be YYYY-MM-DD"}), 400
    if band not in db.HOURS_BANDS:
        return jsonify({"error": f"band must be one of {', '.join(db.HOURS_BANDS)}"}), 400
    override_id = str(uuid.uuid4())
    db.create_hours_override(
        override_id,
        date_str,
        band,
        opens=body.get("opens"),
        closes=body.get("closes"),
        off=bool(body.get("off")),
    )
    return jsonify(next(o for o in db.list_hours_overrides(band) if o["id"] == override_id))


@app.delete("/api/hours-overrides/<override_id>")
def api_delete_hours_override(override_id):
    db.delete_hours_override(override_id)
    return jsonify({"ok": True, "id": override_id})


def _is_valid_date(date_str):
    try:
        date.fromisoformat(date_str)
        return True
    except ValueError:
        return False


@app.get("/api/schedule-settings")
def api_get_schedule_settings():
    return jsonify(db.get_schedule_settings())


@app.put("/api/schedule-settings")
def api_save_schedule_settings():
    """Whole-object replace, same convention as the hours endpoints -- the
    settings panel (session 9's bedtime section) always submits all three
    fields together."""
    body = request.get_json(force=True, silent=True) or {}
    current = db.get_schedule_settings()
    sleep_target = body.get("sleep_target_minutes", current["sleep_target_minutes"])
    morning_routine = body.get("morning_routine_minutes", current["morning_routine_minutes"])
    notify = body.get("bedtime_notifications_enabled", current["bedtime_notifications_enabled"])
    if not isinstance(sleep_target, (int, float)) or sleep_target <= 0:
        return jsonify({"error": "sleep_target_minutes must be a positive number"}), 400
    if not isinstance(morning_routine, (int, float)) or morning_routine < 0:
        return jsonify({"error": "morning_routine_minutes must be zero or more"}), 400
    db.save_schedule_settings(int(sleep_target), int(morning_routine), bool(notify))
    return jsonify(db.get_schedule_settings())


@app.get("/api/schedule/bedtimes")
def api_list_suggested_bedtimes():
    """The suggested-bedtime marker (see scheduling.suggested_bedtime) for
    every evening in [start, end] -- one calendar fetch for a whole visible
    week rather than one request per day. Evenings with nothing to derive a
    bedtime from (see suggested_bedtime's None case) are simply omitted."""
    start = request.args.get("start")
    end = request.args.get("end")
    if not start or not end or not _is_valid_date(start) or not _is_valid_date(end):
        return jsonify({"error": "start and end must both be YYYY-MM-DD"}), 400
    day = date.fromisoformat(start)
    stop = date.fromisoformat(end)
    if (stop - day).days > scheduling.MAX_HORIZON_DAYS:
        return jsonify({"error": "range is too wide"}), 400
    markers = []
    while day <= stop:
        marker = scheduling.suggested_bedtime(day.isoformat())
        if marker:
            markers.append(marker)
        day += timedelta(days=1)
    return jsonify(markers)


@app.get("/api/capacity/<date_str>")
def api_get_daily_capacity(date_str):
    if not _is_valid_date(date_str):
        return jsonify({"error": "date must be YYYY-MM-DD"}), 400
    row = scheduling.compute_daily_capacity(date_str)
    row["energy"] = scheduling.effective_energy(row)
    return jsonify(row)


@app.put("/api/capacity/<date_str>")
def api_set_manual_energy(date_str):
    """Set, or clear, the manual energy override for one day -- send
    manual_energy: null to clear it back to the inferred value. Always wins
    over inferred_energy while set (see scheduling.effective_energy)."""
    if not _is_valid_date(date_str):
        return jsonify({"error": "date must be YYYY-MM-DD"}), 400
    body = request.get_json(force=True, silent=True) or {}
    if "manual_energy" not in body:
        return jsonify({"error": "manual_energy is required (null clears the override)"}), 400

    row = scheduling.compute_daily_capacity(date_str)
    db.save_daily_capacity(
        date_str,
        inferred_energy=row["inferred_energy"],
        manual_energy=body["manual_energy"],
        available_minutes=row["available_minutes"],
    )
    updated = db.get_daily_capacity(date_str)
    updated["energy"] = scheduling.effective_energy(updated)
    return jsonify(updated)


# --- Schedule: the plan --------------------------------------------------------


@app.post("/api/schedule/plan")
def api_run_schedule_plan():
    """Resolve whatever's lapsed, then run the scheduler and replace the
    future of scheduled_blocks with what it placed (see scheduling.replan).

    Safe to call repeatedly -- and meant to be: on first load each day, on
    demand, and whenever working or domestic hours change (see
    SCHEDULE_SCOPE.md's "Replan"). Blocks already in the past are left alone,
    whether they're a completed or partial task's genuine history, or a
    not-completed block auto-resolved by this same call. A locked block in
    the future is re-seeded at its pinned slot rather than replaced with
    something else -- everything schedules around it.

    An optional `now` in the body anchors the walk somewhere other than the
    actual current time, which is what makes a plan reproducible; a dependency
    cycle is a 400 naming the tasks in it, never a schedule in some order the
    scheduler picked for itself.
    """
    body = request.get_json(force=True, silent=True) or {}
    try:
        return jsonify(scheduling.replan(body.get("now")))
    except scheduling.DependencyCycleError as e:
        return jsonify({"error": str(e), "task_ids": e.task_ids}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.put("/api/schedule/blocks/<block_id>/lock")
def api_lock_scheduled_block(block_id):
    """Pin a scheduled block to its slot, or release it -- the only property
    of a block mutable outside a replan (see SCHEDULE_SCOPE.md's "Pinning").
    Locking only makes sense for a 'task' block with a real time of day: a
    day-granularity allocation has no slot to lock to (detail decays with
    distance -- see scheduling.SLOT_DETAIL_DAYS), and a travel/break/chain
    block is derived from the placements around it rather than being
    independently pinnable."""
    block = db.get_scheduled_block(block_id)
    if not block:
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    if "is_locked" not in body:
        return jsonify({"error": "is_locked is required"}), 400
    if block["kind"] != "task":
        return jsonify({"error": "only a task block can be locked"}), 400
    if scheduling.block_granularity(block) != "slot":
        return jsonify({"error": "a day-granularity block has no slot to lock to"}), 400

    db.set_scheduled_block_locked(block_id, bool(body["is_locked"]))
    return jsonify(db.get_scheduled_block(block_id))


@app.put("/api/schedule/blocks/<block_id>/move")
def api_move_scheduled_block(block_id):
    """Reposition a task block by dragging it on the calendar (week.js) --
    sets a new start (its length carries over unchanged) and always locks it
    there, same slot-only rule as api_lock_scheduled_block. A scoped variant
    of that route rather than a change to it: locking in place and locking at
    a new place are different gestures with different bodies.

    Never reflows anything else by itself -- the caller follows this with
    POST /api/schedule/plan so everything unlocked replans around the new
    pin, same as any other lock."""
    block = db.get_scheduled_block(block_id)
    if not block:
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    if "start" not in body:
        return jsonify({"error": "start is required"}), 400
    if block["kind"] != "task":
        return jsonify({"error": "only a task block can be moved"}), 400
    if scheduling.block_granularity(block) != "slot":
        return jsonify({"error": "a day-granularity block has no slot to move to"}), 400
    try:
        new_start = datetime.fromisoformat(body["start"])
    except (TypeError, ValueError):
        return jsonify({"error": "start must be an ISO datetime"}), 400

    duration = datetime.fromisoformat(block["end"]) - datetime.fromisoformat(block["start"])
    new_end = new_start + duration
    db.move_scheduled_block(block_id, new_start.isoformat(), new_end.isoformat(), is_locked=True)
    return jsonify(db.get_scheduled_block(block_id))


@app.get("/api/schedule")
def api_get_schedule():
    """The scheduled blocks in a date range, plus the at-risk list.

    `start` and `end` are inclusive dates, defaulting to today and the end of
    the current horizon -- so no arguments at all means the whole plan from
    here on.

    The blocks are what the last plan committed. The at-risk list is computed
    fresh on every read rather than stored, because it is the half that has to
    be true *now*: a deadline that moved this morning changes what is
    unreachable whether or not anything has been replanned since, and being
    told late is the failure this whole feature exists to prevent. If the two
    ever disagree, the fix is to replan.
    """
    start = request.args.get("start")
    end = request.args.get("end")
    for value in (start, end):
        if value is not None and not _is_valid_date(value):
            return jsonify({"error": "start and end must be YYYY-MM-DD"}), 400

    try:
        result = scheduling.plan()
    except scheduling.DependencyCycleError as e:
        return jsonify({"error": str(e), "task_ids": e.task_ids}), 400

    range_start = start or result["today"]
    range_end = end or result["horizon_end"]
    # end is inclusive, and db's range is half-open, so the query runs to the
    # following midnight -- otherwise a request for a week silently drops
    # everything scheduled on its last day.
    stop = (date.fromisoformat(range_end) + timedelta(days=1)).isoformat()
    blocks = db.list_scheduled_blocks_between(range_start, stop)
    for block in blocks:
        block["granularity"] = scheduling.block_granularity(block)

    return jsonify({
        "start": range_start,
        "end": range_end,
        "blocks": blocks,
        "at_risk": result["at_risk"],
        "at_risk_by_deliverable": result["at_risk_by_deliverable"],
        "chronically_slipping": result["chronically_slipping"],
        "horizon_end": result["horizon_end"],
        "slot_detail_until": result["slot_detail_until"],
    })


# --- Schedule: reset ----------------------------------------------------------


RESET_SCHEDULE_CONFIRMATION = "clear-schedule"


@app.post("/api/schedule/reset")
def api_reset_schedule():
    """Empty the schedule back to nothing, for clearing out test data.

    Destructive and not undoable, so it will not fire on an empty or careless
    request: the body must carry {"confirm": "clear-schedule"} exactly.

    Always clears tasks (with their dependencies and actuals), scheduled
    blocks, commitments, deliverables, recurrence rules, daily capacity and
    per-date hours overrides -- see db.SCHEDULE_DATA_TABLES. Three optional
    flags each clear a group of configuration that is tedious to re-enter and
    rarely what a reset means, all default false:

        clear_locations  -- locations and their hours, overrides and travel
        clear_hours      -- the weekly working and domestic hour bands
        clear_resources  -- the resource library and imported briefs

    The reference archive shares this SQLite file and is never touched, nor
    are the remembered ICS feed URL and bedtime settings.

    Returns {"deleted": {table: rows, ...}, "task_vectors_deleted": n}.
    """
    body = request.get_json(force=True, silent=True) or {}
    if body.get("confirm") != RESET_SCHEDULE_CONFIRMATION:
        return jsonify({
            "error": "this wipes all schedule data and cannot be undone; "
                     f'send {{"confirm": "{RESET_SCHEDULE_CONFIRMATION}"}} to proceed'
        }), 400

    deleted = db.reset_schedule(
        clear_locations=bool(body.get("clear_locations")),
        clear_hours=bool(body.get("clear_hours")),
        clear_resources=bool(body.get("clear_resources")),
    )

    # estimation.py finds "similar past tasks" in a Chroma collection of task
    # vectors, not the tasks table -- clearing one and not the other leaves it
    # matching new work against tasks that are gone. db.reset_schedule keeps
    # clear of Chroma by design, so the two-step cleanup lands here.
    task_vectors_deleted = embeddings.clear_task_collection()

    return jsonify({"deleted": deleted, "task_vectors_deleted": task_vectors_deleted})


# --- Schedule: resources -----------------------------------------------------------


@app.get("/api/resources")
def api_list_resources():
    return jsonify(db.list_resources())


@app.post("/api/resources")
def api_create_resource():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "a name is required"}), 400
    resource_id = str(uuid.uuid4())
    db.create_resource(
        resource_id,
        name,
        location_id=body.get("location_id"),
        url=body.get("url"),
        notes=body.get("notes"),
    )
    return jsonify(db.get_resource(resource_id))


@app.put("/api/resources/<resource_id>")
def api_update_resource(resource_id):
    if not db.get_resource(resource_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    fields = {k: v for k, v in body.items() if k in db.RESOURCE_PATCH_COLUMNS}
    if "name" in fields and not (fields["name"] or "").strip():
        return jsonify({"error": "a name is required"}), 400
    db.update_resource(resource_id, **fields)
    return jsonify(db.get_resource(resource_id))


@app.delete("/api/resources/<resource_id>")
def api_delete_resource(resource_id):
    if not db.get_resource(resource_id):
        abort(404)
    db.delete_resource(resource_id)
    return jsonify({"ok": True, "id": resource_id})


@app.post("/api/resources/<resource_id>/items")
def api_add_resource_item(resource_id):
    if not db.get_resource(resource_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    item = (body.get("item") or "").strip()
    if not item:
        return jsonify({"error": "an item is required"}), 400
    db.add_resource_item(resource_id, item, tags=body.get("tags"))
    return jsonify(db.list_resource_items(resource_id))


@app.delete("/api/resources/<resource_id>/items")
def api_remove_resource_item(resource_id):
    """Removes one item, named in the body -- like the location overrides
    delete, an item has no id of its own outside the resource it belongs to."""
    if not db.get_resource(resource_id):
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    item = body.get("item")
    if not item:
        return jsonify({"error": "an item is required"}), 400
    db.remove_resource_item(resource_id, item)
    return jsonify(db.list_resource_items(resource_id))


@app.get("/api/health")
def api_health():
    """Cheap liveness probe -- the extension calls this to decide between
    "ready" and "Archive unavailable"."""
    return jsonify({
        "ok": True,
        "app": "fashion-reference-library",
        "reference_count": len(db.list_references()),
        "auth_required": bool(ARCHIVE_API_TOKEN),
    })


@app.post("/api/captures/check")
def api_capture_check():
    """Has this been captured already? Answered from URLs alone, so the
    extension can warn before downloading anything."""
    if not _capture_auth_ok():
        return jsonify({"error": "unauthorized"}), 401
    body = request.get_json(force=True, silent=True) or {}
    try:
        envelope = _parse_envelope(body.get("capture", body))
    except capture.CaptureError as e:
        return jsonify({"error": str(e)}), 400
    match = capture.check_duplicate(envelope)
    return jsonify({"duplicate": bool(match), "match": match})


@app.post("/api/captures")
def api_create_capture():
    """Accept one capture. Multipart (file + `capture` JSON field) for images,
    plain JSON for text and page captures."""
    if not _capture_auth_ok():
        return jsonify({"error": "unauthorized"}), 401

    try:
        if "file" in request.files:
            envelope = _parse_envelope(request.form.get("capture"))
            payload, code = _accept_one(envelope, upload=request.files["file"])
        else:
            body = request.get_json(force=True, silent=True) or {}
            envelope = _parse_envelope(body.get("capture", body))
            payload, code = _accept_one(envelope)
    except capture.CaptureError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify(payload), code


@app.post("/api/captures/batch")
def api_create_captures_batch():
    """Accept several captures at once (multi-select on one page).

    Per-item results rather than all-or-nothing: one bad item shouldn't lose
    the rest of a selection, and the extension shows a per-row status anyway.
    Image bytes come in as `file0`, `file1`, ... matching `captures[i].
    """
    if not _capture_auth_ok():
        return jsonify({"error": "unauthorized"}), 401

    if request.files:
        try:
            envelopes = json.loads(request.form.get("captures") or "[]")
        except (TypeError, ValueError):
            return jsonify({"error": "captures field is not valid JSON"}), 400
        uploads = [request.files.get(f"file{i}") for i in range(len(envelopes))]
    else:
        body = request.get_json(force=True, silent=True) or {}
        envelopes = body.get("captures") or []
        uploads = [None] * len(envelopes)

    if not isinstance(envelopes, list) or not envelopes:
        return jsonify({"error": "no captures provided"}), 400

    results = []
    for envelope, upload in zip(envelopes, uploads):
        try:
            payload, _ = _accept_one(_parse_envelope(envelope), upload=upload)
            results.append({"ok": True, **payload})
        except Exception as e:
            results.append({"ok": False, "error": str(e)})

    accepted = sum(1 for r in results if r["ok"])
    return jsonify({"accepted": accepted, "total": len(results), "results": results}), 202


@app.get("/api/captures/<capture_id>")
def api_get_capture(capture_id):
    """Status of one capture -- queued, processing, done, duplicate, failed."""
    if not _capture_auth_ok():
        return jsonify({"error": "unauthorized"}), 401
    row = db.get_capture(capture_id)
    if not row:
        abort(404)
    return jsonify(capture.summary(row))


def bootstrap():
    """Shared startup for every entry point: init the db, resume any
    in-flight capture queue, and start the capture worker. Called by both
    `python app.py` and desktop.py so the two never drift apart."""
    db.init_db()
    # Pick up anything a previous run left mid-flight before serving.
    resumed, lost = capture.resume_pending()
    if resumed or lost:
        print(f"captures resumed: {resumed}, unrecoverable: {lost}")
    capture.ensure_worker()


if __name__ == "__main__":
    bootstrap()
    url = f"http://127.0.0.1:{PORT}"
    print(f"Fashion reference library running at {url}")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(port=PORT, debug=False)
