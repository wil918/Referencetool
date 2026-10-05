"""The portfolio staging store: working pages, kept apart from the archive.

A portfolio spread (spreads.py) used to fill its pages by sending each image
through the capture queue, so every page was tagged by Claude, embedded by CLIP
and inserted as a reference with is_own_work = 1. Seven revisions of a page cost
seven API calls and left seven near-duplicates in the archive. A page is a
working file, not research, so it now lives here instead:

  - UPLOAD IS DIRECT. The bytes are written, hashed, measured and a row is
    inserted -- no capture queue, no Claude call, no CLIP embedding. Placing a
    page is as instant as copying a file, because that is all it is.
  - THE STORE IS PROJECT-SCOPED, not spread-scoped. A page can exist before it
    has a slot (upload thirty, then fill slots from what is staged), and a page
    that is replaced stays here as its own row: versions are cheap, deletable
    and invisible to search, which is exactly where they should pile up.
  - A SPREAD POINTS AT A PAGE by id ({ page_id, fit, crop? }). Deleting a staged
    page empties the slots that used it rather than breaking them -- pagination
    is the document.
  - PROMOTION IS EXPLICIT. promote() runs a page through ingest.add_reference
    with is_own_work = 1, and only then does it become archive material.
    Content hashing means promoting the same page twice is a no-op.

The files live in config.PORTFOLIO_DIR, beside references/ and deleted/.
Nothing in here writes to the archive except promote().
"""
import hashlib
import json
import re
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import config
import db
import ingest
import spreads

_CHUNK = 1 << 20


class PortfolioError(Exception):
    """Something the caller did wrong, with the HTTP status to say so."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def path_for(page):
    # config.PORTFOLIO_DIR read at call time, not bound at import: tests point
    # it at a temp directory after this module has already been imported.
    return config.PORTFOLIO_DIR / page["filepath"]


def _need_page(page_id):
    page = db.get_portfolio_page(page_id) if page_id else None
    if not page:
        raise PortfolioError("no such staged page", 404)
    return page


# --- Staging ----------------------------------------------------------------


def stage_upload(project_id, upload):
    """Store an uploaded file as a staged page: (page, created).

    The whole of the work: write the bytes, hash them, read the dimensions,
    insert the row. A file whose bytes this project already has comes back as
    the page it already is (created = False) rather than a second copy -- a
    folder dragged in twice is not sixty pages.
    """
    filename = Path(upload.filename or "").name or "page"
    ext = Path(filename).suffix.lower()
    if ext not in ingest.IMAGE_EXTS:
        raise PortfolioError(f"{filename}: pages take JPEG, PNG, GIF, WebP or BMP images")

    config.PORTFOLIO_DIR.mkdir(parents=True, exist_ok=True)
    page_id = str(uuid.uuid4())
    dest = config.PORTFOLIO_DIR / f"{page_id}{ext}"
    digest = hashlib.sha256()
    try:
        with open(dest, "wb") as out:
            for chunk in iter(lambda: upload.stream.read(_CHUNK), b""):
                digest.update(chunk)
                out.write(chunk)
        return _register(project_id, dest, page_id, digest.hexdigest(), filename)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise


def stage_path(project_id, source, filename=None, uploaded_at=None):
    """Copy a file that is already on disk into the store: (page, created).
    The migration's way in; an upload never needs it."""
    source = Path(source)
    config.PORTFOLIO_DIR.mkdir(parents=True, exist_ok=True)
    page_id = str(uuid.uuid4())
    dest = config.PORTFOLIO_DIR / f"{page_id}{source.suffix.lower()}"
    try:
        # A copy of the bytes, not a link: the archive's own file must be free
        # to be rotated or deleted without touching a page that uses it.
        dest.write_bytes(source.read_bytes())
        return _register(
            project_id, dest, page_id, ingest._file_hash(dest), filename or source.name,
            uploaded_at=uploaded_at,
        )
    except BaseException:
        dest.unlink(missing_ok=True)
        raise


