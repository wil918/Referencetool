"""ics_import.sync_feed and the /api/commitments/import, /api/commitments/classify
routes -- dedup on re-sync, upstream deletion, and that reclassification
survives a re-sync (see the module docstring in ics_import.py for the
external_uid and timezone rules these rely on).
"""
import io
import uuid
from datetime import date, timedelta
from pathlib import Path

import db
import ics_import

# sync_feed's default window is relative to *today*, so it wouldn't see
# fixed January-2026 test fixtures once "today" moves past them -- every
# direct sync_feed call below pins the window to cover them regardless of
# when the suite runs.
FIXED_WINDOW = {"window_start": date(2026, 1, 1), "window_days": 200}


def sync(source, ics_text):
    return ics_import.sync_feed(source, ics_text, **FIXED_WINDOW)


# Five real VEVENTs extracted verbatim from a fetch of the user's own
# Westminster feed (see ics_import.py's module docstring) -- not a hand-built
# guess at the house format. Dated across the 2026/27 academic year, so this
# fixture gets its own window rather than reusing FIXED_WINDOW above.
REAL_FEED_FIXTURE = Path(__file__).parent / "fixtures" / "westminster_feed_sample.ics"
REAL_FEED_WINDOW = {"window_start": date(2026, 9, 1), "window_days": 200}


def real_feed_text():
    return REAL_FEED_FIXTURE.read_text()


def sync_real_feed(source="westminster.ics"):
    return ics_import.sync_feed(source, real_feed_text(), **REAL_FEED_WINDOW)


# Four VEVENTs built to exercise the parallel-teaching-group logic (see
# ics_import._group_tokens / _session_is_mine) without disturbing the pinned
# assertions on the big fixture above: a "gp4; gp3" two-room studio, a
# "gp4"-only workshop, a no-group induction, and an optional event.
GROUPS_FIXTURE = Path(__file__).parent / "fixtures" / "westminster_groups_sample.ics"


def sync_groups_feed(source="groups.ics"):
    return ics_import.sync_feed(source, GROUPS_FIXTURE.read_text(), **FIXED_WINDOW)


def groups_commitment(slug):
    return db.get_commitment_by_external_uid(f"groups-{slug}@timetabling.westminster.ac.uk")


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


# --- Events found vs. events within the import window --------------------------
#
# A sync that places nothing must be able to say why -- a feed that's
# genuinely empty and one whose events all fell outside the window both used
# to report the same bare "0 created" summary.


def test_events_found_counts_vevent_components_not_occurrences(archive):
    ics = ics_calendar(
        single_event("lecture-1@studio.example"),
        weekly_series("lecture-2@studio.example", count=4),
    )

    result = sync("studio.ics", ics)

    # 2 VEVENT blocks in the file, even though the series expands to 4
    # separate commitments -- events_found is a parse-level fact, not a
    # count of what got synced.
    assert result["events_found"] == 2
    assert result["events_in_window"] == 5


def test_events_outside_the_window_are_found_but_not_placed(archive):
    # Pinned well outside FIXED_WINDOW (2026-01-01 for 200 days).
    ics = ics_calendar(single_event(
        "lecture-1@studio.example", start="20300105T090000", end="20300105T110000",
    ))

    result = sync("studio.ics", ics)

    assert result["events_found"] == 1
    assert result["events_in_window"] == 0
    assert result["created"] == 0
    assert result["window_start"] == "2026-01-01"
    assert result["window_end"] == (date(2026, 1, 1) + timedelta(days=200)).isoformat()


def test_window_bounds_use_the_default_window_when_not_pinned(archive):
    ics = ics_calendar(single_event("lecture-1@studio.example"))

    result = ics_import.sync_feed("adhoc.ics", ics)  # no FIXED_WINDOW override

    expected_start = date.today() - timedelta(days=ics_import.IMPORT_WINDOW_PAST_DAYS)
    expected_days = ics_import.IMPORT_WINDOW_PAST_DAYS + ics_import.IMPORT_WINDOW_FUTURE_DAYS
    assert result["window_start"] == expected_start.isoformat()
    assert result["window_end"] == (expected_start + timedelta(days=expected_days)).isoformat()


def test_a_fully_empty_feed_reports_zero_found_and_zero_in_window(archive):
    result = sync("studio.ics", ics_calendar())

    assert result["events_found"] == 0
    assert result["events_in_window"] == 0


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


# --- House-format parsing: meta, and locations acquired on import --------------


