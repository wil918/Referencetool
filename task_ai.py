"""Task field generation, powered by Claude.

Fills in whatever a quick-added task left blank -- a duration estimate, an
importance/difficulty rating, a title, a measurable goal -- from nothing but
the one sentence the user typed. Reuses tagging.py's client and retry/error
handling exactly (same model, same transient-error tolerance) rather than
re-implementing it, since this is the same shape of single-shot JSON call to
the same API. Nothing here persists anything; the caller decides which
generated fields to keep and which to overwrite with what the user actually
supplied (see app.py's /api/tasks/generate and db.py's *_source columns).
"""
import json

from tagging import _create_with_retry, get_client
from config import CLAUDE_MODEL

TASK_AI_INSTRUCTIONS = """You are helping someone plan a task on their personal task list \
(design project work, coursework, or a everyday errand). Given a one-sentence description of \
a task, respond with ONLY a JSON object (no other text, no markdown fences) in exactly this \
shape:
{
  "title": "a short task title (3-8 words)",
  "est_minutes": 45,
  "importance": 3,
  "difficulty": 2,
  "measurable_goal": "one sentence describing what 'done' looks like for this task"
}
est_minutes is your best-guess realistic duration in minutes for one focused person doing this
task alone. importance and difficulty are each an integer from 1 (lowest) to 5 (highest).
measurable_goal should be concrete and checkable ("three sketches finished and pinned to the
board"), not vague ("make progress")."""


def generate_task_fields(description):
    client = get_client()
    response = _create_with_retry(
        client,
        model=CLAUDE_MODEL,
        max_tokens=300,
        messages=[
            {
                "role": "user",
                "content": f"{TASK_AI_INSTRUCTIONS}\n\nTask description:\n{description[:2000]}",
            }
        ],
    )
    return _parse_response(response)


def _parse_response(response):
    raw = "".join(block.text for block in response.content if block.type == "text").strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        raw = raw[4:] if raw.startswith("json") else raw
    raw = raw.strip()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # Same fallback philosophy as tagging._parse_response: a malformed
        # reply degrades to "nothing generated" rather than failing the save.
        data = {}

    return {
        "title": data.get("title") or "",
        "est_minutes": _clamp_int(data.get("est_minutes"), 1, 24 * 60),
        "importance": _clamp_int(data.get("importance"), 1, 5),
        "difficulty": _clamp_int(data.get("difficulty"), 1, 5),
        "measurable_goal": data.get("measurable_goal") or "",
    }


def _clamp_int(value, lo, hi):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return None
