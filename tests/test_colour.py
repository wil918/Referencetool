"""Colour analysis, combined profiles, weighted similarity and search.

Fixtures are flat colour bands rather than photographs so that the expected
answer is knowable: an image that is exactly 70% black and 30% cream has a
palette this code should recover, and comparisons between such images have an
obvious right ordering. Photographs would make failures ambiguous.
"""
import numpy as np
import pytest
from PIL import Image

from conftest import drain, envelope  # noqa: F401  (fixtures live there)

import colour
import db

# Reference colours, chosen to be far apart in Lab so tests aren't measuring
# rounding noise.
BLACK = (18, 18, 20)
CREAM = (240, 232, 214)
RED = (190, 40, 35)
BLUE = (40, 60, 190)
GREY = (128, 128, 128)
WHITE = (250, 250, 250)


def banded(tmp_path, name, bands, size=160):
    """An image made of horizontal bands: [(rgb, fraction), ...]."""
    arr = np.zeros((size, size, 3), dtype=np.uint8)
    y = 0
    for rgb, fraction in bands:
        height = int(round(size * fraction))
        arr[y:y + height] = rgb
        y += height
    if y < size:
        arr[y:] = bands[-1][0]
    path = tmp_path / f"{name}.png"
    Image.fromarray(arr).save(path)
    return path


def profile(tmp_path, name, bands):
    return colour.analyse_image(banded(tmp_path, name, bands))


# --- Analysis ---------------------------------------------------------------


def test_palette_recovers_proportions(tmp_path):
    p = profile(tmp_path, "a", [(BLACK, 0.70), (CREAM, 0.30)])
    weights = sorted((e["weight"] for e in p["palette"]), reverse=True)
    assert len(p["palette"]) == 2
    assert weights[0] == pytest.approx(0.70, abs=0.02)
    assert weights[1] == pytest.approx(0.30, abs=0.02)


def test_palette_colours_are_recognisable(tmp_path):
    p = profile(tmp_path, "a", [(BLACK, 0.70), (CREAM, 0.30)])
    rgbs = [tuple(e["rgb"]) for e in p["palette"]]
    # Each recovered swatch should be close to the colour that was painted.
    assert any(sum(abs(a - b) for a, b in zip(rgb, BLACK)) < 30 for rgb in rgbs)
    assert any(sum(abs(a - b) for a, b in zip(rgb, CREAM)) < 30 for rgb in rgbs)


def test_lightness_tracks_the_image(tmp_path):
    dark = profile(tmp_path, "dark", [(BLACK, 1.0)])
    light = profile(tmp_path, "light", [(WHITE, 1.0)])
    assert dark["lightness"] < 0.2
    assert light["lightness"] > 0.9


def test_saturation_distinguishes_grey_from_vivid(tmp_path):
    grey = profile(tmp_path, "grey", [(GREY, 1.0)])
    vivid = profile(tmp_path, "vivid", [(RED, 1.0)])
    assert grey["saturation"] < 0.1
    assert vivid["saturation"] > grey["saturation"]


def test_greyscale_image_has_no_hue_mass(tmp_path):
    """A grey image's hue angle is numerical noise and must not be recorded."""
    grey = profile(tmp_path, "grey", [(BLACK, 0.5), (WHITE, 0.5)])
    assert sum(grey["hue_histogram"]) == pytest.approx(0.0, abs=1e-6)


def test_analysis_is_deterministic(tmp_path):
    """Requirement: same image + same version -> same profile, always."""
    path = banded(tmp_path, "a", [(BLACK, 0.4), (CREAM, 0.35), (RED, 0.25)])
    assert colour.analyse_image(path) == colour.analyse_image(path)


def test_profile_records_its_version(tmp_path):
    p = profile(tmp_path, "a", [(BLACK, 1.0)])
    assert p["version"] == colour.ANALYSIS_VERSION


# --- Similarity -------------------------------------------------------------


def test_similar_proportions_beat_a_merely_shared_colour(tmp_path):
    """The headline requirement.

    (black 70 / cream 30) vs (black 65 / cream 35) should score far above
    (red 70 / cream 30), which only happens to share the cream. A metric
    keyed on "contains a colour in common" would get this backwards.
    """
    a = profile(tmp_path, "a", [(BLACK, 0.70), (CREAM, 0.30)])
    b = profile(tmp_path, "b", [(BLACK, 0.65), (CREAM, 0.35)])
    c = profile(tmp_path, "c", [(RED, 0.70), (CREAM, 0.30)])

    assert colour.similarity(a, b) > colour.similarity(a, c)
    assert colour.similarity(a, b) > 0.9


