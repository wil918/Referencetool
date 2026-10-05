"""Portfolio spreads: A4 pages on the canvas, and the PDF they become.

A spread is one canvas node (kind "pages") that owns its pages -- their count,
orientation, spacing and order all live in the node's config, with each page
an entry { page_id, fit, crop? } pointing at a page in the staging store
(portfolio.py). A page with no page_id is an empty slot, which is the normal
state of a portfolio in progress, not an error.

Where the pages sit on the canvas is the browser's business
(static/project/canvas/spread-layout.js). This module is the print side: what
an image will look like on paper, and the PDF export itself.

The export streams. PyMuPDF has no streaming writer, but an incremental save
only ever *appends* to a PDF -- every byte already written stays exactly where
it is -- so the file is built one page at a time, reopening it for each page
and saving incrementally, and whatever each save appended is sent before the
next page is started. At no point is more than one image held in memory, and
a thirty-page export starts arriving after the first page rather than after
the thirtieth.
"""
import io
import tempfile
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image, ImageOps

# ISO 216. The canvas side (spread-layout.js) uses the same two numbers.
A4_MM = (210, 297)
MM_PER_INCH = 25.4
PT_PER_INCH = 72

ORIENTATIONS = ("portrait", "landscape")
LAYOUTS = ("sequential", "booklet")
# Stretching artwork to fill a page is not a mode, and the API refuses it by
# name -- see validate_config.
FITS = ("contain", "cover")

# A page that would print below this looks fine on screen and soft on paper.
# Warned about, never blocked: a draft page at 120dpi is still a page.
MIN_PRINT_DPI = 150
# How far an image's proportions may be from A4 and still count as A4.
A4_TOLERANCE = 0.01
MAX_PAGE_COUNT = 200

# What an export aims for. 300 is what university submission portals ask for
# and what a print shop wants; the Portfolio widget's config.exportDpi
# overrides it for a project and ?dpi= for a single export.
DEFAULT_EXPORT_DPI = 300
MIN_EXPORT_DPI = 72
MAX_EXPORT_DPI = 1200
# An image has to be this much over the target before it is resampled. 5% over
# is a 2480px page landing on 2362px: no one can tell, and the re-encode that
# buys it is a real (if small) loss, so it is left exactly as it came.
DOWNSAMPLE_SLACK = 1.05

# EXIF orientations PyMuPDF can honour by rotating the placed image, which
# keeps a JPEG's own bytes (no re-encode). MuPDF ignores the tag entirely, so
# without this a phone photo exports on its side. The mirrored orientations
# (2, 4, 5, 7) have no rotation equivalent and are transposed by Pillow instead.
_EXIF_ORIENTATION = 0x0112
_EXIF_ROTATION = {1: 0, 3: 180, 6: -90, 8: 90}
# What MuPDF can embed as-is. Anything else ingest accepts (WebP) is converted
# by Pillow, one page at a time.
_NATIVE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp"}

_STREAM_CHUNK = 1 << 20


# --- Page geometry ----------------------------------------------------------


def page_size_mm(orientation="portrait"):
    short, long_ = A4_MM
    return (long_, short) if orientation == "landscape" else (short, long_)


def page_size_in(orientation="portrait"):
    w, h = page_size_mm(orientation)
    return w / MM_PER_INCH, h / MM_PER_INCH


def page_size_pt(orientation="portrait"):
    """True A4 in PDF points -- 595.28 x 841.89, not the 595 x 842 that
    fitz.paper_size rounds it to."""
    w, h = page_size_in(orientation)
    return w * PT_PER_INCH, h * PT_PER_INCH


