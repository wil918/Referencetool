"""Web captures from the browser extension.

The extension is a capture client: it collects an image (or a text selection)
plus whatever provenance it can read off the page, and hands the whole thing
here. Everything downstream -- storage, tagging, embedding, duplicate
detection, project membership -- is the existing pipeline, reached through
`ingest.add_reference`. Nothing in this module writes to reference_items or
touches Chroma directly.

Why a queue rather than a plain function call: ingesting one image runs a
Claude tagging request and a CLIP encode (which downloads a ~600MB model the
first time), so it takes seconds. A browser popup is destroyed the moment it
loses focus, taking any in-flight request with it. So the HTTP layer accepts a
capture, writes it down, and returns immediately; this worker does the slow
part afterwards. The capture row is the queue, so work survives a restart.
"""
import json
import queue
import re
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from urllib.parse import urlparse

import db
import ingest

# Captures whose bytes are waiting to be processed live here until the worker
# picks them up, so a restart mid-queue can still find them.
PENDING_DIR = Path(tempfile.gettempdir()) / "fashion-ref-captures"

# Text captures become .txt files so they flow through the same ingest path as
# a typed-in text reference; images keep whatever extension they arrived with.
DEFAULT_IMAGE_EXT = ".jpg"

_queue = queue.Queue()
_worker = None
_worker_lock = threading.Lock()


class CaptureError(Exception):
    """A capture that could not be accepted at all (bad payload, no content)."""


# --- Envelope -> archive field mapping -------------------------------------
#
# The extension sends a rich envelope; reference_items has title/source/notes.
# These three functions are the whole translation, kept together so it's clear
# what the archive actually ends up storing versus what stays in `captures`.


def envelope_title(envelope):
    """Best available title, or None to let ingest fall back to its own logic.

    Deliberately does NOT invent one: if the page gave us nothing usable,
    returning None lets `ingest.add_reference` use Claude's suggested title,
    which is better than a filename like "media" or a bare domain.
    """
    meta = envelope.get("metadata") or {}
    for key in ("title", "caption"):
        value = (meta.get(key) or "").strip()
        if value:
            return value[:200]

    source = envelope.get("source") or {}
    page_title = (source.get("page_title") or "").strip()
    return page_title[:200] or None


# Metadata sources that represent an explicit, machine-readable claim by the
# publisher, as opposed to something guessed from surrounding page text.
AUTHORITATIVE_SOURCES = {"json-ld", "opengraph", "dublin-core", "schema.org"}


def authoritative_title(envelope):
    """The title only if the page stated it outright, otherwise None.

    `ingest.add_reference` replaces a supplied title with Claude's suggestion
    when the two don't appear related -- that exists so camera filenames like
    "IMG_2384" get something descriptive, and it's the right default for a
    dragged-in file. But a title lifted from a museum object's JSON-LD is a
    publisher's own statement of what the thing is called, and is worth more
    than a guess made from the pixels. Where the title came from structured
    metadata, it's restored after ingest; where it was scraped from nearby
    text, the existing heuristic is left to do its job.
    """
    for record in envelope.get("metadata_provenance") or []:
        if record.get("field") != "title":
            continue
        if (record.get("source") or "").lower() not in AUTHORITATIVE_SOURCES:
            continue
        value = (record.get("value") or "").strip()
        if value and not _is_bare_site_name(value, envelope):
            return value[:200]
    return None


def _is_bare_site_name(value, envelope):
    """True if `value` is just the site's own brand name, not a real title
    for the specific thing being captured.

    Single-page apps commonly render their <meta>/OpenGraph tags once, in the
    initial page shell, and never update them again as the user navigates
    client-side to a specific item. Pinterest does exactly this on its search
    and board pages: og:title is the literal string "Pinterest" no matter
    which pin is on screen. Treating that as "the publisher's own stated
    title" is worse than not treating it as authoritative at all, since it
    actively overwrites ingest's own Claude-vision title guess (see
    ingest.add_reference / envelope_title) with something that names the
    site, not the thing being saved.
    """
    domain = _clean_domain((envelope.get("source") or {}).get("domain"))
    if not domain:
        return False
    brand = domain.split(".")[0]
    return bool(brand) and re.sub(r"[^a-z0-9]", "", value.lower()) == brand


