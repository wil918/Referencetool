"""Concept analysis: read a project's moodboard -- its measured CLIP clusters,
named and pushed lateral -- from a canvas selection.

analyze._send (the Claude call) is patched per-test to a canned writeup -- it is
the same call the plain Analyze action uses, and nothing else stubs it.
analyze.gather_context and analyze.graph_layout.build_graph are both patched to
skip the vector store (the embedding lookups they'd otherwise do would hit
real Chroma, the same isolation wart the estimation tests have) -- build_graph
stubbed empty means every test here exercises the "too few references for
meaningful clusters" fallback unless a test overrides the stub itself.
"""
import base64
import datetime
import io
import itertools
from unittest.mock import patch

import fitz
import pytest
from conftest import png_bytes
from PIL import Image
from test_portfolio import image_bytes, make_spread, slot, stage_id

import analyze
import config
import db
import ingest
import thumbnails

CANNED = (
    "READ\nThe canvas is still gathering its first direction.\n\n"
    "CLUSTERS\nCluster 0 shares a raw, unfinished surface.\n\n"
    "LATERAL DIRECTIONS\nCluster 0\n- Look at rust bloom on old machinery.\n\n"
    "THE WHOLE BODY\nOne cluster is carrying the whole board so far.\n\n"
    "NEXT ACTIONS\n"
    "- Photograph three rusted surfaces around the studio.\n"
    "- Add a swatch of raw canvas.\n"
)

_colours = itertools.count()
sent_max_tokens = []


def blocks_of(sent, call=0):
    """The first user turn as a list of blocks, whether it was sent as a plain
    string (nothing to show) or already as blocks."""
    content = sent[call][0]["content"]
    return [{"type": "text", "text": content}] if isinstance(content, str) else content


def prompt_of(sent, call=0):
    return blocks_of(sent, call)[0]["text"]


def images_of(blocks):
    return [b for b in blocks if b["type"] == "image"]


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
    sent_max_tokens.clear()

    def fake_send(messages, max_tokens=4096):
        sent.append(messages)
        sent_max_tokens.append(max_tokens)
        return CANNED

    monkeypatch.setattr(analyze, "_send", fake_send)
    monkeypatch.setattr(analyze, "gather_context", lambda refs: {})
    monkeypatch.setattr(
        analyze.graph_layout, "build_graph",
        lambda reference_ids=None: {"nodes": [], "edges": [], "planes": [], "cluster_count": 0},
    )
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

    prompt = prompt_of(_stub_claude)
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

    prompt = prompt_of(_stub_claude)
    # no brief imported -> the prompt says so rather than inventing one
    assert "THE BRIEF: none imported" in prompt
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

    prompt = prompt_of(_stub_claude)
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
    prompt = prompt_of(_stub_claude)
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
    prompt = prompt_of(_stub_claude)
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
    prompt = prompt_of(_stub_claude)
    assert "Loose thread about tension." in prompt
    assert "## Tension" in prompt


def test_an_imported_brief_is_stated_in_the_prompt(client, archive, _stub_claude):
    pid = make_project(client)
    add_reference(archive, client, pid, "swatch")
    db.create_brief(
        "b1", pid, extracted={"extraction": {"summary": "Explore deconstruction."}, "applied": None}
    )

    client.post(f"/api/projects/{pid}/concept-analysis", json={})
    prompt = prompt_of(_stub_claude)
    assert "Explore deconstruction." in prompt


def test_concept_analysis_needs_a_real_project(client):
    assert client.post("/api/projects/nope/concept-analysis", json={}).status_code == 404


def test_next_actions_are_pulled_out_of_the_trailing_heading(client, archive, _stub_claude):
    pid = make_project(client)
    add_reference(archive, client, pid, "swatch")

    resp = client.post(f"/api/projects/{pid}/concept-analysis", json={})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["next_actions"] == [
        "Photograph three rusted surfaces around the studio.",
        "Add a swatch of raw canvas.",
    ]
    # the prose transcript still carries the section -- extraction reads it,
    # it doesn't strip it back out
    assert "NEXT ACTIONS" in data["writeup"]


# --- measured clusters, not invented ones ---------------------------------


