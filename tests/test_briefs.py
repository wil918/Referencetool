"""Brief import: read a PDF into a proposal, then approve a filtered, edited
subset of it into real deliverables, tasks and commitments -- and, on a
re-import, diff the revised brief against what it already created rather than
inserting a duplicate set.

briefs.analyse (the Claude call) is stubbed in conftest to return a deep copy of
BRIEF_EXTRACTION; briefs.extract_text runs for real against a PDF built here
with fitz, so the read path is genuinely exercised offline.
"""
import copy
import io
from unittest.mock import patch

import fitz

import db
from conftest import BRIEF_EXTRACTION


def make_project(client, title="A Project"):
    return client.post("/api/projects", json={"title": title}).get_json()["id"]


def pdf_bytes(text="Construction brief.\nBriefing 12 January 2026.\nHand-in 20 March 2026."):
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), text)
    data = doc.tobytes()
    doc.close()
    return data


def import_brief(client, project_id, filename="brief.pdf"):
    return client.post(
        f"/api/projects/{project_id}/briefs",
        data={"file": (io.BytesIO(pdf_bytes()), filename)},
        content_type="multipart/form-data",
    )


# The payload the review sheet sends when every proposed item is accepted with
# no edits -- source_key carried straight through from the extraction, which is
# what makes a re-import a diff.
def full_payload(brief):
    ex = brief["extracted"]["extraction"]
    return {
        "deliverables": [
            {
                "source_key": d["source_key"],
                "title": d["title"],
                "due_at": d.get("due_date"),
                "weighting": d.get("weighting"),
                "description": d.get("description"),
                "spec": d.get("spec"),
                "tasks": [
                    {"title": t["title"], "description": t.get("note"),
                     "est_minutes": t.get("est_minutes")}
                    for t in d.get("tasks") or []
                ],
            }
            for d in ex.get("deliverables") or []
        ],
        "mandatory_activities": [
            {"source_key": a["source_key"], "title": a["title"],
             "description": a.get("note"), "location_bound": a.get("location_bound")}
            for a in ex.get("mandatory_activities") or []
        ],
    }


# --- import ----------------------------------------------------------------


def test_importing_a_pdf_stores_the_extraction_and_stamps_source_keys(client):
    pid = make_project(client)
    resp = import_brief(client, pid)
    assert resp.status_code == 200, resp.get_json()
    brief = resp.get_json()

    assert brief["project_id"] == pid
    extraction = brief["extracted"]["extraction"]
    assert extraction["summary"] == BRIEF_EXTRACTION["summary"]
    # every deliverable and activity now carries a stable key derived from the
    # brief's printed heading, not from the model-written title
    assert extraction["deliverables"][0]["source_key"] == "part-1"
    assert extraction["mandatory_activities"][0]["source_key"] == "activity:fabric-shop-visit"
    assert brief["extracted"]["applied"] is None

    file_resp = client.get(f"/api/briefs/{brief['id']}/file")
    assert file_resp.status_code == 200
    assert file_resp.mimetype == "application/pdf"

    listed = client.get(f"/api/projects/{pid}/briefs").get_json()
    assert [b["id"] for b in listed] == [brief["id"]]


