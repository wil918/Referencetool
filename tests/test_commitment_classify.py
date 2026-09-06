"""commitment_classify.classify_gaps -- the model fallback ics_import.sync_feed
runs for the meta fields the deterministic parser couldn't fill.

Four things matter more than the feature (see the module docstring):
distinct-shape batching, caching across re-syncs, never being required, and
never overwriting a confident parse. One test each.
"""
from datetime import date

import commitment_classify
import config
import db
import ics_import

FIXED_WINDOW = {"window_start": date(2026, 1, 1), "window_days": 200}


def vevent(uid, description, *, location, start="20260105T090000", end="20260105T110000",
           summary="5FADE010W Drawing"):
    return "\n".join([
        "BEGIN:VEVENT",
        f"UID:{uid}",
        "DTSTAMP:20260101T000000Z",
        f"DTSTART;TZID=Europe/London:{start}",
        f"DTEND;TZID=Europe/London:{end}",
        f"SUMMARY:{summary}",
        f"DESCRIPTION:{description}",
        f"LOCATION:{location}",
        "END:VEVENT",
    ])


def calendar(*events):
    return "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Test//EN\n" + "\n".join(events) + "\nEND:VCALENDAR\n"


def sync(ics_text, source="drawing.ics"):
    return ics_import.sync_feed(source, ics_text, **FIXED_WINDOW)


# A session the parser reads fully EXCEPT the details line, which isn't there --
# one clean gap for the model to fill. `eid`/`wk` are the volatile parts
# _normalise strips, so every instance shares one cache shape.
DRAWING_LOCATION = "A Building\\, A3-02"
NO_DETAILS = (
    "5FADE010W \\nDrawing \\nSeminar \\nA Building\\, A3-02 \\nSmith\\, Jo "
    "\\nEvent id {eid} \\nTeaching \\nWk {wk} \\n"
)


def drawing(uid, eid=1, wk=3, **kw):
    return vevent(uid, NO_DETAILS.format(eid=eid, wk=wk), location=DRAWING_LOCATION, **kw)


def test_a_gap_is_filled_from_the_model_and_marked_as_model_sourced(archive, monkeypatch):
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(
        commitment_classify, "_call_model",
        lambda descriptions: {0: {"n": 0, "details": "Life drawing session"}},
    )

    sync(calendar(drawing("d1@x")))

    c = db.get_commitment_by_external_uid("d1@x")
    assert c["meta"]["details"] == "Life drawing session"
    assert c["meta"]["field_sources"]["details"] == "model"


def test_a_confident_parse_is_never_replaced_by_a_model_value(archive, monkeypatch):
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(
        commitment_classify, "_call_model",
        lambda descriptions: {0: {
            "n": 0,
            "module_name": "Something Else Entirely",  # parser already has "Drawing"
            "details": "Life drawing session",         # this one IS a gap
        }},
    )

    sync(calendar(drawing("d1@x")))

    meta = db.get_commitment_by_external_uid("d1@x")["meta"]
    assert meta["module_name"] == "Drawing"
    assert "module_name" not in meta["field_sources"]
    assert meta["details"] == "Life drawing session"


def test_events_are_batched_by_distinct_description_shape(archive, monkeypatch):
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "test-key")
    calls = []

    def fake(descriptions):
        calls.append(list(descriptions))
        return {i: {"n": i, "details": f"filled {i}"} for i in range(len(descriptions))}

    monkeypatch.setattr(commitment_classify, "_call_model", fake)

    other = (
        "5FADE011W \\nPrint \\nWorkshop \\nA Building\\, A3-05 \\nDoe\\, Sam "
        "\\nEvent id {eid} \\nTeaching \\nWk {wk} \\n"
    )

    def printmaking(uid, eid, wk, start, end):
        return vevent(uid, other.format(eid=eid, wk=wk), location="A Building\\, A3-05",
                      start=start, end=end, summary="5FADE011W Print")

    sync(calendar(
        drawing("a1@x", eid=1, wk=3, start="20260105T090000", end="20260105T110000"),
        drawing("a2@x", eid=2, wk=4, start="20260112T090000", end="20260112T110000"),
        drawing("a3@x", eid=3, wk=5, start="20260119T090000", end="20260119T110000"),
        printmaking("b1@x", 4, 3, "20260106T090000", "20260106T110000"),
        printmaking("b2@x", 5, 4, "20260113T090000", "20260113T110000"),
    ))

    # Five events, two shapes -> exactly one call, carrying two descriptions.
    assert len(calls) == 1
    assert len(calls[0]) == 2
    assert db.get_commitment_by_external_uid("a3@x")["meta"]["details"] == db.get_commitment_by_external_uid("a1@x")["meta"]["details"]


def test_a_resync_does_not_reissue_a_call_for_an_unchanged_description(archive, monkeypatch):
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "test-key")
    calls = []

    def fake(descriptions):
        calls.append(list(descriptions))
        return {i: {"n": i, "details": "cached answer"} for i in range(len(descriptions))}

    monkeypatch.setattr(commitment_classify, "_call_model", fake)
    ics = calendar(drawing("d1@x"))

    sync(ics)
    sync(ics)

    assert len(calls) == 1  # the second sync is served entirely from the cache


def test_import_completes_with_no_api_key_and_leaves_the_parser_result_intact(archive, monkeypatch):
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "")

    def boom(descriptions):
        raise AssertionError("_call_model must not be reached without an API key")

    monkeypatch.setattr(commitment_classify, "_call_model", boom)

    result = sync(calendar(drawing("d1@x")))

    assert result["created"] == 1
    meta = db.get_commitment_by_external_uid("d1@x")["meta"]
    assert meta["module_name"] == "Drawing"  # parser fields all intact
    assert meta["details"] is None           # the gap simply stays a gap
    assert "details" not in meta["field_sources"]


def test_a_failed_model_call_does_not_fail_the_import(archive, monkeypatch):
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "test-key")

    def boom(descriptions):
        raise RuntimeError("network down")

    monkeypatch.setattr(commitment_classify, "_call_model", boom)

    result = sync(calendar(drawing("d1@x")))

    assert result["created"] == 1
    assert db.get_commitment_by_external_uid("d1@x")["meta"]["details"] is None