def test_clusters_are_fed_in_as_measured_structure(client, archive, _stub_claude, monkeypatch):
    """The prompt reasons over graph_layout's own CLIP clusters and the
    strongest cross-cluster edge, not over a grouping invented from titles."""
    pid = make_project(client)
    # conftest's tagging stub gives every image the same suggested title, which
    # ingest.py then prefers over an unrelated filename -- so the real titles
    # aren't "rust"/"bark"/"wallpaper" as added, just dedupe_title()'s take on
    # "Tagged Image" repeated three times. Read them back rather than assuming.
    rust = add_reference(archive, client, pid, "rust")
    bark = add_reference(archive, client, pid, "bark")
    wallpaper = add_reference(archive, client, pid, "wallpaper")
    rust_title = db.get_reference(rust)["title"]
    bark_title = db.get_reference(bark)["title"]
    wallpaper_title = db.get_reference(wallpaper)["title"]

    monkeypatch.setattr(
        analyze.graph_layout,
        "build_graph",
        lambda reference_ids=None: {
            "nodes": [
                {"id": rust, "cluster": 0, "title": rust_title, "tags": [], "type": "image"},
                {"id": bark, "cluster": 0, "title": bark_title, "tags": [], "type": "image"},
                {"id": wallpaper, "cluster": 1, "title": wallpaper_title, "tags": [], "type": "image"},
            ],
            "edges": [{"source": rust, "target": wallpaper, "score": 0.7, "cross_cluster": True}],
            "planes": [],
            "cluster_count": 2,
        },
    )
    monkeypatch.setattr(
        analyze.colour, "colour_map",
        lambda include_ids=None: {"nodes": [], "radius": 0, "height": 0, "hue_ticks": []},
    )

    resp = client.post(
        f"/api/projects/{pid}/concept-analysis",
        json={"reference_ids": [rust, bark, wallpaper]},
    )
    assert resp.status_code == 200
    prompt = prompt_of(_stub_claude)

    assert "MEASURED CLUSTERS" in prompt
    assert "CLUSTER 0 (2 references):" in prompt
    assert "CLUSTER 1 (1 reference):" in prompt
    assert prompt.count(f'"{rust_title}"') >= 1
    assert prompt.count(f'"{wallpaper_title}"') >= 1
    assert (
        f'CLOSEST TWO CLUSTERS: cluster 0 and cluster 1 come nearest to touching, '
        f'via "{rust_title}" and "{wallpaper_title}".' in prompt
    )
    # the weak-link framing is gone -- no reference is ever asked to justify itself
    assert "weak link" not in prompt.lower()
    assert "argues for" not in prompt.lower()


# --- stage awareness -------------------------------------------------------


def test_stage_context_reports_elapsed_remaining_and_deliverable_progress(client, archive):
    pid = make_project(client)
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=10)).isoformat()
    end = (today + datetime.timedelta(days=5)).isoformat()
    extraction = {
        "summary": "",
        "key_dates": [
            {"label": "Briefing", "date": start, "kind": "briefing"},
            {"label": "Hand-in", "date": end, "kind": "hand-in"},
        ],
        "deliverables": [],
    }

    db.create_deliverable("d-stage", pid, "Part 1")
    db.create_task("t1", "Task one", project_id=pid, deliverable_id="d-stage", status="done")
    db.create_task("t2", "Task two", project_id=pid, deliverable_id="d-stage", status="pending")

    stage = analyze._project_stage_context(pid, extraction)
    assert stage["days_elapsed"] == 10
    assert stage["days_remaining"] == 5
    assert stage["deliverables"] == [
        {"title": "Part 1", "due_at": None, "task_count": 2, "tasks_resolved": 1, "is_done": False}
    ]
    assert isinstance(stage["at_risk"], list)


# --- the plain Analyze action is untouched -------------------------------


def test_analyze_action_still_returns_its_original_shape(client, archive, _stub_claude):
    pid = make_project(client)
    ref_id = add_reference(archive, client, pid, "ref")

    resp = client.post("/api/analyze", json={"reference_ids": [ref_id], "mode": "full"})
    assert resp.status_code == 200
    data = resp.get_json()
    assert set(data) == {"analysis_id", "writeup", "references"}
    assert data["writeup"] == CANNED


