"""scheduling.travel_minutes -- the rules in order: same-location/missing is
free, a direct or reverse location_travel row wins over the via-home
fallback, and a missing location never raises -- plus daily capacity
(available_minutes, infer_energy, compute_daily_capacity) and the scheduler
itself.
"""
import json
import uuid
from datetime import date, datetime, timedelta

import pytest

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


def test_available_minutes_counts_overlapping_commitments_once(archive):
    set_working_hours(0, "09:00", "18:00")
    db.create_commitment("c1", "Studio session", "2026-01-05T10:00:00", "2026-01-05T12:00:00")
    # A lunch inside the session isn't a second hour lost -- it's the same
    # hour, already gone.
    db.create_commitment("c2", "Lunch", "2026-01-05T11:00:00", "2026-01-05T11:30:00")

    assert scheduling.available_minutes("2026-01-05") == 9 * 60 - 120


def test_free_intervals_are_what_is_left_either_side_of_a_commitment(archive):
    set_working_hours(0, "09:00", "18:00")
    db.create_commitment("c1", "Studio session", "2026-01-05T10:00:00", "2026-01-05T12:00:00")

    assert scheduling.free_intervals("2026-01-05") == [
        (datetime(2026, 1, 5, 9, 0), datetime(2026, 1, 5, 10, 0)),
        (datetime(2026, 1, 5, 12, 0), datetime(2026, 1, 5, 18, 0)),
    ]


# --- The scheduler ---------------------------------------------------------------
#
# Every plan is anchored explicitly, so none of these depend on the day they
# are run. MONDAY is a Monday; the working week below runs Monday to Friday.

MONDAY = "2026-03-02"
TUESDAY = "2026-03-03"
WEDNESDAY = "2026-03-04"
FRIDAY = "2026-03-06"


def working_week(opens="09:00", closes="17:00", weekdays=range(5)):
    db.save_working_hours([{"weekday": w, "opens": opens, "closes": closes} for w in weekdays])


def task(task_id, title=None, **fields):
    db.create_task(task_id, title or task_id, **fields)
    return task_id


def placed(result):
    """Task blocks by task id -- what the plan actually committed to.

    Travel blocks carry the task id of the leg's destination, so they have to
    be filtered out here or a task's trip home would overwrite the task.
    """
    return {b["task_id"]: b for b in result["blocks"] if b["kind"] == "task"}


def risk(result):
    return {e["task_id"]: e for e in result["at_risk"]}


def test_an_empty_task_set_returns_an_empty_schedule_rather_than_raising(archive):
    working_week()

    result = scheduling.plan(MONDAY)

    assert result["blocks"] == []
    assert result["at_risk"] == []
    assert result["at_risk_by_deliverable"] == []
    assert result["summary"]["tasks"] == 0
    # The horizon still exists -- there is simply nothing in it.
    assert result["horizon_end"] > result["today"]


def test_nothing_can_be_placed_with_no_working_hours_at_all(archive):
    task("t-a", est_minutes=60)

    result = scheduling.plan(MONDAY)

    assert result["blocks"] == []
    assert risk(result)["t-a"]["reason"] == scheduling.AT_RISK_NO_CAPACITY


def test_a_dependency_is_never_scheduled_before_what_it_depends_on(archive):
    working_week()
    # The dependent is the more important of the two, so a scheduler that
    # ranked on score alone would place it first.
    task("t-a-cut", "Cut the toile", est_minutes=120, importance=1)
    task("t-b-sew", "Sew the toile", est_minutes=120, importance=5)
    db.add_task_dependency("t-b-sew", "t-a-cut")

    blocks = placed(scheduling.plan(MONDAY))

    assert blocks["t-a-cut"]["end"] <= blocks["t-b-sew"]["start"]


def test_a_chain_of_dependencies_comes_out_in_order(archive):
    working_week()
    for n in range(4):
        task(f"t-{n}", est_minutes=180)
    for n in range(1, 4):
        db.add_task_dependency(f"t-{n}", f"t-{n - 1}")

    blocks = placed(scheduling.plan(MONDAY))

    starts = [blocks[f"t-{n}"]["start"] for n in range(4)]
    assert starts == sorted(starts)


def test_a_dependency_cycle_is_an_error_naming_the_tasks(archive):
    working_week()
    task("t-a", "Cut the toile")
    task("t-b", "Sew the toile")
    # add_task_dependency trusts its caller (the route checks first), which is
    # how a cycle can be in the table at all.
    db.add_task_dependency("t-a", "t-b")
    db.add_task_dependency("t-b", "t-a")

    with pytest.raises(scheduling.DependencyCycleError) as excinfo:
        scheduling.plan(MONDAY)

    assert "Cut the toile" in str(excinfo.value)
    assert "Sew the toile" in str(excinfo.value)
    assert set(excinfo.value.task_ids) == {"t-a", "t-b"}


def test_a_dependency_on_finished_work_does_not_block_anything(archive):
    working_week()
    task("t-done", est_minutes=60, status="done")
    task("t-next", est_minutes=60)
    db.add_task_dependency("t-next", "t-done")

    blocks = placed(scheduling.plan(MONDAY))

    assert blocks["t-next"]["start"].startswith(MONDAY)
    assert "t-done" not in blocks  # finished work is not replanned


def test_urgency_comes_from_slack_not_from_the_raw_deadline(archive):
    working_week(closes="18:00")  # nine-hour days, so both fit on Monday
    # Four days of sewing, due Friday, entered the way it would really be
    # entered: a chain of day-long tasks.
    for n in range(4):
        task(f"t-sew-{n}", f"Sew part {n}", est_minutes=8 * 60, deadline=FRIDAY, importance=3)
        if n:
            db.add_task_dependency(f"t-sew-{n}", f"t-sew-{n - 1}")
    # An hour of admin, due a day EARLIER. Ranked by deadline it would go
    # first; ranked by slack the sewing does, because four days of work
    # against four days of calendar has none left.
    task("t-admin", "Admin", est_minutes=60, deadline=WEDNESDAY, importance=3)

    blocks = placed(scheduling.plan(MONDAY))

    assert blocks["t-sew-0"]["start"] < blocks["t-admin"]["start"]
    assert blocks["t-sew-0"]["start"] == f"{MONDAY}T09:00:00"


