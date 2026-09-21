"""The supporting-document routes: attach, parse, propose, review, apply --
session 15's brief-import shape, but for a workshop/materials list/reading
list rather than the brief itself. See supporting_docs.py's module docstring
for the two things it does differently and the one thing it doesn't (no
re-import diff).
"""
import copy
import io
from unittest.mock import patch

import docx
import fitz

import briefs
import db
import supporting_docs

SUPPORTING_DOC_EXTRACTION = {
    "summary": "A workshop materials list.",
    "sessions": [
        {"label": "Construction workshop", "date": "2026-09-23", "group": None,
         "matched_commitment": True},
    ],
    "preparation_tasks": [
        {"title": "Bring fabric shears", "due_date": "2026-09-23",
         "session_index": 0, "source_key": "bring-fabric-shears"},
        {"title": "Bring a metre of calico", "due_date": "2026-09-23",
         "session_index": 0, "source_key": "bring-a-metre-of-calico"},
    ],
    "date_context": None,
}


def make_project(client, title="A Project"):
    return client.post("/api/projects", json={"title": title}).get_json()["id"]


def pdf_bytes(text="Construction workshop.\nBring fabric shears.\nBring a metre of calico."):
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), text)
    data = doc.tobytes()
    doc.close()
    return data


def docx_bytes(text="Construction workshop.\nBring fabric shears.\nBring a metre of calico."):
    document = docx.Document()
    for line in text.split("\n"):
        document.add_paragraph(line)
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue()


def import_document(client, project_id, data=None, filename="workshop.pdf"):
    return client.post(
        f"/api/projects/{project_id}/supporting-documents",
        data={"file": (io.BytesIO(data or pdf_bytes()), filename)},
        content_type="multipart/form-data",
    )


def _stub():
    return patch("supporting_docs.analyse", side_effect=lambda *a, **k: copy.deepcopy(SUPPORTING_DOC_EXTRACTION))


def test_importing_a_pdf_stores_the_extraction(client):
    pid = make_project(client)
    with _stub():
        resp = import_document(client, pid)
    assert resp.status_code == 200, resp.get_json()
    doc = resp.get_json()
    assert doc["project_id"] == pid
    assert doc["extracted"]["extraction"]["summary"] == SUPPORTING_DOC_EXTRACTION["summary"]
    assert doc["extracted"]["applied"] is None

    listed = client.get(f"/api/projects/{pid}/supporting-documents").get_json()
    assert [d["id"] for d in listed] == [doc["id"]]

    file_resp = client.get(f"/api/supporting-documents/{doc['id']}/file")
    assert file_resp.status_code == 200


def test_importing_a_docx_is_accepted(client):
    pid = make_project(client)
    with _stub():
        resp = import_document(client, pid, data=docx_bytes(), filename="materials.docx")
    assert resp.status_code == 200, resp.get_json()
    # extract_text ran for real against the .docx -- not stubbed -- so a
    # broken .docx path would show up as a 400, not here.
    assert resp.get_json()["extracted"]["extraction"]["summary"]


def test_a_non_pdf_non_docx_is_rejected(client):
    pid = make_project(client)
    resp = client.post(
        f"/api/projects/{pid}/supporting-documents",
        data={"file": (io.BytesIO(b"not a document"), "notes.txt")},
        content_type="multipart/form-data",
    )
    assert resp.status_code == 400
    assert db.list_supporting_documents(pid) == []


def test_a_broken_extraction_is_reported_not_stored_as_empty(client):
    pid = make_project(client)
    err = briefs.BriefExtractionError("truncated", "cut off before it finished")
    with patch("supporting_docs.analyse", side_effect=err):
        resp = import_document(client, pid)
    assert resp.status_code == 502
    body = resp.get_json()
    assert body["reason"] == "truncated"
    assert db.list_supporting_documents(pid) == []


def test_apply_creates_one_task_per_material_with_its_own_deadline(client):
    # The materials-list acceptance case: two distinct items in, two distinct
    # deadlined tasks out -- never one combined "gather materials" task.
    pid = make_project(client)
    with _stub():
        doc = import_document(client, pid).get_json()

    payload = {
        "preparation_tasks": [
            {"source_key": "bring-fabric-shears", "title": "Bring fabric shears",
             "due_date": "2026-09-23"},
            {"source_key": "bring-a-metre-of-calico", "title": "Bring a metre of calico",
             "due_date": "2026-09-23"},
        ],
    }
    resp = client.post(f"/api/supporting-documents/{doc['id']}/apply", json=payload)
    assert resp.status_code == 200, resp.get_json()

    tasks = client.get(f"/api/tasks?project_id={pid}").get_json()
    titles = sorted(t["title"] for t in tasks)
    assert titles == ["Bring a metre of calico", "Bring fabric shears"]
    assert all(t["deadline"] == "2026-09-23" for t in tasks)
    assert all(t["project_id"] == pid for t in tasks)

    applied = client.get(f"/api/supporting-documents/{doc['id']}").get_json()["extracted"]["applied"]
    assert len(applied["tasks"]) == 2


def test_a_session_never_becomes_a_task(client):
    # The "implies preparation" rule: the session itself is already on the
    # timetable and must never be created as a task -- apply only ever reads
    # `preparation_tasks`, so a body carrying nothing else creates nothing.
    pid = make_project(client)
    with _stub():
        doc = import_document(client, pid).get_json()

    resp = client.post(f"/api/supporting-documents/{doc['id']}/apply", json={})
    assert resp.status_code == 200
    assert client.get(f"/api/tasks?project_id={pid}").get_json() == []


def test_deleting_a_supporting_document_removes_the_row_and_file(client):
    pid = make_project(client)
    with _stub():
        doc = import_document(client, pid).get_json()

    resp = client.delete(f"/api/supporting-documents/{doc['id']}")
    assert resp.status_code == 200
    assert db.get_supporting_document(doc["id"]) is None
    assert client.get(f"/api/supporting-documents/{doc['id']}/file").status_code == 404


def test_deleting_the_project_clears_its_supporting_documents(client):
    pid = make_project(client)
    with _stub():
        import_document(client, pid)
    assert len(db.list_supporting_documents(pid)) == 1

    client.delete(f"/api/projects/{pid}")

    assert db.list_supporting_documents(pid) == []
