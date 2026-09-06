"""Shared fixtures.

Every test runs against a throwaway database and reference directory, and with
the two slow/networked steps of the pipeline (Claude tagging, CLIP embedding)
stubbed out. That keeps the suite fast and offline while still exercising the
real ingest code path -- hashing, duplicate detection, file placement and the
database writes are all genuine.
"""
import io
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import capture  # noqa: E402
import config  # noqa: E402
import db  # noqa: E402
import ingest  # noqa: E402


# A representative brief extraction -- the shape briefs.analyse returns, stubbed
# so tests never call Claude. briefs.extract_text still runs for real (fitz is
# offline), so a test builds a tiny PDF and gets this back.
BRIEF_EXTRACTION = {
    "summary": "Design and realise one outfit exploring construction.",
    "key_dates": [
        {"label": "Briefing", "date": "2026-01-12", "kind": "briefing", "note": ""},
        {"label": "Hand-in", "date": "2026-03-20", "kind": "hand-in", "note": ""},
    ],
    "deliverables": [
        {
            "title": "Part 1 - Research",
            "due_date": "2026-02-20",
            "weighting": 40,
            "description": "A research portfolio.",
            "spec": {"pages": 20, "required_items": ["3 documented fabric tests"]},
            "tasks": [
                {"title": "Gather fabric research", "note": "", "est_minutes": 120},
                {"title": "Document fabric tests", "note": "", "est_minutes": None},
            ],
        }
    ],
    "mandatory_activities": [
        {
            "title": "Fabric shop visit",
            "kind": "shop visit",
            "note": "at least one documented visit",
            "location_bound": True,
        }
    ],
}


@pytest.fixture
def archive(tmp_path, monkeypatch):
    """An empty archive: temp database, temp reference dirs, stubbed pipeline."""
    images = tmp_path / "references" / "images"
    texts = tmp_path / "references" / "texts"
    for d in (images, texts):
        d.mkdir(parents=True)

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(ingest, "IMAGES_DIR", images)
    monkeypatch.setattr(ingest, "TEXTS_DIR", texts)
    monkeypatch.setattr(capture, "PENDING_DIR", tmp_path / "pending")
    briefs_dir = tmp_path / "briefs"
    briefs_dir.mkdir()
    monkeypatch.setattr(config, "BRIEFS_DIR", briefs_dir)
    # Anything that resolves a stored reference back to a file on disk reads
    # this at call time (colour.py, app.py's media routes), so it has to point
    # at the temp archive too -- otherwise those look in the real library
    # while ingest writes to the temp one.
    monkeypatch.setattr(config, "REFERENCES_DIR", tmp_path / "references")
    db.init_db()

    stubs = [
        patch("tagging.tag_image", return_value=("Tagged Image", ["tag-a"], "an image")),
        patch("tagging.tag_text", return_value=("Tagged Text", ["tag-b"], "some text")),
        patch("tagging.tag_pdf", return_value=("Tagged PDF", ["tag-c"], "a pdf")),
        patch("briefs.analyse", return_value=BRIEF_EXTRACTION),
        patch("embeddings.embed_image", return_value=[0.1] * 512),
        patch("embeddings.embed_text", return_value=[0.2] * 512),
        patch("embeddings.embed_combined", return_value=[0.3] * 512),
        patch("embeddings.add_to_index"),
        patch("embeddings.remove_from_index"),
        patch("task_ai.generate_task_fields", return_value={
            "title": "Generated Title",
            "est_minutes": 30,
            "importance": 3,
            "difficulty": 2,
            "measurable_goal": "Generated goal",
        }),
    ]
    for s in stubs:
        s.start()
    yield tmp_path

    # The worker thread and its queue are module-level globals shared by every
    # test, so anything a test left queued would otherwise be processed after
    # this fixture has torn down -- against the *next* test's database, or the
    # real one. Draining here keeps each test's work inside its own archive.
    capture._queue.join()
    for s in stubs:
        s.stop()


@pytest.fixture
def client(archive):
    """Flask test client bound to the throwaway archive."""
    import app as flask_app

    flask_app.app.config["TESTING"] = True
    with flask_app.app.test_client() as c:
        yield c


@pytest.fixture
def ext_headers():
    """Headers a real extension request would carry."""
    return {"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"}


def png_bytes(colour=(120, 80, 60), size=(400, 300)):
    buf = io.BytesIO()
    Image.new("RGB", size, colour).save(buf, "PNG")
    return buf.getvalue()


class FakeUpload:
    """Stands in for a werkzeug FileStorage."""

    def __init__(self, data, filename="photo.png"):
        self._data = data
        self.filename = filename

    def save(self, path):
        Path(path).write_bytes(self._data)


def envelope(**overrides):
    """A representative image capture envelope."""
    base = {
        "type": "image",
        "source": {
            "url": "https://www.example.com/article",
            "canonical_url": "https://example.com/article",
            "domain": "www.example.com",
            "page_title": "An Article",
            "captured_at": "2026-01-01T00:00:00Z",
        },
        "content": {"image_url": "https://cdn.example.com/one.png", "image_alt": "alt text"},
        "metadata": {"title": "A Work", "creator": "A Creator"},
        "metadata_provenance": [
            {"field": "creator", "value": "A Creator", "source": "json-ld", "confidence": "high"}
        ],
        "project_ids": [],
        "user_note": "",
    }
    base.update(overrides)
    return base


def drain(monkeypatch=None):
    """Run every queued capture to completion, synchronously."""
    capture._queue.join()
