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
import hashlib
import json
import re

import fitz  # PyMuPDF

import tagging
from config import CLAUDE_MODEL

# A brief longer than this is truncated before it reaches the model. The passes
# below keep each *response* small; this bounds the *prompt*.
_MAX_BRIEF_CHARS = 24000


class BriefExtractionError(Exception):
    """Extraction failed in a way the user has to be told about, rather than a
    result that happens to be empty.

    Before this existed the parse fell back to `{"summary": <raw text>, ...}` on
    any formatting slip, and the review sheet then reported "None found in the
    brief" -- asserting the brief was empty when in fact the read broke. A
    failure is now a failure: it says so, says why (`reason` is "truncated" or
    "malformed"), and the caller offers a retry. `raw` is whatever the model did
    return, kept for inspection and never shown as though it were the extraction.
    """

    def __init__(self, reason, message, raw=""):
        super().__init__(message)
        self.reason = reason
        self.raw = raw or ""


def extract_text(pdf_path):
    """Every page's text, joined. Text only -- a brief is prose, not a
    tearsheet, so the embedded-image path `ingest.py` uses is not wanted here."""
    doc = fitz.open(pdf_path)
    try:
        return "\n".join(page.get_text() for page in doc).strip()
    finally:
        doc.close()


# Two prompts, because one response can't safely carry a whole four-part brief
# with a task skeleton under each deliverable -- at max_tokens the reply is cut
# off mid-string and nothing parses. The overview pass gets the shape; a second
# pass per deliverable gets its detail. The shape is still a suggestion, not a
# contract: `spec` is passed straight through to deliverables.spec, which
# renders arbitrary JSON (schedule/deliverables.js renderSpec).
_OVERVIEW_INSTRUCTIONS = """You are reading a fashion/design course assignment brief so a student can turn it \
into a schedule. This is the first of several passes: capture the brief's SHAPE only -- a later pass \
fills in each deliverable's detailed requirements and task list, so do NOT include those here. \
Respond with ONLY a JSON object (no prose, no markdown fences) in this shape:

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
      "description": "one or two sentences on what this deliverable is"
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
- List EVERY distinct thing the brief asks to be handed in as a deliverable, including
  a physical or studio submission that sits alongside the written/visual documents.
- `mandatory_activities` are things the brief requires the student to *do* that
  happen somewhere specific: shop visits, museum/archive visits, workshops with
  required attendance, documented tests. `location_bound` is true when it can only
  happen at a particular place.
- Every array may be empty. Prefer omitting a doubtful item to fabricating one."""


_DELIVERABLE_INSTRUCTIONS = """You are reading a fashion/design course assignment brief. Focus ONLY on the one \
deliverable named below and return its concrete requirements and a task skeleton. Respond with ONLY \
a JSON object (no prose, no markdown fences) in this shape:

{
  "spec": {"pages": 20, "required_items": ["3 documented fabric tests"]},
  "tasks": [
    {"title": "Compile fabric research", "note": "", "est_minutes": null}
  ]
}

Rules:
- `spec` holds the concrete requirements for THIS deliverable -- page counts, required
  items, format notes -- in whatever keys fit. `required_items` should be a list of
  short strings a student can tick off. Use only what the brief states for this
  deliverable; omit a key rather than guess.
- `tasks` is a SKELETON: 3-6 concrete steps that would get this deliverable done, in
  rough order. `est_minutes` only if the brief implies a duration, otherwise null.
- Either may be empty if the brief says nothing concrete about this deliverable."""


# Per-pass memo, keyed by (brief-text hash, pass name). The whole point of
# splitting the extraction is lost if a retry after one pass fails re-pays for
# the passes that already returned -- so a successful pass is cached and a fresh
# analyse() call (the user clicking "try again" is a new request) reuses it. A
# raised BriefExtractionError is never cached, so only the failed pass re-runs.
# In memory only: brief import is rare and the dev server is long-lived, so a
# DB-backed cache (as commitment_classify uses) would be more than it earns.
_PASS_CACHE = {}


