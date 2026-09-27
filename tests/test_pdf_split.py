"""PDF page splitting: one reference per page instead of the whole document
as one reference.

Covers ingest.py's parse_page_range/render_pdf_pages and app.py's
/api/pdf-info + /api/split-pdf, which render synchronously and then queue
each page through the existing capture pipeline (capture.py) -- so most of
these tests call drain() explicitly, the same as the browser-extension
capture tests, to separate "the request returned" from "the page was
ingested".
"""
import io

import fitz
import pytest
from conftest import drain

import db
import ingest


def pdf_bytes(pages=3):
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page()
        page.insert_text((72, 100), f"Page {i + 1}")
    data = doc.tobytes()
    doc.close()
    return data


def post_split(client, pages=3, filename="catalogue.pdf", **form):
    data = {"file": (io.BytesIO(pdf_bytes(pages)), filename)}
    data.update(form)
    return client.post("/api/split-pdf", data=data, content_type="multipart/form-data")


# --- parse_page_range() ------------------------------------------------------


def test_parse_page_range_blank_means_every_page():
    assert ingest.parse_page_range("", 5) == [0, 1, 2, 3, 4]
    assert ingest.parse_page_range(None, 5) == [0, 1, 2, 3, 4]


def test_parse_page_range_supports_commas_and_ranges():
    assert ingest.parse_page_range("1,3-4", 5) == [0, 2, 3]


def test_parse_page_range_rejects_out_of_bounds():
    with pytest.raises(ValueError):
        ingest.parse_page_range("0-2", 5)
    with pytest.raises(ValueError):
        ingest.parse_page_range("6", 5)


def test_parse_page_range_rejects_a_backwards_range():
    with pytest.raises(ValueError):
        ingest.parse_page_range("4-3", 5)


# --- /api/pdf-info ------------------------------------------------------------


def test_pdf_info_reports_page_count(client):
    r = client.post(
        "/api/pdf-info",
        data={"file": (io.BytesIO(pdf_bytes(5)), "catalogue.pdf")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 200
    assert r.get_json()["pages"] == 5


def test_pdf_info_rejects_a_non_pdf(client):
    r = client.post(
        "/api/pdf-info",
        data={"file": (io.BytesIO(b"not a pdf"), "notes.txt")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 400


# --- /api/split-pdf -----------------------------------------------------------


def test_splitting_produces_one_reference_per_page(client):
    r = post_split(client, pages=3, filename="lookbook.pdf")
    assert r.status_code == 202
    body = r.get_json()
    assert body["queued"] == 3
    assert body["total_pages"] == 3

    drain()
    refs = db.list_references()
    assert len(refs) == 3
    assert sorted(ref["title"] for ref in refs) == [
        "lookbook — page 1", "lookbook — page 2", "lookbook — page 3",
    ]
    assert all(ref["source"] == "lookbook.pdf" for ref in refs)
    assert all(ref["type"] == "image" for ref in refs)


def test_page_titles_are_zero_padded_for_natural_sorting(client):
    """A two-digit document must not sort "page 10" before "page 2"."""
    post_split(client, pages=12, filename="catalogue.pdf")
    drain()
    titles = sorted(ref["title"] for ref in db.list_references())
    assert titles[0] == "catalogue — page 01"
    assert titles[-1] == "catalogue — page 12"


def test_own_work_follows_the_import_choice(client):
    post_split(client, pages=2, own_work="true")
    drain()
    refs = db.list_references()
    assert len(refs) == 2
    assert all(ref["is_own_work"] for ref in refs)


def test_a_page_range_imports_only_those_pages(client):
    r = post_split(client, pages=10, filename="show.pdf", range="3-5")
    body = r.get_json()
    assert body["queued"] == 3
    assert body["total_pages"] == 10

    drain()
    titles = sorted(ref["title"] for ref in db.list_references())
    assert titles == ["show — page 03", "show — page 04", "show — page 05"]


def test_an_out_of_range_page_is_rejected(client):
    r = post_split(client, pages=3, range="1-9")
    assert r.status_code == 400
    assert db.list_references() == []


def test_re_splitting_the_same_pdf_creates_no_duplicates(client):
    """Duplicate detection falls out of the ordinary content-hash check --
    re-splitting at the same DPI renders byte-identical pages."""
    pdf = pdf_bytes(3)

    first = client.post(
        "/api/split-pdf",
        data={"file": (io.BytesIO(pdf), "repeat.pdf")},
        content_type="multipart/form-data",
    )
    drain()
    assert first.get_json()["queued"] == 3
    assert len(db.list_references()) == 3

    second = client.post(
        "/api/split-pdf",
        data={"file": (io.BytesIO(pdf), "repeat.pdf")},
        content_type="multipart/form-data",
    )
    drain()
    assert second.status_code == 202
    assert len(db.list_references()) == 3, "re-splitting must resolve to the existing pages"


def test_split_pdf_rejects_a_non_pdf(client):
    r = client.post(
        "/api/split-pdf",
        data={"file": (io.BytesIO(b"not a pdf"), "notes.txt")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 400


def test_splitting_a_large_document_does_not_block_the_request(client):
    """40 pages rendered and handed to the capture queue in one request --
    each page's Claude tagging call and CLIP embed happen on the worker
    thread afterwards, not before this request returns. (The worker runs
    concurrently even in tests, so what's checkable here isn't "nothing is
    ingested yet" -- that would race the worker -- but that the request
    itself reports all 40 as queued, and that every one of them is ingested
    once the queue is drained.)"""
    r = post_split(client, pages=40, filename="big-catalogue.pdf")
    assert r.status_code == 202
    body = r.get_json()
    assert body["queued"] == 40
    assert body["total_pages"] == 40
    assert len(body["capture_ids"]) == 40

    drain()
    assert len(db.list_references()) == 40
