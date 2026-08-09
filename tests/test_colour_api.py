"""Colour search through the HTTP API, and its integration with projects.

These cover the parts that only exist once colour analysis meets the archive:
storage and caching, excluding a project's own references, and adding a
result through the project relationship the app already has.
"""
import numpy as np
import pytest
from PIL import Image

from conftest import png_bytes  # noqa: F401

import colour
import db
import ingest


def banded_bytes(bands, size=160):
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    y = 0
    for rgb, fraction in bands:
        height = int(round(size * fraction))
        arr[y:y + height] = rgb
        y += height
    if y < size:
        arr[y:] = bands[-1][0]
    import io
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    return buf.getvalue()


BLACK = (18, 18, 20)
CREAM = (240, 232, 214)
RED = (190, 40, 35)
BLUE = (40, 60, 190)


def add_image(archive, name, bands):
    """A real reference in the archive, through the real ingest path."""
    path = archive / f"{name}.png"
    path.write_bytes(banded_bytes(bands))
    return ingest.add_reference(path, title=name)["id"]


# --- Storage and caching ----------------------------------------------------


def test_profile_is_computed_on_demand_and_stored(archive):
    ref_id = add_image(archive, "dark", [(BLACK, 0.7), (CREAM, 0.3)])
    assert db.get_colour_analysis(ref_id) is None

    profile = colour.profile_for_reference(ref_id)
    assert profile is not None

    stored = db.get_colour_analysis(ref_id, version=colour.ANALYSIS_VERSION)
    assert stored is not None
    assert stored["version"] == colour.ANALYSIS_VERSION
    assert colour.profile_from_json(stored["profile"]) == profile


def test_second_call_reuses_the_stored_profile(archive, monkeypatch):
    """Requirement: an unchanged image is never re-analysed."""
    ref_id = add_image(archive, "dark", [(BLACK, 1.0)])
    colour.profile_for_reference(ref_id)

    def fail(*a, **k):
        raise AssertionError("should have used the cached profile")

    monkeypatch.setattr(colour, "analyse_image", fail)
    assert colour.profile_for_reference(ref_id) is not None


def test_a_stale_version_is_not_a_cache_hit(archive):
    ref_id = add_image(archive, "dark", [(BLACK, 1.0)])
    colour.profile_for_reference(ref_id)

    # Simulate a row written by an older algorithm.
    stored = db.get_colour_analysis(ref_id)
    db.save_colour_analysis(ref_id, colour.ANALYSIS_VERSION - 1, stored["content_hash"], stored["profile"])
    assert db.get_colour_analysis(ref_id, version=colour.ANALYSIS_VERSION) is None

    # It gets recomputed rather than reused.
    assert colour.profile_for_reference(ref_id) is not None
    assert db.get_colour_analysis(ref_id, version=colour.ANALYSIS_VERSION) is not None


def test_text_reference_has_no_colour_profile(archive):
    path = archive / "note.txt"
    path.write_text("a written reference has no palette", encoding="utf-8")
    ref_id = ingest.add_reference(path, title="note")["id"]
    assert colour.profile_for_reference(ref_id) is None


def test_backfill_analyses_pending_images_and_is_idempotent(archive):
    # Proportions varied per image so the files differ: identical bytes are
    # correctly rejected by the archive's own duplicate detection, which
    # would make this a test of that instead.
    for i in range(3):
        add_image(archive, f"img{i}", [(BLACK, 0.6 - i * 0.1), (CREAM, 0.4 + i * 0.1)])

    assert colour.coverage()["pending"] == 3
    analysed, failed = colour.backfill()
    assert (analysed, failed) == (3, 0)
    assert colour.coverage() == {"version": colour.ANALYSIS_VERSION, "images": 3, "analysed": 3, "pending": 0}

    # Running again does nothing rather than redoing the work.
    assert colour.backfill() == (0, 0)


def test_deleting_a_reference_removes_its_analysis(archive):
    ref_id = add_image(archive, "gone", [(BLACK, 1.0)])
    colour.profile_for_reference(ref_id)
    assert db.get_colour_analysis(ref_id) is not None

    db.delete_reference(ref_id)
    assert db.get_colour_analysis(ref_id) is None


# --- Search -----------------------------------------------------------------


def test_search_ranks_colour_similar_first(archive):
    query = add_image(archive, "query", [(BLACK, 0.7), (CREAM, 0.3)])
    near = add_image(archive, "near", [(BLACK, 0.66), (CREAM, 0.34)])
    far = add_image(archive, "far", [(RED, 0.7), (BLUE, 0.3)])
    colour.backfill()

    results = colour.search([query])["results"]
    ids = [r["reference_id"] for r in results]
    assert ids.index(near) < ids.index(far)


def test_search_excludes_the_query_itself(archive):
    query = add_image(archive, "query", [(BLACK, 1.0)])
    add_image(archive, "other", [(CREAM, 1.0)])
    colour.backfill()

    ids = [r["reference_id"] for r in colour.search([query])["results"]]
    assert query not in ids


