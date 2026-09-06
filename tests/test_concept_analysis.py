"""Concept analysis: critique a project's concept against its brief, from a
canvas selection.

analyze._send (the Claude call) is patched per-test to a canned writeup -- it is
the same call the plain Analyze action uses, and nothing else stubs it.
analyze.gather_context is patched to skip the vector store (the embedding
lookups it does would otherwise hit real Chroma, the same isolation wart the
estimation tests have).
"""
import itertools

import pytest
from conftest import png_bytes

import analyze
import db
import ingest

CANNED = (
    "Strong connections\nThe tailoring references carry the silhouette claim.\n\n"
    "Asserted, not demonstrated\nThe 'movement' note has no reference behind it.\n\n"
    "The weak link\nThe runway snapshot argues for nothing.\n\n"
    "Research directions\nLook at 1980s pattern-cutting manuals."
)

_colours = itertools.count()


def make_project(client, title="A Project"):
    return client.post("/api/projects", json={"title": title}).get_json()["id"]


def add_reference(archive, client, project_id, name):
    n = next(_colours)
    path = archive / f"{name}.png"
    path.write_bytes(png_bytes((n % 256, (n // 256) % 256, 90)))
    ref_id = ingest.add_reference(path, title=name)["id"]
    db.add_reference_to_project(project_id, ref_id)
    return ref_id


@pytest.fixture(autouse=True)
def _stub_claude(monkeypatch):
    sent = []

    def fake_send(messages):
        sent.append(messages)
        return CANNED

    monkeypatch.setattr(analyze, "_send", fake_send)
    monkeypatch.setattr(analyze, "gather_context", lambda refs: {})
    return sent


# --- the analysis --------------------------------------------------------


def test_selection_of_refs_and_notes_produces_a_critique(client, archive, _stub_claude):
    pid = make_project(client)
    ref_id = add_reference(archive, client, pid, "tailoring")

    resp = client.post(
        f"/api/projects/{pid}/concept-analysis",
        json={
            "reference_ids": [ref_id],
            "notes": ["The collection is about movement.", "  "],
        },
    )
    assert resp.status_code == 200, resp.get_json()
    data = resp.get_json()
    assert data["writeup"] == CANNED
    assert data["analysis_id"]

    prompt = _stub_claude[0][0]["content"]
    assert "VISUAL RESEARCH" in prompt
    assert "The collection is about movement." in prompt
    # the blank note was dropped
    assert prompt.count("about movement") == 1

    # follow-ups go through the existing reply route unchanged
    reply = client.post(
        f"/api/analyze/{data['analysis_id']}/reply", json={"message": "Say more about the weak link."}
    )
    assert reply.status_code == 200
    assert reply.get_json()["reply"] == CANNED


def test_empty_selection_falls_back_to_the_whole_project(client, archive, _stub_claude):
    pid = make_project(client)
    add_reference(archive, client, pid, "one")
    add_reference(archive, client, pid, "two")

    resp = client.post(f"/api/projects/{pid}/concept-analysis", json={})
    assert resp.status_code == 200

    prompt = _stub_claude[0][0]["content"]
    # no brief imported -> the prompt says so rather than inventing one
    assert "no brief" in prompt.lower()
    # both project references were pulled in (conftest's tag stub titles every
    # image the same, so count the formatted lines rather than the titles)
    assert prompt.count("(image)") == 2


def test_notepad_html_reaches_the_prompt_with_headings_kept(client, archive, _stub_claude):
    pid = make_project(client)
    add_reference(archive, client, pid, "swatch")

    html = (
        '<span style="font-size: 1.5rem; font-weight: 700;">Movement</span>'
        '<span style="color: rgb(20,20,20);"> is the whole point of the drape.</span>'
    )
    resp = client.post(
        f"/api/projects/{pid}/concept-analysis",
        json={"note_html": [html]},
    )
    assert resp.status_code == 200

    prompt = _stub_claude[0][0]["content"]
    assert "## Movement" in prompt
    assert "is the whole point of the drape." in prompt
    # the style attributes did not come through
    assert "rgb(20,20,20)" not in prompt
    assert "font-size" not in prompt


def test_text_nodes_and_notepads_are_both_the_thinking(client, archive, _stub_claude):
    pid = make_project(client)
    add_reference(archive, client, pid, "ref")

    resp = client.post(
        f"/api/projects/{pid}/concept-analysis",
        json={
            "reference_ids": [],
            "notes": ["A plain text node."],
            "note_html": ['<span style="font-weight: 700;">A notepad line.</span>'],
        },
    )
    assert resp.status_code == 200
    prompt = _stub_claude[0][0]["content"]
    assert "A plain text node." in prompt
    assert "A notepad line." in prompt


def test_a_prior_analysis_widget_is_labelled_as_earlier_ai_output(client, archive, _stub_claude):
    pid = make_project(client)
    add_reference(archive, client, pid, "ref")
    db.save_analysis(
        "prev1",
        pid,
        ["r1"],
        [
            {"kind": "writeup", "text": "The silhouette is under-argued."},
            {"kind": "question", "text": "Which reference is weakest?"},
        ],
    )

    resp = client.post(
        f"/api/projects/{pid}/concept-analysis",
        json={"notes": ["My concept holds together."], "prior_analysis_ids": ["prev1"]},
    )
    assert resp.status_code == 200
    prompt = _stub_claude[0][0]["content"]
    assert "EARLIER AI CRITIQUE" in prompt
    assert "The silhouette is under-argued." in prompt
    # the student's own follow-up question from that transcript is not fed back
    assert "Which reference is weakest?" not in prompt


def test_empty_selection_also_picks_up_canvas_text(client, archive, _stub_claude):
    pid = make_project(client)
    add_reference(archive, client, pid, "one")

    db.create_canvas_node("n-text", pid, "text", content="Loose thread about tension.")
    db.create_canvas_node(
        "n-pad",
        pid,
        "widget",
        config={
            "type": "notepad",
            "widget": {"content": '<span style="font-size: 1.6rem;">Tension</span>'},
        },
    )
    db.create_canvas_node(
        "n-view",
        pid,
        "widget",
        config={"type": "colourspace", "widget": {}},
    )

    resp = client.post(f"/api/projects/{pid}/concept-analysis", json={})
    assert resp.status_code == 200
    prompt = _stub_claude[0][0]["content"]
    assert "Loose thread about tension." in prompt
    assert "## Tension" in prompt


def test_an_imported_brief_is_stated_in_the_prompt(client, archive, _stub_claude):
    pid = make_project(client)
    add_reference(archive, client, pid, "swatch")
    db.create_brief(
        "b1", pid, extracted={"extraction": {"summary": "Explore deconstruction."}, "applied": None}
    )

    client.post(f"/api/projects/{pid}/concept-analysis", json={})
    prompt = _stub_claude[0][0]["content"]
    assert "Explore deconstruction." in prompt


def test_concept_analysis_needs_a_real_project(client):
    assert client.post("/api/projects/nope/concept-analysis", json={}).status_code == 404


# --- the plain Analyze action is untouched -------------------------------


def test_analyze_action_still_returns_its_original_shape(client, archive, _stub_claude):
    pid = make_project(client)
    ref_id = add_reference(archive, client, pid, "ref")

    resp = client.post("/api/analyze", json={"reference_ids": [ref_id], "mode": "full"})
    assert resp.status_code == 200
    data = resp.get_json()
    assert set(data) == {"analysis_id", "writeup", "references"}
    assert data["writeup"] == CANNED
