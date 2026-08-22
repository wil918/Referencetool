"""ics_import.sync_feed and the /api/commitments/import, /api/commitments/classify
routes -- dedup on re-sync, upstream deletion, and that reclassification
survives a re-sync (see the module docstring in ics_import.py for the
external_uid and timezone rules these rely on).
"""
import io
from datetime import date, timedelta

import db
import ics_import

# sync_feed's default window is relative to *today*, so it wouldn't see
# fixed January-2026 test fixtures once "today" moves past them -- every
# direct sync_feed call below pins the window to cover them regardless of
# when the suite runs.
FIXED_WINDOW = {"window_start": date(2026, 1, 1), "window_days": 200}


def sync(source, ics_text):
    return ics_import.sync_feed(source, ics_text, **FIXED_WINDOW)


def ics_calendar(*events):
    body = "\n".join(events)
    return f"BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Test//EN\n{body}\nEND:VCALENDAR\n"


def single_event(uid, start="20260105T090000", end="20260105T110000", summary="Pattern Cutting"):
    return (
        "BEGIN:VEVENT\n"
        f"UID:{uid}\n"
        "DTSTAMP:20260101T000000Z\n"
        f"DTSTART;TZID=Europe/London:{start}\n"
        f"DTEND;TZID=Europe/London:{end}\n"
        f"SUMMARY:{summary}\n"
        "END:VEVENT"
    )


def weekly_series(uid, start="20260105T090000", end="20260105T110000", count=4,
                   summary="Pattern Cutting"):
    return (
        "BEGIN:VEVENT\n"
        f"UID:{uid}\n"
        "DTSTAMP:20260101T000000Z\n"
        f"DTSTART;TZID=Europe/London:{start}\n"
        f"DTEND;TZID=Europe/London:{end}\n"
        f"RRULE:FREQ=WEEKLY;COUNT={count}\n"
        f"SUMMARY:{summary}\n"
        "END:VEVENT"
    )


# --- Timezones ---------------------------------------------------------------


def test_a_tzid_event_is_stored_as_naive_local_wall_clock_time(archive):
    ics = ics_calendar(single_event("lecture-1@studio.example"))

    sync("studio.ics", ics)

    commitment = db.list_commitments()[0]
    assert commitment["start"] == "2026-01-05T09:00:00"
    assert commitment["end"] == "2026-01-05T11:00:00"


def test_a_weekly_series_keeps_the_same_wall_clock_hour_across_the_dst_change(archive):
    # 2026-03-29 is when UK clocks spring forward -- a naive-offset bug would
    # show up as the stored hour shifting to 08:00 or 10:00 after that date.
    ics = ics_calendar(weekly_series(
        "lecture-2@studio.example", start="20260322T090000", end="20260322T110000", count=4,
    ))

    sync("studio.ics", ics)

    starts = sorted(c["start"] for c in db.list_commitments())
    assert starts == [
        "2026-03-22T09:00:00",
        "2026-03-29T09:00:00",
        "2026-04-05T09:00:00",
        "2026-04-12T09:00:00",
    ]


# --- Re-sync: dedup, update, deletion -----------------------------------------


def test_resyncing_the_same_ics_twice_produces_no_duplicates(archive):
    ics = ics_calendar(single_event("lecture-1@studio.example"))

    first = sync("studio.ics", ics)
    second = sync("studio.ics", ics)

    assert first["created"] == 1
    assert second["created"] == 0 and second["updated"] == 1
    assert len(db.list_commitments()) == 1


def test_resyncing_updates_a_changed_title_and_time_in_place(archive):
    ics_v1 = ics_calendar(single_event("lecture-1@studio.example"))
    ics_v2 = ics_calendar(single_event(
        "lecture-1@studio.example", start="20260105T100000", end="20260105T120000",
        summary="Pattern Cutting (moved)",
    ))

    sync("studio.ics", ics_v1)
    original_id = db.list_commitments()[0]["id"]
    sync("studio.ics", ics_v2)

    commitments = db.list_commitments()
    assert len(commitments) == 1
    assert commitments[0]["id"] == original_id
    assert commitments[0]["title"] == "Pattern Cutting (moved)"
    assert commitments[0]["start"] == "2026-01-05T10:00:00"


