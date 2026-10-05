"""Portfolio spreads: page geometry, uploads onto pages, and the PDF export.

The page geometry is the browser's own module (static/project/canvas/
spread-layout.js), run here under node exactly as the canvas runs it -- a
Python copy of it would only test the copy. Those tests skip when node isn't
on PATH; everything else runs offline like the rest of the suite.
"""
import base64
import io
import json
import shutil
import subprocess
from pathlib import Path

import fitz
import pytest
from PIL import Image

from conftest import FakeUpload, drain, png_bytes

import capture
import db
import embeddings
import ingest
import spreads

LAYOUT_JS = Path(__file__).resolve().parents[1] / "static" / "project" / "canvas" / "spread-layout.js"
A4_RATIO = 297 / 210
A4_PT = (210 / 25.4 * 72, 297 / 25.4 * 72)
EPS = 1e-6


# --- running the canvas's own layout ----------------------------------------


def run_js(expression):
    """Evaluate `expression` against spread-layout.js's exports (bound as `m`)
    and return the JSON result. Loaded from a data: URL so it's an ES module
    whatever this node's module-type detection thinks of a bare .js file."""
    node = shutil.which("node")
    if not node:
        pytest.skip("node isn't on PATH -- the page layout is the canvas's own JS module")
    source = base64.b64encode(LAYOUT_JS.read_bytes()).decode()
    script = (
        f'const m = await import("data:text/javascript;base64,{source}");'
        f"process.stdout.write(JSON.stringify({expression}));"
    )
    out = subprocess.run(
        [node, "--input-type=module", "-e", script],
        capture_output=True, text=True, timeout=30, check=True,
    )
    return json.loads(out.stdout)


def layout(**options):
    return run_js(f"m.layoutSpread({json.dumps(options)})")


def pairs(result):
    """Page indices grouped by the grid cell they share."""
    grouped = {}
    for page in result["pages"]:
        grouped.setdefault(page["unit"], []).append(page["index"])
    return [grouped[k] for k in sorted(grouped)]


# --- page geometry ----------------------------------------------------------


@pytest.mark.parametrize("width,height", [(1200, 600), (3000, 200), (200, 3000), (640, 905)])
def test_a_drawn_region_fills_with_correctly_proportioned_a4_pages(width, height):
    result = layout(width=width, height=height, count=30)
    assert len(result["pages"]) == 30
    for page in result["pages"]:
        # Exactly A4, whatever shape the region is -- never bent to fit it.
        assert page["h"] / page["w"] == pytest.approx(A4_RATIO, rel=1e-9)
        assert page["x"] >= -EPS and page["y"] >= -EPS
        assert page["x"] + page["w"] <= width + EPS
        assert page["y"] + page["h"] <= height + EPS


def test_landscape_pages_are_a4_on_their_side():
    result = layout(width=1200, height=800, count=12, orientation="landscape")
    for page in result["pages"]:
        assert page["w"] / page["h"] == pytest.approx(A4_RATIO, rel=1e-9)


def test_the_page_size_follows_from_the_region_and_the_slack_is_left():
    # Three portrait pages and two gaps, exactly: the pages should fill it.
    gap = 0.12
    width = 3 * 100 + 2 * gap * 100
    exact = layout(width=width, height=100 * A4_RATIO, count=3, gap=gap)
    assert exact["columns"] == 3
    assert exact["pageW"] == pytest.approx(100)

    # Twice as tall: same pages, and the extra height is slack, split evenly
    # above and below rather than stretched into the pages.
    tall = layout(width=width, height=2 * 100 * A4_RATIO, count=3, gap=gap)
    assert tall["pageW"] == pytest.approx(100)
    top = tall["pages"][0]["y"]
    bottom = 2 * 100 * A4_RATIO - (top + tall["pageH"])
    assert top == pytest.approx(bottom) and top > 0


def test_resizing_a_spread_rescales_every_page_together():
    small = layout(width=900, height=500, count=24, layout="booklet")
    large = layout(width=1800, height=1000, count=24, layout="booklet")
    for a, b in zip(small["pages"], large["pages"]):
        for key in ("x", "y", "w", "h"):
            assert b[key] == pytest.approx(a[key] * 2)


