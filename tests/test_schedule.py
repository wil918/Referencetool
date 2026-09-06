"""The schedule data layer: tasks, deliverables, locations, travel,
commitments and resources.

These cover the semantics that are easy to get wrong by "fixing" them: a task
outliving its project with project_id cleared rather than the row being
deleted, a dependency cycle being rejected before it's ever written, and the
derived task_actuals/scheduled_blocks rows going away with the task that
owned them.
"""
import uuid

import db


def make_project(client, title="A Project"):
    return client.post("/api/projects", json={"title": title}).get_json()["id"]


def make_task(client, title="A Task", **kwargs):
    body = {"title": title, **kwargs}
    resp = client.post("/api/tasks", json=body)
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()


# --- Dependency cycles -------------------------------------------------------


def test_a_task_cannot_depend_on_itself(client):
    a = make_task(client, "A")["id"]

    resp = client.post(f"/api/tasks/{a}/dependencies", json={"depends_on_task_id": a})

    assert resp.status_code == 400
    assert db.list_task_dependencies(a) == []


def test_a_dependency_cycle_is_rejected_and_names_the_tasks_involved(client):
    a = make_task(client, "A")["id"]
    b = make_task(client, "B")["id"]
    c = make_task(client, "C")["id"]

    # B depends on A, C depends on B -- a normal chain, both accepted.
    assert client.post(f"/api/tasks/{b}/dependencies", json={"depends_on_task_id": a}).status_code == 200
    assert client.post(f"/api/tasks/{c}/dependencies", json={"depends_on_task_id": b}).status_code == 200

    # Closing the loop -- A depending on C -- would make A transitively depend
    # on itself via C -> B -> A.
    resp = client.post(f"/api/tasks/{a}/dependencies", json={"depends_on_task_id": c})

    assert resp.status_code == 400
    body = resp.get_json()
    assert "A" in body["error"] and "B" in body["error"] and "C" in body["error"]
    # The rejected edge was never written.
    assert db.list_task_dependencies(a) == []


def test_a_dependency_on_a_task_that_does_not_exist_is_rejected(client):
    a = make_task(client, "A")["id"]

    resp = client.post(f"/api/tasks/{a}/dependencies", json={"depends_on_task_id": "nope"})

    assert resp.status_code == 400


def test_a_dependency_can_be_removed(client):
    a = make_task(client, "A")["id"]
    b = make_task(client, "B")["id"]
    client.post(f"/api/tasks/{b}/dependencies", json={"depends_on_task_id": a})

    resp = client.delete(f"/api/tasks/{b}/dependencies", json={"depends_on_task_id": a})

    assert resp.status_code == 200
    assert db.list_task_dependencies(b) == []


# --- A task outliving its project ---------------------------------------------


def test_a_task_survives_its_projects_deletion_with_a_null_project_id(client):
    project_id = make_project(client)
    task = make_task(client, "Task", project_id=project_id)
    assert task["project_id"] == project_id

    assert client.delete(f"/api/projects/{project_id}").status_code == 200

    survived = client.get(f"/api/tasks/{task['id']}").get_json()
    assert survived is not None
    assert survived["project_id"] is None


def test_a_task_without_a_project_is_accepted(client):
    task = make_task(client, "Errand")

    assert task["project_id"] is None
    assert client.get(f"/api/tasks/{task['id']}").status_code == 200


def test_deleting_a_project_nulls_deliverable_id_on_its_tasks(client):
    project_id = make_project(client)
    deliverable = client.post(
        f"/api/projects/{project_id}/deliverables", json={"title": "Final Collection"}
    ).get_json()
    task = make_task(client, "Task", project_id=project_id, deliverable_id=deliverable["id"])

    client.delete(f"/api/projects/{project_id}")

    survived = client.get(f"/api/tasks/{task['id']}").get_json()
    assert survived["deliverable_id"] is None
    assert survived["project_id"] is None


def test_deleting_a_deliverable_nulls_deliverable_id_on_its_tasks_but_keeps_them(client):
    project_id = make_project(client)
    deliverable = client.post(
        f"/api/projects/{project_id}/deliverables", json={"title": "Final Collection"}
    ).get_json()
    task = make_task(client, "Task", project_id=project_id, deliverable_id=deliverable["id"])

    assert client.delete(f"/api/deliverables/{deliverable['id']}").status_code == 200

    survived = client.get(f"/api/tasks/{task['id']}").get_json()
    assert survived["deliverable_id"] is None
    assert survived["project_id"] == project_id


# --- Deleting a task ----------------------------------------------------------


def test_deleting_a_task_removes_its_dependencies_actuals_and_blocks(client):
    a = make_task(client, "A")["id"]
    b = make_task(client, "B")["id"]
    client.post(f"/api/tasks/{b}/dependencies", json={"depends_on_task_id": a})

    db.save_task_actual(a, actual_minutes=25, notes="went fine")
    db.create_scheduled_block(str(uuid.uuid4()), a, "2026-01-01T09:00:00", "2026-01-01T09:30:00")

    assert db.get_task_actual(a) is not None
    assert db.list_scheduled_blocks_for_task(a) != []

    assert client.delete(f"/api/tasks/{a}").status_code == 200

    assert client.get(f"/api/tasks/{a}").status_code == 404
    assert db.get_task_actual(a) is None
    assert db.list_scheduled_blocks_for_task(a) == []
    # B's dependency pointed at a task that no longer exists -- gone too.
    assert db.list_task_dependencies(b) == []


