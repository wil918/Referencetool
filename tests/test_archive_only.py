"""The three ways a copy of the app can be configured to do less: no schedule
(ARCHIVE_ONLY), no Anthropic key, no embeddings (SKIP_EMBEDDINGS).

All three default to today's behaviour, so the first job of every group here is
to show that "on" is unchanged; the rest show what "off" does and, as
importantly, what it leaves alone.

Schedule-off is the awkward one to test, because the routes are registered by
decorators at import: the `archive_only_client` fixture sets the flag, reloads
`app`, and reloads it again once the flag is restored so no other test sees a
half-built app.
"""
import importlib
import io
import json
import re
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest

from conftest import png_bytes

import config
import db
import embeddings
import ingest
import tagging

STATIC = Path(__file__).resolve().parents[1] / "static"


# --- fixtures -----------------------------------------------------------------


@pytest.fixture
def archive_only_client(archive):
    import app as flask_app

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(config, "ARCHIVE_ONLY", True)
        importlib.reload(flask_app)
        flask_app.app.config["TESTING"] = True
        try:
            with flask_app.app.test_client() as c:
                yield c
        finally:
            pass
    importlib.reload(flask_app)


@pytest.fixture
def no_key(archive, monkeypatch):
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", None)


@pytest.fixture
def no_embeddings(archive, monkeypatch):
    monkeypatch.setattr(config, "SKIP_EMBEDDINGS", True)


def _png(tmp_path, name="look-12.png", colour=(120, 80, 60)):
    path = tmp_path / name
    path.write_bytes(png_bytes(colour=colour))
    return path


def _seed(title, tags=(), description=None, type_="image", filepath=None):
    ref_id = str(uuid.uuid4())
    db.insert_reference(
        ref_id=ref_id, type_=type_, filepath=filepath or f"images/{ref_id}.png", title=title,
        source=None, tags=list(tags), description=description, notes=None,
    )
    return ref_id


def _url_rules(flask_app):
    return {(r.rule, m) for r in flask_app.url_map.iter_rules() for m in r.methods - {"HEAD", "OPTIONS"}}


# --- the schedule switch -----------------------------------------------------------


def test_schedule_on_is_the_default_and_unchanged(client):
    assert client.get("/").data == (STATIC / "schedule.html").read_bytes()
    assert client.get("/day").status_code == 200
    assert client.get("/schedule.html").status_code == 200
    assert client.get("/api/tasks").status_code == 200
    assert client.get("/api/capabilities").get_json()["schedule"] is True


def test_schedule_off_serves_the_archive_as_the_homepage(archive_only_client):
    response = archive_only_client.get("/")
    assert response.status_code == 200
    assert response.data == (STATIC / "index.html").read_bytes()


def test_schedule_off_registers_none_of_the_schedule_routes(client, archive_only_client):
    import app as flask_app  # the reloaded, schedule-off app

    off = _url_rules(flask_app.app)
    # The full set is rebuilt from a fresh schedule-on import: any route the
    # blueprint owns is in it and not in `off`.
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(config, "ARCHIVE_ONLY", False)
        importlib.reload(flask_app)
        on = _url_rules(flask_app.app)
    importlib.reload(flask_app)  # back to schedule-off for the fixture's teardown order

    missing = on - off
    assert len(missing) > 80  # the schedule is most of the API
    for rule in ("/day", "/api/tasks", "/api/schedule", "/api/commitments", "/api/locations",
                 "/api/resources", "/api/recurrence-rules", "/api/working-hours",
                 "/api/projects/<project_id>/deliverables", "/api/projects/<project_id>/briefs",
                 "/api/tasks/generate", "/api/schedule/reset"):
        assert any(r == rule for r, _ in missing), rule
    # ... and nothing outside the schedule went with it.
    assert off <= on
    for rule in ("/api/references", "/api/projects", "/api/similarity/graph", "/api/colour/map",
                 "/api/portfolio/pages/<page_id>/thumb", "/api/captures", "/api/health", "/api/analyze"):
        assert any(r == rule for r, _ in off), rule


