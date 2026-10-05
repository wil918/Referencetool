"""The portfolio staging store: pages that are working files, not archive material.

A spread's pages used to be uploaded through the capture queue -- tagged by
Claude, embedded by CLIP, inserted as is_own_work references -- so every
revision of a page cost an API call and left another near-duplicate in the
archive. They are staged now (portfolio.py). These tests hold the line that
matters: staging never touches Claude, CLIP or the archive; only an explicit
promotion does, and only once.
"""
import io
import json
from unittest.mock import patch

import fitz
import pytest
from PIL import Image

import config
import db
import ingest
import portfolio
import spreads


# --- helpers ----------------------------------------------------------------


def new_project(client, title="Portfolio"):
    return client.post("/api/projects", json={"title": title}).get_json()["id"]


def image_bytes(size=(620, 877), colour=(120, 80, 60), fmt="PNG", **save_kwargs):
    buf = io.BytesIO()
    Image.new("RGB", size, colour).save(buf, fmt, **save_kwargs)
    return buf.getvalue()


def stage(client, project_id, data=None, name="page.png", **form):
    """Stage one file through the real route; returns the response."""
    return client.post(
        f"/api/projects/{project_id}/portfolio/pages",
        data={"file": (io.BytesIO(data if data is not None else image_bytes()), name), **form},
        content_type="multipart/form-data",
    )


def stage_id(client, project_id, **kwargs):
    response = stage(client, project_id, **kwargs)
    assert response.status_code == 200, response.get_json()
    return response.get_json()["pages"][0]["id"]


def make_spread(client, project_id, pages, **overrides):
    config_ = {"layout": "sequential", "orientation": "portrait", "cover": True, "gap": 0.12, "pages": pages}
    config_.update(overrides)
    response = client.post(
        f"/api/projects/{project_id}/canvas/nodes",
        json={"kind": "pages", "x": 0, "y": 0, "w": 900, "h": 500, "config": config_},
    )
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def slot(page_id=None, **extra):
    return {"page_id": page_id, "fit": "contain", **extra}


def slots_of(node_id):
    return db.get_canvas_node(node_id)["config"]["pages"]


def export_doc(client, node_id, query=""):
    response = client.get(f"/api/canvas/nodes/{node_id}/export.pdf{query}")
    assert response.status_code == 200, response.data[:200]
    return fitz.open(stream=response.get_data(), filetype="pdf")


def embedded_size(doc, index=0):
    image = doc.extract_image(doc[index].get_images()[0][0])
    return image["width"], image["height"]


def _write(path, data):
    path.write_bytes(data)
    return path


def add_own_work_reference(archive, colour, name):
    """What the Add tab's own-work checkbox (and the old spread upload) made."""
    path = archive / name
    Image.new("RGB", (2480, 3508), colour).save(path, "PNG")
    return ingest.add_reference(path, title=path.stem, is_own_work=True, force=True)["id"]


# --- 1. upload is direct ------------------------------------------------------


def test_staging_a_page_makes_no_claude_call_and_creates_no_reference(client):
    project_id = new_project(client)
    with patch("tagging.tag_image") as tag, patch("embeddings.embed_image") as embed, \
            patch("embeddings.add_to_index") as index, patch("ingest.add_reference") as add:
        response = stage(client, project_id, image_bytes(), "cover.png")

    assert response.status_code == 200
    assert tag.call_count == embed.call_count == index.call_count == add.call_count == 0
    assert db.list_references() == []
    # And the capture queue was never involved either.
    with db.get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM captures").fetchone()[0] == 0


def test_a_staged_page_is_stored_hashed_and_measured(client):
    project_id = new_project(client)
    data = image_bytes((620, 877))
    page = stage(client, project_id, data, "Cover Page.png").get_json()["pages"][0]

    row = db.get_portfolio_page(page["id"])
    assert (row["width"], row["height"]) == (620, 877)
    assert row["project_id"] == project_id
    assert row["filename"] == "Cover Page.png"
    assert row["content_hash"] == ingest._file_hash(portfolio.path_for(row))
    assert portfolio.path_for(row).read_bytes() == data
    # Its own directory, not the archive's tree.
    assert portfolio.path_for(row).parent == config.PORTFOLIO_DIR
    assert config.REFERENCES_DIR not in portfolio.path_for(row).parents
    assert page["print"]["dpi"] < spreads.MIN_PRINT_DPI  # the print check rides along


def test_dimensions_are_the_displayed_ones_for_an_exif_rotated_photo(client):
    exif = Image.Exif()
    exif[0x0112] = 6
    data = image_bytes((800, 600), fmt="JPEG", exif=exif.tobytes())
    page = stage(client, new_project(client), data, "phone.jpg").get_json()["pages"][0]
    assert (page["width"], page["height"]) == (600, 800)


