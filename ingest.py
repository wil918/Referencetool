"""Core logic for adding a new reference: copy file, tag it, embed it, store it."""
import hashlib
import re
import shutil
import tempfile
import uuid
from pathlib import Path

import fitz  # PyMuPDF

from config import IMAGES_DIR, TEXTS_DIR
import colour
import db
import embeddings
import tagging

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
TEXT_EXTS = {".txt", ".md"}
PDF_EXTS = {".pdf"}
SUPPORTED_EXTS = IMAGE_EXTS | TEXT_EXTS | PDF_EXTS

# Embedded images smaller than this (in pixels, width*height) are almost
# always icons, bullets, or decorative flourishes -- skip them.
MIN_PDF_IMAGE_AREA = 10_000
MAX_PDF_IMAGES = 4


class DuplicateReferenceError(Exception):
    """Raised when a file's content exactly matches a reference already in the library."""

    def __init__(self, existing):
        self.existing = existing
        super().__init__(
            f"identical file already added as '{existing['title']}' (id {existing['id'][:8]})"
        )


def _title_seems_related(title, tags, description):
    """Rough check for whether `title` already reflects the tagged content.

    A title sharing a real word with its own tags/description (e.g. a
    filename like "blue-jacket-detail" whose tags include "jacket") is left
    alone. A title with no such overlap -- a camera-generated name like
    "IMG_2384", or one that's just unrelated -- gets replaced by Claude's
    suggested title instead.

    Filenames are often several words mashed together with no separator
    ("husseinchalayan", "chloevanderstraeten2"), which a word-boundary match
    against prose would always miss -- so a long token also gets checked
    against the haystack with its own spaces stripped, and again with any
    trailing digits removed (a common "second/third upload" suffix that
    isn't part of the actual name).
    """
    tokens = [t for t in re.split(r"[^a-z0-9]+", title.lower()) if len(t) > 2]
    if not tokens:
        return True  # nothing meaningful to compare against -- leave it alone

    haystack = " ".join(tags).lower() + " " + (description or "").lower()
    haystack_nospace = re.sub(r"[^a-z0-9]+", "", haystack)

    def variants(tok):
        yield tok
        stripped = tok.rstrip("0123456789")
        if len(stripped) >= 4 and stripped != tok:
            yield stripped

    for tok in tokens:
        for v in variants(tok):
            if v in haystack:
                return True
            if len(v) >= 6 and v in haystack_nospace:
                return True
    return False


_TITLE_SUFFIX_RE = re.compile(r"^(.*) \((\d+)\)$")


def dedupe_title(title):
    """Append a numeric suffix if `title` is already used somewhere in the
    archive, so the grid doesn't fill up with indistinguishable rows.

    The first reference to use a title keeps it bare; a second becomes
    "Title (2)", a third "Title (3)", always picking the lowest number not
    already taken (so deleting "Title (2)" later means the next collision
    reuses it, rather than climbing straight to "(4)"). Comparison is
    case-insensitive -- "Sketch" and "sketch" read as the same title to a
    person scanning the archive, even if Claude or a captured page happened
    to capitalise them differently.

    Shared by both the CLI/upload path (`add_reference`, below) and the
    browser extension's capture pipeline (`capture.py`), since a title can be
    reassigned after the fact there too (see its authoritative_title()).
    """
    if not title:
        return title

    candidates = db.find_titles_like(title)
    lower_title = title.lower()
    if not any(c.lower() == lower_title for c in candidates):
        return title

    used = {1}
    for c in candidates:
        m = _TITLE_SUFFIX_RE.match(c)
        if m and m.group(1).lower() == lower_title:
            used.add(int(m.group(2)))

    n = 2
    while n in used:
        n += 1
    return f"{title} ({n})"


