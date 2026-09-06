"""Assignment-brief import.

A brief PDF attached to a project is read with the PyMuPDF already in the stack
(same library `ingest.py` uses), and Claude proposes the structure a schedule
would need from it: key dates, deliverables with their page counts and required
items, a task skeleton per deliverable, and the mandatory activities that imply
location-bound tasks.

Nothing here writes to the schedule. This module only *proposes* -- `app.py`
stores the proposal in `briefs.extracted` and the review sheet in the
Deliverables tab is where a human accepts, edits or discards each item before
any of it becomes a deliverable, task or commitment.

Brief formats change year to year -- next year's may carry tutor contact points,
reviews and presentations, and shift sessions from skills teaching toward project
development. So the extraction asks for whatever shape is present and never
assumes a fixed one; `deliverables.spec` staying JSON is the same decision.
"""
import json

import fitz  # PyMuPDF

import tagging
from config import CLAUDE_MODEL


def extract_text(pdf_path):
    """Every page's text, joined. Text only -- a brief is prose, not a
    tearsheet, so the embedded-image path `ingest.py` uses is not wanted here."""
    doc = fitz.open(pdf_path)
    try:
        return "\n".join(page.get_text() for page in doc).strip()
    finally:
        doc.close()


# The shape is a suggestion, not a contract: the prompt asks for what is present
# and the review sheet renders whatever comes back. `spec` in particular is
# passed straight through to deliverables.spec, which already renders arbitrary
# JSON (schedule/deliverables.js renderSpec).
EXTRACTION_INSTRUCTIONS = """You are reading a fashion/design course assignment brief so a student can turn it \
into a schedule. Respond with ONLY a JSON object (no prose, no markdown fences) in this shape:

{
  "summary": "one short paragraph, plain language, describing what the brief asks for",
  "key_dates": [
    {"label": "Briefing", "date": "YYYY-MM-DD", "kind": "briefing", "note": ""}
  ],
  "deliverables": [
    {
      "title": "Part 1 - Research",
      "due_date": "YYYY-MM-DD",
      "weighting": 40,
      "description": "",
      "spec": {"pages": 20, "required_items": ["3 documented fabric tests"]},
      "tasks": [
        {"title": "Compile fabric research", "note": "", "est_minutes": null}
      ]
    }
  ],
  "mandatory_activities": [
    {"title": "Fabric shop visit", "kind": "shop visit", "note": "at least one documented visit",
     "location_bound": true}
  ]
}

Rules:
- Extract only what the brief actually states. Do NOT invent dates, weightings or
  page counts. If something is not given, leave the field out rather than guessing.
- `key_dates.kind` is one of: briefing, hand-in, review, tutorial, presentation, other.
- `deliverables[].spec` holds the concrete requirements for that deliverable --
  page counts, required items, format notes -- in whatever keys fit. `required_items`
  should be a list of short strings a student can tick off.
- `deliverables[].tasks` is a SKELETON: 3-6 concrete steps that would get that
  deliverable done, in rough order. `est_minutes` only if the brief implies a
  duration, otherwise null.
- `mandatory_activities` are things the brief requires the student to *do* that
  happen somewhere specific: shop visits, museum/archive visits, workshops with
  required attendance, documented tests. `location_bound` is true when it can only
  happen at a particular place.
- Every array may be empty. Prefer omitting a doubtful item to fabricating one."""


def _parse(response):
    """Same tolerant parse as tagging._parse_response, but for the brief's
    larger object -- strip an accidental fence, json.loads, and on a formatting
    slip fall back to a summary-only extraction rather than crashing the import.
    """
    raw = "".join(b.text for b in response.content if b.type == "text").strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        raw = raw[4:] if raw.startswith("json") else raw
    raw = raw.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {"summary": raw, "key_dates": [], "deliverables": [], "mandatory_activities": []}
    if not isinstance(data, dict):
        return {"summary": "", "key_dates": [], "deliverables": [], "mandatory_activities": []}
    # Normalise the three lists so the review sheet never has to guard for a
    # missing key or a non-list.
    for key in ("key_dates", "deliverables", "mandatory_activities"):
        if not isinstance(data.get(key), list):
            data[key] = []
    data.setdefault("summary", "")
    return data


def analyse(text):
    """Ask Claude for the brief's structure. One call; returns the parsed dict."""
    client = tagging.get_client()
    prompt = EXTRACTION_INSTRUCTIONS + f"\n\nHere is the brief:\n\n{text[:24000]}"
    response = tagging._create_with_retry(
        client,
        model=CLAUDE_MODEL,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    return _parse(response)