def test_a_real_vevent_parses_into_the_expected_meta_fields(archive):
    result = sync_real_feed()
    assert result["created"] == 6  # 5 VEVENTs, one of them a 2-occurrence series

    identity_seminar = db.get_commitment_by_external_uid(
        "0ID255278:2016-04-06T11:33:00.0000000+01:00@timetabling.westminster.ac.uk"
    )
    assert identity_seminar["meta"]["module_code"] == "5FADE005W/2"
    assert identity_seminar["meta"]["module_name"] == "Identity"
    assert identity_seminar["meta"]["delivery_type"] == "Seminar"
    assert identity_seminar["meta"]["site"] == "Online"
    assert identity_seminar["meta"]["room"] == "Online - Live"
    assert identity_seminar["meta"]["details"] == "Identity briefing"
    assert identity_seminar["meta"]["lecturer"] == ["Ladega, Tumi"]
    assert identity_seminar["meta"]["raw"]["summary"].strip() == "5FADE005W/2 Identity"

    # A VEVENT whose SUMMARY/DESCRIPTION delivery type agrees across its two
    # bundled groups ("Studio; Studio") but whose LOCATION does not (two
    # different rooms) -- delivery_type is confidently one value, room is
    # confidently NOT one value, and that difference must survive the parse
    # rather than being flattened into a guess.
    surface_studio = db.get_commitment_by_external_uid(
        "0ID264863:2021-09-25T12:41:00.0000000+01:00@timetabling.westminster.ac.uk"
    )
    assert surface_studio["meta"]["delivery_type"] == "Studio"
    assert surface_studio["meta"]["site"] == "A Building"
    assert surface_studio["meta"]["room"] is None
    assert surface_studio["meta"]["lecturer"] == ["Loftus, Lauren", "Bigg-Wither, Jan"]


def test_a_vevent_with_no_location_property_still_parses_the_rest(archive):
    sync_real_feed()

    no_location = db.get_commitment_by_external_uid(
        "0ID365113:2026-09-04T15:29:00.0000000+01:00@timetabling.westminster.ac.uk"
    )
    assert no_location["meta"]["site"] is None
    assert no_location["meta"]["room"] is None
    assert no_location["meta"]["module_code"] == "5FADE003W"
    assert no_location["meta"]["lecturer"] == ["James, Emily"]


def test_a_vevent_bundling_two_modules_leaves_module_code_and_name_unconfident(archive):
    sync_real_feed()

    combined = next(
        c for c in db.list_commitments() if c["meta"] and c["meta"].get("details") == "Design assistant pairing"
    )
    # "5FADE003W" and "6FADE003W/2" disagree -- there's no honest single
    # answer, so this stays None rather than silently picking the first.
    assert combined["meta"]["module_code"] is None
    assert combined["meta"]["module_name"] is None
    assert combined["meta"]["delivery_type"] == "Optional Event"


def test_resyncing_backfills_meta_onto_a_commitment_imported_before_the_parser_existed(archive):
    # Simulates one of the 96 pre-existing commitments: created the way
    # sync_feed used to, with no meta at all.
    db.create_commitment(
        "old-row", "5FADE005W/2 Identity", "2027-02-25T14:00:00", "2027-02-25T16:00:00",
        source="westminster.ics",
        external_uid="0ID255278:2016-04-06T11:33:00.0000000+01:00@timetabling.westminster.ac.uk",
    )
    assert db.get_commitment("old-row")["meta"] is None

    sync_real_feed()

    backfilled = db.get_commitment("old-row")
    assert backfilled["meta"] is not None
    assert backfilled["meta"]["module_name"] == "Identity"


def test_resync_only_fills_a_blank_location_never_overwrites_a_classified_one(archive):
    sync_real_feed()
    identity_seminar = db.get_commitment_by_external_uid(
        "0ID255278:2016-04-06T11:33:00.0000000+01:00@timetabling.westminster.ac.uk"
    )
    # The import mapped "Online" onto a real location automatically.
    assert identity_seminar["location_id"] is not None
    auto_mapped = identity_seminar["location_id"]

    manual_id = str(uuid.uuid4())
    db.create_location(manual_id, "My Own Desk")
    db.update_commitment(identity_seminar["id"], location_id=manual_id)

    sync_real_feed()

    reclassified = db.get_commitment(identity_seminar["id"])
    assert reclassified["location_id"] == manual_id
    assert reclassified["location_id"] != auto_mapped


def test_import_creates_locations_under_the_configured_default_umbrella(archive):
    campus_id = str(uuid.uuid4())
    db.create_location(campus_id, "Harrow Campus")
    db.save_schedule_settings(480, 30, False, default_location_umbrella_id=campus_id)

    sync_real_feed()

    a_building = next(l for l in db.list_locations() if l["name"] == "A Building")
    assert a_building["parent_location_id"] == campus_id
    assert a_building["travel_minutes_from_home"] is None  # never invented

    online = next(l for l in db.list_locations() if l["name"] == "Online")
    assert online["is_online"] is True


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