def test_a_non_pdf_is_rejected(client):
    pid = make_project(client)
    resp = client.post(
        f"/api/projects/{pid}/briefs",
        data={"file": (io.BytesIO(b"not a pdf"), "notes.txt")},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    assert db.list_briefs(pid) == []


def test_a_pdf_with_no_text_is_rejected_and_leaves_nothing_behind(client):
    pid = make_project(client)
    doc = fitz.open()
    doc.new_page()  # a blank page -- no text
    blank = doc.tobytes()
    doc.close()
    resp = client.post(
        f"/api/projects/{pid}/briefs",
        data={"file": (io.BytesIO(blank), "blank.pdf")},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    assert db.list_briefs(pid) == []


# --- apply ---------------------------------------------------------------


def test_apply_creates_only_the_accepted_items(client):
    pid = make_project(client)
    brief_id = import_brief(client, pid).get_json()["id"]

    payload = {
        "deliverables": [
            {
                "source_key": "part-1",
                "title": "Part 1 - Research",
                "due_at": "2026-02-20",
                "weighting": 40,
                "description": "A research portfolio.",
                "spec": {"pages": 20, "required_items": ["3 documented fabric tests"]},
                "tasks": [
                    {"title": "Gather fabric research", "description": "", "est_minutes": 120},
                    # second skeleton task deliberately omitted -- the user discarded it
                ],
            }
        ],
        "key_dates": [
            {"label": "Briefing", "kind": "briefing",
             "start": "2026-01-12T09:00:00", "end": "2026-01-12T10:00:00"},
            {"label": "Hand-in", "kind": "hand-in", "start": "2026-03-25", "attach_to": 0},
        ],
        "mandatory_activities": [
            {"source_key": "activity:fabric-shop-visit", "title": "Fabric shop visit",
             "description": "at least one documented visit", "location_bound": True},
        ],
        "discarded": ["deliverable:1", "activity:archive-visit"],
    }
    resp = client.post(f"/api/briefs/{brief_id}/apply", json=payload)
    assert resp.status_code == 200, resp.get_json()

    deliverables = client.get(f"/api/projects/{pid}/deliverables").get_json()
    assert len(deliverables) == 1
    d = deliverables[0]
    assert d["title"] == "Part 1 - Research"
    assert d["weighting"] == 40
    assert d["spec"]["pages"] == 20
    assert d["due_at"] == "2026-03-25"  # the tied hand-in overrode the deliverable's own due date
    assert d["brief_id"] == brief_id
    assert d["source_key"] == "part-1"

    tasks = client.get(f"/api/tasks?project_id={pid}").get_json()
    titles = sorted(t["title"] for t in tasks)
    assert titles == ["Fabric shop visit", "Gather fabric research"]
    assert all(t["brief_id"] == brief_id for t in tasks)

    research = next(t for t in tasks if t["title"] == "Gather fabric research")
    assert research["deliverable_id"] == d["id"]
    assert research["est_minutes"] == 120
    assert research["est_minutes_source"] == "generated"
    assert research["source_key"] == "part-1#t0"

    shop = next(t for t in tasks if t["title"] == "Fabric shop visit")
    assert "set it in Tasks" in shop["description"]
    assert shop["required_location_id"] is None
    assert shop["source_key"] == "activity:fabric-shop-visit"

    commitments = client.get("/api/commitments").get_json()
    assert [c["title"] for c in commitments] == ["Briefing"]

    brief = client.get(f"/api/briefs/{brief_id}").get_json()
    applied = brief["extracted"]["applied"]
    assert applied["at"]
    assert len(applied["deliverables"]) == 1
    assert {t["title"] for t in applied["tasks"]} == {"Gather fabric research", "Fabric shop visit"}
    assert applied["discarded"] == ["deliverable:1", "activity:archive-visit"]


def test_apply_with_nothing_selected_creates_nothing(client):
    pid = make_project(client)
    brief_id = import_brief(client, pid).get_json()["id"]

    resp = client.post(f"/api/briefs/{brief_id}/apply", json={})
    assert resp.status_code == 200

    assert client.get(f"/api/projects/{pid}/deliverables").get_json() == []
    assert client.get(f"/api/tasks?project_id={pid}").get_json() == []


# --- re-import is a diff, not a replace ------------------------------------


def test_re_importing_the_same_brief_does_not_duplicate(client):
    pid = make_project(client)
    brief = import_brief(client, pid).get_json()
    client.post(f"/api/briefs/{brief['id']}/apply", json=full_payload(brief))

    first = client.get(f"/api/projects/{pid}/deliverables").get_json()
    assert len(first) == 1
    task_ids_before = {t["id"] for t in client.get(f"/api/tasks?project_id={pid}").get_json()}

    # Re-import the unchanged brief: same project -> same brief row.
    brief2 = import_brief(client, pid).get_json()
    assert brief2["id"] == brief["id"]
    assert len(db.list_briefs(pid)) == 1

    diff = client.get(f"/api/briefs/{brief2['id']}/diff").get_json()
    assert [d["source_key"] for d in diff["unchanged"]] == ["part-1"]
    assert diff["changed"] == [] and diff["new"] == [] and diff["gone"] == []

    client.post(f"/api/briefs/{brief2['id']}/apply", json=full_payload(brief2))

    after = client.get(f"/api/projects/{pid}/deliverables").get_json()
    assert len(after) == 1
    assert after[0]["id"] == first[0]["id"]
    # the task skeleton under the matched deliverable is left exactly as it was
    task_ids_after = {t["id"] for t in client.get(f"/api/tasks?project_id={pid}").get_json()}
    assert task_ids_after == task_ids_before


def test_a_moved_due_date_reads_as_changed_not_new(client):
    pid = make_project(client)
    brief = import_brief(client, pid).get_json()
    client.post(f"/api/briefs/{brief['id']}/apply", json=full_payload(brief))

    # The brief is reissued with Part 1's due date pushed back a week.
    reissued = copy.deepcopy(BRIEF_EXTRACTION)
    reissued["deliverables"][0]["due_date"] = "2026-02-27"
    with patch("briefs.analyse", return_value=reissued):
        brief2 = import_brief(client, pid).get_json()

    diff = client.get(f"/api/briefs/{brief2['id']}/diff").get_json()
    assert [d["source_key"] for d in diff["new"]] == []
    assert len(diff["changed"]) == 1
    change = diff["changed"][0]
    assert change["source_key"] == "part-1"
    assert change["fields"]["due_at"] == ["2026-02-20", "2026-02-27"]


def test_a_deliverable_dropped_from_the_reissue_is_reported_gone(client):
    pid = make_project(client)
    brief = import_brief(client, pid).get_json()
    client.post(f"/api/briefs/{brief['id']}/apply", json=full_payload(brief))

    dropped = copy.deepcopy(BRIEF_EXTRACTION)
    dropped["deliverables"] = []
    with patch("briefs.analyse", return_value=dropped):
        brief2 = import_brief(client, pid).get_json()

    diff = client.get(f"/api/briefs/{brief2['id']}/diff").get_json()
    assert [d["source_key"] for d in diff["gone"]] == ["part-1"]

    # Approving the removal drops the deliverable; its tasks survive, unparented.
    client.post(f"/api/briefs/{brief2['id']}/apply", json={"remove": ["part-1"]})
    assert client.get(f"/api/projects/{pid}/deliverables").get_json() == []
    tasks = client.get(f"/api/tasks?project_id={pid}").get_json()
    assert tasks and all(t["deliverable_id"] is None for t in tasks)


# --- scoped reset ----------------------------------------------------------


def test_a_hand_made_deliverable_is_untouched_by_a_brief_reset(client):
    pid = make_project(client)
    brief_id = import_brief(client, pid).get_json()["id"]
    client.post(f"/api/briefs/{brief_id}/apply",
                json={"deliverables": [{"source_key": "part-1", "title": "Part 1"}]})

    hand = client.post(f"/api/projects/{pid}/deliverables",
                       json={"title": "A deliverable I typed"}).get_json()

    resp = client.post(f"/api/briefs/{brief_id}/reset", json={})
    assert resp.status_code == 200
    assert resp.get_json()["deleted"]["deliverables"] == 1

    remaining = client.get(f"/api/projects/{pid}/deliverables").get_json()
    assert [d["id"] for d in remaining] == [hand["id"]]


def test_a_worked_task_survives_the_default_reset_and_falls_to_the_explicit_one(client):
    pid = make_project(client)
    brief_id = import_brief(client, pid).get_json()["id"]
    client.post(
        f"/api/briefs/{brief_id}/apply",
        json={"deliverables": [{
            "source_key": "part-1", "title": "Part 1",
            "tasks": [{"title": "Done step"}, {"title": "Untouched step"}],
        }]},
    )
    tasks = client.get(f"/api/tasks?project_id={pid}").get_json()
    done = next(t for t in tasks if t["title"] == "Done step")
    db.save_task_actual(done["id"], actual_minutes=45)
    db.update_task(done["id"], status="done")

    # default reset: the worked task is kept, the untouched one and the
    # deliverable go
    report = client.post(f"/api/briefs/{brief_id}/reset", json={}).get_json()
    assert report["kept_tasks"] == 1
    assert report["deleted"]["tasks"] == 1
    assert report["deleted"]["deliverables"] == 1

    survivors = client.get(f"/api/tasks?project_id={pid}").get_json()
    assert [t["title"] for t in survivors] == ["Done step"]
    assert survivors[0]["deliverable_id"] is None  # its deliverable went

    # explicit purge removes even the worked task
    report = client.post(f"/api/briefs/{brief_id}/reset", json={"purge": True}).get_json()
    assert report["deleted"]["tasks"] == 1
    assert client.get(f"/api/tasks?project_id={pid}").get_json() == []


# --- lifecycle ---------------------------------------------------------------


def test_deleting_a_brief_leaves_no_orphans(client):
    pid = make_project(client)
    brief_id = import_brief(client, pid).get_json()["id"]
    client.post(
        f"/api/briefs/{brief_id}/apply",
        json={"deliverables": [{
            "source_key": "part-1", "title": "Part 1",
            "tasks": [{"title": "Step one"}, {"title": "Step two"}],
        }]},
    )
    tasks = client.get(f"/api/tasks?project_id={pid}").get_json()
    worked = next(t for t in tasks if t["title"] == "Step two")
    db.update_task(worked["id"], status="partial")

    assert client.delete(f"/api/briefs/{brief_id}").status_code == 200
    assert client.get(f"/api/briefs/{brief_id}").status_code == 404

    # the untouched deliverable and task are gone; the worked task is preserved
    # (its deliverable_id nulled) rather than orphaned
    assert client.get(f"/api/projects/{pid}/deliverables").get_json() == []
    survivors = client.get(f"/api/tasks?project_id={pid}").get_json()
    assert [t["title"] for t in survivors] == ["Step two"]
    assert survivors[0]["deliverable_id"] is None


def test_deleting_a_brief_with_purge_removes_everything_it_made(client):
    pid = make_project(client)
    brief_id = import_brief(client, pid).get_json()["id"]
    client.post(
        f"/api/briefs/{brief_id}/apply",
        json={"deliverables": [{
            "source_key": "part-1", "title": "Part 1",
            "tasks": [{"title": "Step one"}],
        }]},
    )
    tasks = client.get(f"/api/tasks?project_id={pid}").get_json()
    db.update_task(tasks[0]["id"], status="done")

    assert client.delete(f"/api/briefs/{brief_id}?purge=1").status_code == 200
    assert client.get(f"/api/projects/{pid}/deliverables").get_json() == []
    assert client.get(f"/api/tasks?project_id={pid}").get_json() == []


def test_deleting_the_project_clears_its_brief(client):
    pid = make_project(client)
    import_brief(client, pid)
    assert len(db.list_briefs(pid)) == 1

    client.delete(f"/api/projects/{pid}")
    assert db.list_briefs(pid) == []