def test_inverted_proportions_score_below_matching_ones(tmp_path):
    """Same two colours, opposite amounts -- similar, but not as similar."""
    a = profile(tmp_path, "a", [(BLACK, 0.70), (CREAM, 0.30)])
    same = profile(tmp_path, "same", [(BLACK, 0.68), (CREAM, 0.32)])
    flipped = profile(tmp_path, "flip", [(CREAM, 0.70), (BLACK, 0.30)])

    assert colour.similarity(a, same) > colour.similarity(a, flipped)


def test_identical_images_score_one(tmp_path):
    a = profile(tmp_path, "a", [(BLACK, 0.6), (RED, 0.4)])
    assert colour.similarity(a, a) == pytest.approx(1.0, abs=1e-6)


def test_similarity_is_symmetric(tmp_path):
    a = profile(tmp_path, "a", [(BLACK, 0.6), (CREAM, 0.4)])
    b = profile(tmp_path, "b", [(RED, 0.5), (BLUE, 0.5)])
    assert colour.similarity(a, b) == pytest.approx(colour.similarity(b, a))


# --- The controls -----------------------------------------------------------
#
# Each slider must actually change what "similar" means. The test for each is
# the same shape: take a pair differing on exactly one dimension, and check
# that raising that dimension's weight lowers the score (the difference now
# counts for more) while raising an unrelated one doesn't.


def only(dimension):
    """Weights isolating a single dimension."""
    return {k: (1.0 if k == dimension else 0.0) for k in colour.DEFAULT_WEIGHTS}


def test_hue_weight_controls_hue_influence(tmp_path):
    """Two images identical in tone, opposite in hue."""
    red = profile(tmp_path, "red", [(RED, 1.0)])
    blue = profile(tmp_path, "blue", [(BLUE, 1.0)])

    hue_led = colour.similarity(red, blue, only("hue"))
    lightness_led = colour.similarity(red, blue, only("lightness"))
    assert hue_led < lightness_led, "hue weighting should punish a hue difference hardest"


def test_lightness_weight_controls_lightness_influence(tmp_path):
    """Same hue, very different lightness."""
    dark = profile(tmp_path, "dark2", [((20, 20, 20), 1.0)])
    light = profile(tmp_path, "light2", [((235, 235, 235), 1.0)])

    lightness_led = colour.similarity(dark, light, only("lightness"))
    hue_led = colour.similarity(dark, light, only("hue"))
    assert lightness_led < hue_led, "lightness weighting should punish a tone difference hardest"


def test_saturation_weight_controls_saturation_influence(tmp_path):
    """Same hue family, one muted and one vivid."""
    vivid = profile(tmp_path, "vivid", [((200, 30, 30), 1.0)])
    muted = profile(tmp_path, "muted", [((150, 110, 108), 1.0)])

    saturation_led = colour.similarity(vivid, muted, only("saturation"))
    hue_led = colour.similarity(vivid, muted, only("hue"))
    assert saturation_led < hue_led


def test_proportions_weight_controls_proportion_influence(tmp_path):
    """Same two colours, different amounts -- only the proportions differ."""
    a = profile(tmp_path, "a", [(BLACK, 0.8), (CREAM, 0.2)])
    b = profile(tmp_path, "b", [(BLACK, 0.2), (CREAM, 0.8)])

    proportion_led = colour.similarity(a, b, only("proportions"))
    hue_led = colour.similarity(a, b, only("hue"))
    assert proportion_led < hue_led, "proportion weighting should expose the difference"


def test_raising_a_weight_changes_the_ranking(tmp_path):
    """End to end: the same pair of candidates can swap order on a slider.

    This is what makes the controls meaningful rather than decorative.
    """
    query = profile(tmp_path, "q", [(BLACK, 0.5), (RED, 0.5)])
    same_hue_diff_tone = profile(tmp_path, "h", [((120, 25, 22), 0.5), ((90, 20, 18), 0.5)])
    same_tone_diff_hue = profile(tmp_path, "t", [(BLACK, 0.5), (BLUE, 0.5)])

    hue_ranking = (
        colour.similarity(query, same_hue_diff_tone, only("hue")),
        colour.similarity(query, same_tone_diff_hue, only("hue")),
    )
    assert hue_ranking[0] > hue_ranking[1], "under hue weighting, the hue-match should win"