def test_search_with_no_analysable_selection_returns_empty(archive):
    path = archive / "note.txt"
    path.write_text("text only", encoding="utf-8")
    ref_id = ingest.add_reference(path, title="note")["id"]

    outcome = colour.search([ref_id])
    assert outcome["profile"] is None
    assert outcome["results"] == []


def test_multi_selection_builds_one_combined_profile(archive):
    a = add_image(archive, "a", [(RED, 1.0)])
    b = add_image(archive, "b", [(BLUE, 1.0)])
    colour.backfill()

    outcome = colour.search([a, b])
    assert outcome["profile"]["combined_from"] == 2
    assert set(outcome["used_ids"]) == {a, b}


# --- Colour map -------------------------------------------------------------


def test_map_places_every_analysed_reference(archive):
    add_image(archive, "a", [(BLACK, 0.7), (CREAM, 0.3)])
    add_image(archive, "b", [(RED, 0.6), (BLUE, 0.4)])
    colour.backfill()

    layout = colour.colour_map()
    assert len(layout["nodes"]) == 2
    assert layout["radius"] > 0 and layout["height"] > 0


def test_map_stacks_lighter_references_higher(archive):
    dark = add_image(archive, "dark", [(BLACK, 1.0)])
    light = add_image(archive, "light", [((250, 250, 250), 1.0)])
    colour.backfill()

    by_id = {n["id"]: n for n in colour.colour_map()["nodes"]}
    assert by_id[light]["y"] > by_id[dark]["y"]


def test_map_pushes_saturated_references_further_out(archive):
    grey = add_image(archive, "grey", [((128, 128, 128), 1.0)])
    vivid = add_image(archive, "vivid", [(RED, 1.0)])
    colour.backfill()

    by_id = {n["id"]: n for n in colour.colour_map()["nodes"]}
    radius = lambda n: np.hypot(n["x"], n["z"])  # noqa: E731
    assert radius(by_id[vivid]) > radius(by_id[grey])


def test_map_excludes_text_references(archive):
    path = archive / "note.txt"
    path.write_text("a written reference has no palette", encoding="utf-8")
    ref_id = ingest.add_reference(path, title="note")["id"]
    add_image(archive, "img", [(RED, 1.0)])
    colour.backfill()

    assert ref_id not in {n["id"] for n in colour.colour_map()["nodes"]}


def test_map_is_deterministic(archive):
    add_image(archive, "a", [(RED, 0.6), (BLUE, 0.4)])
    add_image(archive, "b", [(BLACK, 0.5), (CREAM, 0.5)])
    colour.backfill()
    assert colour.colour_map() == colour.colour_map()


def test_map_positions_respond_to_removing_black_and_white(archive):
    """The toggle has to reach placement, not just the palette shown: the
    filtered profile is what the search compares, so it must also be what the
    map positions by."""
    add_image(archive, "on_white", [(RED, 0.3), ((250, 250, 250), 0.7)])
    add_image(archive, "plain", [(BLUE, 0.5), (RED, 0.5)])
    colour.backfill()

    plain = colour.colour_map()["nodes"]
    filtered = colour.colour_map(exclude_black_white=True)["nodes"]
    assert [n["id"] for n in plain] == [n["id"] for n in filtered]
    assert plain != filtered


def test_map_endpoint_carries_archive_detail_and_hue_ring(client, archive):
    add_image(archive, "a", [(RED, 0.6), (BLUE, 0.4)])
    colour.backfill()

    body = client.get("/api/colour/map").get_json()
    assert body["nodes"], "expected the analysed reference to be placed"
    node = body["nodes"][0]
    # The same summary shape the rest of the app renders references from, so
    # the map can draw a node without a second lookup.
    for key in ("id", "title", "type", "ext", "x", "y", "z", "palette", "hue", "chroma"):
        assert key in node
    assert len(body["hue_ticks"]) == colour.HUE_TICKS
    assert all(len(t["rgb"]) == 3 for t in body["hue_ticks"])


def test_map_endpoint_accepts_the_black_and_white_flag(client, archive):
    add_image(archive, "a", [(RED, 0.3), ((250, 250, 250), 0.7)])
    colour.backfill()

    plain = client.get("/api/colour/map").get_json()["nodes"]
    filtered = client.get("/api/colour/map?exclude_black_white=1").get_json()["nodes"]
    assert plain != filtered


# --- API --------------------------------------------------------------------


def test_coverage_endpoint(client, archive):
    add_image(archive, "one", [(BLACK, 1.0)])
    body = client.get("/api/colour/coverage").get_json()
    assert body["images"] == 1 and body["pending"] == 1

    client.post("/api/colour/backfill", json={})
    assert client.get("/api/colour/coverage").get_json()["pending"] == 0


