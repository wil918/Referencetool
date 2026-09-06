"""Referential integrity across the schedule tables.

The schedule half of the database has no foreign keys -- SQLite would enforce
them only with a pragma the app never sets, and several references are
deliberately allowed to dangle (a commitment keeps its location_id when the
location goes; a worked task keeps its brief_id when the brief is reset). This
module pins down the cascades that ARE meant to fire: after a task, deliverable,
commitment, resource, brief or project is deleted, nothing that only existed
because of it is left behind.

The counterpart for the project-space tables (folders, widgets, canvas) is
test_project_spaces.py's orphan_rows sweep.
"""
import io
import uuid

import fitz

import db


def make_project(client, title="A Project"):
    return client.post("/api/projects", json={"title": title}).get_json()["id"]


def make_task(client, title="A Task", **kwargs):
    resp = client.post("/api/tasks", json={"title": title, **kwargs})
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()


def schedule_orphan_rows():
    """Rows in each schedule table whose parent no longer exists, restricted to
    the references that a delete IS supposed to clean up.

    Deliberately excluded because the dangling reference is by design:
      - commitments.location_id / resources.location_id  (see delete_location)
      - tasks.recurrence_id                              (see delete_recurrence_rule)
      - tasks.brief_id on a worked task                  (see db.reset_brief)
      - locations.parent_location_id, schedule_settings.default_location_umbrella_id
    """
    with db.get_conn() as conn:
        queries = {
            "scheduled_blocks->task": """
                SELECT id FROM scheduled_blocks
                WHERE task_id IS NOT NULL
                  AND task_id NOT IN (SELECT id FROM tasks)
            """,
            "scheduled_blocks->commitment": """
                SELECT id FROM scheduled_blocks
                WHERE commitment_id IS NOT NULL
                  AND commitment_id NOT IN (SELECT id FROM commitments)
            """,
            "task_actuals->task": """
                SELECT task_id FROM task_actuals
                WHERE task_id NOT IN (SELECT id FROM tasks)
            """,
            "task_dependencies->task": """
                SELECT task_id, depends_on_task_id FROM task_dependencies
                WHERE task_id NOT IN (SELECT id FROM tasks)
                   OR depends_on_task_id NOT IN (SELECT id FROM tasks)
            """,
            "task_resources->task": """
                SELECT task_id, resource_id FROM task_resources
                WHERE task_id NOT IN (SELECT id FROM tasks)
            """,
            "task_resources->resource": """
                SELECT task_id, resource_id FROM task_resources
                WHERE resource_id NOT IN (SELECT id FROM resources)
            """,
            "tasks->deliverable": """
                SELECT id FROM tasks
                WHERE deliverable_id IS NOT NULL
                  AND deliverable_id NOT IN (SELECT id FROM deliverables)
            """,
            "deliverables->project": """
                SELECT id FROM deliverables
                WHERE project_id NOT IN (SELECT id FROM projects)
            """,
            "deliverables->brief": """
                SELECT id FROM deliverables
                WHERE brief_id IS NOT NULL
                  AND brief_id NOT IN (SELECT id FROM briefs)
            """,
            "resource_items->resource": """
                SELECT resource_id, item FROM resource_items
                WHERE resource_id NOT IN (SELECT id FROM resources)
            """,
            "location_hours->location": """
                SELECT location_id, weekday FROM location_hours
                WHERE location_id NOT IN (SELECT id FROM locations)
            """,
            "location_overrides->location": """
                SELECT id FROM location_overrides
                WHERE location_id NOT IN (SELECT id FROM locations)
            """,
            "location_travel->location": """
                SELECT from_location_id, to_location_id FROM location_travel
                WHERE from_location_id NOT IN (SELECT id FROM locations)
                   OR to_location_id NOT IN (SELECT id FROM locations)
            """,
        }
        return {name: conn.execute(q).fetchall() for name, q in queries.items()}