# --- Source flags --------------------------------------------------------------


def test_source_flags_round_trip(client):
    task = make_task(
        client,
        "Task",
        est_minutes=45,
        est_minutes_source="user",
        importance=3,
        importance_source="generated",
        difficulty=2,
        difficulty_source="generated",
    )

    assert task["est_minutes_source"] == "user"
    assert task["importance_source"] == "generated"
    assert task["difficulty_source"] == "generated"

    fetched = client.get(f"/api/tasks/{task['id']}").get_json()
    assert fetched["est_minutes_source"] == "user"
    assert fetched["importance_source"] == "generated"
    assert fetched["difficulty_source"] == "generated"


# --- Status ----------------------------------------------------------------


def test_creating_a_task_rejects_an_unknown_status(client):
    resp = client.post("/api/tasks", json={"title": "Task", "status": "nonsense"})
    assert resp.status_code == 400


def test_updating_a_task_rejects_an_unknown_status(client):
    task = make_task(client, "Task")

    resp = client.put(f"/api/tasks/{task['id']}", json={"status": "nonsense"})

    assert resp.status_code == 400
    assert client.get(f"/api/tasks/{task['id']}").get_json()["status"] == "pending"


def test_a_task_can_move_through_every_real_status(client):
    task = make_task(client, "Task")
    for status in db.TASK_STATUSES:
        resp = client.put(f"/api/tasks/{task['id']}", json={"status": status})
        assert resp.status_code == 200
        assert resp.get_json()["status"] == status


def test_is_domestic_round_trips_through_the_api(client):
    created = client.post("/api/tasks", json={"title": "Laundry", "is_domestic": True}).get_json()
    assert created["is_domestic"] is True

    updated = client.put(f"/api/tasks/{created['id']}", json={"is_domestic": False}).get_json()
    assert updated["is_domestic"] is False

    default = make_task(client, "Ordinary")
    assert default["is_domestic"] is False


# --- Listing and filtering ------------------------------------------------


def test_listing_tasks_filters_by_project_and_status(client):
    project_id = make_project(client)
    in_project = make_task(client, "In project", project_id=project_id)
    make_task(client, "Elsewhere")
    client.put(f"/api/tasks/{in_project['id']}", json={"status": "done"})

    by_project = client.get(f"/api/tasks?project_id={project_id}").get_json()
    assert [t["id"] for t in by_project] == [in_project["id"]]

    by_status = client.get("/api/tasks?status=done").get_json()
    assert [t["id"] for t in by_status] == [in_project["id"]]

    resp = client.get("/api/tasks?status=nonsense")
    assert resp.status_code == 400


# --- Deliverables --------------------------------------------------------------


def test_deliverable_crud(client):
    project_id = make_project(client)

    created = client.post(
        f"/api/projects/{project_id}/deliverables",
        json={"title": "Final Collection", "weighting": 0.6, "spec": {"pages": 20}},
    ).get_json()
    assert created["project_id"] == project_id
    assert created["spec"] == {"pages": 20}

    listed = client.get(f"/api/projects/{project_id}/deliverables").get_json()
    assert [d["id"] for d in listed] == [created["id"]]

    updated = client.put(
        f"/api/deliverables/{created['id']}", json={"weighting": 0.8}
    ).get_json()
    assert updated["weighting"] == 0.8
    assert updated["title"] == "Final Collection"  # untouched fields survive

    assert client.delete(f"/api/deliverables/{created['id']}").status_code == 200
    assert client.get(f"/api/projects/{project_id}/deliverables").get_json() == []


def test_a_task_can_be_moved_between_deliverables_by_hand(client):
    """What the Deliverables tab and the task detail panel both do: PUT the
    task with a new deliverable_id, or null to unfile it."""
    project_id = make_project(client)
    part1 = client.post(
        f"/api/projects/{project_id}/deliverables", json={"title": "Part 1"}
    ).get_json()["id"]
    part2 = client.post(
        f"/api/projects/{project_id}/deliverables", json={"title": "Part 2"}
    ).get_json()["id"]
    task = make_task(client, "Toile", project_id=project_id, deliverable_id=part1)

    moved = client.put(
        f"/api/tasks/{task['id']}", json={"deliverable_id": part2}
    ).get_json()
    assert moved["deliverable_id"] == part2
    assert [t["id"] for t in client.get(f"/api/tasks?deliverable_id={part2}").get_json()] == [
        task["id"]
    ]

    unfiled = client.put(
        f"/api/tasks/{task['id']}", json={"deliverable_id": None}
    ).get_json()
    assert unfiled["deliverable_id"] is None


