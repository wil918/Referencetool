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
import re

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
      "source_ref": "Part 1",
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
    {"title": "Fabric shop visit", "source_ref": "Fabric shop visit", "kind": "shop visit",
     "note": "at least one documented visit", "location_bound": true}
  ]
}

Rules:
- Extract only what the brief actually states. Do NOT invent dates, weightings or
  page counts. If something is not given, leave the field out rather than guessing.
- `source_ref` is the part number or section heading EXACTLY as printed in the brief
  for that deliverable or activity -- "Part 1", "Part 2 - Final Realisation", "A. Portfolio".
  Copy it verbatim; do not paraphrase, renumber or tidy it. A re-import of a revised
  brief uses it to recognise this as the same item, so a stable, printed string matters
  more than a neat one. If the brief gives an activity no heading, repeat its title here.
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
    """Ask Claude for the brief's structure. One call; returns the parsed dict
    with a stable source_key stamped on every deliverable and activity."""
    client = tagging.get_client()
    prompt = EXTRACTION_INSTRUCTIONS + f"\n\nHere is the brief:\n\n{text[:24000]}"
    response = tagging._create_with_retry(
        client,
        model=CLAUDE_MODEL,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    return assign_source_keys(_parse(response))


# --- provenance keys -----------------------------------------------------------
#
# source_key is the stable identifier that makes a re-import a diff rather than a
# duplicate insert. It must be identical whenever the source document is, so it
# is derived from the brief's OWN words -- the printed part number / heading the
# model copied into `source_ref` -- and never from the model-written `title`,
# which may come back rephrased next run ("Part 1 - Research and Design
# Development Portfolio" vs "Part 1: Research & Design Portfolio") and would then
# make every deliverable look new.


def _slugify(text, fallback):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return s or fallback


def _uniquifier():
    """Returns a function that appends -2, -3 ... to a key it has seen before,
    so two deliverables printed under the same heading still get distinct keys."""
    seen = set()

    def take(key):
        candidate, n = key, 2
        while candidate in seen:
            candidate, n = f"{key}-{n}", n + 1
        seen.add(candidate)
        return candidate

    return take


def assign_source_keys(extraction):
    """Stamp `source_key` onto every extracted deliverable and mandatory
    activity, in place, and return `extraction`.

    Idempotent: an item that already carries a non-empty source_key keeps it
    (so re-running over a stored extraction, or over a hand-tweaked one, never
    renumbers anything). Deliverables and activities get separate namespaces --
    an activity key is prefixed `activity:` -- so a deliverable and an activity
    with the same heading don't collide.
    """
    if not isinstance(extraction, dict):
        return extraction

    take = _uniquifier()
    for d in extraction.get("deliverables") or []:
        if not isinstance(d, dict):
            continue
        if d.get("source_key"):
            take(d["source_key"])
            continue
        basis = d.get("source_ref") or d.get("title") or "deliverable"
        d["source_key"] = take(_slugify(basis, "deliverable"))

    take_activity = _uniquifier()
    for a in extraction.get("mandatory_activities") or []:
        if not isinstance(a, dict):
            continue
        if a.get("source_key"):
            take_activity(a["source_key"])
            continue
        basis = a.get("source_ref") or a.get("title") or "activity"
        a["source_key"] = take_activity("activity:" + _slugify(basis, "activity"))

    return extraction


# --- re-import diff ----------------------------------------------------------

_DELIVERABLE_DIFF_FIELDS = ("title", "due_at", "weighting", "description", "spec")


def _norm(field, value):
    """Compare-ready form of a deliverable field, so a cosmetic difference
    (a date with a time on it, "" vs null, 40 vs 40.0) doesn't read as a change."""
    if field == "due_at":
        return value[:10] if isinstance(value, str) and len(value) >= 10 else None
    if field == "weighting":
        try:
            return float(value) if value is not None and value != "" else None
        except (TypeError, ValueError):
            return None
    if field == "spec":
        return value or None
    return (value or "").strip() if isinstance(value, str) else (value or None)


def _extracted_deliverable_value(field, extracted):
    # The extraction names the due date `due_date`; the row calls it `due_at`.
    return extracted.get("due_date") if field == "due_at" else extracted.get(field)


def diff_against(extraction, existing):
    """Sort a source-keyed extraction against the brief's existing deliverable
    rows into the four groups the review sheet presents:

        unchanged  matched by source_key, no field differs
        changed    matched, one or more fields differ -- carries per-field
                   [old, new] so the sheet can offer each
        new        no existing row for this source_key
        gone       an existing row whose source_key is absent from the extraction

    `existing` is the list db.list_brief_deliverables returns.
    """
    by_key = {d["source_key"]: d for d in existing if d.get("source_key")}
    matched = set()
    groups = {"unchanged": [], "changed": [], "new": [], "gone": []}

    for d in extraction.get("deliverables") or []:
        if not isinstance(d, dict):
            continue
        sk = d.get("source_key")
        row = by_key.get(sk)
        if row is None:
            groups["new"].append(d)
            continue
        matched.add(sk)
        deltas = {}
        for field in _DELIVERABLE_DIFF_FIELDS:
            old = _norm(field, row.get(field))
            new = _norm(field, _extracted_deliverable_value(field, d))
            if new is None:
                continue  # the brief no longer states this field -> not a change
            if old != new:
                deltas[field] = [row.get(field), _extracted_deliverable_value(field, d)]
        entry = {"source_key": sk, "existing_id": row["id"], "title": row["title"],
                 "extracted": d}
        if deltas:
            entry["fields"] = deltas
            groups["changed"].append(entry)
        else:
            groups["unchanged"].append(entry)

    for sk, row in by_key.items():
        if sk not in matched:
            groups["gone"].append({"source_key": sk, "existing_id": row["id"],
                                   "title": row["title"]})

    return groups
