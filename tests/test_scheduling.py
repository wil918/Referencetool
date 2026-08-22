"""scheduling.travel_minutes -- the rules in order: same-location/missing is
free, a direct or reverse location_travel row wins over the via-home
fallback, and a missing location never raises.
"""
import db
import scheduling


def make_location(name, travel_minutes_from_home=None):
    location_id = name.lower().replace(" ", "-")
    db.create_location(location_id, name, travel_minutes_from_home=travel_minutes_from_home)
    return location_id


def test_same_location_is_zero(archive):
    studio = make_location("Studio", travel_minutes_from_home=15)

    assert scheduling.travel_minutes(studio, studio) == 0


def test_a_missing_side_is_zero(archive):
    studio = make_location("Studio", travel_minutes_from_home=15)

    assert scheduling.travel_minutes(None, studio) == 0
    assert scheduling.travel_minutes(studio, None) == 0
    assert scheduling.travel_minutes(None, None) == 0


def test_a_missing_location_does_not_raise(archive):
    assert scheduling.travel_minutes("nonexistent", "also-nonexistent") == 0


def test_via_home_fallback_when_no_direct_pair_is_on_file(archive):
    studio = make_location("Studio", travel_minutes_from_home=15)
    shop = make_location("Fabric Shop", travel_minutes_from_home=25)

    assert scheduling.travel_minutes(studio, shop) == 40


def test_via_home_fallback_treats_a_missing_travel_minutes_from_home_as_zero(archive):
    studio = make_location("Studio", travel_minutes_from_home=15)
    library = make_location("Library")  # no travel_minutes_from_home set

    assert scheduling.travel_minutes(studio, library) == 15


def test_a_direct_pair_beats_the_via_home_fallback(archive):
    studio = make_location("Studio", travel_minutes_from_home=15)
    shop = make_location("Fabric Shop", travel_minutes_from_home=25)
    db.save_travel([{"from_location_id": studio, "to_location_id": shop, "minutes": 8}])

    assert scheduling.travel_minutes(studio, shop) == 8
    # Nothing written for the reverse pair, but it's the same trip.
    assert scheduling.travel_minutes(shop, studio) == 8


def test_a_reverse_pair_row_overrides_the_symmetric_fallback(archive):
    studio = make_location("Studio", travel_minutes_from_home=15)
    shop = make_location("Fabric Shop", travel_minutes_from_home=25)
    db.save_travel([
        {"from_location_id": studio, "to_location_id": shop, "minutes": 8},
        {"from_location_id": shop, "to_location_id": studio, "minutes": 12},
    ])

    assert scheduling.travel_minutes(studio, shop) == 8
    assert scheduling.travel_minutes(shop, studio) == 12