def test_deliverable_spec_round_trips_an_arbitrary_shape(client):
    """spec is rendered by shape, not by fixed keys -- so whatever a brief
    puts there must survive a write and come back intact, including the
    checklist tick state the readable view adds under its own key."""
    project_id = make_project(client)
    spec = {
        "pages": {"portfolio": 20, "report": 8},
        "required_items": ["Fabric test 1", "Fabric test 2", "Museum visit"],
        "__checked": ["required_items.0"],
    }
    created = client.post(
        f"/api/projects/{project_id}/deliverables",
        json={"title": "Realisation", "spec": spec},
    ).get_json()
    assert created["spec"] == spec

    updated = client.put(
        f"/api/deliverables/{created['id']}",
        json={"spec": {**spec, "__checked": ["required_items.0", "required_items.2"]}},
    ).get_json()
    assert updated["spec"]["__checked"] == ["required_items.0", "required_items.2"]
    assert updated["spec"]["pages"] == {"portfolio": 20, "report": 8}


# --- Locations, hours, overrides, travel ---------------------------------------


def test_location_crud_and_deletion_clears_required_location_on_tasks(client):
    location = client.post(
        "/api/locations", json={"name": "Studio", "travel_minutes_from_home": 15}
    ).get_json()
    task = make_task(client, "Sew", required_location_id=location["id"])

    assert client.get("/api/locations").get_json()[0]["id"] == location["id"]

    client.put(f"/api/locations/{location['id']}/hours", json={
        "hours": [{"weekday": 0, "opens": "09:00", "closes": "18:00"}]
    })
    hours = client.get(f"/api/locations/{location['id']}/hours").get_json()
    assert hours == [{"location_id": location["id"], "weekday": 0, "opens": "09:00", "closes": "18:00"}]

    override_resp = client.post(
        f"/api/locations/{location['id']}/overrides",
        json={"date": "2026-12-25", "closed": True},
    ).get_json()
    assert len(override_resp) == 1
    override_id = override_resp[0]["id"]
    assert client.get(f"/api/locations/{location['id']}/overrides").get_json() == override_resp
    remaining = client.delete(
        f"/api/locations/{location['id']}/overrides", json={"id": override_id}
    ).get_json()
    assert remaining == []

    assert client.delete(f"/api/locations/{location['id']}").status_code == 200
    survived = client.get(f"/api/tasks/{task['id']}").get_json()
    assert survived["required_location_id"] is None


def test_a_location_can_be_created_and_edited_with_a_parent_and_online_flag(client):
    campus = client.post("/api/locations", json={"name": "Harrow Campus"}).get_json()
    studio = client.post("/api/locations", json={
        "name": "Studio", "parent_location_id": campus["id"],
    }).get_json()
    assert studio["parent_location_id"] == campus["id"]
    assert studio["is_online"] is False

    resp = client.put(f"/api/locations/{studio['id']}", json={"is_online": True})
    assert resp.get_json()["is_online"] is True


def test_creating_a_location_rejects_an_unknown_parent(client):
    resp = client.post("/api/locations", json={"name": "Studio", "parent_location_id": "nonexistent"})
    assert resp.status_code == 400


def test_a_location_parent_update_rejects_a_cycle(client):
    campus = client.post("/api/locations", json={"name": "Harrow Campus"}).get_json()
    studio = client.post("/api/locations", json={
        "name": "Studio", "parent_location_id": campus["id"],
    }).get_json()

    # Campus is already an ancestor of Studio -- pointing Campus at Studio
    # would make Studio its own ancestor.
    resp = client.put(f"/api/locations/{campus['id']}", json={"parent_location_id": studio["id"]})

    assert resp.status_code == 400
    assert "cycle" in resp.get_json()["error"]
    # And the rejected edit never landed.
    still = next(l for l in client.get("/api/locations").get_json() if l["id"] == campus["id"])
    assert still["parent_location_id"] is None


def test_travel_matrix_round_trips_wholesale(client):
    a = client.post("/api/locations", json={"name": "A"}).get_json()
    b = client.post("/api/locations", json={"name": "B"}).get_json()

    resp = client.put("/api/travel", json={
        "travel": [{"from_location_id": a["id"], "to_location_id": b["id"], "minutes": 20}]
    })
    assert resp.status_code == 200
    assert client.get("/api/travel").get_json() == [
        {"from_location_id": a["id"], "to_location_id": b["id"], "minutes": 20}
    ]

    # A second PUT replaces the matrix rather than adding to it.
    client.put("/api/travel", json={"travel": []})
    assert client.get("/api/travel").get_json() == []


# --- Commitments -----------------------------------------------------------


def test_commitment_crud_and_support_level_validation(client):
    created = client.post("/api/commitments", json={
        "title": "Studio class",
        "start": "2026-01-05T09:00:00",
        "end": "2026-01-05T11:00:00",
        "support_level": "priority",
    }).get_json()
    assert created["support_level"] == "priority"
    # A plain event, not routed through Claude: home_first defaults off.
    assert created["home_first"] is False
    assert created["prep_minutes"] is None

    bad = client.post("/api/commitments", json={
        "title": "Bad", "start": "x", "end": "y", "support_level": "nonsense"
    })
    assert bad.status_code == 400

    updated = client.put(f"/api/commitments/{created['id']}", json={"support_level": "ambient"}).get_json()
    assert updated["support_level"] == "ambient"

    assert client.delete(f"/api/commitments/{created['id']}").status_code == 200
    assert client.get("/api/commitments").get_json() == []


