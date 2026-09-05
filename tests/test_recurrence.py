"""Floating, interval-based recurrence (scheduling.spawn_recurrence_successor
and generate_recurring_tasks).

The cadence is measured from when an instance was COMPLETED, not when it was
scheduled; a missed instance never stacks a second; pausing a rule stops
generation; and the window is tolerance, not a pin.
"""
import uuid
from datetime import date

import db
import scheduling


def make_rule(interval_days=3, window_days=1, active=True):
    rule_id = str(uuid.uuid4())
    db.create_recurrence_rule(rule_id, interval_days, window_days=window_days, active=active)
    return rule_id


def make_instance(rule_id, title="Water the samples", **fields):
    task_id = str(uuid.uuid4())
    db.create_task(task_id, title, recurrence_id=rule_id, **fields)
    return task_id


def live_instances(rule_id):
    return [t for t in db.list_tasks_for_recurrence(rule_id)
            if t["status"] in scheduling.SCHEDULABLE_STATUSES]


def test_completing_an_instance_spawns_exactly_one_successor(archive):
    rule = make_rule(interval_days=3)
    first = make_instance(rule, est_minutes=20, importance=2)

    result = scheduling.resolve_completed(first, actual_minutes=15, now="2026-03-02T10:00:00")

    successor = result["recurrence_successor"]
    assert successor is not None
    assert successor["recurrence_id"] == rule
    assert successor["title"] == "Water the samples"
    assert successor["est_minutes"] == 20  # a recurring chore's estimate is stable
    assert len(live_instances(rule)) == 1


def test_the_successor_is_due_an_interval_after_completion_plus_the_window(archive):
    rule = make_rule(interval_days=3, window_days=2)
    first = make_instance(rule)

    result = scheduling.resolve_completed(first, actual_minutes=10, now="2026-03-02T09:00:00")

    # ideal date = 2 March + 3 days = 5 March; deadline sits at the far edge
    # of the tolerance window, 5 + 2 = 7 March, giving the scheduler slack.
    assert result["recurrence_successor"]["deadline"] == "2026-03-07"


def test_completing_late_shifts_the_next_instance(archive):
    rule = make_rule(interval_days=7, window_days=1)
    first = make_instance(rule)

    # Due around 9 March, but not done until the 13th -- four days late.
    result = scheduling.resolve_completed(first, actual_minutes=30, now="2026-03-13T18:00:00")

    # Next ideal date is 13 + 7 = 20 March, not 9 + 7 = 16: the slip carries
    # forward rather than the cadence snapping back to the original grid.
    assert result["recurrence_successor"]["deadline"] == "2026-03-21"


def test_a_missed_instance_does_not_accumulate(archive):
    rule = make_rule(interval_days=2)
    first = make_instance(rule)

    # Completed weeks late: many intervals have elapsed.
    scheduling.resolve_completed(first, actual_minutes=10, now="2026-04-01T12:00:00")

    # Still just one outstanding instance, not one per missed interval.
    assert len(live_instances(rule)) == 1


def test_pausing_a_rule_stops_generation_but_keeps_history(archive):
    rule = make_rule(interval_days=3)
    first = make_instance(rule)
    db.update_recurrence_rule(rule, active=False)

    result = scheduling.resolve_completed(first, actual_minutes=10, now="2026-03-02T10:00:00")

    assert result["recurrence_successor"] is None
    assert live_instances(rule) == []
    # The completed instance is untouched.
    done = db.get_task(first)
    assert done["status"] == "done"
    assert db.get_task_actual(first)["actual_minutes"] == 10


def test_resuming_a_paused_rule_regenerates_on_the_next_replan(archive):
    rule = make_rule(interval_days=3, window_days=1)
    first = make_instance(rule)
    db.update_recurrence_rule(rule, active=False)
    scheduling.resolve_completed(first, actual_minutes=10, now="2026-03-02T10:00:00")

    db.update_recurrence_rule(rule, active=True)
    # Well past the ideal date (5 March) now.
    spawned = scheduling.generate_recurring_tasks(now="2026-03-20T09:00:00")

    assert len(spawned) == 1
    successor = db.get_task(spawned[0])
    assert successor["recurrence_id"] == rule
    # Cadence still measured from the real completion, 2 March.
    assert successor["deadline"] == "2026-03-06"