def test_several_files_stage_in_one_request_and_a_bad_one_does_not_sink_the_rest(client):
    project_id = new_project(client)
    response = client.post(
        f"/api/projects/{project_id}/portfolio/pages",
        data={"file": [
            (io.BytesIO(image_bytes(colour=(1, 2, 3))), "one.png"),
            (io.BytesIO(b"not an image"), "two.png"),
            (io.BytesIO(b"hello"), "notes.txt"),
            (io.BytesIO(image_bytes(colour=(9, 8, 7))), "three.png"),
        ]},
        content_type="multipart/form-data",
    )
    body = response.get_json()
    assert response.status_code == 200
    assert [p["filename"] for p in body["pages"]] == ["one.png", "three.png"]
    assert {e["filename"] for e in body["errors"]} == {"two.png", "notes.txt"}
    assert len(db.list_portfolio_pages(project_id)) == 2


def test_nothing_staged_is_an_error(client):
    project_id = new_project(client)
    response = stage(client, project_id, b"nope", "x.txt")
    assert response.status_code == 400
    assert "images" in response.get_json()["error"]
    assert client.post(f"/api/projects/{project_id}/portfolio/pages").status_code == 400
    assert stage(client, "no-such-project").status_code == 404


def test_the_same_bytes_in_one_project_are_one_page(client):
    project_id = new_project(client)
    data = image_bytes()
    first = stage(client, project_id, data, "a.png").get_json()["pages"][0]
    again = stage(client, project_id, data, "b.png").get_json()["pages"][0]
    assert again["id"] == first["id"] and first["created"] is True and again["created"] is False
    assert len(db.list_portfolio_pages(project_id)) == 1
    assert len(list(config.PORTFOLIO_DIR.iterdir())) == 1  # the second copy was not kept

    # Another project is another store.
    other = stage(client, new_project(client, "Other"), data, "a.png").get_json()["pages"][0]
    assert other["id"] != first["id"]


# --- 2. migrating the pages that already exist ---------------------------------


def seven_page_spread(client, archive):
    """The state the old pipeline left: a project whose spread names seven
    own-work references, plus own-work references the spread never mentions."""
    project_id = new_project(client)
    named = [add_own_work_reference(archive, (30 * i, 60, 200 - 20 * i), f"page{i}.png") for i in range(7)]
    # Own work from the Add tab's checkbox -- never on a page.
    stray_image = add_own_work_reference(archive, (250, 250, 10), "stray.png")
    pdf = archive / "portfolio-so-far.pdf"
    fitz_doc = fitz.open()
    fitz_doc.new_page()
    fitz_doc.save(pdf)
    stray_pdf = ingest.add_reference(pdf, is_own_work=True, force=True)["id"]
    research = ingest.add_reference(
        _write(archive / "research.png", image_bytes((900, 900), colour=(5, 5, 5))), force=True
    )["id"]

    pages = [{"reference_id": ref, "fit": "cover" if i == 2 else "contain"} for i, ref in enumerate(named)]
    pages[2]["crop"] = {"x": 0.25, "y": 0.5}
    pages += [{"reference_id": None, "fit": "contain"}, {"reference_id": None, "fit": "contain"}]
    node = make_spread(client, project_id, pages)
    return project_id, node, named, {"stray_image": stray_image, "stray_pdf": stray_pdf, "research": research}


def test_the_seven_existing_pages_migrate_and_their_spreads_still_render(client, archive):
    project_id, node, named, others = seven_page_spread(client, archive)
    references_before = {r["id"]: r for r in db.list_references()}

    report = portfolio.migrate_spread_references()

    assert report["migrated"] == 7 and report["emptied"] == 2 and report["left"] == []
    # Repointed: page_id in place of reference_id, fit and crop carried across.
    entries = slots_of(node["id"])
    assert len(entries) == 9
    assert all("reference_id" not in e and "capture_id" not in e for e in entries)
    assert all(e["page_id"] for e in entries[:7]) and all(e["page_id"] is None for e in entries[7:])
    assert entries[2]["fit"] == "cover" and entries[2]["crop"] == {"x": 0.25, "y": 0.5}
    staged = {p["id"]: p for p in db.list_portfolio_pages(project_id)}
    assert len(staged) == 7

    # Each staged page is a byte-for-byte copy of the reference it replaced.
    for entry, ref_id in zip(entries[:7], named):
        page = staged[entry["page_id"]]
        original = config.REFERENCES_DIR / references_before[ref_id]["filepath"]
        assert portfolio.path_for(page).read_bytes() == original.read_bytes()
        assert page["content_hash"] == references_before[ref_id]["content_hash"]

    # Only what a spread named was touched: every archive row is still there,
    # unchanged, including the own-work ones that were never pages.
    assert {r["id"]: r for r in db.list_references()} == references_before
    for stray in others.values():
        assert stray in references_before
    # ...and they were not copied into staging.
    assert {p["content_hash"] for p in staged.values()}.isdisjoint(
        {references_before[s]["content_hash"] for s in others.values()}
    )

    # The spread still renders: it exports a page per slot with the images in,
    # and every staged page serves a thumbnail.
    doc = export_doc(client, node["id"])
    assert len(doc) == 9
    assert [bool(doc[i].get_images()) for i in range(9)] == [True] * 7 + [False] * 2
    for page_id in staged:
        thumb = client.get(f"/api/portfolio/pages/{page_id}/thumb")
        assert thumb.status_code == 200 and thumb.mimetype in ("image/jpeg", "image/png")
    overview = client.get(f"/api/projects/{project_id}/portfolio").get_json()
    assert overview["spreads"][0]["filled"] == 7 and overview["spreads"][0]["total"] == 9
    assert all(p["placements"] for p in overview["pages"])