def test_a_home_first_personal_event_round_trips_through_the_api(client):
    created = client.post("/api/commitments", json={
        "title": "Drinks out",
        "start": "2026-01-05T19:00:00",
        "end": "2026-01-05T21:00:00",
        "home_first": True,
        "prep_minutes": 30,
    }).get_json()
    assert created["home_first"] is True
    assert created["prep_minutes"] == 30

    updated = client.put(f"/api/commitments/{created['id']}", json={
        "home_first": False, "prep_minutes": None,
    }).get_json()
    assert updated["home_first"] is False
    assert updated["prep_minutes"] is None


def test_a_personal_events_venue_name_and_travel_time_round_trip_through_the_api(client):
    # Free text, not a locations foreign key -- see COMMITMENTS_SCHEMA. A
    # personal event never has to name a location already in the archive.
    created = client.post("/api/commitments", json={
        "title": "Haircut",
        "start": "2026-01-05T09:00:00",
        "end": "2026-01-05T09:45:00",
        "home_first": True,
        "location_name": "Corner barber's",
        "travel_minutes": 12,
    }).get_json()
    assert created["location_name"] == "Corner barber's"
    assert created["travel_minutes"] == 12
    assert created["location_id"] is None  # no match required

    updated = client.put(f"/api/commitments/{created['id']}", json={
        "travel_minutes": 20,
    }).get_json()
    assert updated["travel_minutes"] == 20
    assert updated["location_name"] == "Corner barber's"  # untouched by the partial update


# --- Working hours and daily capacity -----------------------------------------


def test_working_hours_round_trip_wholesale(client):
    resp = client.put("/api/working-hours", json={
        "hours": [{"weekday": 0, "opens": "09:00", "closes": "18:00"}]
    })
    assert resp.status_code == 200
    assert client.get("/api/working-hours").get_json() == [
        {"weekday": 0, "opens": "09:00", "closes": "18:00"}
    ]

    client.put("/api/working-hours", json={"hours": []})
    assert client.get("/api/working-hours").get_json() == []


def test_capacity_route_computes_available_minutes_from_working_hours_and_commitments(client):
    client.put("/api/working-hours", json={
        "hours": [{"weekday": 0, "opens": "09:00", "closes": "18:00"}]  # Monday
    })
    client.post("/api/commitments", json={
        "title": "Studio class", "start": "2026-01-05T10:00:00", "end": "2026-01-05T11:00:00",
    })

    resp = client.get("/api/capacity/2026-01-05")

    assert resp.status_code == 200
    body = resp.get_json()
    assert body["available_minutes"] == 9 * 60 - 60
    assert body["energy"] == body["inferred_energy"]


def test_capacity_route_rejects_a_malformed_date(client):
    assert client.get("/api/capacity/not-a-date").status_code == 400
    assert client.put("/api/capacity/not-a-date", json={"manual_energy": 4}).status_code == 400


def test_manual_energy_override_wins_and_survives_recompute(client):
    client.get("/api/capacity/2026-01-06")  # seed a row with inferred_energy

    resp = client.put("/api/capacity/2026-01-06", json={"manual_energy": 5})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["manual_energy"] == 5
    assert body["energy"] == 5

    # Recomputing (e.g. after a new commitment) must not clear the override.
    client.post("/api/commitments", json={
        "title": "Something new", "start": "2026-01-05T09:00:00", "end": "2026-01-05T10:00:00",
    })
    again = client.get("/api/capacity/2026-01-06").get_json()
    assert again["manual_energy"] == 5
    assert again["energy"] == 5


def test_manual_energy_override_can_be_cleared_back_to_inferred(client):
    client.put("/api/capacity/2026-01-06", json={"manual_energy": 5})

    cleared = client.put("/api/capacity/2026-01-06", json={"manual_energy": None}).get_json()

    assert cleared["manual_energy"] is None
    assert cleared["energy"] == cleared["inferred_energy"]


def test_capacity_override_route_requires_manual_energy_key(client):
    resp = client.put("/api/capacity/2026-01-06", json={})
    assert resp.status_code == 400


# --- Domestic hours and hours overrides -----------------------------------------
#
# Data and routes only -- session 9 builds the week/month UI that lets someone
# actually drag these. See scheduling.py's domestic_free_intervals and
# _band_window for the placement rules that read them.


def test_domestic_hours_round_trip_wholesale(client):
    resp = client.put("/api/domestic-hours", json={
        "hours": [{"weekday": 5, "opens": "10:00", "closes": "14:00"}]
    })
    assert resp.status_code == 200
    assert client.get("/api/domestic-hours").get_json() == [
        {"weekday": 5, "opens": "10:00", "closes": "14:00"}
    ]

    client.put("/api/domestic-hours", json={"hours": []})
    assert client.get("/api/domestic-hours").get_json() == []


def test_domestic_hours_are_independent_of_working_hours(client):
    client.put("/api/working-hours", json={
        "hours": [{"weekday": 0, "opens": "09:00", "closes": "17:00"}]
    })
    client.put("/api/domestic-hours", json={
        "hours": [{"weekday": 0, "opens": "18:00", "closes": "20:00"}]
    })

    assert client.get("/api/working-hours").get_json() == [
        {"weekday": 0, "opens": "09:00", "closes": "17:00"}
    ]
    assert client.get("/api/domestic-hours").get_json() == [
        {"weekday": 0, "opens": "18:00", "closes": "20:00"}
    ]