# --- the model is shown images, not just captions --------------------------
#
# conftest stubs every Claude call, so these assert against the blocks that
# WOULD have been sent: what the model sees is the whole point of the change.


def decode(block):
    return Image.open(io.BytesIO(base64.b64decode(block["source"]["data"])))


def run_whole_project(client, pid, **body):
    resp = client.post(f"/api/projects/{pid}/concept-analysis", json=body)
    assert resp.status_code == 200, resp.get_json()


def named_images(blocks):
    """[(label, image block)] -- asserting, on the way, that every image has a
    text block directly before it to say what it is."""
    out = []
    for i, block in enumerate(blocks):
        if block["type"] == "image":
            assert blocks[i - 1]["type"] == "text", "an image with no name before it"
            out.append((blocks[i - 1]["text"], block))
    return out


def stage_pages(client, pid, *colours):
    return [
        stage_id(client, pid, data=image_bytes(colour=c), name=f"p{i}.png")
        for i, c in enumerate(colours)
    ]


def spread_at(client, pid, z_index, pages):
    """A spread with an explicit canvas order. Spreads sort by (z_index, id) and
    ids are uuids, so two at the default z_index come out in no stable order --
    a test that cares which is 'spread 1' has to say."""
    resp = client.post(
        f"/api/projects/{pid}/canvas/nodes",
        json={"kind": "pages", "x": 0, "y": 0, "w": 900, "h": 500, "z_index": z_index,
              "config": {"layout": "sequential", "orientation": "portrait", "cover": True,
                         "gap": 0.12, "pages": pages}},
    )
    assert resp.status_code == 200, resp.get_json()
    return resp.get_json()


def mean_red(block):
    return decode(block).convert("RGB").getpixel((5, 5))[0]


def test_placed_pages_are_sent_in_document_order_each_named(client, archive, _stub_claude):
    pid = make_project(client)
    a, b, c = stage_pages(client, pid, (10, 0, 0), (100, 0, 0), (200, 0, 0))
    spread_at(client, pid, 1, [slot(a), slot(), slot(b)])
    spread_at(client, pid, 2, [slot(c)])

    run_whole_project(client, pid)
    blocks = blocks_of(_stub_claude)

    assert blocks[0]["type"] == "text"
    pages = named_images(blocks)
    assert [label for label, _ in pages] == [
        "Page 1 of 3, spread 1", "Page 2 of 3, spread 1", "Page 3 of 3, spread 2",
    ]
    assert [mean_red(img) for _, img in pages] == [10, 100, 200]
    assert "THE STUDENT'S OWN WORK" in blocks[0]["text"]


def test_a_replaced_page_sends_only_its_replacement(client, archive, _stub_claude):
    pid = make_project(client)
    v1 = stage_id(client, pid, data=image_bytes(colour=(10, 0, 0)), name="cover.png")
    make_spread(client, pid, [slot(v1)])
    client.post(
        f"/api/portfolio/pages/{v1}/replace",
        data={"file": (io.BytesIO(image_bytes(colour=(200, 0, 0))), "cover.png")},
        content_type="multipart/form-data",
    )
    assert len(db.list_portfolio_pages(pid)) == 2  # the store keeps both versions

    run_whole_project(client, pid)
    [(label, image)] = named_images(blocks_of(_stub_claude))
    assert label == "Page 1 of 1, spread 1"
    assert mean_red(image) == 200


def test_an_unplaced_page_is_never_sent(client, archive, _stub_claude):
    pid = make_project(client)
    placed, waiting = stage_pages(client, pid, (10, 0, 0), (200, 0, 0))
    make_spread(client, pid, [slot(placed)])

    run_whole_project(client, pid)
    [(_, image)] = named_images(blocks_of(_stub_claude))
    assert mean_red(image) == 10


def test_pages_over_the_cap_are_cut_from_the_end_and_the_prompt_says_so(
    client, archive, _stub_claude, monkeypatch
):
    monkeypatch.setattr(analyze, "MAX_ANALYSIS_PAGES", 2)
    pid = make_project(client)
    ids = stage_pages(client, pid, (10, 0, 0), (100, 0, 0), (200, 0, 0))
    make_spread(client, pid, [slot(i) for i in ids])

    run_whole_project(client, pid)
    blocks = blocks_of(_stub_claude)
    assert [mean_red(img) for _, img in named_images(blocks)] == [10, 100]
    assert "Only the first 2 pages are shown; 1 more exist" in blocks[0]["text"]