def test_zero_weights_fall_back_rather_than_dividing_by_zero(tmp_path):
    a = profile(tmp_path, "a", [(BLACK, 1.0)])
    b = profile(tmp_path, "b", [(CREAM, 1.0)])
    score = colour.similarity(a, b, {k: 0 for k in colour.DEFAULT_WEIGHTS})
    assert 0.0 <= score <= 1.0


# --- Remove black and white --------------------------------------------------


def test_near_black_and_near_white_are_flagged(tmp_path):
    for rgb in (BLACK, CREAM, WHITE):
        assert colour._is_near_black_or_white(colour.rgb_to_lab(rgb))


def test_saturated_colours_are_never_flagged_regardless_of_lightness(tmp_path):
    dark_red = (60, 10, 8)     # dark but saturated -- not "black"
    pale_yellow = (250, 245, 180)  # pale but saturated -- not "white"
    for rgb in (RED, BLUE, GREY, dark_red, pale_yellow):
        assert not colour._is_near_black_or_white(colour.rgb_to_lab(rgb))


def test_remove_black_and_white_drops_neutral_entries_and_renormalises(tmp_path):
    p = profile(tmp_path, "a", [(BLACK, 0.6), (RED, 0.4)])
    filtered = colour.remove_black_and_white(p)
    assert filtered["black_white_removed"] is True
    rgbs = [tuple(e["rgb"]) for e in filtered["palette"]]
    assert len(filtered["palette"]) == 1
    assert sum(e["weight"] for e in filtered["palette"]) == pytest.approx(1.0)


def test_remove_black_and_white_falls_back_when_nothing_would_survive(tmp_path):
    p = profile(tmp_path, "a", [(BLACK, 0.7), (CREAM, 0.3)])
    filtered = colour.remove_black_and_white(p)
    assert filtered == p
    assert "black_white_removed" not in filtered


def test_remove_black_and_white_is_a_noop_when_nothing_is_neutral(tmp_path):
    p = profile(tmp_path, "a", [(RED, 0.7), (BLUE, 0.3)])
    filtered = colour.remove_black_and_white(p)
    assert filtered == p


def test_remove_black_and_white_is_deterministic(tmp_path):
    p = profile(tmp_path, "a", [(BLACK, 0.5), (RED, 0.3), (BLUE, 0.2)])
    assert colour.remove_black_and_white(p) == colour.remove_black_and_white(p)


def test_remove_black_and_white_recomputes_derived_statistics(tmp_path):
    """Not just the palette -- the histograms and scalars used by weighted
    similarity must reflect only the surviving colours too."""
    p = profile(tmp_path, "a", [(BLACK, 0.6), (RED, 0.4)])
    filtered = colour.remove_black_and_white(p)
    red_only = profile(tmp_path, "b", [(RED, 1.0)])
    assert filtered["mean_lab"] == pytest.approx(red_only["mean_lab"], abs=0.5)
    assert filtered["lightness"] == pytest.approx(red_only["lightness"], abs=0.02)


def test_shared_background_stops_dominating_similarity_once_removed(tmp_path):
    """The practical payoff: two garments with the same colour but opposite
    backgrounds should look far more alike once the backgrounds are removed."""
    on_white = profile(tmp_path, "on_white", [(RED, 0.3), (WHITE, 0.7)])
    on_black = profile(tmp_path, "on_black", [(RED, 0.3), (BLACK, 0.7)])

    raw_score = colour.similarity(on_white, on_black)
    filtered_score = colour.similarity(
        colour.remove_black_and_white(on_white), colour.remove_black_and_white(on_black)
    )
    assert filtered_score > raw_score


# --- Map placement (LCh) ------------------------------------------------------


def test_map_lightness_tracks_the_image(tmp_path):
    dark = colour.map_colour(profile(tmp_path, "dark", [(BLACK, 1.0)]))
    light = colour.map_colour(profile(tmp_path, "light", [(WHITE, 1.0)]))
    assert light[0] > dark[0]


def test_map_chroma_separates_grey_from_vivid(tmp_path):
    grey = colour.map_colour(profile(tmp_path, "grey", [(GREY, 1.0)]))
    vivid = colour.map_colour(profile(tmp_path, "vivid", [(RED, 1.0)]))
    assert vivid[1] > grey[1]