def test_sequential_pages_are_evenly_spaced():
    result = layout(width=1000, height=700, count=12)
    pages = result["pages"]
    columns = result["columns"]
    across = [pages[i + 1]["x"] - (pages[i]["x"] + pages[i]["w"]) for i in range(columns - 1)]
    down = pages[columns]["y"] - (pages[0]["y"] + pages[0]["h"])
    assert across and all(g == pytest.approx(result["gap"]) for g in across)
    assert down == pytest.approx(result["gap"])


@pytest.mark.parametrize("gap", [0.04, 0.12, 0.6])
def test_booklet_pairs_have_a_tighter_gutter_than_the_gap_between_pairs(gap):
    result = layout(width=1600, height=500, count=8, layout="booklet", cover=False, gap=gap)
    by_index = {p["index"]: p for p in result["pages"]}
    assert result["columns"] >= 2, "need two pairs on one row to measure between them"

    gutter = by_index[1]["x"] - (by_index[0]["x"] + by_index[0]["w"])
    between = by_index[2]["x"] - (by_index[1]["x"] + by_index[1]["w"])
    assert by_index[0]["y"] == by_index[2]["y"]
    # The pages of a pair never touch -- touching, they read as one wide page.
    assert gutter > 0
    assert gutter < between
    assert gutter == pytest.approx(result["gutter"])
    assert between == pytest.approx(result["gap"])


def test_a_cover_page_shifts_the_pairing():
    with_cover = layout(width=1600, height=900, count=8, layout="booklet", cover=True)
    without = layout(width=1600, height=900, count=8, layout="booklet", cover=False)

    # Page 1 stands alone on the right, like the first page of a book; every
    # pair after it moves along by one. The last page is then alone too.
    assert pairs(with_cover) == [[0], [1, 2], [3, 4], [5, 6], [7]]
    assert with_cover["pages"][0]["side"] == "right"
    assert with_cover["pages"][7]["side"] == "left"
    assert pairs(without) == [[0, 1], [2, 3], [4, 5], [6, 7]]

    # Pairing moves; numbering doesn't. Page i is the i-th page either way.
    for result in (with_cover, without):
        assert [p["index"] for p in result["pages"]] == list(range(8))


def test_pages_in_a_booklet_row_read_left_to_right():
    result = layout(width=1600, height=500, count=6, layout="booklet", cover=False)
    xs = [p["x"] for p in result["pages"]]
    assert xs == sorted(xs)


def test_the_page_under_a_point_is_found_from_the_layout():
    found = run_js(
        "(() => { const l = m.layoutSpread({ width: 800, height: 400, count: 6 });"
        " const p = l.pages[4];"
        " return [m.pageAt(l, p.x + p.w / 2, p.y + p.h / 2), m.pageAt(l, -5, -5)]; })()"
    )
    assert found == [4, None]


def test_the_canvas_and_the_server_agree_on_print_resolution():
    for w, h, orientation, fit in [
        (2480, 3508, "portrait", "contain"),
        (1200, 900, "portrait", "contain"),
        (1200, 900, "portrait", "cover"),
        (3508, 2480, "landscape", "cover"),
    ]:
        js = run_js(f"m.printDpi({w}, {h}, {json.dumps(orientation)}, {json.dumps(fit)})")
        py = spreads.print_check(w, h, orientation, fit)
        assert round(js) == py["dpi"]


# --- fitting an image to a page --------------------------------------------


def test_a_non_a4_image_contains_without_distortion():
    page_w, page_h = A4_PT
    x0, y0, x1, y1 = spreads.placement(1600, 1200, page_w, page_h, fit="contain")
    w, h = x1 - x0, y1 - y0
    assert w / h == pytest.approx(1600 / 1200)  # its own proportions, not the page's
    assert w == pytest.approx(page_w)  # the whole image: full width...
    assert h < page_h  # ...letterboxed top and bottom
    assert y0 == pytest.approx(page_h - y1)  # centred
    assert x0 >= -EPS and y0 >= -EPS and x1 <= page_w + EPS and y1 <= page_h + EPS


