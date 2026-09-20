"""briefs.analyse -- the multi-pass Claude extraction.

The network seam is briefs._create; every test here fakes it. These are unit
tests of the pass/parse/cache logic, so they deliberately don't take the
`archive`/`client` fixtures (whose conftest setup stubs briefs.analyse whole).
"""
import json
import types
from datetime import date

import pytest

import briefs

OVERVIEW = json.dumps({
    "summary": "Design an identity.",
    "key_dates": [
        {"label": "Briefing", "date": "2027-01-11", "kind": "briefing"},
        {"label": "Hand-in", "date": "2027-05-07", "kind": "hand-in"},
    ],
    "deliverables": [
        {"title": "Part 1 - Research", "source_ref": "Part 1", "due_date": "2027-03-05"},
        {"title": "Physical submission", "source_ref": "Part 2"},
    ],
    "mandatory_activities": [{"title": "Shop visit", "source_ref": "Shop visit"}],
})

DETAIL = json.dumps({"spec": {"pages": 20}, "tasks": [{"title": "Step", "est_minutes": None}]})


class FakeResp:
    def __init__(self, text, stop_reason="end_turn"):
        self.content = [types.SimpleNamespace(type="text", text=text)]
        self.stop_reason = stop_reason


def _is_overview(prompt):
    return "first of several passes" in prompt


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    briefs._PASS_CACHE.clear()
    monkeypatch.setattr(briefs.tagging, "get_client", lambda: object())
    yield
    briefs._PASS_CACHE.clear()


def _fake_create(overview=OVERVIEW, detail=DETAIL, overview_stop="end_turn", detail_stop="end_turn"):
    def create(client, prompt, max_tokens):
        if _is_overview(prompt):
            return FakeResp(overview, overview_stop)
        return FakeResp(detail, detail_stop)
    return create


def test_passes_assemble_into_one_extraction(monkeypatch):
    monkeypatch.setattr(briefs, "_create", _fake_create())
    out = briefs.analyse("a brief")

    assert out["summary"] == "Design an identity."
    assert len(out["key_dates"]) == 2
    assert [d["title"] for d in out["deliverables"]] == ["Part 1 - Research", "Physical submission"]
    # the per-deliverable pass is merged onto each overview row
    assert out["deliverables"][0]["spec"] == {"pages": 20}
    assert out["deliverables"][0]["tasks"][0]["title"] == "Step"
    # source keys still come from the printed heading
    assert out["deliverables"][0]["source_key"] == "part-1"
    assert out["mandatory_activities"][0]["source_key"] == "activity:shop-visit"


def test_a_truncated_reply_raises_rather_than_reporting_nothing(monkeypatch):
    monkeypatch.setattr(briefs, "_create", _fake_create(overview_stop="max_tokens"))
    with pytest.raises(briefs.BriefExtractionError) as excinfo:
        briefs.analyse("a brief")
    assert excinfo.value.reason == "truncated"
    assert excinfo.value.raw  # the partial reply is kept for inspection


def test_a_malformed_reply_raises_and_keeps_the_raw_text(monkeypatch):
    monkeypatch.setattr(briefs, "_create", _fake_create(overview='{"summary": "cut off'))
    with pytest.raises(briefs.BriefExtractionError) as excinfo:
        briefs.analyse("a brief")
    assert excinfo.value.reason == "malformed"
    assert "cut off" in excinfo.value.raw


def test_a_non_object_reply_raises(monkeypatch):
    monkeypatch.setattr(briefs, "_create", _fake_create(overview='["not", "an", "object"]'))
    with pytest.raises(briefs.BriefExtractionError) as excinfo:
        briefs.analyse("a brief")
    assert excinfo.value.reason == "malformed"


def test_a_retry_after_one_pass_fails_does_not_repeat_the_others(monkeypatch):
    calls = []
    state = {"detail_ok": False}

    def create(client, prompt, max_tokens):
        if _is_overview(prompt):
            calls.append("overview")
            return FakeResp(OVERVIEW)
        calls.append("detail")
        if not state["detail_ok"]:
            return FakeResp("nonsense{")
        return FakeResp(DETAIL)

    monkeypatch.setattr(briefs, "_create", create)

    with pytest.raises(briefs.BriefExtractionError):
        briefs.analyse("a brief")
    assert calls == ["overview", "detail"]  # aborts on the first failed detail pass

    state["detail_ok"] = True
    calls.clear()
    out = briefs.analyse("a brief")

    # the overview pass is served from cache; only the deliverable passes re-run
    assert calls == ["detail", "detail"]
    assert out["deliverables"][0]["spec"] == {"pages": 20}
    assert out["deliverables"][1]["source_key"] == "part-2"