def test_an_undated_prerequisite_inherits_the_urgency_of_what_waits_on_it(archive):
    # Monday holds one two-hour slot, so only one of the two undated tasks
    # can have it.
    db.save_working_hours([
        {"weekday": 0, "opens": "09:00", "closes": "11:00"},
        {"weekday": 1, "opens": "09:00", "closes": "17:00"},
        {"weekday": 2, "opens": "09:00", "closes": "17:00"},
    ])
    task("t-aaa-loose", "Loose end", est_minutes=120)
    task("t-zzz-prep", "Prepare", est_minutes=120)
    task("t-urgent", "Hand in", est_minutes=60, deadline=TUESDAY)
    db.add_task_dependency("t-urgent", "t-zzz-prep")

    blocks = placed(scheduling.plan(MONDAY))

    # Identical on their own terms, so without the inherited deadline id order
    # would give Monday to t-aaa-loose and leave the hand-in unreachable.
    assert blocks["t-zzz-prep"]["start"].startswith(MONDAY)
    assert blocks["t-aaa-loose"]["start"].startswith(TUESDAY)
    assert blocks["t-urgent"]["start"].startswith(TUESDAY)


def test_the_same_input_twice_gives_byte_identical_output(archive):
    working_week()
    db.create_commitment("c1", "Class", f"{MONDAY}T10:00:00", f"{MONDAY}T12:00:00")
    task("t-a", "Cut", est_minutes=120, importance=4, difficulty=3, deadline=FRIDAY)
    task("t-b", "Sew", est_minutes=180, importance=4, difficulty=4)
    # Two tasks alike in every way but their ids: the tie has to break the
    # same way every run, or the plan shuffles between replans.
    task("t-c", "Press", est_minutes=90, importance=3, difficulty=2)
    task("t-d", "Trim", est_minutes=90, importance=3, difficulty=2)
    task("t-e", "Unreachable", est_minutes=20 * 60, deadline=TUESDAY)
    db.add_task_dependency("t-b", "t-a")

    first = json.dumps(scheduling.plan(MONDAY))
    second = json.dumps(scheduling.plan(MONDAY))

    assert first == second


def test_a_replan_keeps_the_ids_of_blocks_that_did_not_move(archive):
    working_week()
    task("t-a", est_minutes=60)

    scheduling.replan(MONDAY)
    first = [b["id"] for b in db.list_scheduled_blocks_for_task("t-a")]
    scheduling.replan(MONDAY)
    second = [b["id"] for b in db.list_scheduled_blocks_for_task("t-a")]

    assert first == second != []


def test_a_task_with_no_slack_lands_on_the_at_risk_list(archive):
    working_week()
    # Five days of work due Wednesday, with three working days to do it in.
    for n in range(5):
        task(f"t-{n}", f"Task {n}", est_minutes=8 * 60, deadline=WEDNESDAY)

    result = scheduling.plan(MONDAY)

    assert len(result["blocks"]) == 3
    at_risk = result["at_risk"]
    assert len(at_risk) == 2
    assert all(e["reason"] == scheduling.AT_RISK_NO_CAPACITY for e in at_risk)
    assert all(e["message"] for e in at_risk)


def test_a_task_longer_than_any_available_day_is_flagged_rather_than_silently_dropped(archive):
    working_week()  # eight-hour days
    task("t-long", "Ten hours of pattern cutting", est_minutes=10 * 60, deadline=FRIDAY)

    result = scheduling.plan(MONDAY)

    assert result["blocks"] == []
    entry = risk(result)["t-long"]
    assert entry["reason"] == scheduling.AT_RISK_TOO_LONG
    assert "10h" in entry["message"]
    assert "8h" in entry["message"]


def test_a_task_whose_deadline_has_already_passed_says_so(archive):
    working_week()
    task("t-late", est_minutes=60, deadline="2026-02-20")

    entry = risk(scheduling.plan(MONDAY))["t-late"]

    assert entry["reason"] == scheduling.AT_RISK_OVERDUE
    assert "2026-02-20" in entry["message"]


def test_work_waiting_on_unplaceable_work_is_reported_as_blocked(archive):
    working_week()
    task("t-a-huge", "Huge", est_minutes=20 * 60, deadline=FRIDAY)
    task("t-b-after", "After", est_minutes=60, deadline=FRIDAY)
    db.add_task_dependency("t-b-after", "t-a-huge")

    entries = risk(scheduling.plan(MONDAY))

    assert entries["t-a-huge"]["reason"] == scheduling.AT_RISK_TOO_LONG
    assert entries["t-b-after"]["reason"] == scheduling.AT_RISK_BLOCKED
    assert "Huge" in entries["t-b-after"]["message"]


def test_a_low_energy_day_refuses_a_high_difficulty_task(archive):
    working_week()
    db.save_daily_capacity(MONDAY, manual_energy=scheduling.LOW_ENERGY)
    task("t-hard", "Fit the sleeve head", est_minutes=60, difficulty=5)

    block = placed(scheduling.plan(MONDAY))["t-hard"]

    assert block["start"].startswith(TUESDAY)


def test_a_low_energy_day_still_takes_low_difficulty_work(archive):
    working_week()
    db.save_daily_capacity(MONDAY, manual_energy=scheduling.LOW_ENERGY)
    task("t-easy", "Trim threads", est_minutes=60, difficulty=2)

    block = placed(scheduling.plan(MONDAY))["t-easy"]

    assert block["start"].startswith(MONDAY)


def test_a_task_no_day_has_the_energy_for_is_at_risk_with_that_reason(archive):
    working_week()
    for day in (MONDAY, TUESDAY):
        db.save_daily_capacity(day, manual_energy=1)
    task("t-hard", "Draft the block", est_minutes=60, difficulty=4, deadline=TUESDAY)

    entry = risk(scheduling.plan(MONDAY))["t-hard"]

    assert entry["reason"] == scheduling.AT_RISK_ENERGY
    assert "difficulty 4" in entry["message"]


def test_the_horizon_runs_to_the_furthest_deadline_not_a_fixed_window(archive):
    working_week()
    task("t-soon", est_minutes=60, deadline=FRIDAY)
    task("t-far", est_minutes=60, deadline="2026-04-10")  # six weeks out

    result = scheduling.plan(MONDAY)

    assert result["horizon_end"] == "2026-04-10"
    assert placed(result)["t-far"]  # and it is reachable inside it


def test_the_horizon_still_covers_a_fortnight_with_no_deadlines_at_all(archive):
    working_week()
    task("t-a", est_minutes=60)

    result = scheduling.plan(MONDAY)

    expected = date.fromisoformat(MONDAY) + timedelta(days=scheduling.DEFAULT_HORIZON_DAYS)
    assert result["horizon_end"] == expected.isoformat()


def test_a_task_inherits_its_deliverables_due_date(archive):
    working_week()
    db.create_project("p1", "Construction")
    db.create_deliverable("d1", "p1", "Part 2", due_at="2026-04-03")
    task("t-a", est_minutes=60, project_id="p1", deliverable_id="d1")

    result = scheduling.plan(MONDAY)

    assert result["horizon_end"] == "2026-04-03"


