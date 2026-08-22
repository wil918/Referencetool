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

    bad = client.post("/api/commitments", json={
        "title": "Bad", "start": "x", "end": "y", "support_level": "nonsense"
    })
    assert bad.status_code == 400

    updated = client.put(f"/api/commitments/{created['id']}", json={"support_level": "ambient"}).get_json()
    assert updated["support_level"] == "ambient"

    assert client.delete(f"/api/commitments/{created['id']}").status_code == 200
    assert client.get("/api/commitments").get_json() == []


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