def envelope_source(envelope):
    """A short human-readable origin for the existing carousel's Source line.

    The carousel renders `source` as plain text (never a link), so a bare URL
    would read badly there. The full URL chain stays in the capture row.
    """
    source = envelope.get("source") or {}
    meta = envelope.get("metadata") or {}

    domain = _clean_domain(source.get("domain")) or _domain_of(
        source.get("url") or source.get("canonical_url") or ""
    )

    # Prefer a credited creator/publication over the domain -- on a museum or
    # journal page that's the more meaningful attribution.
    credit = ""
    for key in ("creator", "author", "publication", "institution"):
        value = (meta.get(key) or "").strip()
        if value:
            credit = value
            break

    if credit and domain:
        return f"{credit} — {domain}"
    return credit or domain or None


def envelope_notes(envelope):
    """The user's own note, preserved exactly.

    This is the one field the person actually typed, and it records WHY they
    saved something -- so it is never merged with, or overwritten by, anything
    extracted from the page.
    """
    note = envelope.get("user_note")
    return note if note else None


def _clean_domain(domain):
    """Normalise a hostname the same way regardless of who supplied it.

    The extension sends whatever `location.hostname` gave it, so this has to
    match what _domain_of derives -- otherwise the same site reads as
    "www.dezeen.com" in one capture and "dezeen.com" in the next.
    """
    domain = (domain or "").strip().lower()
    prefix = "www."
    if domain.startswith(prefix):
        domain = domain[len(prefix):]
    return domain


def _domain_of(url):
    try:
        return _clean_domain(urlparse(url).hostname)
    except (ValueError, AttributeError):
        return ""


def _urls_of(envelope):
    source = envelope.get("source") or {}
    content = envelope.get("content") or {}
    domain = _clean_domain(source.get("domain")) or _domain_of(source.get("url") or "")
    return {
        "source_url": source.get("url") or None,
        "canonical_url": source.get("canonical_url") or None,
        "image_url": content.get("image_url") or None,
        "domain": domain or None,
    }


# --- Duplicate detection ---------------------------------------------------


def check_duplicate(envelope, file_path=None):
    """Has this been captured before? Returns a dict, or None if it's new.

    Two independent signals, cheapest first:

      1. URL. Catches re-capturing the same image from the same page without
         downloading anything, which is what makes the popup able to warn
         before the user commits.
      2. Content hash. The authoritative check -- the same image served from
         two different URLs is still the same image. Only possible once bytes
         are on disk, and it reuses the exact hash the archive already stores.
    """
    urls = _urls_of(envelope)

    if file_path is not None:
        existing = db.find_by_content_hash(ingest._file_hash(file_path))
        if existing:
            return {
                "reason": "content_hash",
                "reference_id": existing["id"],
                "title": existing["title"],
            }

    # Only match on image_url/canonical_url. source_url alone is too broad --
    # two different images on one article page share it.
    prior = db.find_captures_by_urls(
        image_url=urls["image_url"],
        canonical_url=urls["canonical_url"] if not urls["image_url"] else None,
    )
    for row in prior:
        if row["status"] in db.CAPTURE_PENDING_STATUSES:
            return {"reason": "in_progress", "capture_id": row["id"], "reference_id": None}
        if row["reference_id"]:
            ref = db.get_reference(row["reference_id"])
            if ref:
                return {
                    "reason": "url",
                    "reference_id": ref["id"],
                    "title": ref["title"],
                    "capture_id": row["id"],
                }
    return None


# --- Accepting a capture ---------------------------------------------------


def accept(envelope, upload=None, text=None):
    """Persist a capture and queue it. Returns the capture row.

    Exactly one of `upload` (a werkzeug FileStorage) or `text` is expected.
    Returns as soon as the bytes are safely on disk and the row is written --
    all the slow work happens on the worker.
    """
    kind = envelope.get("type") or ("text" if text is not None else "image")
    capture_id = str(uuid.uuid4())
    PENDING_DIR.mkdir(parents=True, exist_ok=True)

    if upload is not None:
        ext = Path(upload.filename or "").suffix.lower()
        if ext not in ingest.IMAGE_EXTS and ext not in ingest.PDF_EXTS:
            ext = DEFAULT_IMAGE_EXT
        stored = PENDING_DIR / f"{capture_id}{ext}"
        upload.save(stored)
    elif text is not None:
        if not text.strip():
            raise CaptureError("no text provided")
        stored = PENDING_DIR / f"{capture_id}.txt"
        stored.write_text(text, encoding="utf-8")
    else:
        raise CaptureError("capture has no image or text content")

    urls = _urls_of(envelope)
    envelope = dict(envelope)
    envelope["_pending_file"] = str(stored)

    db.create_capture(
        capture_id=capture_id,
        kind=kind,
        envelope=envelope,
        source_url=urls["source_url"],
        canonical_url=urls["canonical_url"],
        image_url=urls["image_url"],
        domain=urls["domain"],
    )
    _enqueue(capture_id)
    return db.get_capture(capture_id)