def test_schedule_off_its_api_answers_like_a_path_that_never_existed(archive_only_client):
    c = archive_only_client
    assert c.get("/api/definitely-not-a-route").status_code == 404
    for method, url in (
        ("get", "/api/tasks"), ("get", "/api/schedule"), ("get", "/api/commitments"),
        ("get", "/api/resources"), ("get", "/day"),
    ):
        assert getattr(c, method)(url).status_code == 404, url
    # A non-GET under /api/ is a 405 for *every* unknown path (the CORS
    # preflight catch-all matches it), so that is the baseline, not a leak.
    baseline = c.post("/api/definitely-not-a-route", json={}).status_code
    assert baseline in (404, 405)
    for method, url in (("post", "/api/tasks"), ("put", "/api/tasks/x"), ("delete", "/api/tasks/x"),
                        ("post", "/api/schedule/plan"), ("post", "/api/tasks/generate")):
        assert getattr(c, method)(url, json={}).status_code == baseline, url


def test_schedule_off_the_archive_still_works(archive_only_client):
    c = archive_only_client
    assert c.get("/api/references").status_code == 200
    assert c.get("/api/projects").status_code == 200
    created = c.post("/api/projects", json={"title": "Capsule"})
    assert created.status_code in (200, 201)
    assert c.get("/index.html").status_code == 200
    assert c.get("/graph.html").status_code == 200
    assert c.get("/project.html").status_code == 200


def test_schedule_off_its_tables_are_still_created(archive_only_client):
    # init_db() is left alone on purpose: empty tables cost nothing and keep the
    # switch reversible by editing one value.
    assert db.list_tasks() == []


def test_schedule_off_its_pages_are_not_served(archive_only_client):
    c = archive_only_client
    denied = [
        "/schedule.html", "/day.html", "/sw.js", "/manifest.webmanifest", "/drafting.css",
        "/tasks.js", "/commitments.js", "/locations.js", "/calendar-import.js",
        "/icons/icon-192.png",
    ] + [f"/schedule/{p.name}" for p in (STATIC / "schedule").iterdir()]
    for path in denied:
        assert c.get(path).status_code == 404, path


@pytest.mark.parametrize("path", [
    "/./schedule.html",          # normalises to schedule.html inside send_from_directory
    "/Schedule.html",            # the same file on a case-insensitive volume
    "/SCHEDULE.HTML",
    "/schedule/../schedule.html",
    "/Schedule/main.js",
    "/ICONS/icon-192.png",
    "//schedule.html",
])
def test_schedule_off_cannot_be_walked_around(archive_only_client, path):
    assert archive_only_client.get(path).status_code != 200


def _asset_refs(html_path):
    """What an HTML page loads: <script src> and <link href>, not anchors."""
    html = html_path.read_text(encoding="utf-8")
    refs = re.findall(r'<script[^>]+src="([^"]+)"', html)
    refs += re.findall(r'<link[^>]+href="([^"]+)"', html)
    return [r for r in refs if r.startswith("/") and not r.startswith("//")]


def test_schedule_off_no_page_it_still_serves_loads_a_hidden_asset(archive_only_client):
    """The denylist must cover everything the schedule's pages load, and no
    page left standing may depend on one of them -- a broken <script> in
    index.html would be the quiet way for this switch to go wrong."""
    c = archive_only_client
    for page in STATIC.glob("*.html"):
        if c.get(f"/{page.name}").status_code == 404:
            continue  # a schedule page: allowed to load schedule assets
        for ref in _asset_refs(page):
            if ref == "/capabilities.js":
                continue
            assert c.get(ref.split("?")[0]).status_code == 200, f"{page.name} loads {ref}"