def test_hours_overrides_crud_and_band_validation(client):
    bad_band = client.post("/api/hours-overrides", json={
        "date": "2026-01-05", "band": "nonsense",
    })
    assert bad_band.status_code == 400

    bad_date = client.post("/api/hours-overrides", json={
        "date": "not-a-date", "band": "working",
    })
    assert bad_date.status_code == 400

    created = client.post("/api/hours-overrides", json={
        "date": "2026-01-05", "band": "domestic", "opens": "08:00", "closes": "10:00",
    }).get_json()
    assert created["band"] == "domestic"
    assert created["off"] is False

    all_overrides = client.get("/api/hours-overrides").get_json()
    assert [o["id"] for o in all_overrides] == [created["id"]]

    by_band = client.get("/api/hours-overrides?band=working").get_json()
    assert by_band == []

    assert client.get("/api/hours-overrides?band=nonsense").status_code == 400

    assert client.delete(f"/api/hours-overrides/{created['id']}").status_code == 200
    assert client.get("/api/hours-overrides").get_json() == []


def test_an_off_hours_override_shuts_the_band_for_that_date(client):
    resp = client.post("/api/hours-overrides", json={
        "date": "2026-01-05", "band": "working", "off": True,
    }).get_json()
    assert resp["off"] is True


# --- Schedule settings (sleep target, morning routine, bedtime notifications) ---


def test_schedule_settings_default_before_anything_is_saved(client):
    resp = client.get("/api/schedule-settings").get_json()
    assert resp == {
        "sleep_target_minutes": 8 * 60,
        "morning_routine_minutes": 30,
        "bedtime_notifications_enabled": False,
        "default_location_umbrella_id": None,
        "cohort_group": None,
    }


def test_schedule_settings_round_trip(client):
    resp = client.put("/api/schedule-settings", json={
        "sleep_target_minutes": 420,
        "morning_routine_minutes": 45,
        "bedtime_notifications_enabled": True,
    })
    assert resp.status_code == 200
    assert resp.get_json() == {
        "sleep_target_minutes": 420,
        "morning_routine_minutes": 45,
        "bedtime_notifications_enabled": True,
        "default_location_umbrella_id": None,
        "cohort_group": None,
    }
    assert client.get("/api/schedule-settings").get_json()["sleep_target_minutes"] == 420


def test_schedule_settings_partial_update_keeps_the_rest(client):
    client.put("/api/schedule-settings", json={
        "sleep_target_minutes": 420, "morning_routine_minutes": 45, "bedtime_notifications_enabled": True,
    })
    resp = client.put("/api/schedule-settings", json={"morning_routine_minutes": 20}).get_json()
    assert resp == {
        "sleep_target_minutes": 420,
        "morning_routine_minutes": 20,
        "bedtime_notifications_enabled": True,
        "default_location_umbrella_id": None,
        "cohort_group": None,
    }


def test_schedule_settings_can_set_the_default_location_umbrella(client):
    campus = client.post("/api/locations", json={"name": "Harrow Campus"}).get_json()

    resp = client.put("/api/schedule-settings", json={"default_location_umbrella_id": campus["id"]})

    assert resp.get_json()["default_location_umbrella_id"] == campus["id"]
    # A later partial update that doesn't mention it leaves it in place.
    resp2 = client.put("/api/schedule-settings", json={"morning_routine_minutes": 20})
    assert resp2.get_json()["default_location_umbrella_id"] == campus["id"]


def test_schedule_settings_rejects_an_unknown_default_location_umbrella(client):
    resp = client.put("/api/schedule-settings", json={"default_location_umbrella_id": "nonexistent"})
    assert resp.status_code == 400


def test_schedule_settings_rejects_a_non_positive_sleep_target(client):
    resp = client.put("/api/schedule-settings", json={"sleep_target_minutes": 0})
    assert resp.status_code == 400


def test_schedule_settings_rejects_a_negative_morning_routine(client):
    resp = client.put("/api/schedule-settings", json={"morning_routine_minutes": -5})
    assert resp.status_code == 400


# --- Suggested bedtime --------------------------------------------------------


def test_bedtimes_route_rejects_a_missing_or_malformed_range(client):
    assert client.get("/api/schedule/bedtimes").status_code == 400
    assert client.get("/api/schedule/bedtimes?start=2026-01-05&end=nonsense").status_code == 400


def test_bedtimes_route_derives_from_tomorrows_first_commitment(client):
    client.put("/api/schedule-settings", json={
        "sleep_target_minutes": 480, "morning_routine_minutes": 30,
    })
    client.post("/api/commitments", json={
        "title": "9am lecture", "start": "2026-01-06T09:00:00", "end": "2026-01-06T10:00:00",
    })

    resp = client.get("/api/schedule/bedtimes?start=2026-01-05&end=2026-01-05")

    assert resp.status_code == 200
    markers = resp.get_json()
    assert len(markers) == 1
    assert markers[0]["evening_date"] == "2026-01-05"
    assert markers[0]["first_thing_start"] == "2026-01-06T09:00:00"
    # 09:00 - 0 travel - 30 min routine - 8h sleep = 00:30 the same calendar day.
    assert markers[0]["bedtime"] == "2026-01-06T00:30:00"