def _register(project_id, dest, page_id, content_hash, filename, uploaded_at=None):
    try:
        (width, height), _ = spreads.image_size(dest)
    except Exception:
        dest.unlink(missing_ok=True)
        raise PortfolioError(f"{filename}: that isn't an image that can be read")

    existing = db.find_portfolio_page_by_hash(project_id, content_hash)
    if existing and path_for(existing).exists():
        dest.unlink(missing_ok=True)
        return existing, False

    db.insert_portfolio_page(
        page_id, project_id, dest.name, content_hash, width, height,
        filename=filename, uploaded_at=uploaded_at,
    )
    return db.get_portfolio_page(page_id), True


def _remove_file(page):
    path_for(page).unlink(missing_ok=True)


def delete_page(page_id):
    """Delete a staged page and its file. Every slot that used it is emptied
    in the same transaction as the row (db.delete_portfolio_page), and stays
    where it was. Returns the deleted row."""
    page = db.delete_portfolio_page(page_id)
    if not page:
        raise PortfolioError("no such staged page", 404)
    _remove_file(page)
    return page


def project_page_paths(project_id):
    """The files a project has staged -- taken before its rows go, so the
    caller can remove them once db.delete_project has."""
    return [path_for(p) for p in db.list_portfolio_pages(project_id)]


def remove_files(paths):
    for path in paths:
        path.unlink(missing_ok=True)


# --- Slots ------------------------------------------------------------------


def _edit_slots(project_id, edit):
    """Apply `edit(entry) -> bool` to every page entry of every spread in the
    project, writing back the spreads that changed. Returns how many entries
    changed. Goes through db.update_canvas_node so ever_placed stays true."""
    changed = 0
    for node in db.list_spread_nodes(project_id):
        cfg = node["config"] or {}
        count = sum(1 for entry in cfg.get("pages") or [] if isinstance(entry, dict) and edit(entry))
        if count:
            db.update_canvas_node(node["id"], config=cfg)
            changed += count
    return changed


def replace_page(old_id, upload):
    """Stage `upload` as a new page and put it wherever `old_id` was.

    The old page is NOT deleted: it stays in the store as an earlier version,
    unplaced. Each slot keeps its own fit and crop. Returns the new page and
    how many slots changed hands; if the upload turns out to be the same bytes
    as the old page, nothing changes.
    """
    old = _need_page(old_id)
    new, _ = stage_upload(old["project_id"], upload)
    if new["id"] == old["id"]:
        return {"page": new, "slots": 0}

    def swap(entry):
        if entry.get("page_id") != old["id"]:
            return False
        entry["page_id"] = new["id"]
        return True

    return {"page": db.get_portfolio_page(new["id"]), "slots": _edit_slots(old["project_id"], swap)}


def _spread_for(page, node_id):
    node = db.get_canvas_node(node_id) if node_id else None
    if not node or node["kind"] != "pages" or node["project_id"] != page["project_id"]:
        raise PortfolioError("that isn't a spread in this project", 404)
    return node


def place(page_id, node_id, index):
    """Put a staged page into one slot of a spread. Whatever was there stays
    in the store, as it does for a replace. The slot keeps its fit and crop."""
    page = _need_page(page_id)
    node = _spread_for(page, node_id)
    entries = (node["config"] or {}).get("pages") or []
    if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(entries):
        raise PortfolioError("that spread has no such page")
    entries[index]["page_id"] = page["id"]
    db.update_canvas_node(node["id"], config=node["config"])
    return {"node_id": node["id"], "index": index, "page_id": page["id"]}


