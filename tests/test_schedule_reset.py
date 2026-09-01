"""Resetting the schedule to empty, for clearing out test data.

The schedule shares one SQLite file with the reference archive, so the thing
these tests really guard is the boundary: a reset empties the task/plan tables
(and, opt-in, some configuration), and touches nothing that belongs to the
archive -- references, projects, canvas, colour analysis and the rest.
"""
import uuid

import db
import embeddings


# --- Seeding ----------------------------------------------------------------


def _seed_task_and_plan_data():
    """One row in every table db.reset_schedule always clears."""
    project_id = str(uuid.uuid4())
    db.create_project(project_id, "A Project")

    deliverable_id = str(uuid.uuid4())
    db.create_deliverable(deliverable_id, project_id, "A Deliverable")

    a = str(uuid.uuid4())
    b = str(uuid.uuid4())
    db.create_task(a, "A", project_id=project_id, deliverable_id=deliverable_id)
    db.create_task(b, "B")
    db.add_task_dependency(b, a)
    db.save_task_actual(a, actual_minutes=30)
    db.create_scheduled_block(str(uuid.uuid4()), a, "2026-01-01T09:00:00", "2026-01-01T09:30:00")

    db.create_commitment(str(uuid.uuid4()), "A Class", "2026-01-02T10:00:00", "2026-01-02T12:00:00")
    db.create_recurrence_rule(str(uuid.uuid4()), interval_days=3)
    db.save_daily_capacity("2026-01-02", manual_energy=4)
    db.create_hours_override(str(uuid.uuid4()), "2026-01-02", "working", off=True)

    return project_id


def _seed_optional_config():
    """One row in every table only cleared when a flag asks for it."""
    location_id = str(uuid.uuid4())
    db.create_location(location_id, "Studio", travel_minutes_from_home=15)
    db.save_location_hours(location_id, [{"weekday": 0, "opens": "09:00", "closes": "17:00"}])
    db.create_location_override(str(uuid.uuid4()), location_id, "2026-01-02", closed=True)
    other = str(uuid.uuid4())
    db.create_location(other, "Library")
    db.save_travel([{"from_location_id": location_id, "to_location_id": other, "minutes": 20}])

    db.save_working_hours([{"weekday": 0, "opens": "09:00", "closes": "17:00"}])
    db.save_domestic_hours([{"weekday": 6, "opens": "10:00", "closes": "12:00"}])

    project_id = str(uuid.uuid4())
    db.create_project(project_id, "Brief Owner")
    resource_id = str(uuid.uuid4())
    db.create_resource(resource_id, "Fabric Supplier")
    db.add_resource_item(resource_id, "Wool twill", tags=["texture"])
    db.create_brief(str(uuid.uuid4()), project_id, extracted={"tasks": []})


class FakeTaskCollection:
    """Just enough of a Chroma collection for embeddings.clear_task_collection:
    it reads ids with get(include=[]) and drops them with delete(ids=...)."""

    def __init__(self, ids):
        self.ids = list(ids)

    def get(self, include=None):
        return {"ids": list(self.ids)}

    def delete(self, ids):
        self.ids = [i for i in self.ids if i not in ids]


# --- db.reset_schedule -----------------------------------------------------------


def test_reset_clears_task_and_plan_data_and_reports_per_table_counts(archive):
    _seed_task_and_plan_data()

    deleted = db.reset_schedule()

    assert set(deleted) == set(db.SCHEDULE_DATA_TABLES)
    assert deleted["tasks"] == 2
    assert deleted["task_dependencies"] == 1
    assert deleted["task_actuals"] == 1
    assert deleted["scheduled_blocks"] == 1
    assert deleted["commitments"] == 1
    assert deleted["deliverables"] == 1
    assert deleted["recurrence_rules"] == 1
    assert deleted["daily_capacity"] == 1
    assert deleted["hours_overrides"] == 1

    assert db.list_tasks() == []
    assert db.list_commitments() == []
    assert db.list_recurrence_rules() == []
    assert db.list_hours_overrides() == []


def test_reset_leaves_optional_configuration_alone_by_default(archive):
    _seed_optional_config()

    deleted = db.reset_schedule()

    # None of the optional tables appear in the report, and their rows survive.
    for table in db.SCHEDULE_LOCATION_TABLES + db.SCHEDULE_HOURS_TABLES + db.SCHEDULE_RESOURCE_TABLES:
        assert table not in deleted
    assert len(db.list_locations()) == 2
    assert db.get_working_hours() != []
    assert db.get_domestic_hours() != []
    assert db.list_resources() != []