def test_migration_is_idempotent(client, archive):
    project_id, node, *_ = seven_page_spread(client, archive)
    portfolio.migrate_spread_references()
    after_first = db.get_canvas_node(node["id"])["config"]
    files = sorted(p.name for p in config.PORTFOLIO_DIR.iterdir() if p.suffix == ".png")

    second = portfolio.migrate_spread_references()

    assert second == {"spreads": 0, "migrated": 0, "emptied": 0, "left": []}
    assert db.get_canvas_node(node["id"])["config"] == after_first
    assert sorted(p.name for p in config.PORTFOLIO_DIR.iterdir() if p.suffix == ".png") == files


def test_migration_keeps_a_backup_of_the_old_shape(client, archive):
    project_id, node, named, _ = seven_page_spread(client, archive)
    portfolio.migrate_spread_references()
    backups = list(config.PORTFOLIO_DIR.glob("spreads-before-staging-*.json"))
    assert len(backups) == 1
    old = json.loads(backups[0].read_text())[node["id"]]
    assert [e["reference_id"] for e in old["pages"][:7]] == named


def test_two_slots_naming_one_reference_share_one_staged_page(client, archive):
    project_id = new_project(client)
    ref = add_own_work_reference(archive, (9, 9, 9), "divider.png")
    node = make_spread(client, project_id, [
        {"reference_id": ref, "fit": "contain"}, {"reference_id": ref, "fit": "contain"},
    ])
    portfolio.migrate_spread_references()
    a, b = (e["page_id"] for e in slots_of(node["id"]))
    assert a == b and len(db.list_portfolio_pages(project_id)) == 1


def test_a_reference_that_cant_be_found_is_left_as_it_was(client, archive):
    project_id = new_project(client)
    ghost = add_own_work_reference(archive, (9, 9, 9), "ghost.png")
    real = add_own_work_reference(archive, (90, 9, 9), "real.png")
    node = make_spread(client, project_id, [
        {"reference_id": ghost, "fit": "contain"}, {"reference_id": real, "fit": "contain"},
    ])
    (config.REFERENCES_DIR / db.get_reference(ghost)["filepath"]).unlink()

    report = portfolio.migrate_spread_references()

    entries = slots_of(node["id"])
    assert entries[0] == {"reference_id": ghost, "fit": "contain"}  # untouched, retried next start
    assert entries[1]["page_id"] and "reference_id" not in entries[1]
    assert report["migrated"] == 1 and report["left"][0]["reference_id"] == ghost


def test_an_upload_still_being_ingested_is_left_and_one_that_finished_is_migrated(client, archive):
    project_id = new_project(client)
    done_ref = add_own_work_reference(archive, (9, 90, 9), "done.png")
    with db.get_conn() as conn:
        for cid, status, ref in (("cap-done", db.CAPTURE_DONE, done_ref), ("cap-busy", db.CAPTURE_PROCESSING, None),
                                 ("cap-failed", db.CAPTURE_FAILED, None)):
            conn.execute(
                "INSERT INTO captures (id, status, reference_id, kind, envelope, created_at, updated_at)"
                " VALUES (?, ?, ?, 'image', '{}', 'x', 'x')", (cid, status, ref),
            )
    node = make_spread(client, project_id, [
        {"reference_id": None, "capture_id": "cap-done", "fit": "contain"},
        {"reference_id": None, "capture_id": "cap-busy", "fit": "contain"},
        {"reference_id": None, "capture_id": "cap-failed", "fit": "contain"},
    ])

    report = portfolio.migrate_spread_references()

    entries = slots_of(node["id"])
    assert entries[0]["page_id"] and "capture_id" not in entries[0]
    assert entries[1].get("capture_id") == "cap-busy" and "page_id" not in entries[1]
    assert entries[2] == {"page_id": None, "fit": "contain"}  # a failed upload was an empty slot
    assert len(report["left"]) == 1


def test_a_migrated_page_is_already_in_the_archive_so_promoting_it_is_a_no_op(client, archive):
    project_id = new_project(client)
    ref = add_own_work_reference(archive, (70, 7, 7), "old.png")
    node = make_spread(client, project_id, [{"reference_id": ref, "fit": "contain"}])
    portfolio.migrate_spread_references()
    page_id = slots_of(node["id"])[0]["page_id"]

    with patch("tagging.tag_image") as tag:
        result = client.post(f"/api/portfolio/pages/{page_id}/promote").get_json()

    assert result == {"reference_id": ref, "created": False, "is_own_work": True}
    assert tag.call_count == 0 and len(db.list_references()) == 1