def placement(image_w, image_h, page_w, page_h, fit="contain", crop=None):
    """Where an image goes on a page: (x0, y0, x1, y1), in the page's units.

    Never distorted -- the rect always has the image's own proportions.
    Contain scales the whole image to fit and centres it (letterboxed);
    cover scales it to fill the page and lets the overflow run off the edge,
    where the page boundary crops it. `crop` is {x, y}, each 0..1, and means
    exactly what CSS object-position percentages mean -- 0 pins the image's
    left (top) edge to the page's, 1 its right (bottom), 0.5 centres -- so the
    PDF crops where the canvas showed it cropping.
    """
    if fit == "cover":
        scale = max(page_w / image_w, page_h / image_h)
        crop = crop or {}
        cx = _unit(crop.get("x"), 0.5)
        cy = _unit(crop.get("y"), 0.5)
    else:
        scale = min(page_w / image_w, page_h / image_h)
        cx = cy = 0.5
    w, h = image_w * scale, image_h * scale
    x0 = (page_w - w) * cx
    y0 = (page_h - h) * cy
    return (x0, y0, x0 + w, y0 + h)


def _unit(value, default):
    try:
        return min(1.0, max(0.0, float(value)))
    except (TypeError, ValueError):
        return default


# --- Print check ------------------------------------------------------------


def image_size(source):
    """(width, height) as the image is *displayed*, and its EXIF orientation.

    `source` is a path or a binary stream. Only the header is read. A phone
    photo stored landscape with an orientation tag is portrait to a browser,
    and portrait is what gets printed, so a quarter-turn tag swaps the axes.
    """
    with Image.open(source) as im:
        w, h = im.size
        try:
            orientation = im.getexif().get(_EXIF_ORIENTATION, 1)
        except Exception:
            orientation = 1
    if orientation in (5, 6, 7, 8):
        w, h = h, w
    return (w, h), orientation


def effective_dpi(width_px, height_px, orientation="portrait", fit="contain"):
    """The resolution, in pixels per inch, an image prints at on an A4 page.

    It depends on the fit as well as the pixels: contain scales the image until
    its tighter side meets the page, cover until its looser side does and
    crops the rest, spreading the same pixels over more paper.
    spread-layout.js's printDpi is the same arithmetic. This is the one copy on
    this side -- print_check warns from it and the export downsamples from it,
    so the two can never disagree about what a page is.
    """
    page_w, page_h = page_size_in(orientation)
    across = width_px / page_w
    down = height_px / page_h
    return min(across, down) if fit == "cover" else max(across, down)


def print_check(width_px, height_px, orientation="portrait", fit="contain"):
    """How an image of this size prints on an A4 page, and what to say about it."""
    page_w, page_h = page_size_in(orientation)
    dpi = effective_dpi(width_px, height_px, orientation, fit)
    a4 = abs((height_px / width_px) / (page_h / page_w) - 1) <= A4_TOLERANCE

    warnings = []
    if dpi < MIN_PRINT_DPI:
        warnings.append(
            f"{width_px}×{height_px} px prints at about {round(dpi)} dpi on A4 — fine on "
            f"screen, soft on paper. Aim for at least {MIN_PRINT_DPI} (300 is ideal)."
        )
    if not a4:
        if fit == "cover":
            warnings.append("Not A4 proportioned — cropped to fill the page.")
        else:
            warnings.append(
                "Not A4 proportioned — letterboxed so nothing is lost. "
                "Switch the page to Cover to fill it and crop the overflow."
            )
    return {
        "width_px": width_px,
        "height_px": height_px,
        "orientation": orientation,
        "fit": fit,
        "dpi": round(dpi),
        "low_resolution": dpi < MIN_PRINT_DPI,
        "a4_proportioned": a4,
        "warnings": warnings,
    }


