"""briefs.analyse -- the multi-pass Claude extraction.

The network seam is briefs._create; every test here fakes it. These are unit
tests of the pass/parse/cache logic, so they deliberately don't take the
`archive`/`client` fixtures (whose conftest setup stubs briefs.analyse whole).
"""
import json
import types

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