def test_deleting_an_archive_reference_still_empties_an_unmigrated_slot(client, archive):
    project_id = new_project(client)
    ref = add_own_work_reference(archive, (70, 7, 7), "old.png")
    node = make_spread(client, project_id, [
        slot(), {"reference_id": ref, "fit": "cover", "crop": {"x": 0.2, "y": 0.5}},
    ])
    assert client.delete(f"/api/references/{ref}").status_code == 200
    assert slots_of(node["id"])[1] == {"reference_id": None, "fit": "cover"}


# --- 3. stage first, place second ---------------------------------------------


def test_a_page_can_exist_before_it_has_a_slot(client):
    project_id = new_project(client)
    page_id = stage_id(client, project_id)
    overview = client.get(f"/api/projects/{project_id}/portfolio").get_json()
    [page] = overview["pages"]
    assert page["id"] == page_id and page["placements"] == [] and overview["spreads"] == []


def test_fill_places_the_waiting_pages_in_filename_order(client):
    project_id = new_project(client)
    ids = {n: stage_id(client, project_id, data=image_bytes(colour=(i * 10, 0, 0)), name=n)
           for i, n in enumerate(["page10.png", "page2.png", "page1.png"])}
    node = make_spread(client, project_id, [slot() for _ in range(4)])

    result = client.post(f"/api/projects/{project_id}/portfolio/fill", json={"node_id": node["id"]}).get_json()

    assert result == {"placed": 3, "left_over": 0, "empty_remaining": 1}
    assert [e["page_id"] for e in slots_of(node["id"])] == [ids["page1.png"], ids["page2.png"], ids["page10.png"], None]


def test_fill_leaves_placed_slots_alone_and_never_grows_the_spread(client):
    project_id = new_project(client)
    placed = stage_id(client, project_id, data=image_bytes(colour=(1, 1, 1)), name="a.png")
    waiting = [stage_id(client, project_id, data=image_bytes(colour=(2 + i, 1, 1)), name=f"w{i}.png") for i in range(3)]
    node = make_spread(client, project_id, [slot(placed), slot(), slot()])

    result = client.post(f"/api/projects/{project_id}/portfolio/fill", json={"node_id": node["id"]}).get_json()

    assert result == {"placed": 2, "left_over": 1, "empty_remaining": 0}
    assert [e["page_id"] for e in slots_of(node["id"])] == [placed, waiting[0], waiting[1]]
    assert len(slots_of(node["id"])) == 3


def test_fill_does_not_put_an_earlier_version_back(client):
    """A page that was on the document and came off it is not 'waiting'."""
    project_id = new_project(client)
    old = stage_id(client, project_id, data=image_bytes(colour=(1, 1, 1)), name="v1.png")
    node = make_spread(client, project_id, [slot(old)])
    new = client.post(
        f"/api/portfolio/pages/{old}/replace",
        data={"file": (io.BytesIO(image_bytes(colour=(2, 2, 2))), "v2.png")},
        content_type="multipart/form-data",
    ).get_json()["page"]["id"]
    extra_slot = db.get_canvas_node(node["id"])["config"]
    extra_slot["pages"].append(slot())
    client.patch(f"/api/canvas/nodes/{node['id']}", json={"config": extra_slot})

    result = client.post(f"/api/projects/{project_id}/portfolio/fill", json={"node_id": node["id"]}).get_json()

    assert result["placed"] == 0  # v1 is an earlier version, v2 is already placed
    assert [e["page_id"] for e in slots_of(node["id"])] == [new, None]
    assert db.get_portfolio_page(old)["ever_placed"] is True


def test_place_puts_a_page_in_a_slot_and_refuses_a_foreign_spread(client):
    project_id = new_project(client)
    page = stage_id(client, project_id)
    node = make_spread(client, project_id, [slot(), slot(fit="cover")])
    other_node = make_spread(client, new_project(client, "Other"), [slot()])

    ok = client.post(f"/api/portfolio/pages/{page}/place", json={"node_id": node["id"], "index": 1})
    assert ok.status_code == 200
    assert slots_of(node["id"])[1] == {"page_id": page, "fit": "cover"}  # the slot's fit is kept
    assert client.post(f"/api/portfolio/pages/{page}/place",
                       json={"node_id": other_node["id"], "index": 0}).status_code == 404
    assert client.post(f"/api/portfolio/pages/{page}/place",
                       json={"node_id": node["id"], "index": 9}).status_code == 400


def test_a_page_counts_as_placed_whichever_route_wrote_the_spread(client):
    project_id = new_project(client)
    a, b, c = (stage_id(client, project_id, data=image_bytes(colour=(i, i, i)), name=f"{i}.png") for i in range(3))
    create = make_spread(client, project_id, [slot(a)])
    client.patch(f"/api/canvas/nodes/{create['id']}",
                 json={"config": {**create["config"], "pages": [slot(a), slot(b)]}})
    assert [db.get_portfolio_page(x)["ever_placed"] for x in (a, b, c)] == [True, True, False]