def inspect_upload(upload, spec):
    """print_check for a file that's still an upload (a werkzeug FileStorage),
    or None if it isn't an image Pillow can read -- the capture pipeline
    still gets to decide what it is.

    Read before the capture is accepted, not after: capture.py's worker may
    ingest the file and delete it before a later read got to it. The stream is
    put back where it was, so the capture saves every byte.
    """
    spec = spec if isinstance(spec, dict) else {}
    orientation = spec.get("orientation") if spec.get("orientation") in ORIENTATIONS else "portrait"
    fit = spec.get("fit") if spec.get("fit") in FITS else "contain"
    stream = upload.stream
    start = stream.tell()
    try:
        (w, h), _ = image_size(stream)
    except Exception:
        return None
    finally:
        stream.seek(start)
    return print_check(w, h, orientation=orientation, fit=fit)


# --- Config -----------------------------------------------------------------


def validate_config(config):
    """None if `config` is a spread the canvas can draw, else what's wrong.

    Checked on every write, because the page list is the document: a page
    entry that isn't an object, or a fit that isn't one of the two real ones,
    would be a spread that renders one way and exports another.
    """
    if not isinstance(config, dict):
        return "a spread's config must be an object"
    if config.get("orientation", "portrait") not in ORIENTATIONS:
        return f"orientation must be one of {', '.join(ORIENTATIONS)}"
    if config.get("layout", "sequential") not in LAYOUTS:
        return f"layout must be one of {', '.join(LAYOUTS)}"
    pages = config.get("pages")
    if not isinstance(pages, list):
        return "a spread needs a list of pages"
    if len(pages) > MAX_PAGE_COUNT:
        return f"a spread holds at most {MAX_PAGE_COUNT} pages"
    for page in pages:
        if not isinstance(page, dict):
            return "every page must be an object"
        if page.get("fit", "contain") not in FITS:
            return (
                "a page's fit must be contain or cover — artwork is never "
                "stretched to fill a page"
            )
        if page.get("page_id") is not None and not isinstance(page.get("page_id"), str):
            return "a page's page_id must be the id of a staged page, or null for an empty slot"
    return None


# --- Export -----------------------------------------------------------------

# Used whenever Pillow has to write a JPEG back out -- to put the pixels
# upright, or to resample them. High, because a page is about to be printed
# and Pillow's default (75) shows.
_JPEG_QUALITY = 95


def parse_export_dpi(value, default=DEFAULT_EXPORT_DPI):
    """(dpi, None) for a usable export resolution, or (None, what's wrong).

    Blank or missing means `default`. Checked rather than clamped: an export
    asked for at 3dpi is a mistake worth saying so about, not one to quietly
    turn into something else.
    """
    if value is None or value == "":
        return default, None
    try:
        dpi = int(round(float(value)))
    except (TypeError, ValueError, OverflowError):
        return None, "dpi must be a number"
    if not MIN_EXPORT_DPI <= dpi <= MAX_EXPORT_DPI:
        return None, f"dpi must be between {MIN_EXPORT_DPI} and {MAX_EXPORT_DPI}"
    return dpi, None


def _plan_page(number, path, fit, orientation, dpi):
    """What the export will do with one page, decided from the image's header
    alone -- shared by plan_export (what the export dialog shows beforehand) and
    export_pdf (what it then does), so the two cannot disagree.

    state is "blank" (an empty slot, or a staged page whose file has gone),
    "unreadable" (a file Pillow can't open; exported blank rather than
    stopping a stream that has already begun), "native" (embedded exactly as it
    is) or "downsample" (resampled to output_px). Downsampling only ever goes
    down: an image below the target is left alone and flagged below_target,
    because resampling up invents detail that was never in the scan.
    """
    if not path:
        return {"number": number, "state": "blank"}
    fit = fit if fit in FITS else "contain"
    try:
        (w, h), _ = image_size(path)
    except Exception:
        return {"number": number, "state": "unreadable"}

    dpi_here = effective_dpi(w, h, orientation, fit)
    plan = {
        "number": number,
        "state": "native",
        "width_px": w,
        "height_px": h,
        "dpi": round(dpi_here),
        "target_dpi": dpi,
        "below_target": False,
    }
    if dpi is None:
        return plan
    if dpi_here > dpi * DOWNSAMPLE_SLACK:
        scale = dpi / dpi_here
        plan["state"] = "downsample"
        plan["output_px"] = [max(1, round(w * scale)), max(1, round(h * scale))]
    elif dpi_here * DOWNSAMPLE_SLACK < dpi:
        plan["below_target"] = True
    return plan


