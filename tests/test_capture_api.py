"""HTTP contract for the capture API, including the CORS boundary."""
import io
import json

from conftest import drain, envelope, png_bytes

import capture
import db


def post_image(client, headers, env, colour=(10, 20, 30), filename="shot.png"):
    return client.post(
        "/api/captures",
        headers=headers,
        data={"capture": json.dumps(env), "file": (io.BytesIO(png_bytes(colour)), filename)},
        content_type="multipart/form-data",
    )


# --- CORS ------------------------------------------------------------------


def test_extension_origin_is_allowed(client, ext_headers):
    r = client.get("/api/health", headers=ext_headers)
    assert r.status_code == 200
    assert r.headers["Access-Control-Allow-Origin"] == ext_headers["Origin"]


def test_ordinary_web_origin_gets_no_cors_headers(client):
    """A random site must not be able to read the archive from a user's browser."""
    r = client.get("/api/health", headers={"Origin": "https://evil.example.com"})
    assert "Access-Control-Allow-Origin" not in r.headers


def test_cors_is_scoped_to_the_api(client, ext_headers):
    r = client.get("/index.html", headers=ext_headers)
    assert "Access-Control-Allow-Origin" not in r.headers


def test_preflight_is_answered(client, ext_headers):
    r = client.open("/api/captures", method="OPTIONS", headers=ext_headers)
    assert r.status_code in (200, 204)
    assert "POST" in r.headers.get("Access-Control-Allow-Methods", "")


# --- Health ----------------------------------------------------------------


def test_health_reports_ready(client, ext_headers):
    body = client.get("/api/health", headers=ext_headers).get_json()
    assert body["ok"] is True
    assert body["auth_required"] is False


# --- Creating captures -----------------------------------------------------


def test_image_capture_returns_202_immediately(client, ext_headers):
    r = post_image(client, ext_headers, envelope())
    assert r.status_code == 202
    body = r.get_json()
    assert body["status"] == db.CAPTURE_QUEUED
    assert body["reference_id"] is None, "must not block on ingestion"


def test_capture_becomes_pollable(client, ext_headers):
    cap_id = post_image(client, ext_headers, envelope()).get_json()["capture_id"]
    drain()
    body = client.get(f"/api/captures/{cap_id}", headers=ext_headers).get_json()
    assert body["status"] == db.CAPTURE_DONE
    assert body["reference"]["title"]


def test_text_capture_via_json(client, ext_headers):
    quote = "The garment functions as an architectural enclosure around the body."
    env = envelope(type="text", content={"selected_text": quote})
    r = client.post("/api/captures", headers=ext_headers, json={"capture": env})
    assert r.status_code == 202
    drain()
    body = client.get(f"/api/captures/{r.get_json()['capture_id']}", headers=ext_headers).get_json()
    assert body["status"] == db.CAPTURE_DONE


def test_page_capture_synthesises_text_when_no_excerpt(client, ext_headers):
    """A page save with nothing selected still becomes a searchable reference."""
    env = envelope(
        type="page",
        content={},
        metadata={"description": "A description of the page."},
    )
    r = client.post("/api/captures", headers=ext_headers, json={"capture": env})
    assert r.status_code == 202
    drain()
    body = client.get(f"/api/captures/{r.get_json()['capture_id']}", headers=ext_headers).get_json()
    assert body["status"] == db.CAPTURE_DONE


def test_capture_with_no_content_is_rejected(client, ext_headers):
    r = client.post("/api/captures", headers=ext_headers, json={"capture": {"type": "image"}})
    assert r.status_code == 400
    assert "error" in r.get_json()


def test_malformed_envelope_is_rejected(client, ext_headers):
    r = client.post(
        "/api/captures",
        headers=ext_headers,
        data={"capture": "{not json", "file": (io.BytesIO(png_bytes()), "a.png")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 400


def test_unknown_capture_id_is_404(client, ext_headers):
    assert client.get("/api/captures/nope", headers=ext_headers).status_code == 404


# --- Duplicate check -------------------------------------------------------


def test_check_reports_new_content_as_not_duplicate(client, ext_headers):
    r = client.post("/api/captures/check", headers=ext_headers, json={"capture": envelope()})
    assert r.get_json() == {"duplicate": False, "match": None}


def test_check_reports_a_previous_capture(client, ext_headers):
    post_image(client, ext_headers, envelope())
    drain()
    body = client.post(
        "/api/captures/check", headers=ext_headers, json={"capture": envelope()}
    ).get_json()
    assert body["duplicate"] is True
    assert body["match"]["reference_id"]


# --- Batch -----------------------------------------------------------------


def test_batch_accepts_every_item(client, ext_headers):
    caps = [
        envelope(content={"image_url": f"https://cdn.example.com/b{i}.png"})
        for i in range(3)
    ]
    data = {"captures": json.dumps(caps)}
    for i in range(3):
        data[f"file{i}"] = (io.BytesIO(png_bytes((i * 40, 10, 10))), f"b{i}.png")

    r = client.post("/api/captures/batch", headers=ext_headers, data=data,
                    content_type="multipart/form-data")
    assert r.status_code == 202
    body = r.get_json()
    assert body["accepted"] == 3 and body["total"] == 3

    drain()
    for res in body["results"]:
        polled = client.get(f"/api/captures/{res['capture_id']}", headers=ext_headers).get_json()
        assert polled["status"] == db.CAPTURE_DONE


def test_batch_reports_per_item_failure_without_losing_the_rest(client, ext_headers):
    """One bad item must not sink the whole selection."""
    caps = [
        envelope(content={"image_url": "https://cdn.example.com/ok.png"}),
        envelope(content={}),  # no image, no text -> rejected
    ]
    data = {"captures": json.dumps(caps),
            "file0": (io.BytesIO(png_bytes()), "ok.png")}

    body = client.post("/api/captures/batch", headers=ext_headers, data=data,
                       content_type="multipart/form-data").get_json()
    assert body["accepted"] == 1
    assert body["results"][0]["ok"] is True
    assert body["results"][1]["ok"] is False
    assert body["results"][1]["error"]


def test_empty_batch_is_rejected(client, ext_headers):
    r = client.post("/api/captures/batch", headers=ext_headers, json={"captures": []})
    assert r.status_code == 400


# --- Auth ------------------------------------------------------------------


def test_token_is_enforced_when_configured(client, ext_headers, monkeypatch):
    import app as flask_app

    monkeypatch.setattr(flask_app, "ARCHIVE_API_TOKEN", "s3cret")
    assert client.post("/api/captures", headers=ext_headers,
                       json={"capture": envelope()}).status_code == 401

    ok = client.post(
        "/api/captures",
        headers={**ext_headers, "Authorization": "Bearer s3cret"},
        json={"capture": envelope(type="text", content={"selected_text": "hi"})},
    )
    assert ok.status_code == 202
    drain()


def test_no_token_configured_means_open_locally(client, ext_headers):
    r = client.post("/api/captures/check", headers=ext_headers, json={"capture": envelope()})
    assert r.status_code == 200