def test_detail_decays_beyond_the_first_week(archive):
    working_week()
    for n in range(12):
        task(f"t-{n:02d}", est_minutes=8 * 60)

    result = scheduling.plan(MONDAY)

    near = [b for b in result["blocks"] if b["granularity"] == "slot"]
    far = [b for b in result["blocks"] if b["granularity"] == "day"]
    assert near and far
    assert all("T" in b["start"] and "T" in b["end"] for b in near)
    # Further out a block claims a date and nothing more.
    assert all(b["start"] == b["end"] and "T" not in b["start"] for b in far)
    boundary = date.fromisoformat(MONDAY) + timedelta(days=scheduling.SLOT_DETAIL_DAYS - 1)
    assert result["slot_detail_until"] == boundary.isoformat()
    assert max(b["start"][:10] for b in near) <= boundary.isoformat()
    assert min(b["start"][:10] for b in far) > boundary.isoformat()


def test_a_far_out_dependency_still_lands_after_what_it_depends_on(archive):
    working_week()
    # Fill the near week, so the chain is pushed into day-granularity days.
    for n in range(6):
        task(f"t-filler-{n}", est_minutes=8 * 60)
    task("t-x-first", est_minutes=8 * 60)
    task("t-y-second", est_minutes=8 * 60)
    db.add_task_dependency("t-y-second", "t-x-first")

    blocks = placed(scheduling.plan(MONDAY))

    assert blocks["t-x-first"]["start"] < blocks["t-y-second"]["start"]


def test_at_risk_is_aggregated_per_deliverable(archive):
    working_week()
    db.create_project("p1", "Construction")
    db.create_deliverable("d1", "p1", "Part 2", due_at=WEDNESDAY)
    for n in range(5):
        task(f"t-{n}", f"Task {n}", project_id="p1", deliverable_id="d1", est_minutes=8 * 60)

    result = scheduling.plan(MONDAY)

    assert len(result["at_risk"]) == 2
    rollup = result["at_risk_by_deliverable"]
    assert len(rollup) == 1
    assert rollup[0]["deliverable_id"] == "d1"
    assert rollup[0]["title"] == "Part 2"
    assert rollup[0]["project_id"] == "p1"
    assert rollup[0]["at_risk_tasks"] == 2
    assert rollup[0]["total_tasks"] == 5
    assert rollup[0]["at_risk_minutes"] == 2 * 8 * 60
    assert rollup[0]["task_ids"] == sorted(rollup[0]["task_ids"])


def test_a_standalone_task_at_risk_is_reported_but_not_aggregated(archive):
    working_week()
    task("t-a", est_minutes=20 * 60, deadline=FRIDAY)

    result = scheduling.plan(MONDAY)

    assert len(result["at_risk"]) == 1
    assert result["at_risk_by_deliverable"] == []


def test_work_is_never_placed_in_hours_that_have_already_passed(archive):
    working_week()
    task("t-a", est_minutes=60)

    result = scheduling.plan(datetime(2026, 3, 2, 14, 30))

    assert placed(result)["t-a"]["start"] == f"{MONDAY}T14:30:00"


def test_commitments_are_planned_around_not_over(archive):
    working_week()
    db.create_commitment("c1", "Studio class", f"{MONDAY}T09:00:00", f"{MONDAY}T15:00:00")
    task("t-a", est_minutes=120)

    assert placed(scheduling.plan(MONDAY))["t-a"]["start"] == f"{MONDAY}T15:00:00"


def test_the_scheduler_never_mutates_a_task_row(archive):
    working_week()
    task("t-a", est_minutes=60, deadline=FRIDAY)
    task("t-b", est_minutes=40 * 60, deadline=FRIDAY)  # will be at risk
    before = {t["id"]: t for t in db.list_tasks()}

    scheduling.replan(MONDAY)

    assert {t["id"]: t for t in db.list_tasks()} == before
    assert db.list_scheduled_blocks_for_task("t-a")  # it did place it


def test_replan_replaces_the_previous_plan_wholesale(archive):
    working_week()
    task("t-a", est_minutes=60)
    scheduling.replan(MONDAY)
    db.create_scheduled_block("stale", "t-a", "2026-01-01T09:00:00", "2026-01-01T10:00:00")

    scheduling.replan(MONDAY)

    blocks = db.list_scheduled_blocks_for_task("t-a")
    assert [b["id"] for b in blocks] != ["stale"]
    assert len(blocks) == 1


def test_a_stored_day_granularity_block_is_recognised_as_such(archive):
    working_week()
    for n in range(12):
        task(f"t-{n:02d}", est_minutes=8 * 60)
    scheduling.replan(MONDAY)

    stored = db.list_scheduled_blocks_between(MONDAY, "2026-04-01")
    kinds = {scheduling.block_granularity(b) for b in stored}

    assert kinds == {"slot", "day"}


# --- The routes -------------------------------------------------------------------
#
# Anchored on today rather than a fixed date, so the stored blocks fall inside
# the range GET /api/schedule covers by default.


def any_day_working_hours():
    db.save_working_hours([{"weekday": w, "opens": "09:00", "closes": "17:00"} for w in range(7)])


def test_the_plan_route_places_work_and_persists_the_blocks(client):
    any_day_working_hours()
    today = date.today().isoformat()
    task("t-a", "Cut the toile", est_minutes=120)

    body = client.post("/api/schedule/plan", json={"now": today}).get_json()

    assert body["summary"]["placed"] == 1
    assert body["blocks"][0]["task_id"] == "t-a"
    assert [b["id"] for b in db.list_scheduled_blocks_for_task("t-a")] == [body["blocks"][0]["id"]]


def test_the_plan_route_replaces_the_previous_plans_blocks(client):
    any_day_working_hours()
    today = date.today().isoformat()
    task("t-a", est_minutes=120)
    db.create_scheduled_block("stale", "t-a", "2020-01-01T09:00:00", "2020-01-01T10:00:00")

    client.post("/api/schedule/plan", json={"now": today})

    assert "stale" not in [b["id"] for b in db.list_scheduled_blocks_for_task("t-a")]


def test_the_plan_route_rejects_a_dependency_cycle(client):
    any_day_working_hours()
    task("t-a", "Cut the toile")
    task("t-b", "Sew the toile")
    db.add_task_dependency("t-a", "t-b")
    db.add_task_dependency("t-b", "t-a")

    resp = client.post("/api/schedule/plan", json={})

    assert resp.status_code == 400
    body = resp.get_json()
    assert "Cut the toile" in body["error"]
    assert set(body["task_ids"]) == {"t-a", "t-b"}


def test_the_plan_route_rejects_an_unreadable_anchor(client):
    resp = client.post("/api/schedule/plan", json={"now": "next tuesday"})

    assert resp.status_code == 400