def test_reset_flags_each_clear_their_own_group(archive):
    _seed_optional_config()

    deleted = db.reset_schedule(clear_locations=True, clear_hours=True, clear_resources=True)

    assert set(deleted) == set(
        db.SCHEDULE_DATA_TABLES
        + db.SCHEDULE_LOCATION_TABLES
        + db.SCHEDULE_HOURS_TABLES
        + db.SCHEDULE_RESOURCE_TABLES
    )
    assert db.list_locations() == []
    assert db.list_travel() == []
    assert db.get_working_hours() == []
    assert db.get_domestic_hours() == []
    assert db.list_resources() == []
    assert deleted["locations"] == 2
    assert deleted["resource_items"] == 1
    assert deleted["briefs"] == 1


def test_reset_flags_are_independent(archive):
    _seed_optional_config()

    deleted = db.reset_schedule(clear_hours=True)

    assert "working_hours" in deleted and "domestic_hours" in deleted
    assert "locations" not in deleted
    assert "resources" not in deleted
    assert db.get_working_hours() == []
    assert len(db.list_locations()) == 2
    assert db.list_resources() != []


def test_reset_on_an_empty_schedule_is_a_no_op_reporting_zeros(archive):
    deleted = db.reset_schedule()

    assert deleted == {table: 0 for table in db.SCHEDULE_DATA_TABLES}


def test_reset_never_touches_the_reference_archive(archive):
    ref_id = str(uuid.uuid4())
    db.insert_reference(ref_id, "image", "images/x.png", "A Ref", None, ["t"], "d", "n")
    project_id = str(uuid.uuid4())
    db.create_project(project_id, "Kept Project")
    db.add_reference_to_project(project_id, ref_id)
    _seed_task_and_plan_data()

    db.reset_schedule(clear_locations=True, clear_hours=True, clear_resources=True)

    assert db.get_reference(ref_id) is not None
    assert db.get_project(project_id) is not None
    assert db.list_project_references(project_id) != []
    assert db.list_tasks() == []


def test_reset_leaves_remembered_preferences_alone(archive):
    db.save_ics_feed_url("https://example.com/feed.ics")
    db.save_schedule_settings(7 * 60, 25, True)
    _seed_task_and_plan_data()

    db.reset_schedule()

    assert db.get_ics_feed_url() == "https://example.com/feed.ics"
    settings = db.get_schedule_settings()
    assert settings["sleep_target_minutes"] == 7 * 60
    assert settings["morning_routine_minutes"] == 25


# --- embeddings.clear_task_collection ------------------------------------------


def test_clear_task_collection_drops_every_vector_and_counts_them(archive, monkeypatch):
    fake = FakeTaskCollection(["t-1", "t-2", "t-3"])
    monkeypatch.setattr(embeddings, "get_task_collection", lambda: fake)

    assert embeddings.clear_task_collection() == 3
    assert fake.ids == []
    # Safe to call again against an empty collection.
    assert embeddings.clear_task_collection() == 0


# --- POST /api/schedule/reset --------------------------------------------------


def _confirm(client, **body):
    return client.post("/api/schedule/reset", json={"confirm": "clear-schedule", **body})


def test_reset_route_refuses_without_the_confirmation_token(client):
    db.create_task(str(uuid.uuid4()), "A")

    assert client.post("/api/schedule/reset", json={}).status_code == 400
    assert client.post("/api/schedule/reset", json={"confirm": "yes"}).status_code == 400
    assert client.post("/api/schedule/reset").status_code == 400
    # Nothing was cleared.
    assert len(db.list_tasks()) == 1


def test_reset_route_clears_data_and_returns_counts(client, monkeypatch):
    monkeypatch.setattr(embeddings, "get_task_collection", lambda: FakeTaskCollection([]))
    _seed_task_and_plan_data()

    resp = _confirm(client)

    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload["deleted"]["tasks"] == 2
    assert payload["deleted"]["scheduled_blocks"] == 1
    assert set(payload["deleted"]) == set(db.SCHEDULE_DATA_TABLES)
    assert payload["task_vectors_deleted"] == 0
    assert db.list_tasks() == []


def test_reset_route_passes_optional_flags_through(client, monkeypatch):
    monkeypatch.setattr(embeddings, "get_task_collection", lambda: FakeTaskCollection([]))
    _seed_optional_config()

    resp = _confirm(client, clear_locations=True, clear_resources=True)

    payload = resp.get_json()
    assert "locations" in payload["deleted"]
    assert "resources" in payload["deleted"]
    assert "working_hours" not in payload["deleted"]  # clear_hours not asked for
    assert db.list_locations() == []
    assert db.get_working_hours() != []


def test_reset_route_clears_the_task_vector_collection(client, monkeypatch):
    fake = FakeTaskCollection(["gone-1", "gone-2"])
    monkeypatch.setattr(embeddings, "get_task_collection", lambda: fake)
    db.create_task(str(uuid.uuid4()), "A")

    resp = _confirm(client)

    assert resp.get_json()["task_vectors_deleted"] == 2
    assert fake.ids == []
