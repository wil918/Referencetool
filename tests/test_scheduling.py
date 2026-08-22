"""scheduling.travel_minutes -- the rules in order: same-location/missing is
free, a direct or reverse location_travel row wins over the via-home
fallback, and a missing location never raises -- plus daily capacity
(available_minutes, infer_energy, compute_daily_capacity).
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


# --- Daily capacity ------------------------------------------------------------


def set_working_hours(weekday, opens="09:00", closes="18:00"):
    db.save_working_hours([{"weekday": weekday, "opens": opens, "closes": closes}])


def test_available_minutes_subtracts_commitments_correctly(archive):
    # 2026-01-05 is a Monday (weekday 0).
    set_working_hours(0, "09:00", "18:00")
    db.create_commitment("c1", "Studio class", "2026-01-05T10:00:00", "2026-01-05T11:00:00")

    assert scheduling.available_minutes("2026-01-05") == 9 * 60 - 60


def test_available_minutes_only_subtracts_the_overlapping_part_of_a_commitment(archive):
    set_working_hours(0, "09:00", "18:00")
    # Starts before the window opens, ends inside it -- only 08:00-09:00 is
    # outside working hours and doesn't count.
    db.create_commitment("c1", "Early shift", "2026-01-05T08:00:00", "2026-01-05T09:30:00")

    assert scheduling.available_minutes("2026-01-05") == 9 * 60 - 30


def test_available_minutes_ignores_a_commitment_entirely_outside_the_window(archive):
    set_working_hours(0, "09:00", "18:00")
    db.create_commitment("c1", "Late dinner", "2026-01-05T20:00:00", "2026-01-05T22:00:00")

    assert scheduling.available_minutes("2026-01-05") == 9 * 60


def test_available_minutes_is_zero_with_no_working_hours_for_that_weekday(archive):
    set_working_hours(0, "09:00", "18:00")  # Monday only

    assert scheduling.available_minutes("2026-01-04") == 0  # a Sunday


def test_infer_energy_is_baseline_with_no_commitments_the_day_before(archive):
    assert scheduling.infer_energy("2026-01-06") == scheduling.BASELINE_ENERGY


def test_infer_energy_drops_after_a_high_cost_commitment_ending_late(archive):
    db.create_commitment(
        "c1", "Late crit", "2026-01-05T18:00:00", "2026-01-05T21:00:00",
        energy_cost=scheduling.HIGH_ENERGY_COST,
    )

    assert scheduling.infer_energy("2026-01-06") == scheduling.LOW_ENERGY


def test_infer_energy_is_unaffected_by_a_high_cost_commitment_that_ends_early(archive):
    db.create_commitment(
        "c1", "Busy but done by dinner", "2026-01-05T14:00:00", "2026-01-05T18:00:00",
        energy_cost=scheduling.HIGH_ENERGY_COST,
    )

    assert scheduling.infer_energy("2026-01-06") == scheduling.BASELINE_ENERGY


def test_infer_energy_is_unaffected_by_a_late_commitment_that_is_not_high_cost(archive):
    db.create_commitment(
        "c1", "Relaxed evening class", "2026-01-05T18:00:00", "2026-01-05T21:00:00",
        energy_cost=scheduling.HIGH_ENERGY_COST - 1,
    )

    assert scheduling.infer_energy("2026-01-06") == scheduling.BASELINE_ENERGY


def test_compute_daily_capacity_persists_available_minutes_and_inferred_energy(archive):
    set_working_hours(0, "09:00", "18:00")
    db.create_commitment("c1", "Studio class", "2026-01-05T10:00:00", "2026-01-05T11:00:00")

    row = scheduling.compute_daily_capacity("2026-01-05")

    assert row["available_minutes"] == 9 * 60 - 60
    assert row["inferred_energy"] == scheduling.BASELINE_ENERGY
    assert db.get_daily_capacity("2026-01-05") == row


def test_a_manual_energy_override_wins_over_inferred(archive):
    db.create_commitment(
        "c1", "Late crit", "2026-01-05T18:00:00", "2026-01-05T21:00:00",
        energy_cost=scheduling.HIGH_ENERGY_COST,
    )
    scheduling.compute_daily_capacity("2026-01-06")  # inferred_energy would be LOW
    db.save_daily_capacity("2026-01-06", manual_energy=5)

    row = scheduling.compute_daily_capacity("2026-01-06")

    assert row["inferred_energy"] == scheduling.LOW_ENERGY
    assert row["manual_energy"] == 5
    assert scheduling.effective_energy(row) == 5


def test_recomputing_capacity_does_not_clear_a_manual_override(archive):
    scheduling.compute_daily_capacity("2026-01-06")
    db.save_daily_capacity("2026-01-06", manual_energy=1, available_minutes=0)

    # A new commitment on the day before changes what would be inferred --
    # recomputing must still leave the override in place.
    db.create_commitment(
        "c1", "Late crit", "2026-01-05T18:00:00", "2026-01-05T21:00:00",
        energy_cost=scheduling.HIGH_ENERGY_COST,
    )
    row = scheduling.compute_daily_capacity("2026-01-06")

    assert row["manual_energy"] == 1
    assert row["inferred_energy"] == scheduling.LOW_ENERGY