def test_bedtimes_route_omits_evenings_with_nothing_the_next_day(client):
    resp = client.get("/api/schedule/bedtimes?start=2026-02-01&end=2026-02-01")
    assert resp.get_json() == []


# --- Task field generation ---------------------------------------------------
#
# task_ai.generate_task_fields itself is stubbed for every test (conftest.py),
# same as tagging.tag_image/tag_text/tag_pdf -- these exercise the route, not
# the prompt.


def test_generate_task_fields_requires_a_description(client):
    resp = client.post("/api/tasks/generate", json={"description": ""})
    assert resp.status_code == 400


def test_generate_task_fields_returns_the_stubbed_suggestion(client):
    resp = client.post("/api/tasks/generate", json={"description": "Sew the toile"})
    assert resp.status_code == 200
    assert resp.get_json() == {
        "title": "Generated Title",
        "est_minutes": 30,
        "importance": 3,
        "difficulty": 2,
        "measurable_goal": "Generated goal",
    }


def test_generate_task_fields_surfaces_a_failure_as_a_500(client, monkeypatch):
    import task_ai

    def boom(description):
        raise RuntimeError("no API key")

    monkeypatch.setattr(task_ai, "generate_task_fields", boom)

    resp = client.post("/api/tasks/generate", json={"description": "Sew the toile"})

    assert resp.status_code == 500
    assert "no API key" in resp.get_json()["error"]


# --- Task completion -----------------------------------------------------------


def test_getting_the_actual_for_a_task_not_yet_done_is_none_not_404(client):
    task = make_task(client, "Task")

    resp = client.get(f"/api/tasks/{task['id']}/actual")

    assert resp.status_code == 200
    assert resp.get_json() is None


def test_getting_the_actual_for_a_task_that_does_not_exist_404s(client):
    resp = client.get("/api/tasks/nonexistent/actual")
    assert resp.status_code == 404


def test_getting_the_actual_after_completion_returns_the_recorded_values(client):
    task = make_task(client, "Task", est_minutes=40, importance=4, difficulty=3)
    client.post(f"/api/tasks/{task['id']}/complete")

    resp = client.get(f"/api/tasks/{task['id']}/actual")

    assert resp.status_code == 200
    body = resp.get_json()
    assert body["actual_minutes"] == 40
    assert body["actual_difficulty"] == 3
    assert body["actual_importance"] == 4


def test_completing_an_unscheduled_task_defaults_actuals_to_its_own_estimate(client):
    task = make_task(client, "Task", est_minutes=40, importance=4, difficulty=3)

    resp = client.post(f"/api/tasks/{task['id']}/complete")

    assert resp.status_code == 200
    body = resp.get_json()
    assert body["task"]["status"] == "done"
    assert body["actual"]["actual_minutes"] == 40
    assert body["actual"]["actual_difficulty"] == 3
    assert body["actual"]["actual_importance"] == 4


def test_completing_a_scheduled_task_defaults_actual_minutes_to_the_blocks_length(client):
    task = make_task(client, "Task", est_minutes=999)
    db.create_scheduled_block(
        str(uuid.uuid4()), task["id"], "2026-01-01T09:00:00", "2026-01-01T09:25:00"
    )

    resp = client.post(f"/api/tasks/{task['id']}/complete")

    assert resp.get_json()["actual"]["actual_minutes"] == 25


def test_completing_a_task_ignores_travel_blocks_when_defaulting_actual_minutes(client):
    task = make_task(client, "Task", est_minutes=999)
    db.create_scheduled_block(
        str(uuid.uuid4()), task["id"], "2026-01-01T08:45:00", "2026-01-01T09:00:00", kind="travel"
    )
    db.create_scheduled_block(
        str(uuid.uuid4()), task["id"], "2026-01-01T09:00:00", "2026-01-01T09:20:00", kind="task"
    )

    resp = client.post(f"/api/tasks/{task['id']}/complete")

    assert resp.get_json()["actual"]["actual_minutes"] == 20


def test_one_tap_completion_needs_no_body_at_all(client):
    task = make_task(client, "Task")

    resp = client.post(f"/api/tasks/{task['id']}/complete", json=None)

    assert resp.status_code == 200
    assert resp.get_json()["task"]["status"] == "done"


def test_completing_a_task_that_does_not_exist_404s(client):
    resp = client.post("/api/tasks/nonexistent/complete")
    assert resp.status_code == 404


def test_correcting_one_actual_after_completion_keeps_the_others(client):
    task = make_task(client, "Task", est_minutes=40, importance=4, difficulty=3)
    client.post(f"/api/tasks/{task['id']}/complete")

    resp = client.post(f"/api/tasks/{task['id']}/complete", json={"actual_minutes": 55})

    body = resp.get_json()["actual"]
    assert body["actual_minutes"] == 55
    # Not sent this time -- must keep what the first tap already recorded,
    # not fall back to the task's own difficulty/importance again.
    assert body["actual_difficulty"] == 3
    assert body["actual_importance"] == 4


def test_completing_a_task_can_record_notes(client):
    task = make_task(client, "Task")

    resp = client.post(f"/api/tasks/{task['id']}/complete", json={"notes": "went well"})

    assert resp.get_json()["actual"]["notes"] == "went well"