def _natural_key(filename):
    """Sort key that reads page2 before page10 -- the order an export from
    InDesign or Illustrator numbers its files in."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", filename or "")]


def fill(project_id, node_id):
    """Fill a spread's empty slots, in order, from the pages staged and waiting.

    "Waiting" means never placed: a page that has been on a document and came
    off it is an earlier version, or something the user took off on purpose,
    and putting it straight back would undo that. Candidates go in filename
    order (numbers read as numbers), then upload order. Nothing already placed
    is touched, and the spread never grows -- whatever doesn't fit is counted
    and left staged.
    """
    node = db.get_canvas_node(node_id)
    if not node or node["kind"] != "pages" or node["project_id"] != project_id:
        raise PortfolioError("that isn't a spread in this project", 404)
    entries = (node["config"] or {}).get("pages") or []

    in_use = {
        entry.get("page_id")
        for spread in db.list_spread_nodes(project_id)
        for entry in (spread["config"] or {}).get("pages") or []
        if isinstance(entry, dict)
    }
    waiting = [
        p for p in db.list_portfolio_pages(project_id)
        if not p["ever_placed"] and p["id"] not in in_use
    ]
    waiting.sort(key=lambda p: (_natural_key(p["filename"]), p["uploaded_at"]))
    empty = [i for i, entry in enumerate(entries) if not entry.get("page_id")]

    placed = min(len(empty), len(waiting))
    for slot, page in zip(empty, waiting):
        entries[slot]["page_id"] = page["id"]
    if placed:
        db.update_canvas_node(node["id"], config=node["config"])
    return {
        "placed": placed,
        "left_over": len(waiting) - placed,
        "empty_remaining": len(empty) - placed,
    }


# --- Promotion --------------------------------------------------------------

# Serialises promotions. add_reference's duplicate check and its insert are not
# atomic, so two requests for the same page at once -- a double-click, an
# export's batch racing a button -- could both pass the check and archive it
# twice. Promotion is slow anyway (Claude, then CLIP), and one at a time is
# what the API's rate limits want.
_promote_lock = threading.Lock()


def promote(page_id):
    """Add a staged page to the archive as the user's own work.

    Tagging and embedding happen here, then and only then. Returns
    { reference_id, created, is_own_work }: created is False when the archive
    already held these bytes -- promoting twice, or a page that was migrated
    from an archive reference, whose row was never deleted -- and nothing was
    sent to Claude. The staged page stays where it is.
    """
    page = _need_page(page_id)
    path = path_for(page)
    if not path.exists():
        raise PortfolioError("this page's file is missing", 404)

    title = Path(page["filename"]).stem if page["filename"] else None
    with _promote_lock:
        try:
            result = ingest.add_reference(path, title=title, is_own_work=True)
        except ingest.DuplicateReferenceError as exc:
            existing = exc.existing
            return {
                "reference_id": existing["id"],
                "created": False,
                "is_own_work": bool(existing["is_own_work"]),
            }
    return {"reference_id": result["id"], "created": True, "is_own_work": True}


# --- What the UI shows ------------------------------------------------------


def export_dpi_default(project_id):
    """The Portfolio widget's exportDpi for this project, or the app default.

    The widget is where the setting lives (edited in homepage edit mode like
    any other widget setting); the server reads it from there so that an
    export started from the canvas, with no widget in sight, still follows it.
    """
    for widget in db.list_widgets(project_id):
        if widget["type"] == "portfolio":
            dpi, error = spreads.parse_export_dpi((widget["config"] or {}).get("exportDpi"))
            if not error:
                return dpi
            break
    return spreads.DEFAULT_EXPORT_DPI


def overview(project_id):
    """Everything the widget and the management view draw, in one read: the
    staged pages (with where each sits and whether it is already archived) and
    each spread's slots in page order."""
    stored = db.list_portfolio_pages(project_id)
    known = {p["id"] for p in stored}

    placements = defaultdict(list)
    out_spreads = []
    for ordinal, node in enumerate(db.list_spread_nodes(project_id), 1):
        cfg = node["config"] or {}
        slots = []
        for index, entry in enumerate(cfg.get("pages") or []):
            entry = entry if isinstance(entry, dict) else {}
            page_id = entry.get("page_id")
            # A slot naming a page the store no longer has reads as empty.
            page_id = page_id if page_id in known else None
            slots.append({
                "index": index,
                "number": index + 1,
                "page_id": page_id,
                "fit": entry.get("fit") if entry.get("fit") in spreads.FITS else "contain",
            })
            if page_id:
                placements[page_id].append({
                    "node_id": node["id"], "spread": ordinal, "index": index, "number": index + 1,
                })
        out_spreads.append({
            "node_id": node["id"],
            "ordinal": ordinal,
            "orientation": cfg.get("orientation", "portrait"),
            "slots": slots,
            "filled": sum(1 for s in slots if s["page_id"]),
            "total": len(slots),
        })

    pages = []
    for page in stored:
        here = placements.get(page["id"], [])
        spread = next((s for s in out_spreads if here and s["node_id"] == here[0]["node_id"]), None)
        slot = spread["slots"][here[0]["index"]] if spread else None
        archived = db.find_by_content_hash(page["content_hash"])
        pages.append({
            "id": page["id"],
            "filename": page["filename"],
            "width": page["width"],
            "height": page["height"],
            "uploaded_at": page["uploaded_at"],
            "ever_placed": page["ever_placed"],
            "placements": here,
            "in_archive": (
                {"reference_id": archived["id"], "is_own_work": archived["is_own_work"]}
                if archived else None
            ),
            # How it prints where it sits -- or, unplaced, on a portrait page.
            "print": spreads.print_check(
                page["width"], page["height"],
                orientation=spread["orientation"] if spread else "portrait",
                fit=slot["fit"] if slot else "contain",
            ),
        })

    return {
        "pages": pages,
        "spreads": out_spreads,
        "export_dpi": export_dpi_default(project_id),
        "dpi_range": [spreads.MIN_EXPORT_DPI, spreads.MAX_EXPORT_DPI],
        "default_dpi": spreads.DEFAULT_EXPORT_DPI,
        "min_print_dpi": spreads.MIN_PRINT_DPI,
    }