def test_the_backstop_does_not_spawn_before_the_window_opens(archive):
    rule = make_rule(interval_days=10, window_days=1)
    first = make_instance(rule)
    scheduling.resolve_completed(first, actual_minutes=10, now="2026-03-02T10:00:00")
    # resolve_completed already made the successor; drop it to isolate the
    # backstop, leaving only completed history behind.
    for t in live_instances(rule):
        db.delete_task(t["id"])

    # Ideal date is 12 March, window opens 11 March. Ask on the 5th.
    assert scheduling.generate_recurring_tasks(now="2026-03-05T09:00:00") == []
    # Ask again once inside the window.
    assert len(scheduling.generate_recurring_tasks(now="2026-03-11T09:00:00")) == 1


def test_the_backstop_leaves_a_rule_with_a_live_instance_alone(archive):
    rule = make_rule(interval_days=3)
    make_instance(rule)  # pending, never completed

    assert scheduling.generate_recurring_tasks(now="2026-06-01T09:00:00") == []


def test_a_brand_new_rule_with_no_history_is_not_conjured_into_a_task(archive):
    rule = make_rule(interval_days=3)

    assert scheduling.generate_recurring_tasks(now="2026-06-01T09:00:00") == []
    assert db.list_tasks_for_recurrence(rule) == []


def test_editing_a_rule_only_affects_instances_spawned_after(archive):
    rule = make_rule(interval_days=3, window_days=1)
    first = make_instance(rule)
    r1 = scheduling.resolve_completed(first, actual_minutes=10, now="2026-03-02T10:00:00")
    assert r1["recurrence_successor"]["deadline"] == "2026-03-06"

    db.update_recurrence_rule(rule, interval_days=7)
    second = r1["recurrence_successor"]["id"]
    r2 = scheduling.resolve_completed(second, actual_minutes=10, now="2026-03-06T10:00:00")

    # New interval applies to the next one; the first successor's deadline,
    # already set, is not retroactively moved.
    assert r2["recurrence_successor"]["deadline"] == "2026-03-14"
    assert db.get_task(second)["deadline"] == "2026-03-06"


def test_correcting_an_actual_does_not_spawn_a_second_successor(archive):
    rule = make_rule(interval_days=3)
    first = make_instance(rule)
    scheduling.resolve_completed(first, actual_minutes=10, now="2026-03-02T10:00:00")

    again = scheduling.resolve_completed(first, actual_minutes=25, now="2026-03-02T10:00:00")

    assert again["recurrence_successor"] is None
    assert len(live_instances(rule)) == 1


def test_a_partial_outcome_carries_the_recurrence_onto_the_remainder(archive):
    rule = make_rule(interval_days=3)
    first = make_instance(rule, est_minutes=60)

    result = scheduling.resolve_partial(first, actual_minutes=20, est_minutes=40)
    remainder = result["remainder"]
    assert remainder["recurrence_id"] == rule

    # Finishing the remainder is what completes the instance and ticks the rule.
    done = scheduling.resolve_completed(remainder["id"], actual_minutes=40,
                                       now="2026-03-04T10:00:00")
    assert done["recurrence_successor"] is not None
    assert done["recurrence_successor"]["deadline"] == "2026-03-08"


def test_recurrence_rule_routes_round_trip(client):
    made = client.post("/api/recurrence-rules", json={"interval_days": 4}).get_json()
    assert made["interval_days"] == 4
    assert made["window_days"] == 1
    assert made["active"] is True

    client.put(f"/api/recurrence-rules/{made['id']}", json={"window_days": 3, "active": False})
    fetched = client.get(f"/api/recurrence-rules/{made['id']}").get_json()
    assert fetched["window_days"] == 3
    assert fetched["active"] is False

    assert client.get("/api/recurrence-rules?active_only=1").get_json() == []

    client.delete(f"/api/recurrence-rules/{made['id']}")
    assert client.get(f"/api/recurrence-rules/{made['id']}").status_code == 404


def test_recurrence_rule_creation_rejects_a_bad_interval(client):
    assert client.post("/api/recurrence-rules", json={}).status_code == 400
    assert client.post("/api/recurrence-rules", json={"interval_days": 0}).status_code == 400
    assert client.post(
        "/api/recurrence-rules", json={"interval_days": 3, "window_days": -1}
    ).status_code == 400
