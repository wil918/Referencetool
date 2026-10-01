"""Rotating a reference's image: bytes rewritten in place, not a display
flag (see CLAUDE.md's hard rule on this) -- and everything that hangs off
those bytes (content_hash, the colour profile's cache key, the CLIP vector)
kept consistent with the new file.
"""
import io

import fitz  # PyMuPDF
from PIL import Image

from conftest import png_bytes

import colour
import db
import embeddings
import ingest


def rect_bytes(size=(400, 300)):
    """A non-square PNG, so a 90 degree rotation is visible in its dimensions."""
    return png_bytes(size=size)


def pdf_bytes():
    doc = fitz.open()
    doc.new_page()
    data = doc.tobytes()
    doc.close()
    return data


def add_image(archive, name="scan", size=(400, 300)):
    path = archive / f"{name}.png"
    path.write_bytes(rect_bytes(size))
    return ingest.add_reference(path, title=name)["id"]


# --- rotate_reference() itself -----------------------------------------------


def test_rotate_produces_new_bytes_and_content_hash(archive):
    ref_id = add_image(archive)
    before = db.get_reference(ref_id)

    updated = ingest.rotate_reference(ref_id)

    assert updated["content_hash"] != before["content_hash"]


def test_rotate_swaps_dimensions(archive):
    ref_id = add_image(archive, size=(400, 300))
    ref = db.get_reference(ref_id)
    path = archive / "references" / ref["filepath"]
    with Image.open(path) as img:
        assert img.size == (400, 300)

    ingest.rotate_reference(ref_id)

    with Image.open(path) as img:
        assert img.size == (300, 400)


def test_four_rotations_restore_original_orientation(archive):
    ref_id = add_image(archive, size=(400, 300))
    ref = db.get_reference(ref_id)
    path = archive / "references" / ref["filepath"]

    for _ in range(4):
        ingest.rotate_reference(ref_id)

    with Image.open(path) as img:
        assert img.size == (400, 300)


def test_colour_analysis_survives_a_rotation(archive):
    """Rotation doesn't touch the palette -- the stored analysis should be
    carried forward onto the new content_hash, not left to look stale.
    list_references_needing_colour re-queues on a content_hash mismatch, so
    a survived analysis is exactly one that doesn't show up there."""
    ref_id = add_image(archive)
    profile_before = db.get_colour_analysis(ref_id, version=colour.ANALYSIS_VERSION)
    assert profile_before is not None

    updated = ingest.rotate_reference(ref_id)

    profile_after = db.get_colour_analysis(ref_id, version=colour.ANALYSIS_VERSION)
    assert profile_after is not None
    assert profile_after["content_hash"] == updated["content_hash"]
    # Same profile JSON -- carried forward, not recomputed.
    assert profile_after["profile"] == profile_before["profile"]

    needing = db.list_references_needing_colour(colour.ANALYSIS_VERSION)
    assert ref_id not in {r["id"] for r in needing}


def test_embedding_is_recomputed(archive):
    ref_id = add_image(archive)
    calls_before = embeddings.embed_image.call_count

    ingest.rotate_reference(ref_id)

    assert embeddings.embed_image.call_count == calls_before + 1
    embeddings.update_embedding.assert_called_with(ref_id, [0.1] * 512)


def test_rotating_a_non_image_reference_raises(archive):
    text_path = archive / "notes.txt"
    text_path.write_text("some notes")
    ref_id = ingest.add_reference(text_path, title="notes")["id"]

    try:
        ingest.rotate_reference(ref_id)
        assert False, "expected a ValueError"
    except ValueError:
        pass


# --- Through the HTTP API -----------------------------------------------------


def test_api_rotate_changes_the_thumbnail_url(archive, client):
    ref_id = add_image(archive)
    before = next(r for r in client.get("/api/references").get_json() if r["id"] == ref_id)

    res = client.post(f"/api/references/{ref_id}/rotate")
    assert res.status_code == 200

    after = next(r for r in client.get("/api/references").get_json() if r["id"] == ref_id)
    assert after["content_hash"] != before["content_hash"]


def test_api_rotate_rejects_pdf(archive, client, tmp_path):
    path = tmp_path / "brief.pdf"
    path.write_bytes(pdf_bytes())
    ref_id = ingest.add_reference(path, title="brief")["id"]

    res = client.post(f"/api/references/{ref_id}/rotate")
    assert res.status_code == 400


def test_api_rotate_rejects_text(archive, client, tmp_path):
    path = tmp_path / "notes.txt"
    path.write_text("some notes")
    ref_id = ingest.add_reference(path, title="notes")["id"]

    res = client.post(f"/api/references/{ref_id}/rotate")
    assert res.status_code == 400
