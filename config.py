"""Central configuration and paths for the reference tool."""
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
REFERENCES_DIR = BASE_DIR / "references"
IMAGES_DIR = REFERENCES_DIR / "images"
TEXTS_DIR = REFERENCES_DIR / "texts"
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "references.db"
CHROMA_DIR = DATA_DIR / "chroma_db"
# Generated thumbnails, keyed by content hash -- see thumbnails.py. Derived
# and recomputable like CHROMA_DIR; deleting it costs nothing but regeneration.
THUMBNAILS_DIR = DATA_DIR / "thumbnails"
# Portfolio pages staged for the spreads on a project's canvas -- see
# portfolio.py. Beside references/ and deleted/ rather than inside either:
# these are working files and their drafts, not archive material, and nothing
# that walks the archive's tree (export, backup, a future re-index) should ever
# meet them. Unlike THUMBNAILS_DIR this is NOT derived data -- it is the only
# copy of a page until it is promoted -- so deleting it loses work.
PORTFOLIO_DIR = BASE_DIR / "portfolio"
# Original assignment-brief PDFs, kept so a re-import can be re-read and so the
# review sheet can link "view original". Not references -- a brief is the source
# a project's deliverables were built from, not an item in the library.
BRIEFS_DIR = DATA_DIR / "briefs"
# Original supporting documents (workshop/materials lists, reading lists,
# technical handouts) -- PDF or .docx, kept for the same "view original"
# reason as BRIEFS_DIR. Separate directory because these are a different
# table (supporting_documents, not briefs) with no filename collision risk
# between the two id spaces, but keeping them apart avoids ever needing to
# tell them apart by listing a mixed directory.
SUPPORTING_DOCS_DIR = DATA_DIR / "supporting_docs"

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
# You can swap this for any current Claude model via the .env file.
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-5")


def _env_flag(name):
    """True when `name` is set to 1/true/yes/on in the environment or .env.
    Unset, empty or anything else is False -- every flag below defaults to the
    app's behaviour before the flag existed."""
    return os.getenv(name, "").strip().lower() in ("1", "true", "yes", "on")


# --- What this copy of the app is configured to do ---------------------------
#
# Three capabilities, three different sources. Two are switches a person sets
# in .env, and both default to "everything on" so an existing install is
# unchanged by their existence. The third is not a switch at all: whether
# Claude is available is a fact about the machine (is there a key?), and a
# separate "demo" flag beside it could only ever disagree with that fact.

# ARCHIVE_ONLY=1 turns the whole schedule off: its routes are not registered,
# its pages are not served, and the nav drops its entries. What is left is the
# archive, projects, folders, the canvas, portfolio spreads and the 3D views.
# init_db() still creates the schedule's (empty) tables -- harmless, and it
# keeps this reversible by editing one value.
ARCHIVE_ONLY = _env_flag("ARCHIVE_ONLY")

# SKIP_EMBEDDINGS=1 never loads the CLIP model or touches Chroma. An escape
# hatch, not a recommendation: the model is a one-off ~600 MB download that then
# runs locally with no per-use cost, and it is what powers semantic search, the
# similarity graph and the constellation. Colour search and the colour space do
# not need it.
SKIP_EMBEDDINGS = _env_flag("SKIP_EMBEDDINGS")


def schedule_enabled():
    return not ARCHIVE_ONLY


def embeddings_enabled():
    return not SKIP_EMBEDDINGS


def claude_available():
    """True if a call to Claude can be made at all. Everything that would make
    one -- tagging, analysis, brief import, task generation -- asks this, and
    nothing else: one definition, derived from the key being present."""
    return bool(ANTHROPIC_API_KEY)

# Optional shared secret for the browser extension's capture API. Left unset
# for the normal local setup, where the server only listens on 127.0.0.1 and
# the only thing that can reach it is already on this machine. Set it in .env
# if you ever expose the app beyond localhost.
ARCHIVE_API_TOKEN = os.getenv("ARCHIVE_API_TOKEN") or None

# Which interface the server binds to. Default 127.0.0.1: nothing off this
# machine can reach it, and the machine boundary is the trust boundary -- the
# API needs no token because only local processes can call it. Set
# ARCHIVE_HOST=0.0.0.0 (or a specific address) in .env to reach the schedule
# from a phone on the same network / over Tailscale. Doing so is only allowed
# with ARCHIVE_API_TOKEN also set: app.py refuses to start otherwise, and every
# /api/ call from a non-loopback client is then checked against that token.
ARCHIVE_HOST = os.getenv("ARCHIVE_HOST") or "127.0.0.1"


def host_is_loopback(host):
    """True if binding `host` exposes the server to this machine only."""
    return host in ("127.0.0.1", "::1", "localhost", "")


# Whether the current bind reaches beyond this machine. When true the schedule
# API is only as private as ARCHIVE_API_TOKEN makes it, so the token stops
# being optional -- see app.py's startup check and _guard_api_when_exposed.
LAN_EXPOSED = not host_is_loopback(ARCHIVE_HOST)


def _detect_local_timezone():
    """The IANA zone this machine runs in, e.g. "Europe/London".

    Read from the /etc/localtime symlink macOS and Linux both maintain,
    rather than a fixed offset -- an offset can't tell BST from GMT for a
    date on the other side of the clock change. Overridable via .env for a
    machine where that symlink doesn't resolve; falls back to UTC rather than
    guessing wrong. Used by ics_import.py to convert imported commitment
    times to this app's local-wall-clock storage convention.
    """
    override = os.getenv("LOCAL_TIMEZONE")
    if override:
        return override
    try:
        return os.path.realpath("/etc/localtime").split("zoneinfo/", 1)[1]
    except (OSError, IndexError):
        return "UTC"


LOCAL_TIMEZONE = _detect_local_timezone()

for _d in (IMAGES_DIR, TEXTS_DIR, DATA_DIR, CHROMA_DIR, BRIEFS_DIR, SUPPORTING_DOCS_DIR, THUMBNAILS_DIR, PORTFOLIO_DIR):
    if _d == CHROMA_DIR and SKIP_EMBEDDINGS:
        continue  # Chroma is never opened, so its folder is not made either
    _d.mkdir(parents=True, exist_ok=True)
