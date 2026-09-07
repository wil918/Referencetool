"""The phone day view: its route and manifest, and the API token guard that
comes on when the server is bound beyond localhost.

The guard reuses the capture API's own _capture_auth_ok -- these tests check it
is applied to the whole API surface for a non-loopback client, and to nothing
at all for a loopback one (so using the app on the Mac never changes).
"""
import json

import pytest

import app as flask_app
import config


PHONE = {"REMOTE_ADDR": "100.115.92.7"}  # a Tailscale-shaped peer address


# --- The shell + manifest -------------------------------------------------


def test_day_route_serves_the_shell(client):
    r = client.get("/day")
    assert r.status_code == 200
    assert b"day-mobile.js" in r.data
    assert b'id="day-calendar"' in r.data


def test_manifest_is_served_and_points_at_the_day_route(client):
    r = client.get("/manifest.webmanifest")
    assert r.status_code == 200
    assert "json" in r.headers["Content-Type"]
    manifest = json.loads(r.data)
    assert manifest["start_url"] == "/day"
    assert manifest["display"] == "standalone"
    assert any(icon["src"] == "/icons/icon-512.png" for icon in manifest["icons"])


def test_apple_touch_icon_exists(client):
    assert client.get("/icons/apple-touch-icon.png").status_code == 200


# --- The token guard ----------------------------------------------------


@pytest.fixture
def exposed(monkeypatch):
    """Server bound wide, with a token configured -- the phone setup."""
    monkeypatch.setattr(config, "LAN_EXPOSED", True)
    monkeypatch.setattr(flask_app, "ARCHIVE_API_TOKEN", "s3cr3t-token")


def test_loopback_client_still_needs_no_token(client, exposed):
    """Binding wide for a phone must not change anything about the Mac itself."""
    assert client.get("/api/tasks").status_code == 200


def test_remote_client_is_refused_without_a_token(client, exposed):
    r = client.get("/api/tasks", environ_overrides=PHONE)
    assert r.status_code == 401


def test_remote_client_is_allowed_with_the_token(client, exposed):
    r = client.get(
        "/api/tasks",
        headers={"Authorization": "Bearer s3cr3t-token"},
        environ_overrides=PHONE,
    )
    assert r.status_code == 200


def test_remote_client_wrong_token_is_refused(client, exposed):
    r = client.get(
        "/api/tasks",
        headers={"Authorization": "Bearer wrong"},
        environ_overrides=PHONE,
    )
    assert r.status_code == 401


def test_health_stays_open_so_a_phone_can_tell_up_from_locked(client, exposed):
    r = client.get("/api/health", environ_overrides=PHONE)
    assert r.status_code == 200
    assert r.get_json()["auth_required"] is True


def test_static_shell_is_reachable_without_a_token(client, exposed):
    """The HTML/JS/CSS aren't sensitive -- only the API is guarded."""
    assert client.get("/day", environ_overrides=PHONE).status_code == 200
    assert client.get("/schedule/day-mobile.js", environ_overrides=PHONE).status_code == 200


def test_not_exposed_means_no_guard_at_all(client, monkeypatch):
    monkeypatch.setattr(config, "LAN_EXPOSED", False)
    monkeypatch.setattr(flask_app, "ARCHIVE_API_TOKEN", "s3cr3t-token")
    assert client.get("/api/tasks", environ_overrides=PHONE).status_code == 200


# --- Startup refuses an open API --------------------------------------


def test_bootstrap_refuses_wide_bind_without_a_token(archive, monkeypatch):
    monkeypatch.setattr(config, "LAN_EXPOSED", True)
    monkeypatch.setattr(config, "ARCHIVE_HOST", "0.0.0.0")
    monkeypatch.setattr(flask_app, "ARCHIVE_API_TOKEN", None)
    with pytest.raises(SystemExit):
        flask_app.bootstrap()


def test_host_is_loopback():
    assert config.host_is_loopback("127.0.0.1")
    assert config.host_is_loopback("localhost")
    assert not config.host_is_loopback("0.0.0.0")
    assert not config.host_is_loopback("192.168.1.20")