# --- The other two outcomes: partial and not completed --------------------------


def test_a_partial_outcome_closes_the_original_and_spawns_a_remainder(client):
    project_id = make_project(client)
    location_id = client.post("/api/locations", json={"name": "Studio"}).get_json()["id"]
    task = make_task(
        client, "Make the toile", description="First pass in calico",
        measurable_goal="Toile pinned to the mannequin", deadline="2026-06-01",
        project_id=project_id, required_location_id=location_id, support_level="needs",
        importance=4, difficulty=3, is_finishing=True, is_domestic=False, est_minutes=180,
    )

    resp = client.post(f"/api/tasks/{task['id']}/partial", json={
        "actual_minutes": 120, "est_minutes": 90,
    })

    assert resp.status_code == 200
    body = resp.get_json()
    original, remainder = body["original"], body["remainder"]

    assert original["status"] == "partial"
    actual = client.get(f"/api/tasks/{task['id']}/actual").get_json()
    assert actual["actual_minutes"] == 120

    assert remainder["status"] == "pending"
    assert remainder["continues_task_id"] == task["id"]
    # A fresh estimate for what remains -- never the original's.
    assert remainder["est_minutes"] == 90
    # Everything else inherited, editable but untouched here.
    for field in ("title", "description", "measurable_goal", "deadline", "project_id",
                  "required_location_id", "support_level", "importance", "difficulty",
                  "is_finishing", "is_domestic"):
        assert remainder[field] == original[field], field


def test_a_partial_outcome_lets_the_caller_override_an_inherited_field(client):
    task = make_task(client, "Cut the pattern", difficulty=2)

    resp = client.post(f"/api/tasks/{task['id']}/partial", json={
        "actual_minutes": 30, "est_minutes": 30, "title": "Finish cutting the pattern",
        "difficulty": 4,
    })

    remainder = resp.get_json()["remainder"]
    assert remainder["title"] == "Finish cutting the pattern"
    assert remainder["difficulty"] == 4


def test_a_partial_outcome_repoints_dependents_to_the_remainder(client):
    a = make_task(client, "A")
    b = make_task(client, "B")
    client.post(f"/api/tasks/{b['id']}/dependencies", json={"depends_on_task_id": a["id"]})

    resp = client.post(f"/api/tasks/{a['id']}/partial", json={
        "actual_minutes": 30, "est_minutes": 30,
    })
    remainder_id = resp.get_json()["remainder"]["id"]

    deps = client.get(f"/api/tasks/{b['id']}").get_json()
    # There's no GET for a single task's dependencies as a list in the API
    # beyond the task dict itself not carrying them -- read the edge table
    # directly, the same way the scheduler does.
    assert db.list_task_dependencies(b["id"]) == [remainder_id]
    assert a["id"] not in db.list_task_dependencies(b["id"])


def test_a_partial_outcome_requires_a_positive_est_minutes(client):
    task = make_task(client, "Task")

    resp = client.post(f"/api/tasks/{task['id']}/partial", json={"actual_minutes": 30})
    assert resp.status_code == 400

    resp = client.post(f"/api/tasks/{task['id']}/partial", json={
        "actual_minutes": 30, "est_minutes": 0,
    })
    assert resp.status_code == 400


def test_a_partial_outcome_on_a_task_that_does_not_exist_404s(client):
    resp = client.post("/api/tasks/nonexistent/partial", json={
        "actual_minutes": 30, "est_minutes": 30,
    })
    assert resp.status_code == 404


def test_a_not_completed_outcome_returns_the_task_to_the_pool_and_increments_slip_count(client):
    task = make_task(client, "Task")
    assert task["slip_count"] == 0

    resp = client.post(f"/api/tasks/{task['id']}/not-completed")

    assert resp.status_code == 200
    body = resp.get_json()
    assert body["status"] == "pending"
    assert body["slip_count"] == 1

    # Slips again -- the count keeps climbing rather than resetting.
    again = client.post(f"/api/tasks/{task['id']}/not-completed").get_json()
    assert again["slip_count"] == 2


def test_a_not_completed_outcome_writes_no_actual(client):
    task = make_task(client, "Task", est_minutes=60)

    client.post(f"/api/tasks/{task['id']}/not-completed")

    assert client.get(f"/api/tasks/{task['id']}/actual").get_json() is None


def test_a_not_completed_outcome_deletes_the_tasks_scheduled_blocks(client):
    task = make_task(client, "Task")
    db.create_scheduled_block(str(uuid.uuid4()), task["id"], "2026-01-01T09:00:00", "2026-01-01T10:00:00")

    client.post(f"/api/tasks/{task['id']}/not-completed")

    assert db.list_scheduled_blocks_for_task(task["id"]) == []


def test_a_not_completed_outcome_on_a_task_that_does_not_exist_404s(client):
    resp = client.post("/api/tasks/nonexistent/not-completed")
    assert resp.status_code == 404


# --- Pinning a scheduled block --------------------------------------------------