def test_map_hue_distinguishes_red_from_blue(tmp_path):
    red = colour.map_colour(profile(tmp_path, "red", [(RED, 1.0)]))[2]
    blue = colour.map_colour(profile(tmp_path, "blue", [(BLUE, 1.0)]))[2]
    # Compared as a circular distance -- 350 and 10 degrees are 20 apart.
    apart = abs(red - blue) % 360
    assert min(apart, 360 - apart) > 90


def test_map_does_not_send_a_two_colour_image_to_the_neutral_axis(tmp_path):
    """Why placement isn't the mean of the Lab pixels: averaging red and green
    lands on grey, putting a strongly coloured image at the one position that
    means "this has no colour"."""
    p = profile(tmp_path, "split", [(RED, 0.5), ((40, 150, 60), 0.5)])
    mean_chroma = np.hypot(p["mean_lab"][1], p["mean_lab"][2])
    assert colour.map_colour(p)[1] > mean_chroma


def test_map_colour_of_an_empty_palette_is_none():
    assert colour.map_colour({"palette": []}) is None


# --- Scoping the map to a subset ---------------------------------------------
#
# These need a database rather than just a profile, because scoping happens in
# the query. The map reads colour_analysis and nothing else, so a stored row is
# the whole fixture -- no ingest, no files in the archive.

MUTED = (170, 130, 130)  # some chroma, but far less than RED


def stored(tmp_path, ref_id, bands):
    p = profile(tmp_path, ref_id, bands)
    db.save_colour_analysis(ref_id, colour.ANALYSIS_VERSION, f"hash-{ref_id}", colour.profile_to_json(p))
    return ref_id


def test_scoped_map_contains_only_the_requested_ids(archive):
    stored(archive, "a", [(RED, 1.0)])
    stored(archive, "b", [(BLUE, 1.0)])
    stored(archive, "c", [(GREY, 1.0)])

    nodes = colour.colour_map(include_ids=["a", "b"])["nodes"]
    assert [n["id"] for n in nodes] == ["a", "b"]


def test_an_empty_subset_maps_to_nothing_rather_than_raising(archive):
    """A project with no analysed references still has to render: the cylinder
    is described, it just has nothing in it. An empty `include_ids` is a real
    empty set, not "unfiltered"."""
    stored(archive, "a", [(RED, 1.0)])

    layout = colour.colour_map(include_ids=[])
    assert layout["nodes"] == []
    assert layout["radius"] > 0 and layout["hue_ticks"]


def test_unscoped_map_still_covers_the_whole_archive(archive):
    for name, bands in (("a", [(RED, 1.0)]), ("b", [(BLUE, 1.0)]), ("c", [(GREY, 1.0)])):
        stored(archive, name, bands)

    layout = colour.colour_map()
    assert [n["id"] for n in layout["nodes"]] == ["a", "b", "c"]
    assert layout == colour.colour_map(include_ids=None)


def test_scoped_radius_ranks_within_the_subset(archive):
    """Radius is a rank across the set being laid out, so the least saturated
    member of a subset sits on the axis even though the archive holds something
    greyer still. Scoping re-spends the whole radius on the subset -- see
    colour_map()'s docstring; this is the behaviour, not a rounding artefact.
    """
    stored(archive, "grey", [(GREY, 1.0)])
    stored(archive, "muted", [(MUTED, 1.0)])
    stored(archive, "vivid", [(RED, 1.0)])

    radius = lambda n: float(np.hypot(n["x"], n["z"]))  # noqa: E731
    whole = {n["id"]: n for n in colour.colour_map()["nodes"]}
    subset = {n["id"]: n for n in colour.colour_map(include_ids=["muted", "vivid"])["nodes"]}

    assert radius(whole["muted"]) > 0  # middle of three, mid-disc
    assert radius(subset["muted"]) == 0  # least saturated of two, on the axis
    assert radius(subset["vivid"]) == pytest.approx(colour.MAP_RADIUS, abs=1e-3)


def test_include_and_exclude_ids_intersect(archive):
    for name in ("a", "b", "c"):
        stored(archive, name, [(RED, 1.0)])

    rows = db.list_colour_analyses(
        version=colour.ANALYSIS_VERSION, include_ids=["a", "b"], exclude_ids=["b", "c"]
    )
    assert {ref_id for ref_id, _ in rows} == {"a"}


