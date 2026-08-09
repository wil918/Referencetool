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

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
# You can swap this for any current Claude model via the .env file.
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-5")

# Optional shared secret for the browser extension's capture API. Left unset
# for the normal local setup, where the server only listens on 127.0.0.1 and
# the only thing that can reach it is already on this machine. Set it in .env
# if you ever expose the app beyond localhost.
ARCHIVE_API_TOKEN = os.getenv("ARCHIVE_API_TOKEN") or None

for _d in (IMAGES_DIR, TEXTS_DIR, DATA_DIR, CHROMA_DIR):
    _d.mkdir(parents=True, exist_ok=True)