def test_selecting_a_spread_narrows_the_pages_but_not_the_research(client, archive, _stub_claude):
    pid = make_project(client)
    a, b = stage_pages(client, pid, (10, 0, 0), (200, 0, 0))
    spread_at(client, pid, 1, [slot(a)])
    second = spread_at(client, pid, 2, [slot(b)])
    add_reference(archive, client, pid, "research")

    run_whole_project(client, pid, spread_node_ids=[second["id"]])
    labelled = named_images(blocks_of(_stub_claude))
    pages = [(label, img) for label, img in labelled if label.startswith("Page")]
    assert [(label, mean_red(img)) for label, img in pages] == [("Page 1 of 1, spread 2", 200)]
    # lassoing only a spread is not a research selection: the whole project's
    # research is still read against that chapter
    assert len([1 for label, _ in labelled if label.startswith("Research image")]) == 1


def test_the_concept_path_asks_for_the_larger_response(client, archive, _stub_claude):
    pid = make_project(client)
    add_reference(archive, client, pid, "ref")
    run_whole_project(client, pid)
    assert sent_max_tokens[-1] == analyze.CONCEPT_MAX_TOKENS == 8192


# --- the research is seen, not only described ------------------------------


def big_reference(archive, client, pid, name, size):
    path = archive / f"{name}.png"
    path.write_bytes(png_bytes((next(_colours) % 256, 30, 90), size=size))
    ref_id = ingest.add_reference(path, title=name, force=True)["id"]
    db.add_reference_to_project(pid, ref_id)
    return ref_id


def test_an_image_reference_gets_an_image_beside_its_text(client, archive, _stub_claude):
    pid = make_project(client)
    ref_id = add_reference(archive, client, pid, "tailoring")
    title = db.get_reference(ref_id)["title"]

    run_whole_project(client, pid)
    blocks = blocks_of(_stub_claude)
    [(label, _)] = named_images(blocks)
    assert label == f'Research image: "{title}"'
    assert f'- "{title}" (image)' in blocks[0]["text"]  # the caption is kept, not replaced
    assert "what you see governs" in blocks[0]["text"]


def test_a_text_reference_gets_text_and_no_image(client, archive, _stub_claude):
    pid = make_project(client)
    note = archive / "notes.txt"
    note.write_text("A paragraph about pattern cutting.")
    ref_id = ingest.add_reference(note, title="notes", force=True)["id"]
    db.add_reference_to_project(pid, ref_id)

    run_whole_project(client, pid)
    content = _stub_claude[0][0]["content"]
    assert isinstance(content, str)  # nothing to show, so nothing to wrap
    assert "(text)" in content


def test_a_reference_whose_file_is_missing_degrades_to_text(client, archive, _stub_claude):
    pid = make_project(client)
    add_reference(archive, client, pid, "present")
    gone = add_reference(archive, client, pid, "gone")
    (config.REFERENCES_DIR / db.get_reference(gone)["filepath"]).unlink()

    run_whole_project(client, pid)
    blocks = blocks_of(_stub_claude)
    assert len(named_images(blocks)) == 1
    assert blocks[0]["text"].count("(image)") == 2  # both still described


def test_a_pdf_reference_sends_its_first_page(client, archive, _stub_claude):
    pid = make_project(client)
    pdf = archive / "lookbook.pdf"
    doc = fitz.open()
    doc.new_page().insert_text((72, 72), "Lookbook")
    doc.new_page()
    doc.save(pdf)
    ref_id = ingest.add_reference(pdf, title="lookbook", force=True)["id"]
    db.add_reference_to_project(pid, ref_id)

    run_whole_project(client, pid)
    [(_, image)] = named_images(blocks_of(_stub_claude))
    assert max(decode(image).size) == thumbnails.ANALYSIS_REFERENCE_EDGE


