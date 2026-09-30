"""Getting reference bytes out of the archive: named downloads, the bulk zip
export, and the desktop build's reveal-in-Finder bridge.

export.py's filename logic is tested directly (pure functions, no Flask), the
two new routes through the `client` fixture, and desktop.py's Api.reveal
against the same throwaway archive -- see conftest.py's `client` fixture for
why REFERENCES_DIR has to be patched again there, and why desktop.py's own
frozen import of it needs the same treatment in the tests below.
"""
import io
import itertools
import zipfile
from unittest.mock import patch

import fitz

import export
import ingest
from conftest import png_bytes

_colours = itertools.count()


def add_image(archive, title):
    """A real image reference, through the real ingest path. Each call uses
    a distinct flat colour so byte-identical duplicates never collide, and
    the on-disk source filename is a plain counter -- not derived from
    `title`, which tests below deliberately put "/" and ":" into. Claude's
    tagging is stubbed to suggest nothing, so ingest's title-replacement
    heuristic (_title_seems_related) never overrides the title under test --
    see test_ingest.py's test_add_reference_deduplicates_across_uploads for
    the same trap this sidesteps."""
    n = next(_colours)
    path = archive / f"ref-{n}.png"
    path.write_bytes(png_bytes((n % 256, (n // 256) % 256, 60)))
    with patch("tagging.tag_image", return_value=(None, [], "")):
        return ingest.add_reference(path, title=title)["id"]


def add_text(archive, title, content="Some reference notes."):
    n = next(_colours)
    path = archive / f"ref-{n}.txt"
    path.write_text(content, encoding="utf-8")
    with patch("tagging.tag_text", return_value=(None, [], "")):
        return ingest.add_reference(path, title=title)["id"]


def add_pdf(archive, title, text="A brief."):
    n = next(_colours)
    doc = fitz.open()
    doc.new_page().insert_text((72, 100), text)
    data = doc.tobytes()
    doc.close()
    path = archive / f"ref-{n}.pdf"
    path.write_bytes(data)
    # A text-only PDF (no embedded images) takes ingest's tag_text path, not
    # tag_pdf -- see add_reference's extracted_images branch -- so both are
    # stubbed here rather than assuming which one fires.
    with patch("tagging.tag_pdf", return_value=(None, [], "")), \
         patch("tagging.tag_text", return_value=(None, [], "")):
        return ingest.add_reference(path, title=title)["id"]


# --- export.slugify_title / unique_filename ---------------------------------


def test_slugify_title_strips_separators_and_caps_length():
    title = "Balenciaga/1967: Origins " + ("x" * 250)
    slug = export.slugify_title(title)
    assert "/" not in slug
    assert ":" not in slug
    assert len(slug) <= export.MAX_STEM_LENGTH


def test_slugify_title_strips_every_filesystem_hostile_character():
    slug = export.slugify_title('a<b>c:d"e/f\\g|h?i*j')
    assert slug == "abcdefghij"


def test_slugify_title_never_returns_empty():
    assert export.slugify_title("") == "reference"
    assert export.slugify_title("///:::") == "reference"


def test_unique_filename_dedupes_identical_titles():
    used = set()
    first = export.unique_filename("Balenciaga 1967", ".jpg", used)
    second = export.unique_filename("Balenciaga 1967", ".jpg", used)
    assert first != second
    assert first == "Balenciaga 1967.jpg"
    assert second == "Balenciaga 1967 (2).jpg"


def test_unique_filename_dedupe_is_case_insensitive():
    used = set()
    export.unique_filename("Sketch", ".png", used)
    second = export.unique_filename("sketch", ".png", used)
    assert second == "sketch (2).png"


# --- GET /media/<id>/download -----------------------------------------------


def test_download_sets_attachment_filename_from_title(client, archive):
    title = "Balenciaga: 1967 / Origins, a retrospective " + ("a" * 200)
    ref_id = add_image(archive, title)

    res = client.get(f"/media/{ref_id}/download")

    assert res.status_code == 200
    disposition = res.headers["Content-Disposition"]
    assert disposition.startswith("attachment")
    filename = disposition.split('filename="')[1].split('"')[0]
    assert "/" not in filename
    assert ":" not in filename
    assert filename.endswith(".png")
    assert len(filename) <= export.MAX_STEM_LENGTH + len(".png") + 10


def test_download_404s_for_an_unknown_id(client):
    assert client.get("/media/not-a-real-id/download").status_code == 404


# --- POST /api/export --------------------------------------------------------


def test_export_zip_is_empty_selection_400(client):
    res = client.post("/api/export", json={"ids": []})
    assert res.status_code == 400


def test_export_zip_contains_every_type_in_given_order(client, archive):
    image_id = add_image(archive, "A Look")
    pdf_id = add_pdf(archive, "A Brief")
    text_id = add_text(archive, "A Note", content="The actual notes.")

    res = client.post("/api/export", json={"ids": [image_id, pdf_id, text_id]})

    assert res.status_code == 200
    assert res.mimetype == "application/zip"
    assert res.headers["Content-Disposition"].startswith("attachment")

    zf = zipfile.ZipFile(io.BytesIO(res.data))
    names = zf.namelist()
    assert len(names) == 3
    # Zero-padded on-screen-order prefix, in the order the ids were given --
    # not alphabetical, not database order.
    assert names[0].startswith("1 - A Look") and names[0].endswith(".png")
    assert names[1].startswith("2 - A Brief") and names[1].endswith(".pdf")
    assert names[2].startswith("3 - A Note") and names[2].endswith(".txt")
    assert zf.read(names[2]).decode("utf-8") == "The actual notes."


def test_export_zip_dedupes_titles_that_only_collide_after_slugifying(client, archive):
    # Two distinct titles ingest.dedupe_title would never rename (they're
    # not literally identical) but that produce the same filename once
    # slugify_title strips the punctuation apart -- the exact case the zip's
    # own dedup exists for.
    id_a = add_image(archive, "Balenciaga: 1967")
    id_b = add_image(archive, "Balenciaga / 1967")

    res = client.post("/api/export", json={"ids": [id_a, id_b]})
    zf = zipfile.ZipFile(io.BytesIO(res.data))
    names = zf.namelist()

    assert len(names) == 2
    assert names[0].endswith("Balenciaga 1967.png")
    assert names[1].endswith("Balenciaga 1967 (2).png")


def test_export_zip_zero_pads_the_prefix_to_the_batch_width(client, archive):
    ids = [add_image(archive, f"Look {i}") for i in range(11)]
    res = client.post("/api/export", json={"ids": ids})
    names = zipfile.ZipFile(io.BytesIO(res.data)).namelist()
    assert names[0].startswith("01 - Look 0")
    assert names[10].startswith("11 - Look 10")


def test_export_zip_accepts_a_form_field_too(client, archive):
    # The real client submits a hidden form (so the browser's own download
    # flow handles the response) rather than a fetch -- ids arrive as a JSON
    # string form field there, not a JSON body.
    ref_id = add_image(archive, "Form Submitted")
    res = client.post("/api/export", data={"ids": f'["{ref_id}"]'})
    assert res.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(res.data)).namelist()
    assert len(names) == 1


# --- desktop.py's reveal-in-Finder bridge -----------------------------------


def test_reveal_rejects_an_unknown_reference_id(archive, monkeypatch):
    import desktop

    monkeypatch.setattr(desktop, "REFERENCES_DIR", archive / "references")
    with patch("desktop.subprocess.run") as run:
        result = desktop.Api().reveal("not-a-real-id")

    assert result["ok"] is False
    run.assert_not_called()


def test_reveal_rejects_an_empty_or_missing_id(archive, monkeypatch):
    import desktop

    monkeypatch.setattr(desktop, "REFERENCES_DIR", archive / "references")
    with patch("desktop.subprocess.run") as run:
        assert desktop.Api().reveal("")["ok"] is False
        assert desktop.Api().reveal(None)["ok"] is False
    run.assert_not_called()


def test_reveal_shells_out_to_open_dash_r_for_a_known_reference(archive, monkeypatch):
    import desktop

    ref_id = add_image(archive, "Reveal Me")
    monkeypatch.setattr(desktop, "REFERENCES_DIR", archive / "references")

    with patch("desktop.subprocess.run") as run:
        result = desktop.Api().reveal(ref_id)

    assert result["ok"] is True
    run.assert_called_once()
    args = run.call_args[0][0]
    assert args[0] == "open"
    assert args[1] == "-R"
    assert args[2].endswith(".png")
    assert str(archive / "references") in args[2]
