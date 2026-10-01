"""On-disk thumbnail cache for reference images.

Every card -- archive grid, project grids, canvas nodes, the carousel's
similar-items strip -- used to draw from the full-size original decoded at
full resolution. This generates a small resized copy once and serves that
instead.

Same derived-data shape as `colour_analysis` (hard rule 8): recomputable,
versioned, nothing here is load-bearing data. The difference is the cache
key. colour_analysis is keyed by reference_id because the row has to be
*found* for a specific reference; a thumbnail is pure function of the bytes,
so it's keyed by content_hash instead -- two references with identical bytes
share one file for free, and session A6's rotate (which changes
content_hash) can't leave a stale thumbnail of the un-rotated image behind.
"""
import os

from PIL import Image, ImageOps

import config
import ingest

# Bump whenever the resize target, format choice or quality changes. A stale
# cache entry at an old version is just never looked up again -- nothing
# reads the mismatch as an error, and the file can be swept by hand or left.
THUMBNAIL_VERSION = 1

# Long enough edge for a grid cell or canvas node at typical zoom; short
# enough that decoding it costs nothing compared to the original.
MAX_EDGE = 400
JPEG_QUALITY = 82


def _cache_path(content_hash, suffix):
    return config.THUMBNAILS_DIR / f"{content_hash}_v{THUMBNAIL_VERSION}{suffix}"


def _existing(content_hash):
    """An already-cached thumbnail for this content, if one exists, as
    (path, mimetype). Checked before touching the original file at all."""
    for suffix, mimetype in ((".jpg", "image/jpeg"), (".png", "image/png")):
        path = _cache_path(content_hash, suffix)
        if path.exists():
            return path, mimetype
    return None


def _has_transparency(img):
    if img.mode == "P":
        return "transparency" in img.info
    if img.mode in ("RGBA", "LA"):
        return img.getchannel("A").getextrema()[0] < 255
    return False


def thumbnail_for(path, content_hash=None):
    """A thumbnail of the image at `path`, generating and caching it first
    if this content hasn't been thumbnailed at the current version yet.

    Returns (cache_path, mimetype). Raises on a file Pillow can't open --
    the caller falls back to serving the original, the same way a missing
    colour profile just means no colour feature rather than a 500.

    `content_hash` is the reference's own hash, which every image has had
    since ingest.add_reference started recording one. A row from before
    that column existed falls back to hashing the file itself here -- still
    correct, just without the free sharing a stored hash gives for nothing.
    """
    content_hash = content_hash or ingest._file_hash(path)

    cached = _existing(content_hash)
    if cached:
        return cached

    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)  # bake in orientation before resizing
        has_alpha = _has_transparency(img)
        img.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)

        if has_alpha:
            suffix, mimetype = ".png", "image/png"
            out = img.convert("RGBA")
        else:
            suffix, mimetype = ".jpg", "image/jpeg"
            out = img.convert("RGB")

    # The directory is derived data too -- deleting it (to reclaim space, or
    # by hand while debugging) must cost nothing but regenerating whatever is
    # asked for next, never a crash on the next request.
    config.THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)

    cache_path = _cache_path(content_hash, suffix)
    # Write beside the final name and rename into place -- a reader that
    # lands between the write and the rename sees either nothing or the
    # complete file, never a half-written one.
    tmp_path = cache_path.with_name(f".{cache_path.name}.tmp-{os.getpid()}")
    if suffix == ".jpg":
        out.save(tmp_path, "JPEG", quality=JPEG_QUALITY)
    else:
        out.save(tmp_path, "PNG", optimize=True)
    tmp_path.replace(cache_path)

    return cache_path, mimetype
