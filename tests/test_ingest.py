"""Title deduplication: avoiding indistinguishable rows in the archive."""
import uuid

from conftest import FakeUpload, drain, envelope, png_bytes

import capture
import db
import ingest


def _seed_title(title):
    """A minimal reference row, for setting up collisions without running
    the whole tagging/embedding pipeline just to test title logic."""
    ref_id = str(uuid.uuid4())
    db.insert_reference(
        ref_id=ref_id,
        type_="image",
        filepath=f"{ref_id}.png",
        title=title,
        source=None,
        tags=[],
        description=None,
        notes=None,
    )
    return ref_id


# --- dedupe_title() itself --------------------------------------------------


def test_bare_title_is_unchanged_when_unused(archive):
    assert ingest.dedupe_title("Sketch") == "Sketch"


def test_first_collision_becomes_2(archive):
    _seed_title("Sketch")
    assert ingest.dedupe_title("Sketch") == "Sketch (2)"


def test_second_collision_becomes_3(archive):
    _seed_title("Sketch")
    _seed_title("Sketch (2)")
    assert ingest.dedupe_title("Sketch") == "Sketch (3)"


def test_picks_the_lowest_free_number_not_just_the_next_one(archive):
    """Deleting "Sketch (2)" later should let the next duplicate reuse it
    rather than always climbing to a new high-water mark."""
    _seed_title("Sketch")
    _seed_title("Sketch (4)")
    assert ingest.dedupe_title("Sketch") == "Sketch (2)"


def test_comparison_is_case_insensitive(archive):
    _seed_title("sketch")
    assert ingest.dedupe_title("Sketch") == "Sketch (2)"


def test_unrelated_titles_sharing_a_prefix_are_not_collisions(archive):
    """"Sketchbook Notes" starts with "Sketch" but isn't the same title --
    the archive should end up with both bare, not "Sketch (2)"."""
    _seed_title("Sketchbook Notes")
    assert ingest.dedupe_title("Sketch") == "Sketch"


def test_empty_title_passes_through(archive):
    assert ingest.dedupe_title("") == ""
    assert ingest.dedupe_title(None) is None


# --- Wired into the real ingest path ----------------------------------------


def test_add_reference_deduplicates_across_uploads(archive, tmp_path):
    """Two different images that both land on the same Claude-suggested
    title (a very real scenario for visually similar references) must not
    produce two indistinguishable rows."""
    from unittest.mock import patch

    with patch("tagging.tag_image", return_value=("Draped Silhouette Study", ["tag"], "desc")):
        # Filenames deliberately unrelated to the mocked tags/description, so
        # ingest's own heuristic replaces them with Claude's suggested title
        # rather than keeping the filename (see _title_seems_related).
        first_path = tmp_path / "IMG_0001.png"
        first_path.write_bytes(png_bytes((10, 20, 30)))
        second_path = tmp_path / "IMG_0002.png"
        second_path.write_bytes(png_bytes((200, 100, 50)))

        first = ingest.add_reference(first_path)
        second = ingest.add_reference(second_path)

    assert first["title"] == "Draped Silhouette Study"
    assert second["title"] == "Draped Silhouette Study (2)"


def test_capture_pipeline_deduplicates_titles(archive):
    """Two captures through the browser extension, landing on the same
    title, must not produce two indistinguishable rows.

    The envelope's title ("A Work") doesn't share a real word with the
    fixture's stubbed tags/description, so ingest's own heuristic replaces it
    with Claude's suggestion ("Tagged Image" per the `archive` fixture's
    stub) for both captures -- the same collision a real archive would see
    from two visually similar, separately-worded images.
    """
    first = capture.accept(envelope(), upload=FakeUpload(png_bytes((10, 20, 30))))
    second = capture.accept(
        envelope(content={"image_url": "https://cdn.example.com/two.png"}),
        upload=FakeUpload(png_bytes((200, 100, 50))),
    )
    drain()

    first_ref = db.get_reference(db.get_capture(first["id"])["reference_id"])
    second_ref = db.get_reference(db.get_capture(second["id"])["reference_id"])
    assert first_ref["title"] == "Tagged Image"
    assert second_ref["title"] == "Tagged Image (2)"


def test_authoritative_title_override_also_deduplicates(archive):
    """A structured (JSON-LD) title restored after ingest is a second,
    independent write -- it needs the same collision check as the first."""
    _seed_title("Pleats Please")
    env = envelope(
        metadata={"title": "Pleats Please"},
        metadata_provenance=[
            {"field": "title", "value": "Pleats Please", "source": "json-ld", "confidence": "high"}
        ],
    )
    row = capture.accept(env, upload=FakeUpload(png_bytes()))
    drain()

    ref = db.get_reference(db.get_capture(row["id"])["reference_id"])
    assert ref["title"] == "Pleats Please (2)"