# --- Export -----------------------------------------------------------------


def export_pages(node):
    """A spread's entries as spreads.export_pdf wants them: the staged file for
    each slot, or None for one that is empty, belongs to another project, or
    has lost its file -- all of which export as a blank page."""
    pages = []
    for entry in (node["config"] or {}).get("pages") or []:
        entry = entry if isinstance(entry, dict) else {}
        staged = db.get_portfolio_page(entry["page_id"]) if entry.get("page_id") else None
        path = path_for(staged) if staged and staged["project_id"] == node["project_id"] else None
        if path is not None and (path.suffix.lower() not in ingest.IMAGE_EXTS or not path.exists()):
            path = None
        pages.append({
            "path": path,
            "page_id": staged["id"] if path else None,
            "fit": entry.get("fit"),
            "crop": entry.get("crop"),
        })
    return pages


def export_plan(node, dpi):
    """What exporting this spread at `dpi` will do, page by page -- what the
    export dialog shows before anything is sent. The pages that would be
    exported are listed too, in order, without repeats, for an export that
    offers to promote them."""
    pages = export_pages(node)
    plan = spreads.plan_export(pages, (node["config"] or {}).get("orientation", "portrait"), dpi)
    page_ids = []
    for page in pages:
        if page["page_id"] and page["page_id"] not in page_ids:
            page_ids.append(page["page_id"])
    return {
        "dpi": dpi,
        "pages": plan,
        "page_ids": page_ids,
        "downsampled": [p["number"] for p in plan if p["state"] == "downsample"],
        "below_target": [p["number"] for p in plan if p.get("below_target")],
        "blank": [p["number"] for p in plan if p["state"] in ("blank", "unreadable")],
    }


# A browser's download is a navigation, so the page that started it never
# learns when it ends. The export therefore reports its own completion: the
# client names the export (?job=), and asks here whether the stream has run to
# its last byte. That is what lets an export offer to promote its pages "when
# it finishes" and mean it.
_exports = {}
_exports_lock = threading.Lock()
_MAX_TRACKED_EXPORTS = 50
JOB_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _set_export(job_id, state):
    with _exports_lock:
        _exports[job_id] = state
        while len(_exports) > _MAX_TRACKED_EXPORTS:
            _exports.pop(next(iter(_exports)))


def export_state(job_id):
    """"running" | "done" | "failed" | "cancelled", or "unknown" for a job
    that hasn't started (the download may not have begun yet)."""
    with _exports_lock:
        return _exports.get(job_id, "unknown")