# --- 4. versions belong in the store ---------------------------------------------


def test_a_replaced_page_leaves_its_predecessor_in_the_store(client):
    project_id = new_project(client)
    v1 = stage_id(client, project_id, data=image_bytes(colour=(10, 10, 10)), name="cover.png")
    first = make_spread(client, project_id, [slot(v1), slot(v1)])
    second = make_spread(client, project_id, [slot(v1), slot()])

    response = client.post(
        f"/api/portfolio/pages/{v1}/replace",
        data={"file": (io.BytesIO(image_bytes(colour=(200, 10, 10))), "cover.png")},
        content_type="multipart/form-data",
    )
    v2 = response.get_json()["page"]["id"]

    assert response.get_json()["slots"] == 3  # every slot that held v1 now holds v2
    assert v2 != v1
    assert db.get_portfolio_page(v1) is not None  # the predecessor survives...
    assert portfolio.path_for(db.get_portfolio_page(v1)).exists()  # ...with its file
    assert [e["page_id"] for e in slots_of(first["id"])] == [v2, v2]
    assert [e["page_id"] for e in slots_of(second["id"])] == [v2, None]
    overview = client.get(f"/api/projects/{project_id}/portfolio").get_json()
    by_id = {p["id"]: p for p in overview["pages"]}
    assert by_id[v1]["placements"] == [] and by_id[v1]["ever_placed"] is True  # unplaced, and an old version
    assert len(by_id[v2]["placements"]) == 3
    assert db.list_references() == []  # versions never reach the archive


def test_replacing_a_slot_from_the_canvas_keeps_the_old_page_too(client):
    """The canvas stages the new file then repoints the slot itself."""
    project_id = new_project(client)
    v1 = stage_id(client, project_id, data=image_bytes(colour=(10, 10, 10)))
    node = make_spread(client, project_id, [slot(v1)])
    v2 = stage_id(client, project_id, data=image_bytes(colour=(20, 20, 20)), name="v2.png")
    client.patch(f"/api/canvas/nodes/{node['id']}", json={"config": {**node["config"], "pages": [slot(v2)]}})
    assert {p["id"] for p in db.list_portfolio_pages(project_id)} == {v1, v2}


# --- 5. the management view's data ---------------------------------------------


def test_overview_says_where_each_page_sits_and_whether_it_is_archived(client, archive):
    project_id = new_project(client)
    placed = stage_id(client, project_id, data=image_bytes(colour=(1, 1, 1)), name="a.png")
    loose = stage_id(client, project_id, data=image_bytes(colour=(2, 2, 2)), name="b.png")
    node = make_spread(client, project_id, [slot(), slot(placed)], orientation="landscape")
    client.post(f"/api/portfolio/pages/{loose}/promote")

    overview = client.get(f"/api/projects/{project_id}/portfolio").get_json()
    by_id = {p["id"]: p for p in overview["pages"]}

    assert by_id[placed]["placements"] == [{"node_id": node["id"], "spread": 1, "index": 1, "number": 2}]
    assert by_id[placed]["in_archive"] is None
    assert by_id[loose]["placements"] == [] and by_id[loose]["in_archive"]["reference_id"]
    [spread] = overview["spreads"]
    assert spread["orientation"] == "landscape" and [s["page_id"] for s in spread["slots"]] == [None, placed]
    # A staged page the spread names but the store has lost reads as empty.
    client.patch(f"/api/canvas/nodes/{node['id']}", json={"config": {**node["config"], "pages": [slot("ghost")]}})
    again = client.get(f"/api/projects/{project_id}/portfolio").get_json()
    assert again["spreads"][0]["slots"][0]["page_id"] is None


def test_the_export_resolution_comes_from_the_portfolio_widget(client):
    project_id = new_project(client)
    assert client.get(f"/api/projects/{project_id}/portfolio").get_json()["export_dpi"] == 300
    client.post(f"/api/projects/{project_id}/widgets",
                json={"type": "portfolio", "w": 6, "h": 5, "config": {"exportDpi": 150}})
    assert client.get(f"/api/projects/{project_id}/portfolio").get_json()["export_dpi"] == 150
    # A nonsense value in the config falls back rather than breaking the page.
    other = new_project(client, "Other")
    client.post(f"/api/projects/{other}/widgets", json={"type": "portfolio", "config": {"exportDpi": "lots"}})
    assert client.get(f"/api/projects/{other}/portfolio").get_json()["export_dpi"] == 300


# --- 6. promotion is explicit -----------------------------------------------------