def test_search_endpoint_returns_results_with_palettes(client, archive):
    query = add_image(archive, "query", [(BLACK, 0.7), (CREAM, 0.3)])
    add_image(archive, "near", [(BLACK, 0.66), (CREAM, 0.34)])
    colour.backfill()

    body = client.post("/api/colour/search", json={"reference_ids": [query]}).get_json()
    assert body["results"], "expected at least one match"
    first = body["results"][0]
    assert first["palette"], "each result carries its palette so the match is explainable"
    assert 0.0 <= first["score"] <= 1.0
    assert body["profile"]["palette"]


def test_search_endpoint_rejects_an_empty_selection(client):
    assert client.post("/api/colour/search", json={"reference_ids": []}).status_code == 400


def test_search_excludes_references_already_in_the_project(client, archive):
    """The point of the search is discovering things the project doesn't have."""
    query = add_image(archive, "query", [(BLACK, 0.7), (CREAM, 0.3)])
    inside = add_image(archive, "inside", [(BLACK, 0.68), (CREAM, 0.32)])
    outside = add_image(archive, "outside", [(BLACK, 0.65), (CREAM, 0.35)])
    colour.backfill()

    db.create_project("p1", "Colour work")
    db.add_reference_to_project("p1", query)
    db.add_reference_to_project("p1", inside)

    body = client.post(
        "/api/colour/search", json={"reference_ids": [query], "project_id": "p1"}
    ).get_json()
    ids = [r["id"] for r in body["results"]]

    assert inside not in ids, "a reference already in the project shouldn't be offered again"
    assert outside in ids


def test_weights_change_the_ranking_through_the_api(client, archive):
    """The sliders reach the ranking, not just the request body."""
    query = add_image(archive, "query", [(BLACK, 0.5), (RED, 0.5)])
    # Keyed by id, not title: ingest deliberately replaces a supplied title
    # with the tagger's suggestion when the two look unrelated, so every
    # fixture here comes back with the same stubbed title.
    hue_match = add_image(archive, "hue_match", [((120, 25, 22), 0.5), ((90, 20, 18), 0.5)])
    tone_match = add_image(archive, "tone_match", [(BLACK, 0.5), (BLUE, 0.5)])
    colour.backfill()

    def ranking(weights):
        body = client.post(
            "/api/colour/search", json={"reference_ids": [query], "weights": weights}
        ).get_json()
        return {r["id"]: r["score"] for r in body["results"]}

    hue_led = ranking({"hue": 2.0, "lightness": 0.0, "saturation": 0.0, "proportions": 0.0})
    tone_led = ranking({"hue": 0.0, "lightness": 2.0, "saturation": 0.0, "proportions": 0.0})

    assert hue_led != tone_led, "different weights must produce different scores"
    assert hue_led[hue_match] > hue_led[tone_match]


def test_adding_a_result_uses_the_existing_project_relationship(client, archive):
    """No second membership system, and no duplicate rows."""
    query = add_image(archive, "query", [(BLACK, 1.0)])
    found = add_image(archive, "found", [(BLACK, 0.9), (CREAM, 0.1)])
    colour.backfill()
    db.create_project("p1", "Colour work")

    res = client.post("/api/projects/p1/references", json={"reference_id": found})
    assert res.status_code == 200
    assert [r["id"] for r in db.list_project_references("p1")] == [found]

    # Adding the same one again must not duplicate the relationship.
    client.post("/api/projects/p1/references", json={"reference_id": found})
    assert len(db.list_project_references("p1")) == 1

    # And the underlying reference is untouched -- one row, not a copy.
    assert len([r for r in db.list_references() if r["id"] == found]) == 1


def test_search_endpoint_can_exclude_black_and_white(client, archive):
    """The palette on the query profile and on every result must both be
    filtered, since the sidebar shows both and they must match what was
    actually ranked."""
    WHITE = (250, 250, 250)
    query = add_image(archive, "query", [(RED, 0.3), (WHITE, 0.7)])
    add_image(archive, "match", [(RED, 0.28), (BLACK, 0.72)])
    colour.backfill()

    body = client.post(
        "/api/colour/search", json={"reference_ids": [query], "exclude_black_white": True}
    ).get_json()

    def has_black_or_white(palette):
        return any(colour._is_near_black_or_white(entry["lab"]) for entry in palette)

    assert not has_black_or_white(body["profile"]["palette"])
    assert body["results"], "expected at least one match"
    for result in body["results"]:
        assert not has_black_or_white(result["palette"])


def test_added_reference_then_drops_out_of_that_project_search(client, archive):
    """Adding a result removes it from subsequent results, which is what
    makes repeated searching in one project converge rather than repeat."""
    query = add_image(archive, "query", [(BLACK, 0.7), (CREAM, 0.3)])
    found = add_image(archive, "found", [(BLACK, 0.68), (CREAM, 0.32)])
    colour.backfill()
    db.create_project("p1", "Colour work")
    db.add_reference_to_project("p1", query)

    def result_ids():
        body = client.post(
            "/api/colour/search", json={"reference_ids": [query], "project_id": "p1"}
        ).get_json()
        return [r["id"] for r in body["results"]]

    assert found in result_ids()
    client.post("/api/projects/p1/references", json={"reference_id": found})
    assert found not in result_ids()