# --- Parallel teaching groups: room resolution, and sessions that aren't mine --


def test_a_group_users_room_is_picked_from_a_multi_room_session(archive):
    db.save_schedule_settings(480, 30, False, cohort_group="gp3")

    sync_groups_feed()

    both = groups_commitment("both")  # LOCATION lists A4-07 (gp4); A4-05 (gp3)
    assert both["meta"]["room"] == "A4-05 - FD L5 Studio"
    assert both["meta"]["site"] == "A Building"
    # ...and it's attributable: this room came from the group order, not the
    # deterministic parser (which found the two rooms too different to call).
    assert both["meta"]["field_sources"]["room"] == "group"


def test_the_other_group_gets_the_other_room_from_the_same_feed(archive):
    db.save_schedule_settings(480, 30, False, cohort_group="gp4")

    sync_groups_feed()

    assert groups_commitment("both")["meta"]["room"] == "A4-07 - FD L5 Studio"


def test_with_no_group_set_a_multi_room_session_keeps_its_ambiguity(archive):
    sync_groups_feed()

    both = groups_commitment("both")
    assert both["meta"]["room"] is None
    assert both["meta"]["mine"] is True  # can't tell the user apart from the cohort
    assert both["meta"]["group"] == ["gp4", "gp3"]


def test_a_session_for_another_group_is_not_mine_and_leaves_capacity_free(archive):
    db.save_schedule_settings(480, 30, False, cohort_group="gp3")

    sync_groups_feed()

    gp4_only = groups_commitment("gp4-only")
    assert gp4_only["meta"]["mine"] is False
    assert gp4_only["counts_for_capacity"] is False
    assert gp4_only["capacity_exclusion_reason"] == "not-your-group"


def test_a_not_mine_session_is_restorable_by_hand_and_the_override_survives_resync(archive):
    db.save_schedule_settings(480, 30, False, cohort_group="gp3")
    sync_groups_feed()
    gp4_only = groups_commitment("gp4-only")

    db.update_commitment(gp4_only["id"], capacity_override=1)
    assert db.get_commitment(gp4_only["id"])["counts_for_capacity"] is True

    sync_groups_feed()

    restored = db.get_commitment(gp4_only["id"])
    assert restored["capacity_override"] == 1
    assert restored["counts_for_capacity"] is True
    # The classification underneath is still visible for the UI to explain.
    assert restored["capacity_exclusion_reason"] == "not-your-group"


def test_an_absent_group_line_applies_to_everyone(archive):
    db.save_schedule_settings(480, 30, False, cohort_group="gp3")

    sync_groups_feed()

    induction = groups_commitment("induction")  # DESCRIPTION names no group
    assert induction["meta"]["group"] is None
    assert induction["meta"]["mine"] is True
    assert induction["counts_for_capacity"] is True


# --- delivery_type consumed on import ---------------------------------------


def test_an_induction_defaults_to_priority_support_on_import(archive):
    sync_groups_feed()

    induction = groups_commitment("induction")
    assert induction["meta"]["delivery_type"] == "Induction"
    assert induction["support_level"] == "priority"


def test_a_user_changed_support_level_is_not_reset_by_a_resync(archive):
    sync_groups_feed()
    induction = groups_commitment("induction")
    db.update_commitment(induction["id"], support_level="none")

    sync_groups_feed()

    assert db.get_commitment(induction["id"])["support_level"] == "none"


def test_a_workshop_for_another_group_does_not_get_priority(archive):
    db.save_schedule_settings(480, 30, False, cohort_group="gp3")

    sync_groups_feed()

    # "Workshop" would normally default to priority, but this one is gp4's.
    gp4_only = groups_commitment("gp4-only")
    assert gp4_only["meta"]["delivery_type"] == "Workshop"
    assert gp4_only["support_level"] == "none"


def test_an_optional_event_does_not_consume_capacity(archive):
    sync_groups_feed()

    optional = groups_commitment("optional")
    assert optional["meta"]["delivery_type"] == "Optional Event"
    assert optional["counts_for_capacity"] is False
    assert optional["capacity_exclusion_reason"] == "optional-event"


def test_the_group_setting_round_trips_through_the_route(client):
    resp = client.put("/api/schedule-settings", json={"cohort_group": " gp3 "})
    assert resp.status_code == 200
    assert resp.get_json()["cohort_group"] == "gp3"
    assert client.put("/api/schedule-settings", json={"cohort_group": ""}).get_json()["cohort_group"] is None
