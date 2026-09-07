"""Session 18: the phone's offline cache and sync queue, from the server's side.

The queue itself lives in IndexedDB on the phone (static/schedule/offline-queue.js)
and can only be exercised in a browser. What is testable here -- and what the
queue's safety actually rests on -- is the server contract:

  * a mutation carrying a `client_id` is applied at most once, however many
    times a flaky connection makes the phone resend it (app.py's `idempotent`);
  * a completion carries the phone's OWN timestamp, and that timestamp is what
    lands in task_actuals.completed_at -- not whenever the laptop next opened,
    which would teach the estimator from durations that never happened;
  * GET /api/schedule/today returns the whole day in one payload.

The third acceptance test -- "the queue survives a simulated full close" -- is a
property of IndexedDB and is checked in the browser; there is no JS runtime in
this suite to assert it here.
"""
import uuid

import db


def make_task(client, title="A Task", **kwargs):
    resp = client.post("/api/tasks", json={"title": title, **kwargs})
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()


# --- Idempotent replay ----------------------------------------------------


def test_replaying_a_queued_completion_records_it_once(client):
    """A recurring task completed once must spawn exactly one successor, even
    if the queue flushes the same completion twice."""
    rule_id = str(uuid.uuid4())
    db.create_recurrence_rule(rule_id, interval_days=3)
    task = make_task(client, recurrence_id=rule_id, est_minutes=20)
    cid = str(uuid.uuid4())

    first = client.post(f"/api/tasks/{task['id']}/complete",
                        json={"client_id": cid, "completed_at": "2026-05-04T09:00:00"})
    assert first.status_code == 200
    outstanding = [t for t in db.list_tasks_for_recurrence(rule_id)
                   if t["status"] in ("pending", "scheduled")]
    assert len(outstanding) == 1

    replay = client.post(f"/api/tasks/{task['id']}/complete",
                         json={"client_id": cid, "completed_at": "2026-05-04T09:00:00"})
    assert replay.status_code == 200
    # Same response, byte for byte -- the stored one, not a fresh run.
    assert replay.get_json() == first.get_json()
    still_outstanding = [t for t in db.list_tasks_for_recurrence(rule_id)
                         if t["status"] in ("pending", "scheduled")]
    assert len(still_outstanding) == 1


def test_replaying_a_queued_miss_bumps_the_slip_count_once(client):
    task = make_task(client)
    cid = str(uuid.uuid4())

    client.post(f"/api/tasks/{task['id']}/not-completed", json={"client_id": cid})
    client.post(f"/api/tasks/{task['id']}/not-completed", json={"client_id": cid})

    assert db.get_task(task["id"])["slip_count"] == 1


def test_replaying_a_queued_partial_spawns_one_remainder(client):
    task = make_task(client, est_minutes=120)
    cid = str(uuid.uuid4())
    body = {"client_id": cid, "actual_minutes": 40, "est_minutes": 60}

    client.post(f"/api/tasks/{task['id']}/partial", json=body)
    client.post(f"/api/tasks/{task['id']}/partial", json=body)

    remainders = [t for t in db.list_tasks() if t["continues_task_id"] == task["id"]]
    assert len(remainders) == 1


def test_replaying_a_queued_task_creation_makes_one_task(client):
    cid = str(uuid.uuid4())
    body = {"client_id": cid, "title": "Cut the toile"}

    a = client.post("/api/tasks", json=body).get_json()
    b = client.post("/api/tasks", json=body).get_json()

    assert a["id"] == b["id"]
    assert [t for t in db.list_tasks() if t["title"] == "Cut the toile"] == [
        t for t in db.list_tasks() if t["id"] == a["id"]
    ]


def test_a_fresh_client_id_still_runs(client):
    """Idempotency keys off the id, not the endpoint -- a second, genuinely
    different action on the same task is not swallowed."""
    task = make_task(client)
    client.post(f"/api/tasks/{task['id']}/not-completed", json={"client_id": str(uuid.uuid4())})
    client.post(f"/api/tasks/{task['id']}/not-completed", json={"client_id": str(uuid.uuid4())})
    assert db.get_task(task["id"])["slip_count"] == 2