def test_locking_and_unlocking_a_block_round_trips(client):
    task = make_task(client, "Task")
    block_id = str(uuid.uuid4())
    db.create_scheduled_block(block_id, task["id"], "2026-01-01T09:00:00", "2026-01-01T10:00:00")

    locked = client.put(f"/api/schedule/blocks/{block_id}/lock", json={"is_locked": True}).get_json()
    assert locked["is_locked"] is True

    unlocked = client.put(f"/api/schedule/blocks/{block_id}/lock", json={"is_locked": False}).get_json()
    assert unlocked["is_locked"] is False


def test_locking_a_day_granularity_block_is_rejected(client):
    task = make_task(client, "Task")
    block_id = str(uuid.uuid4())
    db.create_scheduled_block(block_id, task["id"], "2026-03-15", "2026-03-15")

    resp = client.put(f"/api/schedule/blocks/{block_id}/lock", json={"is_locked": True})

    assert resp.status_code == 400
    assert db.get_scheduled_block(block_id)["is_locked"] is False


def test_locking_a_travel_block_is_rejected(client):
    task = make_task(client, "Task")
    block_id = str(uuid.uuid4())
    db.create_scheduled_block(
        block_id, task["id"], "2026-01-01T08:45:00", "2026-01-01T09:00:00", kind="travel"
    )

    resp = client.put(f"/api/schedule/blocks/{block_id}/lock", json={"is_locked": True})
    assert resp.status_code == 400


def test_locking_requires_is_locked_in_the_body(client):
    task = make_task(client, "Task")
    block_id = str(uuid.uuid4())
    db.create_scheduled_block(block_id, task["id"], "2026-01-01T09:00:00", "2026-01-01T10:00:00")

    resp = client.put(f"/api/schedule/blocks/{block_id}/lock", json={})
    assert resp.status_code == 400


def test_locking_a_block_that_does_not_exist_404s(client):
    resp = client.put("/api/schedule/blocks/nonexistent/lock", json={"is_locked": True})
    assert resp.status_code == 404


# --- Moving (dragging) a scheduled block ----------------------------------------


def test_moving_a_block_repositions_it_and_locks_it(client):
    task = make_task(client, "Task")
    block_id = str(uuid.uuid4())
    db.create_scheduled_block(block_id, task["id"], "2026-01-01T09:00:00", "2026-01-01T10:00:00")

    resp = client.put(f"/api/schedule/blocks/{block_id}/move", json={"start": "2026-01-02T14:00:00"})

    assert resp.status_code == 200
    moved = resp.get_json()
    assert moved["start"] == "2026-01-02T14:00:00"
    # The original 1-hour length carries over rather than being reset.
    assert moved["end"] == "2026-01-02T15:00:00"
    assert moved["is_locked"] is True


def test_moving_a_day_granularity_block_is_rejected(client):
    task = make_task(client, "Task")
    block_id = str(uuid.uuid4())
    db.create_scheduled_block(block_id, task["id"], "2026-03-15", "2026-03-15")

    resp = client.put(f"/api/schedule/blocks/{block_id}/move", json={"start": "2026-03-16T09:00:00"})

    assert resp.status_code == 400
    assert db.get_scheduled_block(block_id)["start"] == "2026-03-15"


def test_moving_a_travel_block_is_rejected(client):
    task = make_task(client, "Task")
    block_id = str(uuid.uuid4())
    db.create_scheduled_block(
        block_id, task["id"], "2026-01-01T08:45:00", "2026-01-01T09:00:00", kind="travel"
    )

    resp = client.put(f"/api/schedule/blocks/{block_id}/move", json={"start": "2026-01-01T10:00:00"})
    assert resp.status_code == 400


def test_moving_a_block_requires_start_in_the_body(client):
    task = make_task(client, "Task")
    block_id = str(uuid.uuid4())
    db.create_scheduled_block(block_id, task["id"], "2026-01-01T09:00:00", "2026-01-01T10:00:00")

    resp = client.put(f"/api/schedule/blocks/{block_id}/move", json={})
    assert resp.status_code == 400


def test_moving_a_block_rejects_a_malformed_start(client):
    task = make_task(client, "Task")
    block_id = str(uuid.uuid4())
    db.create_scheduled_block(block_id, task["id"], "2026-01-01T09:00:00", "2026-01-01T10:00:00")

    resp = client.put(f"/api/schedule/blocks/{block_id}/move", json={"start": "not-a-datetime"})
    assert resp.status_code == 400


def test_moving_a_block_that_does_not_exist_404s(client):
    resp = client.put("/api/schedule/blocks/nonexistent/move", json={"start": "2026-01-01T09:00:00"})
    assert resp.status_code == 404


# --- Resources and resource items -----------------------------------------------


def test_resource_crud_and_items(client):
    resource = client.post("/api/resources", json={"name": "Fabric Supplier", "url": "https://example.com"}).get_json()

    items = client.post(f"/api/resources/{resource['id']}/items", json={
        "item": "Wool twill", "tags": ["texture", "winter"]
    }).get_json()
    assert items == [{"resource_id": resource["id"], "item": "Wool twill", "tags": ["texture", "winter"]}]

    remaining = client.delete(
        f"/api/resources/{resource['id']}/items", json={"item": "Wool twill"}
    ).get_json()
    assert remaining == []

    assert client.delete(f"/api/resources/{resource['id']}").status_code == 200
    assert client.get("/api/resources").get_json() == []