def _file_hash(path, chunk_size=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            h.update(chunk)
    return h.hexdigest()


def _extract_pdf_content(path):
    """Pull text and the most significant embedded images out of a PDF.

    Returns (full_text, [Path, ...]) -- the image paths point at temp files
    the caller should delete once done with them.
    """
    doc = fitz.open(path)
    text_parts = []
    candidates = []  # (area, xref)

    for page in doc:
        text_parts.append(page.get_text())
        for img in page.get_images(full=True):
            xref, width, height = img[0], img[2], img[3]
            if width * height >= MIN_PDF_IMAGE_AREA:
                candidates.append((width * height, xref))

    full_text = "\n".join(text_parts)

    # Largest images first -- most likely to be actual photos/sketches
    # rather than small logos or bullet graphics.
    candidates.sort(key=lambda c: c[0], reverse=True)

    extracted_paths = []
    seen_xrefs = set()
    for _, xref in candidates:
        if xref in seen_xrefs:
            continue
        if len(extracted_paths) >= MAX_PDF_IMAGES:
            break
        seen_xrefs.add(xref)
        try:
            base_image = doc.extract_image(xref)
            out_path = Path(tempfile.gettempdir()) / f"pdfimg_{uuid.uuid4().hex}.{base_image['ext']}"
            out_path.write_bytes(base_image["image"])
            extracted_paths.append(out_path)
        except Exception:
            continue  # skip any image that fails to extract, don't fail the whole PDF

    doc.close()
    return full_text, extracted_paths


# --- PDF page splitting ------------------------------------------------------
#
# Turns a multi-page PDF into one rendered image per page, so a lookbook or
# scanned catalogue can be tagged, embedded and searched page by page instead
# of living in the archive as a single opaque document.

# Pages rendered as standalone references need to hold up to zooming, colour
# analysis and printing -- a different question from app.py's PDF_THUMB_DPI,
# which only has to look right at grid-thumbnail size, so this gets its own
# constant rather than reusing that one.
#
# Duplicate detection (add_reference's content hash) only recognises a
# re-split of the same PDF as the archive's existing pages while this stays
# fixed -- change it and the same document will render to different bytes and
# come in as a second set of references instead of resolving to the first.
PDF_SPLIT_DPI = 150


def pdf_page_count(path):
    doc = fitz.open(path)
    try:
        return doc.page_count
    finally:
        doc.close()


def parse_page_range(range_str, page_count):
    """Parse a 1-based page range like "3-7" or "1,4,9-12" into a sorted list
    of 0-based page indices. Blank or None means every page.

    Comma-separated so a handful of scattered spreads can be picked without
    typing out every number in between; each part is validated against the
    document's own page count rather than silently clamped, so a typo doesn't
    quietly import the wrong pages.
    """
    if not range_str or not range_str.strip():
        return list(range(page_count))

    indices = set()
    for part in range_str.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start_str, _, end_str = part.partition("-")
        else:
            start_str = end_str = part
        try:
            start_n, end_n = int(start_str.strip()), int(end_str.strip())
        except ValueError:
            raise ValueError(f"'{part}' is not a valid page or page range")
        if start_n < 1 or end_n > page_count or start_n > end_n:
            raise ValueError(f"'{part}' is out of range for a {page_count}-page document")
        indices.update(range(start_n - 1, end_n))

    return sorted(indices)


def render_pdf_pages(path, page_indices):
    """Render the given 0-based page indices of a PDF to standalone PNG files
    at PDF_SPLIT_DPI. Returns [(page_number, Path), ...] in the order given --
    page_number is 1-based, for naming. Caller owns the returned temp files.
    """
    doc = fitz.open(path)
    try:
        rendered = []
        for i in page_indices:
            pix = doc[i].get_pixmap(dpi=PDF_SPLIT_DPI)
            out_path = Path(tempfile.gettempdir()) / f"pdfpage_{uuid.uuid4().hex}.png"
            pix.save(out_path)
            rendered.append((i + 1, out_path))
        return rendered
    finally:
        doc.close()


def add_reference(source_path, title=None, source=None, notes=None, force=False, is_own_work=False):
    source_path = Path(source_path).expanduser().resolve()
    if not source_path.exists():
        raise FileNotFoundError(f"No file at {source_path}")

    content_hash = _file_hash(source_path)
    if not force:
        existing = db.find_by_content_hash(content_hash)
        if existing:
            raise DuplicateReferenceError(existing)

    ext = source_path.suffix.lower()
    ref_id = str(uuid.uuid4())
    title = title or source_path.stem

    if ext in IMAGE_EXTS:
        ref_type = "image"
        print("  tagging image with Claude...")
        suggested_title, tags, description = tagging.tag_image(source_path)
        print("  generating embedding...")
        embedding = embeddings.embed_image(source_path)
        dest = IMAGES_DIR / f"{ref_id}{ext}"

    elif ext in TEXT_EXTS or ext in PDF_EXTS:
        ref_type = "text"

        extracted_images = []
        if ext in PDF_EXTS:
            full_text, extracted_images = _extract_pdf_content(source_path)
        else:
            full_text = source_path.read_text(encoding="utf-8", errors="ignore")

        print("  tagging with Claude...")
        if extracted_images:
            print(f"  ({len(extracted_images)} embedded image(s) found, analyzing alongside the text)")
            suggested_title, tags, description = tagging.tag_pdf(full_text, extracted_images, title=title)
        else:
            suggested_title, tags, description = tagging.tag_text(full_text, title=title)

        print("  generating embedding...")
        embedding = embeddings.embed_combined(text=full_text, image_paths=extracted_images)

        for p in extracted_images:
            p.unlink(missing_ok=True)

        dest = TEXTS_DIR / f"{ref_id}{ext}"

    else:
        raise ValueError(
            f"Unsupported file type: {ext} "
            f"(supported: images {sorted(IMAGE_EXTS)}, text {sorted(TEXT_EXTS | PDF_EXTS)})"
        )

    # The file on disk keeps its own name/extension regardless -- this only
    # decides what's shown as the title. If the starting title (usually the
    # original filename) doesn't share any real word with what Claude found
    # in the content, prefer Claude's more descriptive suggestion.
    if suggested_title and not _title_seems_related(title, tags, description):
        title = suggested_title

    title = dedupe_title(title)

    # Only copy the file into the library once tagging and embedding have
    # both succeeded -- avoids leaving orphaned copies behind on failure.
    shutil.copy2(source_path, dest)

    relative_path = str(dest.relative_to(dest.parents[1]))
    db.insert_reference(
        ref_id=ref_id,
        type_=ref_type,
        filepath=relative_path,
        title=title,
        source=source,
        tags=tags,
        description=description,
        notes=notes,
        content_hash=content_hash,
        is_own_work=is_own_work,
    )
    embeddings.add_to_index(
        ref_id=ref_id,
        embedding=embedding,
        metadata={
            "title": title,
            "type": ref_type,
            "tags": ", ".join(tags),
        },
    )

    if ref_type == "image":
        # Derived data, not part of what "adding a reference" means to
        # succeed at -- a failure here shouldn't undo the copy/tag/embed
        # that already happened, so it's logged and moved past exactly like
        # a reference that's missing a profile is already handled elsewhere
        # (colour.profile_for_reference computes it lazily on demand).
        try:
            profile = colour.analyse_image(dest)
            db.save_colour_analysis(
                ref_id, colour.ANALYSIS_VERSION, content_hash, colour.profile_to_json(profile)
            )
        except Exception as e:
            print(f"  colour analysis failed: {e}")

    return {
        "id": ref_id,
        "title": title,
        "type": ref_type,
        "tags": tags,
        "description": description,
        "is_own_work": is_own_work,
    }


def add_folder(folder_path, source=None, notes=None, recursive=False, force=False, is_own_work=False):
    """Add every supported file in a folder. Returns (results, skipped, errors).

    Fails fast (before touching any file) if the Claude API key isn't set,
    rather than failing once per file in the folder. Files identical to ones
    already in the library are skipped, not treated as errors.
    """
    folder_path = Path(folder_path).expanduser().resolve()
    if not folder_path.is_dir():
        raise NotADirectoryError(f"{folder_path} is not a folder")

    tagging.get_client()  # raises immediately if ANTHROPIC_API_KEY is missing

    pattern = "**/*" if recursive else "*"
    files = sorted(
        p for p in folder_path.glob(pattern)
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS
    )

    if not files:
        print(f"No supported files found in {folder_path}")
        return [], [], []

    results, skipped, errors = [], [], []
    for i, path in enumerate(files, 1):
        print(f"\n[{i}/{len(files)}] {path.name}")
        try:
            result = add_reference(path, source=source, notes=notes, force=force, is_own_work=is_own_work)
            results.append(result)
        except DuplicateReferenceError as e:
            print(f"  SKIPPED: {e}")
            skipped.append((path, str(e)))
        except Exception as e:
            print(f"  FAILED: {e}")
            errors.append((path, str(e)))
    return results, skipped, errors