def test_an_upstream_deletion_is_removed_on_resync(archive):
    ics_with_two = ics_calendar(
        single_event("lecture-1@studio.example"),
        single_event("lecture-2@studio.example", start="20260106T090000", end="20260106T110000"),
    )
    ics_with_one = ics_calendar(single_event("lecture-1@studio.example"))

    sync("studio.ics", ics_with_two)
    assert len(db.list_commitments()) == 2

    result = sync("studio.ics", ics_with_one)

    assert result["deleted"] == 1
    remaining = db.list_commitments()
    assert len(remaining) == 1
    assert remaining[0]["external_uid"] == "lecture-1@studio.example"


def test_a_resync_does_not_touch_commitments_from_a_different_source(archive):
    db.create_commitment(
        "manual-1", "Doctor's appointment", "2026-01-05T09:00:00", "2026-01-05T09:30:00",
    )

    sync("studio.ics", ics_calendar(single_event("lecture-1@studio.example")))

    assert db.get_commitment("manual-1") is not None
    assert len(db.list_commitments()) == 2


def test_a_recurring_series_expands_to_one_commitment_per_occurrence(archive):
    ics = ics_calendar(weekly_series("lecture-2@studio.example", count=3))

    result = sync("studio.ics", ics)

    assert result["created"] == 3
    assert len({c["external_uid"] for c in db.list_commitments()}) == 3


def test_resyncing_a_recurring_series_is_stable_not_duplicated(archive):
    ics = ics_calendar(weekly_series("lecture-2@studio.example", count=3))

    sync("studio.ics", ics)
    second = sync("studio.ics", ics)

    assert second["created"] == 0 and second["updated"] == 3
    assert len(db.list_commitments()) == 3


# --- Reclassification survives re-sync ----------------------------------------


def test_a_manual_reclassification_survives_resync(archive):
    ics = ics_calendar(single_event("lecture-1@studio.example"))
    sync("studio.ics", ics)
    commitment_id = db.list_commitments()[0]["id"]

    db.update_commitment(commitment_id, support_level="priority", location_id="studio-3")

    sync("studio.ics", ics)

    reclassified = db.get_commitment(commitment_id)
    assert reclassified["support_level"] == "priority"
    assert reclassified["location_id"] == "studio-3"


def test_reclassification_survives_the_commitment_moving_in_the_feed(archive):
    ics_v1 = ics_calendar(single_event("lecture-1@studio.example"))
    ics_v2 = ics_calendar(single_event(
        "lecture-1@studio.example", start="20260105T140000", end="20260105T160000",
    ))
    sync("studio.ics", ics_v1)
    commitment_id = db.list_commitments()[0]["id"]
    db.update_commitment(commitment_id, support_level="ambient")

    sync("studio.ics", ics_v2)

    moved = db.get_commitment(commitment_id)
    assert moved["start"] == "2026-01-05T14:00:00"
    assert moved["support_level"] == "ambient"


# --- Errors --------------------------------------------------------------------


def test_parsing_garbage_raises_invalid_ics_error(archive):
    try:
        ics_import.parse_events("not an ics file at all")
        assert False, "expected InvalidICSError"
    except ics_import.InvalidICSError:
        pass


# --- Routes ----------------------------------------------------------------------
#
# The route always uses sync_feed's default (today-relative) window, so these
# fixtures are dated a couple of weeks out from "today" rather than pinned to
# January 2026 like the direct sync_feed tests above.


def test_import_route_accepts_an_uploaded_ics_file(client):
    soon = date.today() + timedelta(days=14)
    ics = ics_calendar(single_event(
        "lecture-1@studio.example",
        start=f"{soon:%Y%m%d}T090000", end=f"{soon:%Y%m%d}T110000",
    ))

    resp = client.post(
        "/api/commitments/import",
        data={"file": (io.BytesIO(ics.encode("utf-8")), "studio.ics")},
        content_type="multipart/form-data",
    )

    assert resp.status_code == 200
    body = resp.get_json()
    assert body["created"] == 1
    assert body["source"] == "studio.ics"


