"""Model fallback for the ICS house-format parser (see ics_import.py).

The deterministic parser in ics_import.py gets most of Westminster's packed
fields, and the group logic resolves most of the rest. What's left -- a handful
of events with a missing room or details line, and, more to the point, whatever
next year's export changes -- is filled here, from Claude, under four
constraints each of which matters more than the feature:

  - BATCH BY DISTINCT DESCRIPTION SHAPE. Ninety-nine events reduce to a handful
    of layouts once their volatile parts (event id, week numbers, dates) are
    normalised away. One call classifies the shapes; the answer is applied to
    every event that shares one.
  - CACHED like colour_analysis: the commitment_classification table, keyed by a
    hash of the normalised description with the algorithm version alongside (see
    db.COMMITMENT_CLASSIFICATION_SCHEMA). A re-sync -- and re-syncs are frequent
    -- never re-pays for a description already classified at the current version.
  - NEVER REQUIRED. No API key, no network, or a malformed reply, and
    classify_gaps returns having changed nothing. A timetable import that
    hard-fails offline is a worse bug than a missing room.
  - NEVER OVERWRITES A CONFIDENT PARSE. Only a field the parser left empty is
    ever filled, and a filled field is recorded in meta["field_sources"] as
    "model" so a wrong classification is attributable rather than mysterious.
"""
import hashlib
import json
import re

import config
import db
import tagging

CLASSIFY_VERSION = 1

# The meta fields the model is asked to supply. lecturer and group are left to
# the deterministic parser alone -- a name list and a group tag are exactly the
# kind of thing a model returns plausibly and wrongly.
MODEL_FIELDS = ("module_code", "module_name", "delivery_type", "site", "room", "details")

# Lines that vary per event and so must not enter the cache key: the event id,
# the week-number line ("Wk 30", "Wks 26-27,29"), and the recurrence blurb
# ("Wkly 29 Jan to 5 Feb, 19 Feb").
_VOLATILE_LINE = re.compile(
    r"^(Event id \d+|Wks?\s+[\d,\s–-]+|(?:Every\s+\d+\s+wks?|Wkly)\b.*)$", re.I
)
_DIGITS = re.compile(r"\d+")
_WS = re.compile(r"\s+")


def _normalise(description):
    """A description with its per-event volatile parts removed, so many events
    collapse to one cache key. Drops the event-id / week-number / recurrence
    lines outright and blanks any remaining digit runs, so two events differing
    only by room number or module-code digits share a shape."""
    kept = []
    for line in (description or "").split("\n"):
        line = _WS.sub(" ", line).strip()
        if not line or _VOLATILE_LINE.match(line):
            continue
        kept.append(_DIGITS.sub("#", line))
    return "\n".join(kept)


def _hash(normalised):
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()


def _has_gap(meta):
    return any(not meta.get(field) for field in MODEL_FIELDS)


def _clean_fields(obj):
    """One model answer reduced to {field: str|None} over MODEL_FIELDS, or None
    if it isn't a dict at all (a truncated reply, say -- not cached, re-asked
    next sync). An all-null dict IS cached: the model saw the shape and had
    nothing to add, and re-asking every sync would be the bug the cache exists
    to prevent."""
    if not isinstance(obj, dict):
        return None
    out = {}
    for field in MODEL_FIELDS:
        value = obj.get(field)
        out[field] = value.strip() if isinstance(value, str) and value.strip() else None
    return out


_PROMPT = """You are parsing university timetable event descriptions into structured fields.
Each description below is one distinct layout, numbered in [brackets]. For each, extract only
what is clearly present; use null for anything not stated. Respond with ONLY a JSON array (no
prose, no markdown fences), one object per numbered description, in order:
[{"n": 0, "module_code": ..., "module_name": ..., "delivery_type": ..., "site": ..., "room": ..., "details": ...}, ...]
 - module_code: a course code such as "5FADE002W/1"
 - module_name: the module's name
 - delivery_type: the session type -- e.g. "Lecture", "Seminar", "Studio", "Workshop", "Induction", "Optional Event"
 - site: the building or campus, never the room on its own
 - room: the specific room
 - details: a short note on what the session actually is ("3D Masterclass", "CV drop-in session"), not a restatement of the fields above"""


def _call_model(descriptions):
    """The single network seam -- stubbed in tests. Takes the list of distinct
    normalised descriptions, returns {index: raw_object} for whatever the model
    returned."""
    client = tagging.get_client()
    listing = "\n\n".join(f"[{i}]\n{d}" for i, d in enumerate(descriptions))
    response = tagging._create_with_retry(
        client,
        model=config.CLAUDE_MODEL,
        max_tokens=4096,
        messages=[{"role": "user", "content": f"{_PROMPT}\n\n{listing}"}],
    )
    # A truncated or malformed reply is not a partial answer to salvage. Per the
    # module contract (NEVER REQUIRED), return nothing and let the import proceed
    # without the model's fills -- but say so, so a missing room is explained
    # rather than mysterious.
    if getattr(response, "stop_reason", None) == "max_tokens":
        print("  commitment classification: reply hit max_tokens; skipping model fills")
        return {}
    raw = "".join(block.text for block in response.content if block.type == "text").strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        raw = raw[4:] if raw.startswith("json") else raw
    try:
        data = json.loads(raw.strip())
    except json.JSONDecodeError:
        print("  commitment classification: reply was not valid JSON; skipping model fills")
        return {}
    result = {}
    for obj in data if isinstance(data, list) else []:
        if isinstance(obj, dict) and isinstance(obj.get("n"), int):
            result[obj["n"]] = obj
    return result


def classify_gaps(events):
    """Fill the meta gaps the deterministic parser and group logic left, for
    the events that still have them, from the classification cache -- topping
    the cache up with one batched model call for shapes it has not seen.

    Mutates each event's `meta` in place: only a currently-empty field is
    filled, and each fill is marked meta["field_sources"][field] = "model".
    Returns the number of events touched (for logging and tests). Changes
    nothing and returns 0 when there is nothing to do or no API key.
    """
    pending = []  # (event, hash) for every event with a fillable gap
    representative = {}  # hash -> a normalised description to classify
    for event in events:
        meta = event.get("meta") or {}
        raw_description = (meta.get("raw") or {}).get("description") or ""
        if not raw_description.strip() or not _has_gap(meta):
            continue
        normalised = _normalise(raw_description)
        if not normalised:
            continue
        description_hash = _hash(normalised)
        pending.append((event, description_hash))
        representative.setdefault(description_hash, normalised)

    if not pending:
        return 0

    cached = db.get_commitment_classifications(set(representative), CLASSIFY_VERSION)

    missing = [h for h in representative if h not in cached]
    if missing and config.ANTHROPIC_API_KEY:
        fresh = _call_model([representative[h] for h in missing])
        for index, description_hash in enumerate(missing):
            fields = _clean_fields(fresh.get(index))
            if fields is None:
                continue
            db.save_commitment_classification(description_hash, CLASSIFY_VERSION, fields)
            cached[description_hash] = fields

    touched = 0
    for event, description_hash in pending:
        fields = cached.get(description_hash)
        if not fields:
            continue
        meta = event["meta"]
        sources = meta.setdefault("field_sources", {})
        filled = False
        for field in MODEL_FIELDS:
            if not meta.get(field) and fields.get(field):
                meta[field] = fields[field]
                sources[field] = "model"
                filled = True
        touched += 1 if filled else 0
    return touched