def test_include_ids_respects_the_version_pin(archive):
    stored(archive, "current", [(RED, 1.0)])
    stored(archive, "stale", [(BLUE, 1.0)])
    row = db.get_colour_analysis("stale")
    db.save_colour_analysis("stale", colour.ANALYSIS_VERSION - 1, row["content_hash"], row["profile"])

    ids = {n["id"] for n in colour.colour_map(include_ids=["current", "stale"])["nodes"]}
    assert ids == {"current"}


# --- Combined profiles ------------------------------------------------------


def test_combined_profile_is_an_aggregate_not_a_list(tmp_path):
    """Selecting A+B+C must build one profile describing the group."""
    a = profile(tmp_path, "a", [(BLACK, 0.7), (CREAM, 0.3)])
    b = profile(tmp_path, "b", [(BLACK, 0.5), (GREY, 0.3), (CREAM, 0.2)])
    c = profile(tmp_path, "c", [(BLACK, 0.4), (CREAM, 0.4), (RED, 0.2)])

    combined = colour.combine_profiles([a, b, c])
    assert combined["combined_from"] == 3
    assert combined["version"] == colour.ANALYSIS_VERSION
    assert sum(e["weight"] for e in combined["palette"]) == pytest.approx(1.0, abs=1e-4)


def test_combined_profile_reflects_shared_dominance(tmp_path):
    """Black is dominant in all three, so it should dominate the aggregate --
    and outweigh red, which appears in only one."""
    a = profile(tmp_path, "a", [(BLACK, 0.7), (CREAM, 0.3)])
    b = profile(tmp_path, "b", [(BLACK, 0.5), (GREY, 0.3), (CREAM, 0.2)])
    c = profile(tmp_path, "c", [(BLACK, 0.4), (CREAM, 0.4), (RED, 0.2)])

    combined = colour.combine_profiles([a, b, c])
    lightest_first = sorted(combined["palette"], key=lambda e: e["lab"][0])
    darkest = lightest_first[0]
    assert darkest["weight"] > 0.3, "the colour common to all three should carry real mass"


def test_combining_one_profile_returns_it(tmp_path):
    a = profile(tmp_path, "a", [(BLACK, 1.0)])
    assert colour.combine_profiles([a])["palette"] == a["palette"]


def test_combined_search_differs_from_any_single_search(tmp_path):
    """The distinction the spec calls out: a group profile is not the same
    as searching for A, or B, and merging."""
    a = profile(tmp_path, "a", [(RED, 1.0)])
    b = profile(tmp_path, "b", [(BLUE, 1.0)])
    combined = colour.combine_profiles([a, b])

    purple_ish = profile(tmp_path, "p", [(RED, 0.5), (BLUE, 0.5)])
    # The mixture should look more like the group than either member does.
    assert colour.similarity(combined, purple_ish) > colour.similarity(a, purple_ish)
    assert colour.similarity(combined, purple_ish) > colour.similarity(b, purple_ish)


def test_combining_nothing_is_an_error():
    with pytest.raises(ValueError):
        colour.combine_profiles([])


# --- Ranking ----------------------------------------------------------------


def test_rank_orders_by_similarity(tmp_path):
    query = profile(tmp_path, "q", [(BLACK, 0.7), (CREAM, 0.3)])
    candidates = [
        ("far", profile(tmp_path, "far", [(RED, 0.7), (BLUE, 0.3)])),
        ("near", profile(tmp_path, "near", [(BLACK, 0.68), (CREAM, 0.32)])),
        ("mid", profile(tmp_path, "mid", [(GREY, 0.6), (CREAM, 0.4)])),
    ]
    ranked = colour.rank(query, candidates)
    assert [r["reference_id"] for r in ranked][0] == "near"
    assert ranked[0]["score"] > ranked[-1]["score"]


def test_rank_is_stable_for_equal_scores(tmp_path):
    """Identical candidates must not reorder between calls."""
    query = profile(tmp_path, "q", [(BLACK, 1.0)])
    p = profile(tmp_path, "p", [(CREAM, 1.0)])
    candidates = [("b", p), ("a", p), ("c", p)]
    assert [r["reference_id"] for r in colour.rank(query, candidates)] == ["a", "b", "c"]


def test_rank_respects_limit(tmp_path):
    query = profile(tmp_path, "q", [(BLACK, 1.0)])
    candidates = [(str(i), profile(tmp_path, f"c{i}", [(CREAM, 1.0)])) for i in range(5)]
    assert len(colour.rank(query, candidates, limit=2)) == 2
