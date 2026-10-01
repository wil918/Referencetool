"""Getting reference bytes out of the archive as real files.

app.py's API deliberately never exposes a reference's on-disk path (see
CLAUDE.md) -- a UUID filename is meaningless to drop into InDesign or
Photoshop. This module builds the safe, human-readable filename a download
uses instead, and streams a zip of several references to disk (never
assembled in memory -- a folder of 40 images is tens of megabytes) for the
archive and project grids' bulk export.
"""
import re
import zipfile
from pathlib import Path

# Characters macOS, Windows or Linux (or Finder/Explorer specifically) reject
# or treat specially in a filename, plus C0 control characters.
_UNSAFE_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WHITESPACE_RE = re.compile(r"\s+")

# Comfortably under every filesystem's real limit (255 bytes on macOS/Linux)
# even after a " (2)" suffix and a multi-character extension are added.
MAX_STEM_LENGTH = 120


def slugify_title(title):
    """A reference title, made safe as a filename stem on any platform.

    Deliberately not Werkzeug's secure_filename: that ASCII-folds, which
    would mangle a title in Cyrillic script, CJK characters or German
    umlauts. This only strips what a filesystem actually rejects, collapses
    whitespace, and caps the length -- everything else about the title
    (accents, non-Latin scripts, punctuation Finder doesn't mind) survives.
    """
    cleaned = _UNSAFE_CHARS_RE.sub("", title or "")
    cleaned = _WHITESPACE_RE.sub(" ", cleaned).strip()
    cleaned = cleaned.strip(" .")  # Windows rejects a trailing dot or space
    cleaned = cleaned[:MAX_STEM_LENGTH].strip(" .")
    return cleaned or "reference"


def unique_filename(title, ext, used):
    """slugify_title(title) + ext, deduped against `used` -- a set of
    lowercase filenames already claimed (lowercase because macOS's default
    filesystem is case-insensitive, so "Title.jpg" and "title.jpg" would
    still collide on disk). Mutates `used` with whatever it returns.

    Same " (2)", " (3)" convention as ingest.dedupe_title, so a duplicate
    title reads the same way whether it collided at ingest time or only
    after slugifying stripped out what made two titles look different (e.g.
    "Balenciaga: 1967" and "Balenciaga / 1967" both become "Balenciaga
    1967").
    """
    stem = slugify_title(title)
    candidate = f"{stem}{ext}"
    n = 2
    while candidate.lower() in used:
        candidate = f"{stem} ({n}){ext}"
        n += 1
    used.add(candidate.lower())
    return candidate


def download_filename(ref):
    """The Content-Disposition filename for a single reference's download."""
    ext = Path(ref["filepath"]).suffix.lower()
    return unique_filename(ref["title"], ext, set())


def write_zip(dest_path, ordered_refs, resolve_path):
    """Write a zip of `ordered_refs` to `dest_path` on disk.

    `ordered_refs` is already in the order the caller wants preserved (the
    order references appeared on screen) -- each entry is prefixed with a
    zero-padded index so extracting the zip keeps that order, the way a
    line-up needs to stay in order once placed. `resolve_path(ref)` maps a
    reference dict to its file on disk; a reference whose file has gone
    missing is skipped rather than failing the whole export.

    Writes straight to the zip on disk via zipfile's own streaming writer --
    nothing here holds more than one file's bytes in memory at a time, so
    this scales to a large selection without ballooning the process's RSS.
    """
    width = len(str(len(ordered_refs))) or 1
    used = set()
    with zipfile.ZipFile(dest_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, ref in enumerate(ordered_refs, 1):
            path = resolve_path(ref)
            if not path.exists():
                continue
            ext = path.suffix.lower()
            name = unique_filename(ref["title"], ext, used)
            zf.write(path, f"{i:0{width}d} - {name}")