def _populate_full_schedule(client, archive):
    """A project carrying one of everything the schedule tables hold, wired
    together the way real data is."""
    project_id = make_project(client, "Full")

    # A brief (briefs.analyse is stubbed in conftest; extract_text runs for
    # real against this PDF), applied into a brief-owned deliverable and task.
    doc = fitz.open()
    doc.new_page().insert_text((72, 100), "Assignment brief. Part 1 due soon.")
    pdf_data = doc.tobytes()
    doc.close()
    brief = client.post(
        f"/api/projects/{project_id}/briefs",
        data={"file": (io.BytesIO(pdf_data), "brief.pdf")},
        content_type="multipart/form-data",
    ).get_json()
    ex = brief["extracted"]["extraction"]
    client.post(
        f"/api/briefs/{brief['id']}/apply",
        json={
            "deliverables": [
                {
                    "source_key": d["source_key"],
                    "title": d["title"],
                    "due_at": d.get("due_date"),
                    "spec": d.get("spec"),
                    "tasks": [{"title": t["title"]} for t in d.get("tasks") or []],
                }
                for d in ex.get("deliverables") or []
            ],
            "mandatory_activities": [
                {"source_key": a["source_key"], "title": a["title"]}
                for a in ex.get("mandatory_activities") or []
            ],
        },
    )

    deliverable = client.post(
        f"/api/projects/{project_id}/deliverables", json={"title": "Part 2"}
    ).get_json()

    location = client.post("/api/locations", json={"name": "Studio 3"}).get_json()
    client.put(
        f"/api/locations/{location['id']}/hours",
        json={"hours": [{"weekday": 0, "opens": "09:00", "closes": "17:00"}]},
    )
    client.post(
        f"/api/locations/{location['id']}/overrides",
        json={"date": "2026-06-01", "closed": True},
    )

    resource = client.post("/api/resources", json={"name": "Cloth House"}).get_json()
    client.post(f"/api/resources/{resource['id']}/items", json={"item": "Linen", "tags": []})

    a = make_task(client, "A", project_id=project_id, deliverable_id=deliverable["id"])["id"]
    b = make_task(client, "B", project_id=project_id, deliverable_id=deliverable["id"])["id"]
    client.post(f"/api/tasks/{b}/dependencies", json={"depends_on_task_id": a})
    client.post(f"/api/tasks/{a}/resources", json={"resource_id": resource["id"]})
    db.save_task_actual(a, actual_minutes=30)
    db.create_scheduled_block(str(uuid.uuid4()), a, "2026-01-05T09:00:00", "2026-01-05T09:30:00")

    commitment = client.post(
        "/api/commitments",
        json={
            "title": "Tutorial",
            "start": "2026-01-06T10:00:00",
            "end": "2026-01-06T11:00:00",
            "home_first": True,
            "prep_minutes": 20,
        },
    ).get_json()
    db.create_scheduled_block(
        str(uuid.uuid4()), None, "2026-01-06T09:00:00", "2026-01-06T09:20:00",
        kind="prep", commitment_id=commitment["id"],
    )

    return {
        "project_id": project_id,
        "brief_id": brief["id"],
        "deliverable_id": deliverable["id"],
        "location_id": location["id"],
        "resource_id": resource["id"],
        "task_a": a,
        "task_b": b,
        "commitment_id": commitment["id"],
    }


def test_deleting_a_commitment_clears_the_home_first_blocks_it_owned(client):
    commitment = client.post(
        "/api/commitments",
        json={"title": "Meeting", "start": "2026-02-02T10:00:00", "end": "2026-02-02T11:00:00"},
    ).get_json()
    block_id = str(uuid.uuid4())
    db.create_scheduled_block(
        block_id, None, "2026-02-02T09:00:00", "2026-02-02T09:30:00",
        kind="travel", commitment_id=commitment["id"],
    )

    assert client.delete(f"/api/commitments/{commitment['id']}").status_code == 200

    assert db.get_scheduled_block(block_id) is None


def test_no_schedule_orphans_after_deleting_a_task_deliverable_commitment_or_resource(client, archive):
    ids = _populate_full_schedule(client, archive)
    assert not any(rows for rows in schedule_orphan_rows().values())

    assert client.delete(f"/api/tasks/{ids['task_a']}").status_code == 200
    assert client.delete(f"/api/deliverables/{ids['deliverable_id']}").status_code == 200
    assert client.delete(f"/api/commitments/{ids['commitment_id']}").status_code == 200
    assert client.delete(f"/api/resources/{ids['resource_id']}").status_code == 200
    assert client.delete(f"/api/locations/{ids['location_id']}").status_code == 200

    orphans = schedule_orphan_rows()
    assert all(len(rows) == 0 for rows in orphans.values()), orphans

    # Task B outlived A: its dangling dependency on A was cleared, and it kept
    # its project and (still-present) nothing-else.
    assert db.list_task_dependencies(ids["task_b"]) == []


def test_no_schedule_orphans_after_resetting_a_brief(client, archive):
    ids = _populate_full_schedule(client, archive)

    assert client.post(f"/api/briefs/{ids['brief_id']}/reset", json={"purge": True}).status_code == 200

    orphans = schedule_orphan_rows()
    assert all(len(rows) == 0 for rows in orphans.values()), orphans


def test_no_schedule_orphans_after_deleting_the_project(client, archive):
    ids = _populate_full_schedule(client, archive)

    assert client.delete(f"/api/projects/{ids['project_id']}").status_code == 200

    orphans = schedule_orphan_rows()
    assert all(len(rows) == 0 for rows in orphans.values()), orphans
    # The tasks themselves survive with project_id cleared -- deleting a project
    # is "forget this grouping", not "delete this work".
    assert db.get_task(ids["task_b"])["project_id"] is None