def test_an_a4_image_lands_exactly():
    page_w, page_h = A4_PT
    x0, y0, x1, y1 = spreads.placement(2480, 3508, page_w, page_h, fit="contain")
    assert (x0, y0) == pytest.approx((0, 0), abs=0.2)
    assert (x1, y1) == pytest.approx((page_w, page_h), abs=0.2)


def test_cover_fills_the_page_and_crops_where_it_was_told():
    page_w, page_h = A4_PT
    centred = spreads.placement(1600, 1200, page_w, page_h, fit="cover")
    left = spreads.placement(1600, 1200, page_w, page_h, fit="cover", crop={"x": 0, "y": 0.5})
    for x0, y0, x1, y1 in (centred, left):
        assert (x1 - x0) / (y1 - y0) == pytest.approx(1600 / 1200)
        assert x0 <= EPS and y0 <= EPS and x1 >= page_w - EPS and y1 >= page_h - EPS
    assert left[0] == pytest.approx(0)  # crop x=0 keeps the image's left edge
    assert centred[0] == pytest.approx(page_w - centred[2])


def test_resolution_is_measured_for_the_fit_actually_used():
    contain = spreads.print_check(1200, 900, "portrait", "contain")
    cover = spreads.print_check(1200, 900, "portrait", "cover")
    assert contain["dpi"] == 145 and not contain["a4_proportioned"]
    assert cover["dpi"] == 77  # the same pixels spread over more paper
    assert spreads.print_check(2480, 3508)["warnings"] == []


# --- uploading onto a page --------------------------------------------------


def page_envelope(orientation="portrait", fit="contain"):
    """What spread.js sends: an own-work image that asks how it'll print."""
    return {"type": "image", "is_own_work": True, "print": {"orientation": orientation, "fit": fit}}


def post_page(client, data, filename="page.png", **kwargs):
    return client.post(
        "/api/captures",
        data={"capture": json.dumps(page_envelope(**kwargs)), "file": (io.BytesIO(data), filename)},
        content_type="multipart/form-data",
    )


def test_a_low_resolution_upload_warns_but_is_not_blocked(client):
    response = post_page(client, png_bytes(size=(600, 848)))
    assert response.status_code == 202
    check = response.get_json()["print"]
    assert check["low_resolution"] is True
    assert check["dpi"] < spreads.MIN_PRINT_DPI
    assert any("dpi" in w for w in check["warnings"])

    drain()
    assert db.get_capture(response.get_json()["capture_id"])["status"] == db.CAPTURE_DONE


def test_a_print_resolution_a4_upload_has_nothing_to_warn_about(client):
    check = post_page(client, png_bytes(size=(2480, 3508))).get_json()["print"]
    assert check["low_resolution"] is False
    assert check["a4_proportioned"] is True
    assert check["warnings"] == []
    drain()


def test_a_non_a4_upload_says_it_will_be_letterboxed(client):
    check = post_page(client, png_bytes(size=(3000, 2000))).get_json()["print"]
    assert check["a4_proportioned"] is False
    assert any("letterboxed" in w for w in check["warnings"])
    drain()


