"""Brief import: read a PDF into a proposal, then approve a filtered, edited
subset of it into real deliverables, tasks and commitments.

briefs.analyse (the Claude call) is stubbed in conftest to return
BRIEF_EXTRACTION; briefs.extract_text runs for real against a PDF built here
with fitz, so the read path is genuinely exercised offline.
"""
import io

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


# --- import ----------------------------------------------------------------


def test_importing_a_pdf_stores_the_extraction_and_the_file(client):
    pid = make_project(client)
    resp = import_brief(client, pid)
    assert resp.status_code == 200, resp.get_json()
    brief = resp.get_json()

    assert brief["project_id"] == pid
    assert brief["extracted"]["extraction"] == BRIEF_EXTRACTION
    assert brief["extracted"]["applied"] is None

    # The PDF is on disk and served back.
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
            # a hand-in tied to the deliverable above -> sets its due_at, no commitment
            {"label": "Hand-in", "kind": "hand-in", "start": "2026-03-25", "attach_to": 0},
        ],
        "mandatory_activities": [
            {"title": "Fabric shop visit", "description": "at least one documented visit",
             "location_bound": True},
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
    # the tied hand-in overrode the deliverable's own due date
    assert d["due_at"] == "2026-03-25"

    tasks = client.get(f"/api/tasks?project_id={pid}").get_json()
    titles = sorted(t["title"] for t in tasks)
    assert titles == ["Fabric shop visit", "Gather fabric research"]

    research = next(t for t in tasks if t["title"] == "Gather fabric research")
    assert research["deliverable_id"] == d["id"]
    assert research["est_minutes"] == 120
    assert research["est_minutes_source"] == "generated"

    shop = next(t for t in tasks if t["title"] == "Fabric shop visit")
    assert "set it in Tasks" in shop["description"]
    assert shop["required_location_id"] is None

    commitments = client.get("/api/commitments").get_json()
    labels = [c["title"] for c in commitments]
    assert labels == ["Briefing"]  # hand-in was tied to the deliverable, not a commitment

    # the applied envelope is written back for a later re-import to diff against
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


# --- lifecycle ---------------------------------------------------------------


def test_deleting_a_brief_leaves_its_created_rows_intact(client):
    pid = make_project(client)
    brief_id = import_brief(client, pid).get_json()["id"]
    client.post(
        f"/api/briefs/{brief_id}/apply",
        json={"deliverables": [{"title": "Part 1", "tasks": [{"title": "Step one"}]}]},
    )

    assert client.delete(f"/api/briefs/{brief_id}").status_code == 200
    assert client.get(f"/api/briefs/{brief_id}").status_code == 404

    deliverables = client.get(f"/api/projects/{pid}/deliverables").get_json()
    assert [d["title"] for d in deliverables] == ["Part 1"]
    tasks = client.get(f"/api/tasks?project_id={pid}").get_json()
    assert [t["title"] for t in tasks] == ["Step one"]


def test_deleting_the_project_clears_its_brief(client):
    pid = make_project(client)
    import_brief(client, pid)
    assert len(db.list_briefs(pid)) == 1

    client.delete(f"/api/projects/{pid}")
    assert db.list_briefs(pid) == []
