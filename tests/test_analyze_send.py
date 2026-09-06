"""analyze._send -- the shared Claude call behind the cross-reference write-up
and the concept critique. A response cut off at max_tokens must not read as a
finished one. (test_concept_analysis.py stubs _send whole, so this lives apart.)
"""
import types

import analyze
import tagging


def _resp(text, stop_reason="end_turn"):
    return types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text=text)], stop_reason=stop_reason
    )


def test_a_complete_writeup_is_returned_verbatim(monkeypatch):
    monkeypatch.setattr(tagging, "get_client", lambda: object())
    monkeypatch.setattr(tagging, "_create_with_retry", lambda *a, **k: _resp("A full critique."))
    assert analyze._send([{"role": "user", "content": "go"}]) == "A full critique."


def test_a_truncated_writeup_is_marked(monkeypatch):
    monkeypatch.setattr(tagging, "get_client", lambda: object())
    monkeypatch.setattr(tagging, "_create_with_retry",
                        lambda *a, **k: _resp("Strong connections\nThe tailoring ref", "max_tokens"))
    out = analyze._send([{"role": "user", "content": "go"}])
    assert out.startswith("Strong connections")
    assert "cut off before it finished" in out