# --- date context and validation (fault: the year is guessed when it should
# be known) ------------------------------------------------------------------


def test_academic_year_range_spans_september_to_august():
    assert briefs.academic_year_range(date(2026, 9, 21)) == ("2026-09-01", "2027-08-31")
    # Before September, still inside the academic year that started last autumn.
    assert briefs.academic_year_range(date(2027, 3, 1)) == ("2026-09-01", "2027-08-31")


def test_date_context_prefers_real_commitments_over_the_academic_year():
    ctx = briefs.date_context(("2026-09-21", "2026-10-27"))
    assert ctx == {"start": "2026-09-21", "end": "2026-10-27", "source": "commitments"}


def test_date_context_falls_back_to_academic_year_with_nothing_imported():
    ctx = briefs.date_context(None, today=date(2026, 9, 21))
    assert ctx == {"start": "2026-09-01", "end": "2027-08-31", "source": "academic_year"}
    ctx = briefs.date_context((None, None), today=date(2026, 9, 21))
    assert ctx["source"] == "academic_year"


def test_a_bare_date_resolves_against_the_projects_own_commitment_year(monkeypatch):
    # The exact scenario the fault describes: a project whose imported
    # timetable runs 21 Sept - 27 Oct 2026. The overview prompt must carry
    # that range so a bare "Monday 26th October" resolves to 2026, not 2025.
    ctx = briefs.date_context(("2026-09-21", "2026-10-27"))
    seen = {}

    def create(client, prompt, max_tokens):
        if _is_overview(prompt):
            seen["prompt"] = prompt
            return FakeResp(OVERVIEW)
        return FakeResp(DETAIL)

    monkeypatch.setattr(briefs, "_create", create)
    out = briefs.analyse("a brief", date_context=ctx)

    assert "2026-09-21 to 2026-10-27" in seen["prompt"]
    assert "resolve its year from that" in seen["prompt"]
    assert out["date_context"] == ctx


def test_a_date_outside_the_range_is_flagged_not_corrected(monkeypatch):
    monkeypatch.setattr(briefs, "_create", _fake_create())
    # OVERVIEW's hand-in is 2027-05-07 and Part 1 is due 2027-03-05 -- both
    # miles outside a 2026 project timetable, exactly the transposed-year bug.
    ctx = briefs.date_context(("2026-09-21", "2026-10-27"))

    out = briefs.analyse("a brief", date_context=ctx)

    hand_in = next(k for k in out["key_dates"] if k["label"] == "Hand-in")
    briefing = next(k for k in out["key_dates"] if k["label"] == "Briefing")
    part_1 = out["deliverables"][0]
    # Flagged, with the exact range it was checked against -- and the date
    # itself is untouched, never silently corrected.
    assert hand_in["date"] == "2027-05-07"
    assert hand_in["date_suspect"] == {"checked_against": ["2026-09-21", "2026-10-27"]}
    assert part_1["due_date"] == "2027-03-05"
    assert part_1["date_suspect"] == {"checked_against": ["2026-09-21", "2026-10-27"]}
    # 2027-01-11 is also outside the range, but by less than the tolerance
    # matters not here -- it's still way over a month out, so it's flagged too.
    assert briefing.get("date_suspect")


def test_a_date_inside_the_range_is_not_flagged(monkeypatch):
    monkeypatch.setattr(briefs, "_create", _fake_create())
    # A range wide enough to cover every date OVERVIEW actually uses.
    ctx = briefs.date_context(("2026-09-01", "2027-08-31"))

    out = briefs.analyse("a brief", date_context=ctx)

    assert all("date_suspect" not in k for k in out["key_dates"])
    assert "date_suspect" not in out["deliverables"][0]


def test_analyse_without_date_context_never_flags_anything(monkeypatch):
    # Callers that don't pass a context (or a project with truly nothing to
    # anchor against, before this landed) get the old behaviour: no validation
    # pass at all, rather than flagging against a context that doesn't exist.
    monkeypatch.setattr(briefs, "_create", _fake_create())
    out = briefs.analyse("a brief")
    assert out["date_context"] is None
    assert all("date_suspect" not in k for k in out["key_dates"])