def test_schedule_pages_dependencies_are_all_denied_when_off(archive_only_client):
    """Everything the schedule pages themselves load that lives beside them is
    hidden too, so nothing of the surface is reachable by its own URL."""
    c = archive_only_client
    for page in ("schedule.html", "day.html"):
        for ref in _asset_refs(STATIC / page):
            path = ref.split("?")[0]
            if path.startswith(("/vendor/", "/capabilities.js")) or path in ("/style.css", "/theme.js", "/ui-effects.js"):
                continue  # shared with pages that stay
            assert c.get(path).status_code == 404, f"{page} loads {path}, which is still served"


def test_schedule_off_reports_itself_in_capabilities(archive_only_client):
    caps = archive_only_client.get("/api/capabilities").get_json()
    assert caps == {"schedule": False, "claude": True, "embeddings": True}
    script = archive_only_client.get("/capabilities.js")
    assert script.mimetype == "text/javascript"
    assert script.headers["Cache-Control"] == "no-store"
    assert '"schedule": false' in script.get_data(as_text=True)


def test_desktop_opens_the_root(archive_only_client):
    """desktop.py loads http://127.0.0.1:<port>/ and nothing else, so it lands on
    whatever `/` serves -- the archive, with the schedule off."""
    source = (Path(__file__).resolve().parents[1] / "desktop.py").read_text()
    assert 'webview.create_window("Fashion Reference Library", f"http://{HOST}:{PORT}"' in source


# --- capabilities --------------------------------------------------------------------


def test_capabilities_all_on_sets_nothing_on_the_page(client):
    caps = client.get("/api/capabilities").get_json()
    assert caps == {"schedule": True, "claude": True, "embeddings": True}
    assert '"claude": true' in client.get("/capabilities.js").get_data(as_text=True)


def test_capabilities_follow_the_key_and_the_embeddings_flag(client, monkeypatch):
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(config, "SKIP_EMBEDDINGS", True)
    assert client.get("/api/capabilities").get_json() == {
        "schedule": True, "claude": False, "embeddings": False,
    }


def test_flags_default_to_off_and_parse_the_usual_spellings(monkeypatch):
    for value, expected in (("1", True), ("true", True), ("YES", True), ("on", True),
                            ("", False), ("0", False), ("no", False), ("false", False)):
        monkeypatch.setenv("SOME_FLAG", value)
        assert config._env_flag("SOME_FLAG") is expected, value
    monkeypatch.delenv("SOME_FLAG")
    assert config._env_flag("SOME_FLAG") is False


# --- no key: adding a reference ------------------------------------------------------------


def test_add_without_a_key_stores_the_file_and_a_row_titled_by_filename(no_key, tmp_path):
    source = _png(tmp_path, "look-12.png")
    with patch("tagging.tag_image") as tag:
        result = ingest.add_reference(source)

    tag.assert_not_called()
    assert result["title"] == "look-12"
    assert result["tags"] == [] and result["description"] == ""
    row = db.get_reference(result["id"])
    assert row["title"] == "look-12" and row["tags"] == [] and not row["description"]
    assert (config.REFERENCES_DIR / row["filepath"]).exists()  # stored, not just inserted
    assert row["content_hash"]  # so it dedupes


def test_add_without_a_key_still_dedupes(no_key, tmp_path):
    source = _png(tmp_path)
    ingest.add_reference(source)
    with pytest.raises(ingest.DuplicateReferenceError):
        ingest.add_reference(source)


def test_add_without_a_key_works_for_text_and_pdf(no_key, tmp_path):
    note = tmp_path / "moodboard-notes.txt"
    note.write_text("heavy wool, raw edges")
    result = ingest.add_reference(note)
    assert result["title"] == "moodboard-notes" and result["tags"] == []
    assert (config.REFERENCES_DIR / db.get_reference(result["id"])["filepath"]).exists()


def test_add_with_a_key_is_unchanged(archive, tmp_path):
    result = ingest.add_reference(_png(tmp_path, "IMG_2384.png"))
    assert result["tags"] == ["tag-a"] and result["description"] == "an image"
    assert result["title"] == "Tagged Image"  # the camera-style name is replaced, as before