def test_promotion_creates_exactly_one_reference_and_promoting_twice_creates_none(client):
    project_id = new_project(client)
    page = stage_id(client, project_id, data=image_bytes(colour=(33, 66, 99)), name="Final Cover.png")
    assert db.list_references() == []

    # Tags that mention the filename's words, so ingest keeps the title the page
    # arrived with (it only swaps in Claude's when the two have nothing in common).
    with patch("tagging.tag_image", return_value=("Tagged Image", ["cover"], "the final cover")) as tag:
        first = client.post(f"/api/portfolio/pages/{page}/promote")
        second = client.post(f"/api/portfolio/pages/{page}/promote")

    assert first.status_code == second.status_code == 200
    refs = db.list_references()
    assert len(refs) == 1
    assert first.get_json() == {"reference_id": refs[0]["id"], "created": True, "is_own_work": True}
    assert second.get_json() == {"reference_id": refs[0]["id"], "created": False, "is_own_work": True}
    assert tag.call_count == 1  # the second promotion never reached Claude
    assert refs[0]["is_own_work"] is True and refs[0]["title"] == "Final Cover"
    # The staged page stays put, and now says it is archived.
    assert db.get_portfolio_page(page) is not None
    overview = client.get(f"/api/projects/{project_id}/portfolio").get_json()
    assert overview["pages"][0]["in_archive"]["reference_id"] == refs[0]["id"]


def test_the_same_bytes_staged_in_two_projects_cannot_double_archive(client):
    project_id = new_project(client)
    data = image_bytes(colour=(5, 50, 5))
    a = stage_id(client, project_id, data=data, name="a.png")
    # Another project staging the identical bytes has a page of its own...
    b = stage_id(client, new_project(client, "Other"), data=data, name="b.png")
    assert a != b
    client.post(f"/api/portfolio/pages/{a}/promote")
    # ...but the archive is shared, so it resolves to the reference that exists.
    assert client.post(f"/api/portfolio/pages/{b}/promote").get_json()["created"] is False
    assert len(db.list_references()) == 1


def test_promoting_a_page_whose_file_has_gone_is_a_clean_error(client):
    project_id = new_project(client)
    page = stage_id(client, project_id)
    portfolio.path_for(db.get_portfolio_page(page)).unlink()
    assert client.post(f"/api/portfolio/pages/{page}/promote").status_code == 404
    assert client.post("/api/portfolio/pages/nope/promote").status_code == 404
    assert db.list_references() == []


# --- 7. thumbnails ------------------------------------------------------------------


def test_a_staged_page_thumbnail_comes_from_the_shared_content_hash_cache(client, archive):
    project_id = new_project(client)
    data = image_bytes((1200, 1700), colour=(80, 40, 20))
    page = stage(client, project_id, data, "big.png").get_json()["pages"][0]
    row = db.get_portfolio_page(page["id"])

    response = client.get(f"/api/portfolio/pages/{page['id']}/thumb")

    assert response.status_code == 200
    assert "immutable" in response.headers["Cache-Control"]
    with Image.open(io.BytesIO(response.data)) as thumb:
        assert max(thumb.size) <= 400
    cached = list(config.THUMBNAILS_DIR.glob(f"{row['content_hash']}_v*"))
    assert len(cached) == 1

    # A reference holding the same bytes shares that one cached file: the cache
    # does not care whether the bytes are a page or a reference.
    src = archive / "same.png"
    src.write_bytes(data)
    ref_id = ingest.add_reference(src, force=True)["id"]
    assert client.get(f"/media/{ref_id}/thumb").status_code == 200
    assert list(config.THUMBNAILS_DIR.glob(f"{row['content_hash']}_v*")) == cached

    assert client.get(f"/api/portfolio/pages/{page['id']}/file").data == data
    assert client.get("/api/portfolio/pages/nope/thumb").status_code == 404


# --- 8. deleting ----------------------------------------------------------------------


def test_deleting_a_staged_page_empties_its_slot_and_keeps_the_pagination(client):
    project_id = new_project(client)
    page = stage_id(client, project_id)
    keep = stage_id(client, project_id, data=image_bytes(colour=(9, 9, 9)), name="keep.png")
    node = make_spread(client, project_id, [
        slot(), slot(page, fit="cover", crop={"x": 0.2, "y": 0.5}), slot(keep), slot(page),
    ])
    path = portfolio.path_for(db.get_portfolio_page(page))

    assert client.delete(f"/api/portfolio/pages/{page}").status_code == 200

    entries = slots_of(node["id"])
    assert len(entries) == 4  # nothing renumbered
    assert entries[1] == {"page_id": None, "fit": "cover"}  # fit kept, the now-meaningless crop dropped
    assert entries[3] == {"page_id": None, "fit": "contain"}
    assert entries[2]["page_id"] == keep
    assert db.get_portfolio_page(page) is None and not path.exists()
    # The spread still renders and exports: blanks where the page was.
    doc = export_doc(client, node["id"])
    assert [bool(doc[i].get_images()) for i in range(4)] == [False, False, True, False]
    assert client.delete(f"/api/portfolio/pages/{page}").status_code == 404


def test_deleting_a_staged_page_leaves_the_archive_alone(client):
    project_id = new_project(client)
    page = stage_id(client, project_id)
    ref = client.post(f"/api/portfolio/pages/{page}/promote").get_json()["reference_id"]
    client.delete(f"/api/portfolio/pages/{page}")
    assert db.get_reference(ref) is not None