def _cache(fingerprint, pass_name, produce):
    key = (fingerprint, pass_name)
    if key not in _PASS_CACHE:
        _PASS_CACHE[key] = produce()
    return _PASS_CACHE[key]


def _create(client, prompt, max_tokens):
    """The single network seam -- patched in tests."""
    return tagging._create_with_retry(
        client,
        model=CLAUDE_MODEL,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )


def _response_text(response):
    return "".join(b.text for b in response.content if b.type == "text").strip()


def _run_pass(client, prompt, max_tokens):
    """One extraction call: send `prompt`, insist the reply was complete and
    valid JSON, return the parsed object. Raises BriefExtractionError otherwise
    -- never a salvaged half-result."""
    response = _create(client, prompt, max_tokens)
    # The API says outright when it ran out of room. A max_tokens stop means the
    # JSON is cut off mid-value by definition; do not hand it to json.loads.
    if getattr(response, "stop_reason", None) == "max_tokens":
        raise BriefExtractionError(
            "truncated",
            "The brief was long enough that Claude's reply was cut off before it "
            "finished, so it couldn't be read. Nothing was imported -- try again.",
            raw=_response_text(response),
        )
    raw = _response_text(response)
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        raw = raw[4:] if raw.startswith("json") else raw
    raw = raw.strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise BriefExtractionError(
            "malformed",
            "Claude's reply for part of the brief wasn't valid JSON, so the brief "
            "couldn't be read. Nothing was imported -- try again.",
            raw=raw,
        ) from e
    if not isinstance(data, dict):
        raise BriefExtractionError(
            "malformed",
            "Claude's reply for part of the brief wasn't the expected shape, so "
            "the brief couldn't be read. Nothing was imported -- try again.",
            raw=raw,
        )
    return data


def analyse(text):
    """Ask Claude for the brief's structure, in passes so no single response has
    to carry everything: one overview call (summary, key dates, the deliverable
    list, mandatory activities), then one call per deliverable for its spec and
    task skeleton. Each pass is cached on a hash of the brief text, so a retry
    after one pass fails does not repeat the others.

    Returns the assembled dict with a stable source_key on every deliverable and
    activity. Raises BriefExtractionError if any pass comes back truncated or
    unparseable.
    """
    client = tagging.get_client()
    brief_text = text[:_MAX_BRIEF_CHARS]
    fingerprint = hashlib.sha256(brief_text.encode("utf-8")).hexdigest()

    overview = _cache(fingerprint, "overview", lambda: _run_pass(
        client,
        f"{_OVERVIEW_INSTRUCTIONS}\n\nHere is the brief:\n\n{brief_text}",
        max_tokens=8192,
    ))

    deliverables = overview.get("deliverables")
    if not isinstance(deliverables, list):
        deliverables = []

    detailed = []
    for index, deliverable in enumerate(deliverables):
        if not isinstance(deliverable, dict):
            continue
        ref = deliverable.get("source_ref") or deliverable.get("title") or f"deliverable {index + 1}"
        prompt = (
            f"{_DELIVERABLE_INSTRUCTIONS}\n\n"
            f"The deliverable: {ref} ({deliverable.get('title') or ref})\n\n"
            f"Here is the brief:\n\n{brief_text}"
        )
        detail = _cache(
            fingerprint,
            f"deliverable:{_slugify(ref, str(index))}",
            lambda p=prompt: _run_pass(client, p, max_tokens=4096),
        )
        merged = dict(deliverable)
        if isinstance(detail.get("spec"), (dict, list)):
            merged["spec"] = detail["spec"]
        if isinstance(detail.get("tasks"), list):
            merged["tasks"] = detail["tasks"]
        detailed.append(merged)
    overview["deliverables"] = detailed

    # Normalise the remaining lists so the review sheet never has to guard for a
    # missing key or a non-list.
    for key in ("key_dates", "mandatory_activities"):
        if not isinstance(overview.get(key), list):
            overview[key] = []
    overview.setdefault("summary", "")
    return assign_source_keys(overview)


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