def test_import_route_rejects_a_missing_file_and_feed_url(client):
    resp = client.post("/api/commitments/import", json={})
    assert resp.status_code == 400


def test_import_route_rejects_a_non_http_feed_url(client):
    resp = client.post("/api/commitments/import", json={"feed_url": "file:///etc/passwd"})
    assert resp.status_code == 400


# --- Feed URL persistence -------------------------------------------------------
#
# The UI's whole point in remembering a feed URL is not having to paste it
# again to re-sync, so these stub fetch_feed rather than hitting the network.


def test_feed_route_returns_null_when_nothing_is_configured(client):
    assert client.get("/api/commitments/feed").get_json() == {"feed_url": None}


def test_a_successful_url_import_is_remembered_as_the_feed(client, monkeypatch):
    ics = ics_calendar(single_event(
        "lecture-1@studio.example",
        start=f"{date.today():%Y%m%d}T090000", end=f"{date.today():%Y%m%d}T110000",
    ))
    monkeypatch.setattr(ics_import, "fetch_feed", lambda url: ics)

    resp = client.post("/api/commitments/import", json={"feed_url": "https://cal.example/timetable.ics"})

    assert resp.status_code == 200
    assert client.get("/api/commitments/feed").get_json() == {
        "feed_url": "https://cal.example/timetable.ics"
    }


def test_a_feed_url_is_remembered_even_if_the_fetch_then_fails(client, monkeypatch):
    def boom(url):
        raise ics_import.FeedFetchError("connection refused")

    monkeypatch.setattr(ics_import, "fetch_feed", boom)

    resp = client.post("/api/commitments/import", json={"feed_url": "https://cal.example/timetable.ics"})

    assert resp.status_code == 502
    assert client.get("/api/commitments/feed").get_json() == {
        "feed_url": "https://cal.example/timetable.ics"
    }


def test_resyncing_via_the_stored_feed_url_reports_no_additions_the_second_time(client, monkeypatch):
    ics = ics_calendar(single_event(
        "lecture-1@studio.example",
        start=f"{date.today():%Y%m%d}T090000", end=f"{date.today():%Y%m%d}T110000",
    ))
    monkeypatch.setattr(ics_import, "fetch_feed", lambda url: ics)

    first = client.post(
        "/api/commitments/import", json={"feed_url": "https://cal.example/timetable.ics"}
    ).get_json()
    stored = client.get("/api/commitments/feed").get_json()["feed_url"]
    second = client.post("/api/commitments/import", json={"feed_url": stored}).get_json()

    assert first["created"] == 1 and first["updated"] == 0
    assert second["created"] == 0 and second["updated"] == 1


def test_classify_route_sets_support_level_and_location_for_several_at_once(client):
    a = client.post("/api/commitments", json={
        "title": "Class A", "start": "2026-01-05T09:00:00", "end": "2026-01-05T11:00:00",
    }).get_json()
    b = client.post("/api/commitments", json={
        "title": "Class B", "start": "2026-01-06T09:00:00", "end": "2026-01-06T11:00:00",
    }).get_json()

    resp = client.put("/api/commitments/classify", json={
        "ids": [a["id"], b["id"]], "support_level": "priority", "location_id": "studio-3",
    })

    assert resp.status_code == 200
    for commitment in resp.get_json():
        assert commitment["support_level"] == "priority"
        assert commitment["location_id"] == "studio-3"


def test_classify_route_requires_a_non_empty_ids_list(client):
    resp = client.put("/api/commitments/classify", json={"ids": [], "support_level": "priority"})
    assert resp.status_code == 400


def test_classify_route_rejects_an_unknown_support_level(client):
    a = client.post("/api/commitments", json={
        "title": "Class A", "start": "2026-01-05T09:00:00", "end": "2026-01-05T11:00:00",
    }).get_json()

    resp = client.put("/api/commitments/classify", json={"ids": [a["id"]], "support_level": "nonsense"})

    assert resp.status_code == 400