def test_deleting_a_project_deletes_its_staged_pages_and_their_files(client):
    project_id = new_project(client)
    other_id = new_project(client, "Other")
    mine = [stage_id(client, project_id, data=image_bytes(colour=(i, 0, 0)), name=f"{i}.png") for i in range(3)]
    theirs = stage_id(client, other_id, data=image_bytes(colour=(0, 9, 0)))
    make_spread(client, project_id, [slot(mine[0])])
    files = [portfolio.path_for(db.get_portfolio_page(p)) for p in mine]
    survivor = portfolio.path_for(db.get_portfolio_page(theirs))
    kept_ref = client.post(f"/api/portfolio/pages/{mine[1]}/promote").get_json()["reference_id"]

    assert client.delete(f"/api/projects/{project_id}").status_code == 200

    assert db.list_portfolio_pages(project_id) == []
    assert not any(f.exists() for f in files)
    assert db.get_portfolio_page(theirs) is not None and survivor.exists()
    assert db.get_reference(kept_ref) is not None  # archive material is not the project's to delete


# --- export -------------------------------------------------------------------------------


def test_export_renders_from_staging_with_no_archive_write(client, archive):
    project_id = new_project(client)
    pages = [stage_id(client, project_id, data=image_bytes(colour=(40 * i, 9, 9)), name=f"{i}.png") for i in range(3)]
    node = make_spread(client, project_id, [slot(p) for p in pages] + [slot()])
    before_refs = db.list_references()
    before_files = sorted(p.name for p in (archive / "references" / "images").iterdir())

    with patch("ingest.add_reference") as add, patch("tagging.tag_image") as tag, \
            patch("embeddings.embed_image") as embed, patch("db.insert_reference") as insert:
        doc = export_doc(client, node["id"])
        plan = client.get(f"/api/canvas/nodes/{node['id']}/export-plan").get_json()

    assert len(doc) == 4 and [bool(doc[i].get_images()) for i in range(4)] == [True, True, True, False]
    assert plan["page_ids"] == pages
    assert add.call_count == tag.call_count == embed.call_count == insert.call_count == 0
    assert db.list_references() == before_refs
    assert sorted(p.name for p in (archive / "references" / "images").iterdir()) == before_files
    with db.get_conn() as conn:
        for table in ("captures", "colour_analysis"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def test_an_export_reads_only_this_projects_pages(client):
    mine, other = new_project(client), new_project(client, "Other")
    foreign = stage_id(client, other)
    node = make_spread(client, mine, [slot(foreign)])  # a page id from someone else's store
    doc = export_doc(client, node["id"])
    assert len(doc) == 1 and doc[0].get_images() == []


def test_a_staged_file_that_has_gone_exports_blank_instead_of_failing(client):
    project_id = new_project(client)
    page = stage_id(client, project_id)
    node = make_spread(client, project_id, [slot(page)])
    portfolio.path_for(db.get_portfolio_page(page)).unlink()
    assert export_doc(client, node["id"])[0].get_images() == []


# --- export resolution: downsample, never upscale ---------------------------------------


def dpi_spread(client, size, fmt="PNG", name="p.png", fit="contain", **save_kwargs):
    project_id = new_project(client)
    page = stage_id(client, project_id, data=image_bytes(size, fmt=fmt, **save_kwargs), name=name)
    return project_id, make_spread(client, project_id, [slot(page, fit=fit)])


def test_an_image_above_the_target_is_resampled_down_to_it(client):
    _, node = dpi_spread(client, (1240, 1754))  # 150 dpi on A4
    resampled = export_doc(client, node["id"], "?dpi=75")
    native = export_doc(client, node["id"], "?dpi=300")
    assert embedded_size(resampled) == pytest.approx((620, 877), abs=1)
    # Same place on the page, same proportions: only the pixels changed.
    rect = lambda doc: doc[0].get_image_rects(doc[0].get_images()[0][0])[0]
    assert tuple(rect(resampled)) == pytest.approx(tuple(rect(native)), abs=0.01)


def test_an_image_below_the_target_is_left_alone_and_never_upscaled(client):
    _, node = dpi_spread(client, (1240, 1754))
    doc = export_doc(client, node["id"], "?dpi=300")
    assert embedded_size(doc) == (1240, 1754)


def test_an_image_within_a_few_percent_of_the_target_is_not_re_encoded(client):
    _, node = dpi_spread(client, (2480, 3508))  # 300 dpi
    assert embedded_size(export_doc(client, node["id"], "?dpi=290")) == (2480, 3508)


def test_a_jpeg_stays_a_jpeg_when_it_is_resampled(client):
    _, node = dpi_spread(client, (1240, 1754), fmt="JPEG", name="scan.jpg", quality=92)
    doc = export_doc(client, node["id"], "?dpi=75")
    image = doc.extract_image(doc[0].get_images()[0][0])
    assert image["ext"] in ("jpeg", "jpg") and (image["width"], image["height"]) == pytest.approx((620, 877), abs=1)


def test_a_cover_page_is_measured_for_the_fit_it_uses(client):
    """Cover spreads the pixels over more paper, so its effective dpi is lower:
    the same image is over the target contained and under it covered."""
    project_id = new_project(client)
    page = stage_id(client, project_id, data=image_bytes((1600, 1200)))
    node = make_spread(client, project_id, [slot(page, fit="contain"), slot(page, fit="cover")])

    plan = client.get(f"/api/canvas/nodes/{node['id']}/export-plan?dpi=150").get_json()
    contain, cover = plan["pages"]

    assert contain["dpi"] == spreads.print_check(1600, 1200, "portrait", "contain")["dpi"]
    assert cover["dpi"] == spreads.print_check(1600, 1200, "portrait", "cover")["dpi"]
    assert contain["state"] == "downsample" and contain["below_target"] is False
    assert cover["state"] == "native" and cover["below_target"] is True
    assert plan["below_target"] == [2] and plan["downsampled"] == [1]


def test_the_plan_names_what_will_be_resampled_and_what_is_below_target(client):
    project_id = new_project(client)
    big = stage_id(client, project_id, data=image_bytes((1240, 1754)), name="big.png")      # 150 dpi
    small = stage_id(client, project_id, data=image_bytes((620, 877), colour=(1, 2, 3)), name="small.png")  # 75 dpi
    node = make_spread(client, project_id, [slot(big), slot(), slot(small)])

    plan = client.get(f"/api/canvas/nodes/{node['id']}/export-plan?dpi=100").get_json()

    assert plan["dpi"] == 100
    assert [p["state"] for p in plan["pages"]] == ["downsample", "blank", "native"]
    assert plan["downsampled"] == [1] and plan["below_target"] == [3] and plan["blank"] == [2]
    assert plan["pages"][0]["output_px"] == [827, 1169]
    # And that is exactly what the export then does.
    doc = export_doc(client, node["id"], "?dpi=100")
    assert embedded_size(doc, 0) == pytest.approx((827, 1169), abs=1)
    assert embedded_size(doc, 2) == (620, 877)


def test_the_export_and_the_print_warning_use_the_same_dpi_arithmetic():
    for size, orientation, fit in [((1200, 900), "portrait", "contain"), ((1200, 900), "portrait", "cover"),
                                   ((3508, 2480), "landscape", "contain"), ((2480, 3508), "portrait", "contain")]:
        assert round(spreads.effective_dpi(*size, orientation, fit)) == spreads.print_check(*size, orientation, fit)["dpi"]


def test_the_default_export_resolution_follows_the_widget_and_an_override_beats_it(client):
    project_id = new_project(client)
    page = stage_id(client, project_id, data=image_bytes((1240, 1754)))  # 150 dpi
    node = make_spread(client, project_id, [slot(page)])
    client.post(f"/api/projects/{project_id}/widgets", json={"type": "portfolio", "config": {"exportDpi": 75}})

    assert embedded_size(export_doc(client, node["id"])) == pytest.approx((620, 877), abs=1)  # the widget's 75
    assert embedded_size(export_doc(client, node["id"], "?dpi=300")) == (1240, 1754)          # this export's override
    assert client.get(f"/api/canvas/nodes/{node['id']}/export-plan").get_json()["dpi"] == 75
    assert client.get(f"/api/canvas/nodes/{node['id']}/export-plan?dpi=200").get_json()["dpi"] == 200


@pytest.mark.parametrize("value", ["0", "10", "5000", "lots", "nan", "inf"])
def test_an_unusable_export_resolution_is_refused(client, value):
    _, node = dpi_spread(client, (620, 877))
    assert client.get(f"/api/canvas/nodes/{node['id']}/export.pdf?dpi={value}").status_code == 400
    assert client.get(f"/api/canvas/nodes/{node['id']}/export-plan?dpi={value}").status_code == 400


def test_an_export_reports_when_it_has_finished(client):
    _, node = dpi_spread(client, (620, 877))
    job = "export-1234abcd"
    assert client.get(f"/api/portfolio/exports/{job}").get_json() == {"state": "unknown"}

    response = client.get(f"/api/canvas/nodes/{node['id']}/export.pdf?job={job}")
    assert response.status_code == 200
    response.get_data()  # the stream is read to its last byte
    assert client.get(f"/api/portfolio/exports/{job}").get_json() == {"state": "done"}

    assert client.get(f"/api/canvas/nodes/{node['id']}/export.pdf?job=../x").status_code == 400
    assert client.get("/api/portfolio/exports/..%2Fx").status_code == 404


def test_an_export_that_is_abandoned_midway_is_not_reported_as_finished(client):
    _, node = dpi_spread(client, (620, 877))
    stream = portfolio.track_export("abandoned-job", spreads.export_pdf(
        [{"path": None}, {"path": None}], dpi=300,
    ))
    next(stream)
    assert portfolio.export_state("abandoned-job") == "running"
    stream.close()  # the browser stopped listening
    assert portfolio.export_state("abandoned-job") == "cancelled"