def test_the_schedule_route_returns_blocks_in_range_plus_the_at_risk_list(client):
    any_day_working_hours()
    today = date.today()
    task("t-a", "Cut the toile", est_minutes=120)
    task("t-b", "Unreachable", est_minutes=100 * 60, deadline=(today + timedelta(days=2)).isoformat())
    client.post("/api/schedule/plan", json={"now": today.isoformat()})

    body = client.get("/api/schedule").get_json()

    # t-a's own two hours cross the break threshold, so its block is followed
    # by a break -- filtered out here, since this test is about task/at-risk
    # routing, not breaks (see BREAK_AFTER_MINUTES).
    assert [b["task_id"] for b in body["blocks"] if b["kind"] == "task"] == ["t-a"]
    assert body["blocks"][0]["granularity"] == "slot"
    assert [e["task_id"] for e in body["at_risk"]] == ["t-b"]
    assert body["start"] == today.isoformat()
    # No range given, so it runs to the end of the horizon.
    assert body["end"] == body["horizon_end"]


def test_the_schedule_routes_end_date_is_inclusive(client):
    any_day_working_hours()
    today = date.today()
    tomorrow = today + timedelta(days=1)
    # Two full days of work, so there is a block on each of them.
    task("t-a", est_minutes=8 * 60)
    task("t-b", est_minutes=8 * 60)
    client.post("/api/schedule/plan", json={"now": today.isoformat()})

    body = client.get(f"/api/schedule?start={today.isoformat()}&end={tomorrow.isoformat()}").get_json()

    assert {b["start"][:10] for b in body["blocks"]} == {today.isoformat(), tomorrow.isoformat()}


def test_the_schedule_route_rejects_a_malformed_date(client):
    resp = client.get("/api/schedule?start=the-fifth")

    assert resp.status_code == 400


def test_an_ordinary_day_admits_the_hardest_work(archive):
    # Energy is only ever inferred as baseline or one below it, so if a
    # baseline day refused difficulty 5 nothing that hard could be scheduled
    # at all without a manual override.
    working_week()
    task("t-hard", "Fit the sleeve head", est_minutes=60, difficulty=5)

    block = placed(scheduling.plan(MONDAY))["t-hard"]

    assert block["start"].startswith(MONDAY)


def test_the_at_risk_list_reads_soonest_deadline_first(archive):
    working_week()
    task("t-z-soon", "Soon", est_minutes=20 * 60, deadline=WEDNESDAY)
    task("t-a-later", "Later", est_minutes=20 * 60, deadline=FRIDAY)

    result = scheduling.plan(MONDAY)

    assert [e["task_id"] for e in result["at_risk"]] == ["t-z-soon", "t-a-later"]


# --- Required location ------------------------------------------------------------
#
# A hard constraint, and a different thing from travel cost: pattern cutting
# cannot happen at home at 22:00 because the studio is shut, not because it is
# far away. Travel is priced separately, further down.


def location_hours(location_id, opens="10:00", closes="18:00", weekdays=range(7)):
    db.save_location_hours(
        location_id, [{"weekday": w, "opens": opens, "closes": closes} for w in weekdays]
    )


def test_a_studio_task_is_never_placed_outside_studio_hours(archive):
    # A working day running long past the studio's, so a scheduler that only
    # looked at working hours would start this at 08:00 and finish it at 22:00.
    db.save_working_hours([{"weekday": 0, "opens": "08:00", "closes": "23:00"}])
    studio = make_location("Studio")
    location_hours(studio, "10:00", "13:00")
    task("t-cut", "Pattern cutting", est_minutes=120, required_location_id=studio,
         deadline=MONDAY)

    block = placed(scheduling.plan(MONDAY))["t-cut"]

    assert block["start"] == f"{MONDAY}T10:00:00"
    assert block["end"] == f"{MONDAY}T12:00:00"


def test_an_override_closing_the_studio_early_moves_the_work(archive):
    working_week(closes="18:00")
    studio = make_location("Studio")
    location_hours(studio, "10:00", "18:00")
    db.create_location_override("o-early", studio, MONDAY, closes="12:00")
    task("t-cut", "Pattern cutting", est_minutes=180, required_location_id=studio)

    block = placed(scheduling.plan(MONDAY))["t-cut"]

    # Monday's two remaining hours cannot hold three hours of work.
    assert block["start"] == f"{TUESDAY}T10:00:00"


def test_a_location_override_closes_the_day_outright(archive):
    studio = make_location("Studio")
    location_hours(studio, "10:00", "18:00")
    db.create_location_override("o-shut", studio, MONDAY, closed=True)

    assert scheduling.location_open_intervals(studio, MONDAY) == []


def test_an_override_naming_only_a_closing_time_keeps_the_weekly_opening(archive):
    studio = make_location("Studio")
    location_hours(studio, "10:00", "18:00")
    db.create_location_override("o-early", studio, MONDAY, closes="12:00")

    assert scheduling.location_open_intervals(studio, MONDAY) == [
        (datetime.fromisoformat(f"{MONDAY}T10:00:00"),
         datetime.fromisoformat(f"{MONDAY}T12:00:00"))
    ]


def test_a_task_with_no_required_location_is_not_bound_by_any_location_hours(archive):
    working_week(closes="18:00")
    studio = make_location("Studio")
    location_hours(studio, "14:00", "16:00")
    task("t-notes", "Write up notes", est_minutes=60)

    assert placed(scheduling.plan(MONDAY))["t-notes"]["start"] == f"{MONDAY}T09:00:00"


def test_a_task_is_at_risk_when_its_location_never_opens_before_the_deadline(archive):
    working_week()  # Monday to Friday
    shop = make_location("Fabric Shop")
    location_hours(shop, "10:00", "16:00", weekdays=(5, 6))  # weekends only
    task("t-buy", "Buy calico", est_minutes=60, required_location_id=shop, deadline=WEDNESDAY)

    entry = risk(scheduling.plan(MONDAY))["t-buy"]

    assert entry["reason"] == scheduling.AT_RISK_LOCATION
    assert "Fabric Shop" in entry["message"]


# --- Support matching -------------------------------------------------------------
#
# A window says what it OFFERS, a task says what it NEEDS, and the two are
# different vocabularies -- so these are matched, never compared.


def commitment(commitment_id, start, end, support_level="none", location_id=None):
    db.create_commitment(
        commitment_id, commitment_id, f"{MONDAY}T{start}:00", f"{MONDAY}T{end}:00",
        support_level=support_level, location_id=location_id,
    )