def test_images_are_cut_to_the_edge_their_role_needs(client, archive, _stub_claude):
    pid = make_project(client)
    big_reference(archive, client, pid, "wide", (2400, 1200))
    page = stage_id(client, pid, data=image_bytes(size=(2480, 3508)), name="big.png")
    make_spread(client, pid, [slot(page)])

    run_whole_project(client, pid)
    sizes = {label.split(" ")[0]: decode(img).size for label, img in named_images(blocks_of(_stub_claude))}
    assert sizes["Research"] == (600, 300)
    assert max(sizes["Page"]) == thumbnails.ANALYSIS_PAGE_EDGE == 1000


def clustered(monkeypatch, assignment):
    """Stub build_graph so that {cluster: [ref ids]} is the measured grouping."""
    nodes = [
        {"id": rid, "cluster": cluster, "title": rid, "tags": [], "type": "image"}
        for cluster, rids in assignment.items() for rid in rids
    ]
    monkeypatch.setattr(
        analyze.graph_layout, "build_graph",
        lambda reference_ids=None: {"nodes": nodes, "edges": [], "planes": [], "cluster_count": len(assignment)},
    )
    monkeypatch.setattr(
        analyze.colour, "colour_map",
        lambda include_ids=None: {"nodes": [], "radius": 0, "height": 0, "hue_ticks": []},
    )


def test_truncation_takes_from_every_cluster_not_the_front(
    client, archive, _stub_claude, monkeypatch
):
    monkeypatch.setattr(analyze, "MAX_ANALYSIS_REFERENCES", 3)
    pid = make_project(client)
    a = [add_reference(archive, client, pid, f"a{i}") for i in range(3)]
    b = [add_reference(archive, client, pid, "b0")]
    c = [add_reference(archive, client, pid, "c0")]
    clustered(monkeypatch, {0: a, 1: b, 2: c})

    run_whole_project(client, pid)
    blocks = blocks_of(_stub_claude)
    headings = [b_["text"] for b_ in blocks if b_["type"] == "text" and b_["text"].startswith("RESEARCH IMAGES")]
    # a front-first cut would have been all of cluster 0; this reaches all three
    assert sorted(headings) == [
        "RESEARCH IMAGES -- CLUSTER 0:", "RESEARCH IMAGES -- CLUSTER 1:", "RESEARCH IMAGES -- CLUSTER 2:",
    ]
    assert len(named_images(blocks)) == 3
    assert "Only 3 of 5 image references are shown" in blocks[0]["text"]


def test_research_images_are_grouped_in_the_order_the_clusters_are_printed(
    client, archive, _stub_claude, monkeypatch
):
    pid = make_project(client)
    small = [add_reference(archive, client, pid, "s0")]
    large = [add_reference(archive, client, pid, f"l{i}") for i in range(2)]
    # the clusters are printed largest first: 1 (two members), then 0
    clustered(monkeypatch, {0: small, 1: large})

    run_whole_project(client, pid)
    blocks = blocks_of(_stub_claude)
    prompt = blocks[0]["text"]
    assert prompt.index("CLUSTER 1 (2 references)") < prompt.index("CLUSTER 0 (1 reference)")
    headings = [b["text"] for b in blocks if b["type"] == "text" and b["text"].startswith("RESEARCH IMAGES")]
    assert headings == ["RESEARCH IMAGES -- CLUSTER 1:", "RESEARCH IMAGES -- CLUSTER 0:"]


# --- both together ----------------------------------------------------------


def test_a_promoted_page_that_is_also_selected_is_sent_once_as_the_reference(
    client, archive, _stub_claude
):
    pid = make_project(client)
    page = stage_id(client, pid, data=image_bytes(colour=(50, 0, 0)), name="Final Cover.png")
    make_spread(client, pid, [slot(page)])
    with patch("tagging.tag_image", return_value=("Tagged Image", ["cover"], "the final cover")):
        ref_id = client.post(f"/api/portfolio/pages/{page}/promote").get_json()["reference_id"]
    db.add_reference_to_project(pid, ref_id)

    run_whole_project(client, pid, reference_ids=[ref_id])
    [(label, _)] = named_images(blocks_of(_stub_claude))
    assert label.startswith("Research image")  # the reference, which carries tags and a title