@pytest.mark.parametrize("failure", [
    RuntimeError("rate limited"),
    ConnectionError("dropped"),
    ValueError("bad reply"),
    KeyError("content"),
])
def test_any_tagging_failure_leaves_a_stored_untagged_reference(archive, tmp_path, failure):
    """A key is set and Claude is called -- and the call blows up. The add must
    still complete: not just for a missing key, for every way the call can go."""
    with patch("tagging.tag_image", side_effect=failure):
        result = ingest.add_reference(_png(tmp_path, "look-13.png"))
    assert result["title"] == "look-13" and result["tags"] == []
    assert (config.REFERENCES_DIR / db.get_reference(result["id"])["filepath"]).exists()


def test_a_reply_that_was_not_json_is_untagged_not_a_prose_description(archive, tmp_path):
    # tagging._parse_response answers non-JSON with ("", [], <the raw prose>)
    with patch("tagging.tag_image", return_value=("", [], "Sure! Here are some tags: ...")):
        result = ingest.add_reference(_png(tmp_path))
    assert result["description"] == ""
    assert db.count_untagged_references() == 1  # so the backfill will retry it


def test_a_tagging_failure_on_a_pdf_with_images_does_not_leak_temp_files(archive, tmp_path):
    import fitz

    pdf = tmp_path / "lookbook.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "lookbook")
    page.insert_image(fitz.Rect(72, 100, 400, 400), stream=png_bytes(size=(300, 300)))
    doc.save(pdf)
    with patch("tagging.tag_pdf", side_effect=RuntimeError("down")), \
         patch("tagging.tag_text", side_effect=RuntimeError("down")):
        result = ingest.add_reference(pdf)
    assert result["tags"] == []


def test_add_folder_no_longer_fails_fast_without_a_key(no_key, tmp_path):
    folder = tmp_path / "inbox"
    folder.mkdir()
    (folder / "a.png").write_bytes(png_bytes(colour=(1, 2, 3)))
    (folder / "b.png").write_bytes(png_bytes(colour=(4, 5, 6)))
    results, skipped, errors = ingest.add_folder(folder)
    assert len(results) == 2 and not errors