def test_a_supported_commitment_is_time_you_work_in_not_time_that_blocks_you(archive):
    set_working_hours(0)  # Monday, 09:00-18:00
    commitment("c-studio", "10:00", "13:00", support_level="priority")
    commitment("c-lecture", "14:00", "15:00")

    # Only the lecture is subtracted. A timetabled studio session does not
    # create availability, but nor does it consume it -- it is where the work
    # happens, and cutting it out would leave a 'needs' task nowhere to go.
    assert scheduling.available_minutes(MONDAY) == 9 * 60 - 60


def test_a_needs_task_refuses_an_ambient_window(archive):
    working_week()
    commitment("c-ambient", "09:00", "13:00", support_level="ambient")
    task("t-welt", "First welt pocket", est_minutes=120, support_level="needs",
         deadline=MONDAY)

    result = scheduling.plan(MONDAY)

    assert result["blocks"] == []
    entry = risk(result)["t-welt"]
    assert entry["reason"] == scheduling.AT_RISK_NO_SUPPORT
    assert "priority" in entry["message"]


def test_a_needs_task_takes_the_priority_window_and_nothing_else(archive):
    working_week()
    commitment("c-ambient", "09:00", "11:00", support_level="ambient")
    commitment("c-tutorial", "13:00", "15:00", support_level="priority")
    task("t-welt", "First welt pocket", est_minutes=120, support_level="needs",
         deadline=MONDAY)

    assert placed(scheduling.plan(MONDAY))["t-welt"]["start"] == f"{MONDAY}T13:00:00"


def test_a_prefers_task_takes_a_priority_window_over_an_earlier_ambient_one(archive):
    working_week()
    commitment("c-ambient", "09:00", "11:00", support_level="ambient")
    commitment("c-tutorial", "13:00", "15:00", support_level="priority")
    task("t-sew", "Sew the toile", est_minutes=120, support_level="prefers", deadline=MONDAY)

    # First fit would take the ambient morning; preferring priority does not.
    assert placed(scheduling.plan(MONDAY))["t-sew"]["start"] == f"{MONDAY}T13:00:00"


def test_a_prefers_task_falls_back_to_ambient_when_there_is_no_priority_window(archive):
    working_week()
    commitment("c-ambient", "13:00", "15:00", support_level="ambient")
    task("t-sew", "Sew the toile", est_minutes=120, support_level="prefers", deadline=MONDAY)

    assert placed(scheduling.plan(MONDAY))["t-sew"]["start"] == f"{MONDAY}T13:00:00"


def test_a_prefers_task_falls_back_to_ordinary_hours_when_nothing_is_supported(archive):
    working_week()
    task("t-sew", "Sew the toile", est_minutes=120, support_level="prefers", deadline=MONDAY)

    # A preference, not a gate: unlike 'needs', a week with no session in it
    # delays this work at worst -- it does not put it out of reach.
    assert placed(scheduling.plan(MONDAY))["t-sew"]["start"] == f"{MONDAY}T09:00:00"


def test_a_prefers_task_is_never_at_risk_merely_for_want_of_support(archive):
    working_week()
    # Only ambient help exists, and only after the deadline it would need.
    commitment("c-ambient", "13:00", "15:00", support_level="ambient")
    task("t-early", "Sew the toile", est_minutes=120, support_level="prefers",
         deadline=MONDAY)
    task("t-needs", "First welt pocket", est_minutes=120, support_level="needs",
         deadline=MONDAY)

    result = scheduling.plan(MONDAY)

    assert "t-early" in placed(result)
    assert risk(result)["t-needs"]["reason"] == scheduling.AT_RISK_NO_SUPPORT


def test_an_independent_task_is_not_confined_to_supported_windows(archive):
    working_week()
    commitment("c-tutorial", "13:00", "15:00", support_level="priority")
    task("t-admin", "Admin", est_minutes=60)

    assert placed(scheduling.plan(MONDAY))["t-admin"]["start"] == f"{MONDAY}T09:00:00"


def test_a_supported_window_somewhere_else_is_no_use_to_located_work(archive):
    working_week()
    studio = make_location("Studio")
    annexe = make_location("Annexe")
    location_hours(studio, "09:00", "17:00")
    commitment("c-annexe", "10:00", "16:00", support_level="priority", location_id=annexe)
    task("t-welt", "First welt pocket", est_minutes=60, support_level="needs",
         required_location_id=studio, deadline=MONDAY)

    result = scheduling.plan(MONDAY)

    assert result["blocks"] == []
    assert risk(result)["t-welt"]["reason"] == scheduling.AT_RISK_NO_SUPPORT


# --- Travel -----------------------------------------------------------------------
#
# Real rows in the plan, not minutes deducted invisibly, and never added to the
# duration of the task they deliver you to.


def test_the_first_leg_of_a_day_comes_from_home_and_the_last_returns_to_it(archive):
    working_week()
    studio = make_location("Studio", travel_minutes_from_home=15)
    location_hours(studio, "09:00", "17:00")
    task("t-cut", "Pattern cutting", est_minutes=120, required_location_id=studio,
         deadline=MONDAY)

    blocks = scheduling.plan(MONDAY)["blocks"]

    # Two hours of cutting crosses the break threshold, so a break sits
    # between the work and the trip home (see BREAK_AFTER_MINUTES).
    assert [(b["kind"], b["start"], b["end"]) for b in blocks] == [
        ("travel", f"{MONDAY}T09:00:00", f"{MONDAY}T09:15:00"),
        ("task", f"{MONDAY}T09:15:00", f"{MONDAY}T11:15:00"),
        ("break", f"{MONDAY}T11:15:00", f"{MONDAY}T11:45:00"),
        ("travel", f"{MONDAY}T11:45:00", f"{MONDAY}T12:00:00"),
    ]
    assert blocks[0]["from_location_id"] is None and blocks[0]["to_location_id"] == studio
    assert blocks[3]["from_location_id"] == studio and blocks[3]["to_location_id"] is None


def test_travel_is_counted_against_the_day_but_never_folded_into_the_task(archive):
    working_week()
    studio = make_location("Studio", travel_minutes_from_home=15)
    location_hours(studio, "09:00", "17:00")
    task("t-cut", "Pattern cutting", est_minutes=120, required_location_id=studio,
         deadline=MONDAY)

    result = scheduling.plan(MONDAY)

    # The estimator learns from task durations; padding one with the trip to
    # get there would teach it that cutting takes longer at the studio.
    assert result["summary"]["planned_minutes"] == 120
    assert result["summary"]["travel_minutes"] == 30
    task_block = next(b for b in result["blocks"] if b["kind"] == "task")
    assert task_block["minutes"] == 120