def track_export(job_id, stream):
    """Pass `stream` through, recording how it ends under `job_id`."""
    if not job_id:
        yield from stream
        return
    _set_export(job_id, "running")
    try:
        yield from stream
    except GeneratorExit:
        # The browser stopped listening (the download was cancelled).
        _set_export(job_id, "cancelled")
        raise
    except Exception:
        _set_export(job_id, "failed")
        raise
    _set_export(job_id, "done")


# --- Migration --------------------------------------------------------------


def _stage_reference(project_id, ref_id, cache):
    """Copy an archive reference's image into the store: its page id, or None
    if it can't be (no such reference, not an image, file gone)."""
    key = (project_id, ref_id)
    if key in cache:
        return cache[key]
    page_id = None
    ref = db.get_reference(ref_id)
    if ref and ref["type"] == "image":
        source = config.REFERENCES_DIR / ref["filepath"]
        if source.exists():
            # The archive stores no original filename, only a title, so the
            # title is the best name a migrated page has.
            name = f"{ref['title'] or Path(ref['filepath']).stem}{source.suffix.lower()}"
            try:
                page, _ = stage_path(project_id, source, filename=name, uploaded_at=ref["date_added"])
                page_id = page["id"]
            except PortfolioError:
                page_id = None
    cache[key] = page_id
    return page_id


def migrate_spread_references():
    """Repoint spreads that still name archive references at staged copies.

    Spreads used to fill their pages with is_own_work references. Only a
    reference a spread's config actually NAMES is a portfolio page:
    is_own_work is also set by the Add tab's own checkbox, so the flag alone
    would sweep up work that was never on a page. Those are left alone, as
    is every archive row -- the page gets a copy, and the reference stays
    exactly where it was, because the user may have come to rely on it.

    Idempotent, and safe to run on every start: an entry already in the new
    shape is skipped, a page already staged (same bytes, same project) is
    reused rather than copied again, and an entry that can't be resolved is
    left exactly as it was to be retried -- an upload still being ingested is
    the one that matters, and it resolves once the capture finishes. Every
    spread about to change is first written to a backup beside the staged
    pages, so the old shape is recoverable by hand.

    Returns a report of what happened.
    """
    report = {"spreads": 0, "migrated": 0, "emptied": 0, "left": []}
    cache = {}
    plans = []

    for node in db.list_spread_nodes():
        cfg = node["config"]
        entries = cfg.get("pages") if isinstance(cfg, dict) else None
        if not isinstance(entries, list):
            continue
        before = json.loads(json.dumps(cfg))
        changed = False

        for entry in entries:
            if not isinstance(entry, dict) or not ({"reference_id", "capture_id"} & entry.keys()):
                continue
            ref_id = entry.get("reference_id")
            if not ref_id and entry.get("capture_id"):
                capture = db.get_capture(entry["capture_id"])
                if capture and capture["status"] in db.CAPTURE_PENDING_STATUSES:
                    report["left"].append({"node_id": node["id"], "reason": "upload still being added"})
                    continue
                if capture and capture["reference_id"]:
                    ref_id = capture["reference_id"]
                # A failed or vanished capture was an empty slot already: the
                # old client put it back to empty the next time it looked.

            if not ref_id:
                page_id = None
                report["emptied"] += 1
            else:
                page_id = _stage_reference(node["project_id"], ref_id, cache)
                if page_id is None:
                    report["left"].append({
                        "node_id": node["id"], "reference_id": ref_id,
                        "reason": "its image can't be found in the archive",
                    })
                    continue
                report["migrated"] += 1

            entry["page_id"] = page_id
            entry.pop("reference_id", None)
            entry.pop("capture_id", None)
            changed = True

        if changed:
            plans.append((node, cfg, before))

    if plans:
        config.PORTFOLIO_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        backup = config.PORTFOLIO_DIR / f"spreads-before-staging-{stamp}.json"
        backup.write_text(json.dumps({node["id"]: before for node, _, before in plans}, indent=2))
        for node, cfg, _ in plans:
            db.update_canvas_node(node["id"], config=cfg)
            report["spreads"] += 1
    return report