def test_upload_route_adds_without_a_key(no_key, client):
    response = client.post(
        "/api/add-file",
        data={"file": (io.BytesIO(png_bytes()), "look-14.png")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    assert response.get_json()["title"] == "look-14"


def test_the_capture_queue_completes_without_a_key(no_key, client):
    from conftest import FakeUpload, drain, envelope

    import capture

    row = capture.accept(envelope(), upload=FakeUpload(png_bytes()))
    drain()
    assert db.get_capture(row["id"])["status"] == "done"
    assert len(db.list_references()) == 1


def test_tagging_get_client_raises_a_plain_runtimeerror_subclass(no_key):
    tagging._client = None
    with pytest.raises(tagging.ClaudeUnavailable) as excinfo:
        tagging.get_client()
    assert isinstance(excinfo.value, RuntimeError)
    assert "ANTHROPIC_API_KEY" in str(excinfo.value)


# --- the tag backfill ---------------------------------------------------------------------------


def _stored_image(tmp_path, name, **kw):
    """A reference with a real file on disk, as ingest leaves one."""
    ref_id = str(uuid.uuid4())
    dest = config.REFERENCES_DIR / "images" / f"{ref_id}.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(png_bytes())
    db.insert_reference(
        ref_id=ref_id, type_="image", filepath=f"images/{ref_id}.png", title=name,
        source=None, tags=kw.get("tags", []), description=kw.get("description"), notes=None,
    )
    return ref_id


def test_backfill_tags_only_untagged_references(archive, tmp_path):
    untagged_a = _stored_image(tmp_path, "look-1")
    untagged_b = _stored_image(tmp_path, "look-2")
    tagged = _stored_image(tmp_path, "look-3", tags=["wool"], description="already described")

    with patch("tagging.tag_image", return_value=("Caption", ["silk", "bias cut"], "A silk dress.")) as tag:
        result = ingest.backfill_tags()

    assert result == {"tagged": 2, "failed": 0, "error": None}
    assert tag.call_count == 2  # the tagged one was never sent
    assert db.get_reference(untagged_a)["tags"] == ["silk", "bias cut"]
    assert db.get_reference(untagged_b)["description"] == "A silk dress."
    assert db.get_reference(tagged)["tags"] == ["wool"]
    assert db.get_reference(tagged)["description"] == "already described"
    assert db.count_untagged_references() == 0


def test_backfill_never_renames_a_reference(archive, tmp_path):
    ref = _stored_image(tmp_path, "My own name for this")
    with patch("tagging.tag_image", return_value=("Some Caption", ["silk"], "desc")):
        ingest.backfill_tags()
    assert db.get_reference(ref)["title"] == "My own name for this"


def test_backfill_respects_the_limit_and_can_be_called_again(archive, tmp_path):
    for i in range(4):
        _stored_image(tmp_path, f"look-{i}")
    with patch("tagging.tag_image", return_value=("", ["t"], "d")):
        assert ingest.backfill_tags(limit=3)["tagged"] == 3
        assert db.count_untagged_references() == 1
        assert ingest.backfill_tags(limit=3)["tagged"] == 1
        assert ingest.backfill_tags(limit=3)["tagged"] == 0


def test_backfill_reports_a_failure_and_leaves_the_reference_untagged(archive, tmp_path):
    ref = _stored_image(tmp_path, "look-1")
    with patch("tagging.tag_image", side_effect=RuntimeError("rate limited")):
        result = ingest.backfill_tags()
    assert result["tagged"] == 0 and result["failed"] == 1
    assert "rate limited" in result["error"]
    assert db.get_reference(ref)["tags"] == []


def test_backfill_counts_an_empty_reply_as_a_failure(archive, tmp_path):
    _stored_image(tmp_path, "look-1")
    with patch("tagging.tag_image", return_value=("", [], "prose, not tags")):
        result = ingest.backfill_tags()
    assert result["failed"] == 1 and db.count_untagged_references() == 1


def test_backfill_tags_text_references_too(archive, tmp_path):
    ref_id = str(uuid.uuid4())
    dest = config.REFERENCES_DIR / "texts" / f"{ref_id}.txt"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text("a note about raw selvedge")
    db.insert_reference(ref_id, "text", f"texts/{ref_id}.txt", "notes", None, [], None, None)
    with patch("tagging.tag_text", return_value=("", ["selvedge"], "A note.")) as tag:
        ingest.backfill_tags()
    assert tag.call_args.args[0] == "a note about raw selvedge"
    assert db.get_reference(ref_id)["tags"] == ["selvedge"]


def test_backfill_with_no_key_refuses_clearly(no_key):
    with pytest.raises(tagging.ClaudeUnavailable):
        ingest.backfill_tags()


def test_tagging_routes(client, tmp_path, monkeypatch):
    _stored_image(tmp_path, "look-1")
    _stored_image(tmp_path, "look-2", tags=["x"])
    coverage = client.get("/api/tagging/coverage").get_json()
    assert coverage == {"total": 2, "untagged": 1, "claude": True}

    with patch("tagging.tag_image", return_value=("", ["silk"], "d")):
        body = client.post("/api/tagging/backfill", json={}).get_json()
    assert body["tagged"] == 1 and body["untagged"] == 0

    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", None)
    response = client.post("/api/tagging/backfill", json={})
    assert response.status_code == 503
    assert response.get_json()["reason"] == "claude_unavailable"
    assert client.get("/api/tagging/coverage").get_json()["claude"] is False


# --- no key: the routes that would call Claude --------------------------------------------------


def _assert_clear_refusal(response):
    assert response.status_code == 503, response.get_data(as_text=True)
    body = response.get_json()
    assert body["reason"] == "claude_unavailable"
    assert "ANTHROPIC_API_KEY" in body["error"]


def test_analysis_routes_answer_clearly_without_a_key(no_key, client):
    project = client.post("/api/projects", json={"title": "Capsule"}).get_json()
    with patch("analyze.start_conversation", side_effect=AssertionError("must not be called")), \
         patch("analyze.start_concept_analysis", side_effect=AssertionError("must not be called")), \
         patch("analyze.continue_conversation", side_effect=AssertionError("must not be called")):
        _assert_clear_refusal(client.post("/api/analyze", json={"reference_ids": ["x"]}))
        _assert_clear_refusal(client.post("/api/analyze/some-session/reply", json={"message": "hi"}))
        _assert_clear_refusal(client.post(f"/api/projects/{project['id']}/concept-analysis", json={}))


def test_schedule_claude_routes_answer_clearly_without_a_key(no_key, client):
    project = client.post("/api/projects", json={"title": "Capsule"}).get_json()
    _assert_clear_refusal(client.post("/api/tasks/generate", json={"description": "hem the skirt"}))

    brief = client.post(
        f"/api/projects/{project['id']}/briefs",
        data={"file": (io.BytesIO(b"%PDF-1.4"), "brief.pdf")},
        content_type="multipart/form-data",
    )
    _assert_clear_refusal(brief)
    assert not list(config.BRIEFS_DIR.glob("*.pdf"))  # nothing was saved before refusing

    doc = client.post(
        f"/api/projects/{project['id']}/supporting-documents",
        data={"file": (io.BytesIO(b"%PDF-1.4"), "list.pdf")},
        content_type="multipart/form-data",
    )
    _assert_clear_refusal(doc)


def test_the_same_routes_work_with_a_key(client):
    project = client.post("/api/projects", json={"title": "Capsule"}).get_json()
    assert client.post("/api/tasks/generate", json={"description": "hem the skirt"}).status_code == 200
    with patch("analyze.start_conversation", return_value=("write-up", [], {})):
        assert client.post("/api/analyze", json={"reference_ids": ["x"]}).status_code == 200
    assert project["id"]


def test_a_saved_analysis_is_still_readable_without_a_key(no_key, client):
    project = client.post("/api/projects", json={"title": "Capsule"}).get_json()
    ref = _seed("Dress")
    db.save_analysis(
        "analysis-1", project["id"], [ref],
        [{"kind": "writeup", "text": "A write-up that outlives the key."}],
    )

    listing = client.get(f"/api/projects/{project['id']}/analyses")
    assert listing.status_code == 200 and len(listing.get_json()) == 1
    detail = client.get("/api/analyses/analysis-1")
    assert detail.status_code == 200
    assert detail.get_json()["transcript"][0]["text"].startswith("A write-up")
    # ... and a stored one can still be saved over, which is also a database write, not a call
    assert client.put("/api/analyses/analysis-1", json={
        "project_id": project["id"], "reference_ids": [ref],
        "transcript": [{"kind": "writeup", "text": "edited"}],
    }).status_code == 200


def test_ics_classification_still_degrades_with_no_key(no_key):
    import commitment_classify

    events = [{"meta": {"raw": {"description": "Event id 1\nStudio\nRoom 4"}}}]
    with patch("commitment_classify._call_model", side_effect=AssertionError("no key, no call")):
        assert commitment_classify.classify_gaps(events) == 0


# --- no embeddings -----------------------------------------------------------------------------


def test_adding_with_embeddings_off_touches_neither_the_model_nor_chroma(no_embeddings, tmp_path):
    with patch("embeddings.embed_image") as embed, patch("embeddings.add_to_index") as index, \
         patch("embeddings.get_model", side_effect=AssertionError("model loaded")), \
         patch("embeddings.get_collection", side_effect=AssertionError("chroma opened")):
        result = ingest.add_reference(_png(tmp_path))
    embed.assert_not_called()
    index.assert_not_called()
    assert result["tags"] == ["tag-a"]  # tagging is independent of embedding
    assert db.get_reference(result["id"])


def test_adding_text_with_embeddings_off_touches_neither(no_embeddings, tmp_path):
    note = tmp_path / "notes.txt"
    note.write_text("heavy wool")
    with patch("embeddings.embed_combined") as embed, patch("embeddings.add_to_index") as index:
        ingest.add_reference(note)
    embed.assert_not_called()
    index.assert_not_called()


def test_embeddings_on_still_embeds_and_indexes(archive, tmp_path):
    import embeddings as e

    ingest.add_reference(_png(tmp_path))
    e.embed_image.assert_called_once()
    e.add_to_index.assert_called_once()


def test_rotating_with_embeddings_off_does_not_embed(no_embeddings, tmp_path):
    result = ingest.add_reference(_png(tmp_path))
    with patch("embeddings.embed_image") as embed, patch("embeddings.update_embedding") as update:
        ingest.rotate_reference(result["id"])
    embed.assert_not_called()
    update.assert_not_called()


def test_the_real_embeddings_module_refuses_clearly_when_off(no_embeddings):
    # conftest stubs the embed_* functions; these three are the real ones.
    for call in (embeddings.get_model, embeddings.get_collection, embeddings.get_task_collection):
        with pytest.raises(embeddings.EmbeddingsDisabled) as excinfo:
            call()
        assert "SKIP_EMBEDDINGS" in str(excinfo.value)
    assert embeddings.clear_task_collection() == 0


def test_views_built_from_vectors_say_why_they_are_empty(no_embeddings, client):
    project = client.post("/api/projects", json={"title": "Capsule"}).get_json()
    for method, url in (
        ("get", "/api/similarity/graph"),
        ("get", "/api/similarity/constellation"),
        ("get", f"/api/projects/{project['id']}/similarity/graph"),
        ("get", f"/api/projects/{project['id']}/similarity/constellation"),
        ("post", "/api/similarity/calculate"),
    ):
        response = getattr(client, method)(url)
        assert response.status_code == 503, url
        body = response.get_json()
        assert body["reason"] == "embeddings_disabled"
        assert "SKIP_EMBEDDINGS" in body["error"]


def test_colour_views_do_not_need_embeddings(no_embeddings, client):
    assert client.get("/api/colour/map").status_code == 200
    assert client.get("/api/colour/coverage").status_code == 200


def test_search_falls_back_to_keywords_with_embeddings_off(no_embeddings, client):
    _seed("Silk slip dress", tags=["silk", "bias cut"], description="A column of satin.")
    _seed("Wool coat", tags=["wool"], description="Heavy.")

    def titles(url):
        return sorted(r["title"] for r in client.get(url).get_json())

    assert titles("/api/references?q=slip&search_by=distance") == ["Silk slip dress"]
    assert titles("/api/references?q=bias&search_by=tags") == ["Silk slip dress"]
    assert titles("/api/references?q=satin&search_by=description") == ["Silk slip dress"]
    assert titles("/api/references?q=satin&search_by=tags") == []  # the checkboxes still mean something
    assert titles("/api/references") == ["Silk slip dress", "Wool coat"]  # browsing is unchanged


def test_reference_detail_skips_the_similar_lookup_with_embeddings_off(no_embeddings, client):
    ref = _seed("Dress")
    with patch("embeddings.get_collection", side_effect=AssertionError("chroma opened")):
        body = client.get(f"/api/references/{ref}").get_json()
    assert body["similar"] == []


def test_deleting_a_reference_with_embeddings_off_does_not_open_chroma(no_embeddings, client, tmp_path):
    result = ingest.add_reference(_png(tmp_path))
    with patch("embeddings.get_collection", side_effect=AssertionError("chroma opened")):
        assert client.delete(f"/api/references/{result['id']}").status_code == 200


def test_analysis_context_with_embeddings_off_skips_neighbours_and_clusters(no_embeddings):
    import analyze

    ref = {"id": "r1", "title": "Dress", "type": "image", "tags": [], "description": ""}
    assert analyze.gather_context([ref]) == {"r1": []}
    assert analyze._cluster_analysis_context([ref]) == ([], None)