def test_a_trip_between_two_locations_uses_the_pair_rather_than_going_via_home(archive):
    working_week(closes="18:00")
    studio = make_location("Studio", travel_minutes_from_home=30)
    shop = make_location("Fabric Shop", travel_minutes_from_home=30)
    db.save_travel([{"from_location_id": studio, "to_location_id": shop, "minutes": 10}])
    location_hours(studio, "09:00", "12:00")
    location_hours(shop, "13:00", "18:00")
    task("t-cut", "Pattern cutting", est_minutes=60, required_location_id=studio,
         deadline=MONDAY)
    task("t-buy", "Buy calico", est_minutes=60, required_location_id=shop, deadline=MONDAY)

    legs = [b for b in scheduling.plan(MONDAY)["blocks"] if b["kind"] == "travel"]
    middle = next(b for b in legs
                  if b["from_location_id"] == studio and b["to_location_id"] == shop)

    # Not 60, which is what studio -> home -> shop would have cost.
    assert middle["minutes"] == 10


def test_the_trip_home_has_to_fit_inside_the_working_day(archive):
    # Three hours of working time and half an hour each way: two hours of work
    # fits exactly, filling the day to the minute.
    db.save_working_hours([{"weekday": 0, "opens": "09:00", "closes": "12:00"}])
    studio = make_location("Studio", travel_minutes_from_home=30)
    location_hours(studio, "09:00", "12:00")
    task("t-fits", "Two hours of cutting", est_minutes=120, required_location_id=studio,
         deadline=MONDAY)

    result = scheduling.plan(MONDAY)

    assert placed(result)["t-fits"]["start"] == f"{MONDAY}T09:30:00"
    assert result["summary"]["travel_minutes"] == 60


def test_work_that_leaves_no_room_for_the_trip_home_does_not_fit(archive):
    db.save_working_hours([{"weekday": 0, "opens": "09:00", "closes": "12:00"}])
    studio = make_location("Studio", travel_minutes_from_home=30)
    location_hours(studio, "09:00", "12:00")
    task("t-long", "Two hours and five minutes", est_minutes=125,
         required_location_id=studio, deadline=MONDAY)

    result = scheduling.plan(MONDAY)

    assert result["blocks"] == []
    entry = risk(result)["t-long"]
    assert entry["reason"] == scheduling.AT_RISK_TOO_LONG
    assert "getting there and back" in entry["message"]


def test_travel_blocks_are_not_emitted_where_there_is_no_time_of_day_to_put_them(archive):
    # Beyond the slot horizon a task claims a date and nothing more, so its
    # legs cannot be positioned -- but they were still made room for, and the
    # summary still counts them.
    working_week(weekdays=range(7))
    studio = make_location("Studio", travel_minutes_from_home=30)
    location_hours(studio, "09:00", "17:00")
    for n in range(9):
        task(f"t-{n}", f"Cutting {n}", est_minutes=7 * 60, required_location_id=studio)

    result = scheduling.plan(MONDAY)
    day_blocks = [b for b in result["blocks"] if b["granularity"] == "day"]

    assert day_blocks and all(b["kind"] == "task" for b in day_blocks)
    # Every placed day, near or far, paid for its round trip.
    assert result["summary"]["travel_minutes"] == 60 * result["summary"]["placed"]


# --- The same-location tie-break ---------------------------------------------------


def two_shops_and_a_studio():
    """Three comparable errands, two of them at the same place. Ranked on
    score alone the studio one sits between the two shop ones."""
    working_week(closes="18:00")
    studio = make_location("Studio", travel_minutes_from_home=15)
    shop = make_location("Fabric Shop", travel_minutes_from_home=15)
    db.save_travel([{"from_location_id": studio, "to_location_id": shop, "minutes": 30}])
    location_hours(studio, "09:00", "18:00")
    location_hours(shop, "09:00", "18:00")
    return studio, shop


def test_two_tasks_at_the_same_location_are_grouped_into_one_trip(archive):
    studio, shop = two_shops_and_a_studio()
    task("t-a-shop", "Buy calico", est_minutes=60, required_location_id=shop)
    task("t-b-studio", "Toile fitting", est_minutes=60, required_location_id=studio)
    # A shorter estimate, so this scores slightly BELOW the studio task rather
    # than tying with it -- which is the case exact equality would miss and
    # COMPARABLE_SCORE_TOLERANCE is there to catch.
    task("t-c-shop", "Buy thread", est_minutes=30, required_location_id=shop)

    order = [b["task_id"] for b in scheduling.plan(MONDAY)["blocks"] if b["kind"] == "task"]

    assert order == ["t-a-shop", "t-c-shop", "t-b-studio"]


def test_a_materially_more_urgent_task_is_not_displaced_by_a_convenient_one(archive):
    studio, shop = two_shops_and_a_studio()
    task("t-a-shop", "Buy calico", est_minutes=60, required_location_id=shop,
         importance=5, deadline=MONDAY)
    task("t-b-studio", "Toile fitting", est_minutes=60, required_location_id=studio,
         importance=4, deadline=TUESDAY)
    task("t-c-shop", "Buy thread", est_minutes=60, required_location_id=shop, importance=1)

    order = [b["task_id"] for b in scheduling.plan(MONDAY)["blocks"] if b["kind"] == "task"]

    # The second shop errand is convenient but nowhere near comparable, so the
    # tie-break leaves the ranking alone.
    assert order[:2] == ["t-a-shop", "t-b-studio"]


# --- Protected finishing time -------------------------------------------------------


def test_ordinary_work_cannot_enter_the_finishing_buffer_even_when_everything_is_late(archive):
    working_week()  # eight-hour days
    # Five days of ordinary work due Wednesday with three days to do it in --
    # as far behind as it is possible to be, which is exactly when the buffer
    # would otherwise be the first thing taken.
    for n in range(5):
        task(f"t-ordinary-{n}", f"Ordinary {n}", est_minutes=8 * 60, deadline=WEDNESDAY)
    task("t-press", "Press and photograph", est_minutes=120, deadline=WEDNESDAY,
         is_finishing=True)

    blocks = placed(scheduling.plan(MONDAY))

    assert blocks["t-press"]["start"].startswith(WEDNESDAY)
    assert [tid for tid, b in blocks.items() if b["start"].startswith(WEDNESDAY)] == ["t-press"]


def test_finishing_work_is_held_for_its_buffer_rather_than_done_early(archive):
    working_week()
    task("t-press", "Press and photograph", est_minutes=120, deadline=FRIDAY,
         is_finishing=True)

    # Nothing else is competing, so a purely greedy walk would do this on
    # Monday morning and leave the protected window empty.
    assert placed(scheduling.plan(MONDAY))["t-press"]["start"].startswith(FRIDAY)


def test_a_deadline_with_no_finishing_work_reserves_nothing(archive):
    working_week()
    for n in range(3):
        task(f"t-{n}", f"Task {n}", est_minutes=8 * 60, deadline=WEDNESDAY)

    blocks = placed(scheduling.plan(MONDAY))

    # The flag is the input. With nothing to protect the time for, reserving
    # it would idle the day before every deadline in the system.
    assert len(blocks) == 3
    assert blocks["t-2"]["start"].startswith(WEDNESDAY)