def test_a_capture_that_asks_nothing_gets_no_print_check(client):
    """The extension's uploads are untouched by any of this."""
    response = client.post(
        "/api/captures",
        data={"capture": json.dumps({"type": "image"}), "file": (io.BytesIO(png_bytes()), "p.png")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 202
    assert "print" not in response.get_json()
    drain()


def test_an_exif_rotated_photo_is_measured_the_way_it_displays():
    # Stored 3508 wide, tagged to display rotated a quarter turn: that's a
    # portrait A4 page on screen and on paper.
    buf = io.BytesIO()
    exif = Image.Exif()
    exif[0x0112] = 6
    Image.new("RGB", (3508, 2480), (90, 90, 90)).save(buf, "JPEG", exif=exif.tobytes())
    buf.seek(0)
    (w, h), orientation = spreads.image_size(buf)
    assert (w, h, orientation) == (2480, 3508, 6)


class _Model:
    def encode(self, _query):
        class _Vector(list):
            def tolist(self):
                return list(self)
        return _Vector([0.0] * 512)


def fake_search(monkeypatch, ids):
    """Every reference is a strong match: whatever the search leaves out, it
    left out on purpose, not because CLIP ranked it low."""
    class _Collection:
        def count(self):
            return len(ids)

    monkeypatch.setattr(embeddings, "get_model", lambda: _Model())
    monkeypatch.setattr(embeddings, "get_collection", lambda: _Collection())
    monkeypatch.setattr(
        embeddings, "query_index",
        lambda *_a, **_k: [{"id": i, "relative_score": 3.0, "metadata": {}} for i in ids],
    )


def test_an_uploaded_page_is_own_work_and_stays_out_of_a_default_search(client, monkeypatch):
    research = capture.accept({"type": "image"}, upload=FakeUpload(png_bytes((10, 90, 10))))
    page = post_page(client, png_bytes((200, 20, 20), size=(2480, 3508))).get_json()
    drain()
    research_id = db.get_capture(research["id"])["reference_id"]
    page_id = db.get_capture(page["capture_id"])["reference_id"]

    assert db.get_reference(page_id)["is_own_work"] is True
    assert db.get_reference(research_id)["is_own_work"] is False

    fake_search(monkeypatch, [research_id, page_id])
    found = {r["id"] for r in client.get("/api/references?q=red").get_json()}
    assert found == {research_id}

    # Still there when asked for, and when browsing rather than searching.
    only = {r["id"] for r in client.get("/api/references?q=red&own_work=only").get_json()}
    assert only == {page_id}
    everything = {r["id"] for r in client.get("/api/references?q=red&own_work=any").get_json()}
    assert everything == {research_id, page_id}
    browsing = {r["id"] for r in client.get("/api/references").get_json()}
    assert browsing == {research_id, page_id}


def test_a_page_upload_is_not_filed_into_the_project(client):
    """Portfolio pages are the project's output, not its research -- they
    live on the spread, not in the project's reference grid."""
    project_id = client.post("/api/projects", json={"title": "AW27"}).get_json()["id"]
    page = post_page(client, png_bytes(size=(2480, 3508))).get_json()
    drain()
    assert db.get_capture(page["capture_id"])["reference_id"]
    assert client.get(f"/api/projects/{project_id}").get_json()["references"] == []


# --- the spread node --------------------------------------------------------


def spread_config(pages, **overrides):
    config = {"layout": "sequential", "orientation": "portrait", "cover": True, "gap": 0.12, "pages": pages}
    config.update(overrides)
    return config


def new_project(client, title="Portfolio"):
    return client.post("/api/projects", json={"title": title}).get_json()["id"]


def make_spread(client, pages, project_id=None, **overrides):
    project_id = project_id or new_project(client)
    response = client.post(
        f"/api/projects/{project_id}/canvas/nodes",
        json={"kind": "pages", "x": 10, "y": 20, "w": 900, "h": 500, "config": spread_config(pages, **overrides)},
    )
    assert response.status_code == 200, response.get_json()
    return project_id, response.get_json()


def stage_image(client, project_id, colour, size=(2480, 3508), fmt="PNG", name="page.png", **save_kwargs):
    """Stage a generated image through the real upload route and return its page id."""
    buf = io.BytesIO()
    Image.new("RGB", size, colour).save(buf, fmt, **save_kwargs)
    response = client.post(
        f"/api/projects/{project_id}/portfolio/pages",
        data={"file": (io.BytesIO(buf.getvalue()), name)},
        content_type="multipart/form-data",
    )
    assert response.status_code == 200, response.get_json()
    return response.get_json()["pages"][0]["id"]


def empty(**extra):
    return {"page_id": None, "fit": "contain", **extra}


def test_a_spread_is_one_node_that_owns_its_pages(client):
    pages = [empty() for _ in range(30)]
    project_id, node = make_spread(client, pages)
    nodes = client.get(f"/api/projects/{project_id}/canvas").get_json()["nodes"]
    assert len(nodes) == 1  # thirty pages, one node
    assert nodes[0]["kind"] == "pages"
    assert nodes[0]["reference_id"] is None
    assert nodes[0]["config"]["pages"] == pages


def test_stretch_is_not_a_fit(client):
    project_id, node = make_spread(client, [empty()])
    bad = spread_config([{"page_id": None, "fit": "stretch"}])

    created = client.post(f"/api/projects/{project_id}/canvas/nodes", json={"kind": "pages", "config": bad})
    assert created.status_code == 400
    assert "stretched" in created.get_json()["error"]
    assert client.patch(f"/api/canvas/nodes/{node['id']}", json={"config": bad}).status_code == 400
    assert client.put(
        f"/api/projects/{project_id}/canvas", json={"nodes": [{"kind": "pages", "config": bad}], "edges": []}
    ).status_code == 400
    # A move still goes through untouched.
    assert client.patch(f"/api/canvas/nodes/{node['id']}", json={"x": 50}).status_code == 200


def test_a_spread_needs_a_page_list(client):
    project_id = new_project(client, "P")
    response = client.post(f"/api/projects/{project_id}/canvas/nodes", json={"kind": "pages", "config": {}})
    assert response.status_code == 400


def test_a_page_id_has_to_be_an_id_or_null(client):
    project_id = new_project(client)
    bad = spread_config([{"page_id": 7, "fit": "contain"}])
    assert client.post(
        f"/api/projects/{project_id}/canvas/nodes", json={"kind": "pages", "config": bad}
    ).status_code == 400


# --- export -----------------------------------------------------------------


def centre_colour(page):
    pix = page.get_pixmap(dpi=10)
    return pix.pixel(pix.width // 2, pix.height // 2)


def export(client, node_id, query=""):
    response = client.get(f"/api/canvas/nodes/{node_id}/export.pdf{query}")
    assert response.status_code == 200, response.data[:200]
    assert response.mimetype == "application/pdf"
    return fitz.open(stream=response.get_data(), filetype="pdf")


def test_export_is_a4_pages_in_order_with_blanks_preserved(client):
    project_id = new_project(client)
    red = stage_image(client, project_id, (220, 20, 20), name="red.png")
    blue = stage_image(client, project_id, (20, 20, 220), name="blue.png")
    _, node = make_spread(client, [
        {"page_id": red, "fit": "contain"},
        empty(),
        {"page_id": blue, "fit": "contain"},
        empty(),
    ], project_id=project_id)
    doc = export(client, node["id"])

    assert len(doc) == 4  # the blanks are pages, not gaps
    for page in doc:
        assert (page.rect.width, page.rect.height) == pytest.approx(A4_PT, abs=0.01)
    assert centre_colour(doc[0])[0] > 200 and centre_colour(doc[0])[2] < 60
    assert doc[1].get_images() == []
    assert centre_colour(doc[2])[2] > 200 and centre_colour(doc[2])[0] < 60
    assert doc[3].get_images() == []


def test_export_follows_the_spreads_order_after_a_reorder(client):
    project_id = new_project(client)
    red = stage_image(client, project_id, (220, 20, 20), name="red.png")
    blue = stage_image(client, project_id, (20, 20, 220), name="blue.png")
    _, node = make_spread(client, [
        {"page_id": red, "fit": "contain"},
        {"page_id": blue, "fit": "contain"},
    ], project_id=project_id)
    client.patch(f"/api/canvas/nodes/{node['id']}", json={"config": spread_config([
        {"page_id": blue, "fit": "contain"},
        {"page_id": red, "fit": "contain"},
    ])})
    doc = export(client, node["id"])
    assert centre_colour(doc[0])[2] > 200
    assert centre_colour(doc[1])[0] > 200


def test_a_landscape_spread_exports_landscape_a4(client):
    project_id = new_project(client)
    page = stage_image(client, project_id, (50, 50, 50), size=(3508, 2480))
    _, node = make_spread(client, [{"page_id": page, "fit": "contain"}], project_id=project_id,
                          orientation="landscape")
    doc = export(client, node["id"])
    assert (doc[0].rect.width, doc[0].rect.height) == pytest.approx(A4_PT[::-1], abs=0.01)


def test_export_embeds_images_at_native_resolution_and_jpegs_untouched(client):
    """Below the 300dpi default, so nothing is resampled -- a JPEG's own bytes
    go into the PDF exactly as they were uploaded."""
    project_id = new_project(client)
    buf = io.BytesIO()
    Image.new("RGB", (1754, 2480), (120, 60, 30)).save(buf, "JPEG", quality=90)
    source = buf.getvalue()
    page = client.post(
        f"/api/projects/{project_id}/portfolio/pages",
        data={"file": (io.BytesIO(source), "page.jpg")}, content_type="multipart/form-data",
    ).get_json()["pages"][0]["id"]
    _, node = make_spread(client, [{"page_id": page, "fit": "contain"}], project_id=project_id)
    doc = export(client, node["id"])
    embedded = doc.extract_image(doc[0].get_images()[0][0])
    assert (embedded["width"], embedded["height"]) == (1754, 2480)
    assert embedded["image"] == source


def test_a_non_a4_image_exports_contained_without_distortion(client):
    project_id = new_project(client)
    page = stage_image(client, project_id, (0, 150, 0), size=(1600, 1200))
    _, node = make_spread(client, [{"page_id": page, "fit": "contain"}], project_id=project_id)
    doc = export(client, node["id"])
    rect = doc[0].get_image_rects(doc[0].get_images()[0][0])[0]
    assert rect.width / rect.height == pytest.approx(1600 / 1200, rel=1e-3)
    assert rect.width == pytest.approx(A4_PT[0], abs=0.01)
    assert rect.y0 > 0 and rect.y1 < A4_PT[1]  # letterboxed, inside the page


def test_a_cover_page_exports_cropped_where_the_canvas_cropped_it(client):
    project_id = new_project(client)
    page = stage_image(client, project_id, (0, 150, 0), size=(1600, 1200))
    _, node = make_spread(
        client, [{"page_id": page, "fit": "cover", "crop": {"x": 0, "y": 0.5}}], project_id=project_id
    )
    doc = export(client, node["id"])
    rect = doc[0].get_image_rects(doc[0].get_images()[0][0])[0]
    assert rect.x0 == pytest.approx(0, abs=0.01)  # left edge kept
    assert rect.x1 > A4_PT[0]  # the overflow runs off the right-hand edge
    assert rect.height == pytest.approx(A4_PT[1], abs=0.01)


def test_an_exif_rotated_photo_exports_upright(client):
    exif = Image.Exif()
    exif[0x0112] = 6
    project_id = new_project(client)
    page = stage_image(
        client, project_id, (90, 90, 90), size=(3508, 2480), fmt="JPEG", name="phone.jpg", exif=exif.tobytes()
    )
    _, node = make_spread(client, [{"page_id": page, "fit": "contain"}], project_id=project_id)
    doc = export(client, node["id"])
    rect = doc[0].get_image_rects(doc[0].get_images()[0][0])[0]
    # Portrait, filling the page -- not a landscape strip across its middle.
    assert rect.height == pytest.approx(A4_PT[1], abs=0.5)
    assert rect.width == pytest.approx(A4_PT[0], abs=0.5)


def test_a_webp_page_still_exports(client):
    project_id = new_project(client)
    page = stage_image(client, project_id, (20, 20, 220), size=(1240, 1754), fmt="WEBP", name="page.webp")
    _, node = make_spread(client, [{"page_id": page, "fit": "contain"}], project_id=project_id)
    doc = export(client, node["id"])
    assert centre_colour(doc[0])[2] > 180


def test_the_export_streams_page_by_page(archive):
    path = archive / "page.png"
    Image.new("RGB", (620, 877), (10, 10, 10)).save(path)
    pages = [{"path": path, "fit": "contain"}, {"path": None}, {"path": path, "fit": "cover"}]
    chunks = list(spreads.export_pdf(pages))
    # Something is sent after every page, not all at once at the end.
    assert len(chunks) >= len(pages)
    doc = fitz.open(stream=b"".join(chunks), filetype="pdf")
    assert len(doc) == 3


def test_only_a_spread_can_be_exported(client):
    project_id = new_project(client, "P")
    note = client.post(f"/api/projects/{project_id}/canvas/nodes", json={"kind": "text"}).get_json()
    assert client.get(f"/api/canvas/nodes/{note['id']}/export.pdf").status_code == 400
    assert client.get("/api/canvas/nodes/nope/export.pdf").status_code == 404


def test_the_download_is_named_after_the_project(client):
    _, node = make_spread(client, [empty()])
    disposition = client.get(f"/api/canvas/nodes/{node['id']}/export.pdf").headers["Content-Disposition"]
    assert "attachment" in disposition and "Portfolio - pages.pdf" in disposition