def test_a_mutation_with_no_client_id_is_untouched(client):
    """The desktop app sends no client_id and must behave exactly as before."""
    task = make_task(client)
    client.post(f"/api/tasks/{task['id']}/not-completed")
    client.post(f"/api/tasks/{task['id']}/not-completed")
    assert db.get_task(task["id"])["slip_count"] == 2


# --- The phone's own timestamp -----------------------------------------


def test_a_queued_completions_phone_timestamp_reaches_task_actuals(client):
    """Completed at 09:00, queue flushed at (say) 18:00: task_actuals records
    09:00. This is the difference between the estimator's data being useful and
    being noise (SCHEDULE_SCOPE.md's "offline queue")."""
    task = make_task(client, est_minutes=30)
    client.post(f"/api/tasks/{task['id']}/complete",
                json={"client_id": str(uuid.uuid4()),
                      "completed_at": "2026-05-04T09:00:00"})
    assert db.get_task_actual(task["id"])["completed_at"] == "2026-05-04T09:00:00"


def test_a_queued_partials_phone_timestamp_reaches_task_actuals(client):
    task = make_task(client, est_minutes=120)
    client.post(f"/api/tasks/{task['id']}/partial",
                json={"client_id": str(uuid.uuid4()), "actual_minutes": 45,
                      "est_minutes": 60, "completed_at": "2026-05-04T09:15:00"})
    assert db.get_task_actual(task["id"])["completed_at"] == "2026-05-04T09:15:00"


def test_an_ordinary_online_completion_still_stamps_now(client):
    """No completed_at in the body -> the server stamps the actual itself, as
    it always has. (A rough check: the recorded moment is not empty and is a
    real ISO timestamp.)"""
    task = make_task(client, est_minutes=30)
    client.post(f"/api/tasks/{task['id']}/complete")
    stamped = db.get_task_actual(task["id"])["completed_at"]
    assert stamped and "T" in stamped


def test_a_malformed_completed_at_is_rejected(client):
    task = make_task(client, est_minutes=30)
    resp = client.post(f"/api/tasks/{task['id']}/complete",
                       json={"completed_at": "yesterday morning"})
    assert resp.status_code == 400
    assert db.get_task(task["id"])["status"] != "done"


# --- One payload for the whole day ------------------------------------


def test_schedule_today_returns_the_whole_day_in_one_request(client):
    project_id = client.post("/api/projects", json={"title": "P"}).get_json()["id"]
    deliverable_id = client.post(f"/api/projects/{project_id}/deliverables",
                                 json={"title": "D"}).get_json()["id"]
    make_task(client, title="Today task", project_id=project_id,
              deliverable_id=deliverable_id, est_minutes=30)
    client.post("/api/schedule/plan")

    payload = client.get("/api/schedule/today").get_json()

    # blocks + at-risk (inside `schedule`), tasks, energy -- the four the phone
    # can't draw the day without, plus the bands it needs for the ledger.
    assert "blocks" in payload["schedule"]
    assert "at_risk" in payload["schedule"]
    assert any(t["title"] == "Today task" for t in payload["tasks"])
    assert "energy" in payload["energy"]
    assert isinstance(payload["working_hours"], list)
    assert isinstance(payload["deliverables"], list)
    assert payload["synced_at"]


def test_schedule_today_is_behind_the_token_guard_when_exposed(client, monkeypatch):
    import app as flask_app
    import config
    monkeypatch.setattr(config, "LAN_EXPOSED", True)
    monkeypatch.setattr(flask_app, "ARCHIVE_API_TOKEN", "s3cr3t")
    r = client.get("/api/schedule/today", environ_overrides={"REMOTE_ADDR": "100.115.92.7"})
    assert r.status_code == 401