def test_finishing_work_that_overflows_its_buffer_is_at_risk(archive):
    # The deadline is the only working day there is, so the protected window
    # is all the time there is -- and three six-hour jobs do not fit in eight
    # hours however they are arranged.
    db.save_working_hours([{"weekday": 2, "opens": "09:00", "closes": "17:00"}])
    for n in range(3):
        task(f"t-finish-{n}", f"Finish {n}", est_minutes=6 * 60, deadline=WEDNESDAY,
             is_finishing=True)

    result = scheduling.plan(MONDAY)
    at_risk = risk(result)

    # The one placed task's six hours cross the break threshold, so a break
    # follows it -- dropping that break wouldn't free enough room for a
    # second six-hour task either, so it stays (see BREAK_AFTER_MINUTES).
    assert [b["kind"] for b in result["blocks"]] == ["task", "break"]
    assert result["breaks_dropped"] == []
    assert len(at_risk) == 2
    assert all(e["reason"] == scheduling.AT_RISK_FINISHING for e in at_risk.values())
    assert all("protected" in e["message"] for e in at_risk.values())


def test_the_finishing_buffer_is_configurable(archive):
    working_week()
    task("t-press", "Press and photograph", est_minutes=120, deadline=FRIDAY,
         is_finishing=True)

    blocks = placed(scheduling.plan(MONDAY, finishing_buffer_minutes=0))

    assert blocks["t-press"]["start"].startswith(MONDAY)


def test_a_plan_with_every_constraint_at_once_is_still_reproducible(archive):
    working_week(closes="18:00")
    studio = make_location("Studio", travel_minutes_from_home=15)
    shop = make_location("Fabric Shop", travel_minutes_from_home=25)
    location_hours(studio, "10:00", "18:00")
    location_hours(shop, "09:00", "17:00")
    commitment("c-tutorial", "13:00", "15:00", support_level="priority", location_id=studio)
    task("t-welt", "First welt pocket", est_minutes=60, support_level="needs",
         required_location_id=studio)
    task("t-buy", "Buy calico", est_minutes=60, required_location_id=shop)
    task("t-press", "Press and photograph", est_minutes=60, deadline=FRIDAY, is_finishing=True)

    first = scheduling.plan(MONDAY)
    second = scheduling.plan(MONDAY)

    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    assert first["summary"]["placed"] == 3


def test_a_travel_block_never_becomes_the_tasks_recorded_duration(client):
    any_day_working_hours()
    today = date.today().isoformat()
    studio = make_location("Studio", travel_minutes_from_home=15)
    location_hours(studio, "09:00", "17:00")
    task("t-cut", "Pattern cutting", est_minutes=120, required_location_id=studio)

    body = client.post("/api/schedule/plan", json={"now": today}).get_json()
    # The two-hour task itself crosses the break threshold, so a break sits
    # between the work and the trip home (see BREAK_AFTER_MINUTES).
    assert [b["kind"] for b in body["blocks"]] == ["travel", "task", "break", "travel"]

    resp = client.post("/api/tasks/t-cut/complete")

    # Two hours of cutting and half an hour of travelling, recorded as two
    # hours of cutting.
    assert resp.get_json()["actual"]["actual_minutes"] == 120


# --- Personal events: immovability, independent of working hours -----------------


def make_commitment(commitment_id, start, end, **fields):
    db.create_commitment(commitment_id, commitment_id, start, end, **fields)
    return commitment_id


def test_a_personal_event_outside_working_hours_survives_working_hours_narrowing(archive):
    db.save_working_hours([{"weekday": 0, "opens": "09:00", "closes": "17:00"}])
    make_commitment("c-dinner", f"{MONDAY}T19:00:00", f"{MONDAY}T21:00:00")

    # Working hours shrink well away from the evening -- setting them must
    # never dislodge a commitment that was never inside them to begin with.
    db.save_working_hours([{"weekday": 0, "opens": "09:00", "closes": "12:00"}])

    commitment_row = db.get_commitment("c-dinner")
    assert commitment_row["start"] == f"{MONDAY}T19:00:00"
    assert commitment_row["end"] == f"{MONDAY}T21:00:00"


# --- Home-first chains -------------------------------------------------------------


def test_a_home_first_chain_inserts_travel_then_prep_and_ends_at_the_event_start(archive):
    studio = make_location("Studio", travel_minutes_from_home=15)
    cinema = make_location("Cinema", travel_minutes_from_home=20)
    # Away from home (at the studio) right up until the chain needs to start
    # working backwards -- so the leading travel-to-home leg has somewhere
    # real to travel from.
    make_commitment("c-studio", f"{MONDAY}T15:00:00", f"{MONDAY}T18:00:00", location_id=studio)
    event_start = f"{MONDAY}T19:30:00"
    c = make_commitment("c-cinema", event_start, f"{MONDAY}T22:00:00",
                        home_first=True, prep_minutes=30, location_id=cinema)

    chain = scheduling.home_first_chain(db.get_commitment(c))

    assert [b["kind"] for b in chain] == ["travel", "prep", "travel"]
    assert chain[-1]["end"] == datetime.fromisoformat(event_start)
    assert chain[0]["from_location_id"] == studio and chain[0]["to_location_id"] is None
    assert chain[-1]["from_location_id"] is None and chain[-1]["to_location_id"] == cinema
    # Contiguous: each block ends exactly where the next begins.
    assert chain[0]["end"] == chain[1]["start"]
    assert chain[1]["end"] == chain[2]["start"]


def test_the_leading_travel_block_is_omitted_when_already_at_home(archive):
    cinema = make_location("Cinema", travel_minutes_from_home=20)
    event_start = f"{MONDAY}T19:30:00"
    # Nothing else on the calendar -- there's nowhere to have travelled from,
    # so home is assumed (see scheduling._location_before).
    c = make_commitment("c-cinema", event_start, f"{MONDAY}T22:00:00",
                        home_first=True, prep_minutes=30, location_id=cinema)

    chain = scheduling.home_first_chain(db.get_commitment(c))

    assert [b["kind"] for b in chain] == ["prep", "travel"]
    assert chain[-1]["end"] == datetime.fromisoformat(event_start)


def test_a_venueless_event_omits_the_final_leg_but_still_means_arrival(archive):
    event_start = f"{MONDAY}T19:00:00"
    c = make_commitment("c-drinks", event_start, f"{MONDAY}T21:00:00",
                        home_first=True, prep_minutes=20)  # no location_id

    chain = scheduling.home_first_chain(db.get_commitment(c))

    assert [b["kind"] for b in chain] == ["prep"]
    # The entered time is still arrival -- the prep block ends exactly there,
    # just without a costed trip in front of it.
    assert chain[-1]["end"] == datetime.fromisoformat(event_start)