def _enqueue(capture_id):
    ensure_worker()
    _queue.put(capture_id)


# --- The worker ------------------------------------------------------------


def ensure_worker():
    """Start the background worker once, lazily.

    Daemon thread: this is a local single-user app, and a half-finished
    capture is re-queued from the database on next boot anyway, so there's
    nothing to gain from blocking shutdown on it.
    """
    global _worker
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, name="capture-worker", daemon=True)
            _worker.start()
    return _worker


def _run():
    while True:
        capture_id = _queue.get()
        try:
            process(capture_id)
        except Exception as e:  # a bad capture must never kill the worker
            try:
                db.update_capture(capture_id, db.CAPTURE_FAILED, error=str(e))
            except Exception:
                pass
        finally:
            _queue.task_done()


def process(capture_id):
    """Run one capture through the existing ingest pipeline."""
    row = db.get_capture(capture_id)
    if not row or row["status"] not in db.CAPTURE_PENDING_STATUSES:
        return  # already handled, or vanished

    envelope = row["envelope"]
    pending = envelope.get("_pending_file")
    path = Path(pending) if pending else None
    if not path or not path.exists():
        db.update_capture(capture_id, db.CAPTURE_FAILED, error="captured file is missing")
        return

    db.update_capture(capture_id, db.CAPTURE_PROCESSING)

    try:
        result = ingest.add_reference(
            path,
            title=envelope_title(envelope),
            source=envelope_source(envelope),
            notes=envelope_notes(envelope),
        )
        reference_id = result["id"]
        status = db.CAPTURE_DONE
        error = None

        # Ingest may have swapped in Claude's suggested title; if the page
        # stated a title outright, that wins. See authoritative_title().
        stated = authoritative_title(envelope)
        if stated and result["title"] != stated:
            # ingest.add_reference already deduped its own title choice
            # against the archive; this is a second, independent write, so it
            # needs the same check -- otherwise two structured-metadata
            # captures with the same real title (e.g. the same museum object
            # saved from two different pages) would collide silently.
            db.update_reference_title(reference_id, ingest.dedupe_title(stated))
    except ingest.DuplicateReferenceError as e:
        # Not a failure: the archive already holds these exact bytes. Point the
        # capture at the reference that already exists so the extension can
        # offer to open it or add it to a project.
        reference_id = e.existing["id"]
        status = db.CAPTURE_DUPLICATE
        error = None
    except Exception as e:
        db.update_capture(capture_id, db.CAPTURE_FAILED, error=str(e))
        return
    finally:
        path.unlink(missing_ok=True)

    # Project membership is idempotent (INSERT OR IGNORE), so this is safe for
    # a duplicate too -- capturing something again into a new project is a
    # reasonable thing to want.
    for project_id in envelope.get("project_ids") or []:
        if db.get_project(project_id):
            db.add_reference_to_project(project_id, reference_id)

    db.update_capture(capture_id, status, reference_id=reference_id, error=error)


def resume_pending():
    """Re-queue anything left unfinished by a previous run.

    Called at startup. Captures whose temp file didn't survive are marked
    failed rather than left queued forever -- the extension can then offer a
    re-capture instead of the row sitting there silently.
    """
    resumed, lost = 0, 0
    for row in db.list_pending_captures():
        pending = (row["envelope"] or {}).get("_pending_file")
        if pending and Path(pending).exists():
            _enqueue(row["id"])
            resumed += 1
        else:
            db.update_capture(
                row["id"], db.CAPTURE_FAILED, error="captured file did not survive restart"
            )
            lost += 1
    return resumed, lost


def summary(row):
    """The public shape of a capture -- what the extension polls for."""
    if not row:
        return None
    envelope = row.get("envelope") or {}
    out = {
        "capture_id": row["id"],
        "status": row["status"],
        "kind": row["kind"],
        "reference_id": row["reference_id"],
        "error": row["error"],
        "source_url": row["source_url"],
        "image_url": row["image_url"],
        "created_at": row["created_at"],
    }
    if row["reference_id"]:
        ref = db.get_reference(row["reference_id"])
        if ref:
            out["reference"] = {
                "id": ref["id"],
                "title": ref["title"],
                "type": ref["type"],
                "tags": ref["tags"],
            }
    if envelope.get("user_note"):
        out["user_note"] = envelope["user_note"]
    return out