def plan_export(pages, orientation="portrait", dpi=None):
    """Per-page record of what export_pdf(pages, ..., dpi=dpi) will do."""
    return [
        _plan_page(index + 1, page.get("path"), page.get("fit"), orientation, dpi)
        for index, page in enumerate(pages)
    ]


def export_pdf(pages, orientation="portrait", title=None, dpi=None):
    """Yield a PDF of `pages` as it is built -- one true A4 page per entry,
    in order.

    `pages` is a list of {path, fit, crop}; a page whose path is None (an
    empty slot, a staged page since deleted) is exported as a blank page
    rather than skipped, so page 12 of the spread is page 12 of the PDF.

    `dpi` is the export's target resolution. An image above it is resampled
    down to it (see _plan_page); one at or below is embedded exactly as it is,
    a JPEG's own bytes untouched. None means no target and nothing is
    resampled. See the module docstring for how this streams.
    """
    page_w, page_h = page_size_pt(orientation)
    with tempfile.TemporaryDirectory(prefix="spread-export-") as tmp:
        out = Path(tmp) / "spread.pdf"
        sent = 0
        for index, page in enumerate(pages):
            plan = _plan_page(index + 1, page.get("path"), page.get("fit"), orientation, dpi)
            doc = fitz.open() if index == 0 else fitz.open(out)
            try:
                pdf_page = doc.new_page(width=page_w, height=page_h)
                if plan["state"] in ("native", "downsample"):
                    _place_image(
                        pdf_page, Path(page["path"]), page.get("fit"), page.get("crop"),
                        resample_to=plan.get("output_px"),
                    )
                if index == 0:
                    if title:
                        doc.set_metadata({"title": title, "creator": "Fashion reference library"})
                    doc.save(out)
                else:
                    doc.saveIncr()
            finally:
                doc.close()

            with open(out, "rb") as f:
                f.seek(sent)
                while True:
                    chunk = f.read(_STREAM_CHUNK)
                    if not chunk:
                        break
                    sent += len(chunk)
                    yield chunk


def _place_image(pdf_page, path, fit, crop, resample_to=None):
    (w, h), orientation = image_size(path)
    # Geometry comes from the image as it was, not as resampled: resampling
    # keeps the proportions, so the placement is the same either way.
    rect = fitz.Rect(*placement(w, h, pdf_page.rect.width, pdf_page.rect.height, fit, crop))

    if resample_to is None:
        rotation = _EXIF_ROTATION.get(orientation)
        if rotation is not None and path.suffix.lower() in _NATIVE_EXTS:
            pdf_page.insert_image(rect, filename=str(path), rotate=rotation)
            return

    # Resampling, a mirrored EXIF orientation, or a format MuPDF can't read:
    # let Pillow put the pixels upright (and, for a resample, at the target
    # size) and hand MuPDF something it can embed. Lossless unless the source
    # was already a JPEG, where a PNG of a photo would be several times the
    # size for no visible gain.
    with Image.open(path) as im:
        upright = ImageOps.exif_transpose(im)
        if resample_to is not None:
            upright = upright.resize(tuple(resample_to), Image.LANCZOS)
        buf = io.BytesIO()
        if path.suffix.lower() in (".jpg", ".jpeg"):
            upright.convert("RGB").save(buf, "JPEG", quality=_JPEG_QUALITY)
        else:
            if upright.mode not in ("1", "L", "LA", "P", "RGB", "RGBA"):
                upright = upright.convert("RGB")  # PNG has no CMYK
            upright.save(buf, "PNG")
    pdf_page.insert_image(rect, stream=buf.getvalue())