def test_work_is_displaced_rather_than_overlapping_a_home_first_chain(archive):
    db.save_working_hours([
        {"weekday": 0, "opens": "17:00", "closes": "19:30"},  # MONDAY: narrow, evening-only
        {"weekday": 1, "opens": "09:00", "closes": "17:00"},  # TUESDAY: a normal day
    ])
    venue = make_location("Venue", travel_minutes_from_home=15)
    make_commitment("c-out", f"{MONDAY}T19:00:00", f"{MONDAY}T21:00:00",
                    home_first=True, prep_minutes=30, location_id=venue)
    # 90 minutes would easily fit inside Monday's nominal 17:00-19:30 window
    # if the chain (18:15-19:00, working backwards from the 19:00 event) were
    # ignored -- but only 75 minutes of it (17:00-18:15) are actually free.
    task("t-work", est_minutes=90, deadline=TUESDAY)

    block = placed(scheduling.plan(MONDAY))["t-work"]

    assert block["start"].startswith(TUESDAY)
    chain_start = datetime.fromisoformat(f"{MONDAY}T18:15:00")
    task_start = datetime.fromisoformat(block["start"])
    task_end = datetime.fromisoformat(block["end"])
    assert task_end <= chain_start or task_start >= datetime.fromisoformat(f"{MONDAY}T21:00:00")


# --- Domestic tasks -----------------------------------------------------------------


def set_domestic_hours(weekday, opens="18:00", closes="20:00"):
    db.save_domestic_hours([{"weekday": weekday, "opens": opens, "closes": closes}])


def test_a_domestic_task_lands_in_domestic_hours_by_default(archive):
    working_week()
    set_domestic_hours(0)  # Monday, 18:00-20:00

    task("t-laundry", est_minutes=60, is_domestic=True)

    block = placed(scheduling.plan(MONDAY))["t-laundry"]

    assert block["start"] == f"{MONDAY}T18:00:00"


def test_a_domestic_task_may_use_working_hours_when_no_away_from_home_work_remains(archive):
    working_week()  # 09:00-17:00
    set_domestic_hours(0, "20:00", "21:00")  # only an hour -- not enough alone
    # No required_location_id, so it doesn't count as away-from-home work.
    task("t-admin", est_minutes=60, deadline=MONDAY)
    task("t-laundry", est_minutes=120, is_domestic=True, deadline=MONDAY)

    block = placed(scheduling.plan(MONDAY))["t-laundry"]

    # Too long for the domestic window alone; with nothing away from home
    # left to compete for it, working hours were available as a fallback.
    assert datetime.fromisoformat(block["start"]) < datetime.fromisoformat(f"{MONDAY}T18:00:00")


def test_a_domestic_task_does_not_use_working_hours_while_away_from_home_work_remains(archive):
    working_week()
    set_domestic_hours(0, "20:00", "21:00")
    studio = make_location("Studio", travel_minutes_from_home=15)
    location_hours(studio, "09:00", "17:00")
    # Away-from-home work still outstanding all week.
    task("t-cut", est_minutes=6 * 60, required_location_id=studio, deadline=FRIDAY)
    task("t-laundry", est_minutes=120, is_domestic=True, deadline=MONDAY)

    result = scheduling.plan(MONDAY)

    # The domestic task's own window is only an hour, and working hours
    # aren't offered as a fallback while t-cut still needs the day -- so it
    # can't be placed on Monday at all.
    assert "t-laundry" not in placed(result)


def test_a_date_override_narrows_domestic_hours_independently_of_working_hours(archive):
    set_domestic_hours(0, "18:00", "21:00")  # Monday, normally three hours
    override_id = str(uuid.uuid4())
    db.create_hours_override(override_id, MONDAY, "domestic", closes="19:00")

    assert scheduling.domestic_free_intervals(MONDAY) == [
        (datetime.fromisoformat(f"{MONDAY}T18:00:00"), datetime.fromisoformat(f"{MONDAY}T19:00:00"))
    ]
    # The working band's own hours (set separately, or not at all here) are
    # untouched by a domestic override.
    assert scheduling.free_intervals(MONDAY) == []


def test_a_non_domestic_task_is_never_placed_in_domestic_hours(archive):
    db.save_working_hours([])  # no working hours anywhere
    set_domestic_hours(0)
    task("t-work", est_minutes=60)

    result = scheduling.plan(MONDAY)

    assert result["blocks"] == []
    assert risk(result)["t-work"]["reason"] == scheduling.AT_RISK_NO_CAPACITY


# --- Breaks -------------------------------------------------------------------------


def test_a_break_appears_after_two_hours_of_consecutive_task_blocks(archive):
    working_week()
    task("t-a", est_minutes=90)
    task("t-b", est_minutes=90)

    blocks = scheduling.plan(MONDAY)["blocks"]

    assert [b["kind"] for b in blocks] == ["task", "task", "break"]
    assert blocks[2]["start"] == f"{MONDAY}T12:00:00"
    assert blocks[2]["end"] == f"{MONDAY}T12:30:00"


def test_travel_between_two_work_blocks_resets_the_break_counter(archive):
    working_week()
    studio = make_location("Studio", travel_minutes_from_home=15)
    location_hours(studio, "09:00", "17:00")
    task("t-home", "At home", est_minutes=70)
    task("t-studio", "At studio", est_minutes=70, required_location_id=studio)

    blocks = scheduling.plan(MONDAY)["blocks"]

    # 70 + 70 = 140 minutes, over the threshold combined -- but a trip
    # separates them, so neither run alone crosses it.
    assert "break" not in [b["kind"] for b in blocks]


def test_breaks_are_dropped_only_when_keeping_them_would_miss_a_deadline(archive):
    # The only working hours there are -- four hours, on the only day either
    # task's deadline allows.
    db.save_working_hours([{"weekday": 0, "opens": "09:00", "closes": "13:00"}])
    task("t-1", est_minutes=150, deadline=MONDAY)
    task("t-2", est_minutes=90, deadline=MONDAY)

    result = scheduling.plan(MONDAY)

    # With the break t-1 earns kept, t-2's 90 minutes don't fit in what's left
    # (60 of the remaining 90 minutes) -- so the break is dropped instead, and
    # the day says so.
    assert result["at_risk"] == []
    assert result["breaks_dropped"] == [MONDAY]
    assert "break" not in [b["kind"] for b in result["blocks"]]
    blocks = placed(result)
    assert blocks["t-1"]["end"] == blocks["t-2"]["start"] == f"{MONDAY}T11:30:00"