def test_a_promoted_page_that_was_not_selected_is_still_a_page(client, archive, _stub_claude):
    pid = make_project(client)
    page = stage_id(client, pid, data=image_bytes(colour=(50, 0, 0)), name="Final Cover.png")
    make_spread(client, pid, [slot(page)])
    with patch("tagging.tag_image", return_value=("Tagged Image", ["cover"], "the final cover")):
        client.post(f"/api/portfolio/pages/{page}/promote")
    other = add_reference(archive, client, pid, "other")

    run_whole_project(client, pid, reference_ids=[other])
    labels = [label for label, _ in named_images(blocks_of(_stub_claude))]
    assert any(label.startswith("Page 1 of 1") for label in labels)


def test_the_second_identical_analysis_reuses_the_thumbnail_cache(client, archive, _stub_claude):
    pid = make_project(client)
    add_reference(archive, client, pid, "ref")
    page = stage_id(client, pid, name="p.png")
    make_spread(client, pid, [slot(page)])

    run_whole_project(client, pid)
    cached = {p: p.stat().st_mtime_ns for p in config.THUMBNAILS_DIR.iterdir()}
    assert len(cached) == 2  # one per role, each at its own size

    run_whole_project(client, pid)
    assert {p: p.stat().st_mtime_ns for p in config.THUMBNAILS_DIR.iterdir()} == cached
    assert blocks_of(_stub_claude, 0) == blocks_of(_stub_claude, 1)


def test_follow_ups_ride_on_the_same_history_with_the_images_still_in_it(
    client, archive, _stub_claude
):
    pid = make_project(client)
    add_reference(archive, client, pid, "ref")
    resp = client.post(f"/api/projects/{pid}/concept-analysis", json={})
    client.post(f"/api/analyze/{resp.get_json()['analysis_id']}/reply", json={"message": "Which page?"})

    history = _stub_claude[1]
    assert isinstance(history[0]["content"], list) and named_images(history[0]["content"])
    # the list is mutated in place, so the reply is last and the question before it
    assert history[-2] == {"role": "user", "content": "Which page?"}


# --- the prompt text --------------------------------------------------------


def test_with_nothing_to_show_the_prompt_is_a_plain_string_without_the_new_sections(
    client, archive, _stub_claude
):
    pid = make_project(client)
    run_whole_project(client, pid)
    content = _stub_claude[0][0]["content"]

    assert isinstance(content, str)
    assert "THE BRIEF: none imported -- read the work on its own terms." in content
    for absent in ("THE STUDENT'S OWN WORK", "The research images follow", "pages together", "Say how much of the work"):
        assert absent not in content
    # the section list is as it was
    for heading in ("READ --", "CLUSTERS --", "LATERAL DIRECTIONS --", "THE WHOLE BODY --", "NEXT ACTIONS --"):
        assert heading in content
    assert '("add garment research on trench coats")' in content


def test_the_word_compliance_is_nowhere_and_deliverables_are_not_audited(client, archive, _stub_claude):
    pid = make_project(client)
    db.create_brief(
        "b1", pid,
        extracted={"extraction": {"summary": "Explore deconstruction.", "deliverables": [
            {"title": "Research portfolio", "description": "A research portfolio."},
        ]}, "applied": None},
    )
    db.create_deliverable("d1", pid, "Research portfolio")
    db.create_deliverable("d2", pid, "Final garment")
    db.create_task("t1", "One", project_id=pid, deliverable_id="d1", status="done")
    db.create_task("t2", "Two", project_id=pid, deliverable_id="d1", status="pending")
    page = stage_id(client, pid)
    make_spread(client, pid, [slot(page)])
    add_reference(archive, client, pid, "ref")

    run_whole_project(client, pid)
    prompt = prompt_of(_stub_claude)

    assert "compliance" not in prompt.lower()
    assert "Explore deconstruction." in prompt  # the brief still frames the reading
    assert "Deliverables not yet complete: Research portfolio; Final garment." in prompt
    assert "tasks resolved" not in prompt and "1/2" not in prompt
    assert "not a checklist" in prompt
    # the timing judgement survives, rewritten rather than removed
    assert "in week five it is the finding" in prompt
    # and the whole body now judges research and pages together
    assert "does the work carry the research" in prompt
    assert "the peeling-wallpaper cluster has no page -- make one" in prompt
