"""Supporting-document import: a brief rarely arrives alone. A workshop and
materials list, a reading list, a technical handout -- each names real
preparation work with a hard date, but none of it IS the brief, so it gets
its own extraction and its own review sheet (supporting_documents.extracted)
rather than being folded into briefs.py.

Two things a supporting document does that a brief does not:

  - IT IS OFTEN SPLIT BY GROUP. "Groups 1 & 2: Monday 21st September. Groups
    3 & 4: Wednesday 23rd." reconcile_group/resolve_group_scope check the
    printed group text against the user's own schedule_settings.cohort_group
    and drop what plainly isn't theirs. Where the two can't be told apart --
    no digits to compare, or no cohort_group recorded at all -- the item is
    kept and flagged rather than guessed either way (see "unresolved" below).

  - IT PRODUCES DEADLINED PREPARATION, NOT ATTENDANCE. The session itself
    (the workshop, the crit) is already a commitment on the timetable -- this
    module never turns one into a task. What it extracts is only what has to
    be gathered or done BEFORE that session, one task per thing: a materials
    list is one task per item to obtain, never a single "gather materials"
    task, because each is acquired at a different time and in a different
    place, and some are already owned.

Nothing here writes to the schedule -- exactly the briefs.py contract.
app.py stores the proposal in supporting_documents.extracted and the review
sheet is where a human accepts, edits or discards each item before any of it
becomes a task.

Unlike briefs.py, THIS IS NOT RE-IMPORTED AS A DIFF: apply always creates
fresh task rows, with no (document_id, source_key) matching against rows
already on the schedule. A supporting document's preparation tasks are a much
smaller, lower-stakes set than a whole deliverable breakdown, and the
diff/reset machinery briefs.py earned over several sessions isn't worth
building twice for it; re-importing a revised document and re-approving it
will duplicate anything already applied, so the review sheet's discard
toggles are the only guard. Delete the document to start over.
"""
import json
import re
from datetime import date, timedelta

import fitz  # PyMuPDF
from docx import Document as DocxDocument

import briefs  # BriefExtractionError and date_context are shared vocabulary
import tagging
from config import CLAUDE_MODEL

_MAX_DOC_CHARS = 16000


def extract_text(path):
    """Every page/paragraph's text, joined. PDF via the fitz already in the
    stack; .docx via python-docx (paragraphs, then table cells -- a materials
    list is as likely to be a table as a bullet list). Text only, same
    reasoning as briefs.extract_text: this is prose to read, not a tearsheet.
    """
    suffix = path.suffix.lower()
    if suffix == ".docx":
        doc = DocxDocument(str(path))
        parts = [p.text for p in doc.paragraphs]
        for table in doc.tables:
            for row in table.rows:
                parts.extend(cell.text for cell in row.cells)
        return "\n".join(p for p in parts if p.strip()).strip()
    doc = fitz.open(path)
    try:
        return "\n".join(page.get_text() for page in doc).strip()
    finally:
        doc.close()


def _date_context_paragraph(ctx):
    """The same DATE CONTEXT paragraph briefs.py builds -- duplicated rather
    than imported (briefs._date_context_paragraph is that module's own
    private helper) since the two prompts otherwise share no wording."""
    if not ctx:
        return ""
    span = f"{ctx['start']} to {ctx['end']}"
    if ctx["source"] == "commitments":
        return (
            f"\n\nDATE CONTEXT: this project's own timetable runs {span}. A bare "
            f"date (\"Monday 26th October\", no year given) almost certainly falls "
            f"inside or near this range -- resolve its year from that."
        )
    return (
        f"\n\nDATE CONTEXT: no timetable is imported for this project yet, so "
        f"treat {span} (the current academic year) as the likely window for a "
        f"bare date, but say what you actually read rather than force-fitting it."
    )


_INSTRUCTIONS = """You are reading a document that SUPPORTS a fashion/design course assignment brief -- \
a workshop and materials list, a reading list, a technical handout -- not the brief itself. Respond \
with ONLY a JSON object (no prose, no markdown fences) in this shape:

{
  "summary": "one short sentence describing what this document is",
  "sessions": [
    {"label": "Construction workshop", "date": "YYYY-MM-DD", "note": "", "group": "Groups 1 & 2"}
  ],
  "preparation_tasks": [
    {"title": "Bring your Construction toile from first year", "note": "",
     "due_date": "YYYY-MM-DD", "group": "Groups 1 & 2", "session_index": 0}
  ]
}

Rules:
- `sessions` is INFORMATIONAL ONLY -- every dated session or activity the document names
  (a workshop, a crit, a hand-in). Do NOT propose a task for attending one: it is either
  already a timetabled commitment or the brief's own concern, never this document's.
- `group` is the EXACT printed text naming which parallel-teaching group(s) a session or
  task applies to -- "Groups 1 & 2", "Group 3" -- copied verbatim, or null if the document
  does not split by group at all. Where a `preparation_tasks` entry doesn't restate its own
  group, copy it from the session it precedes.
- `preparation_tasks` is what has to be GATHERED, MADE or DONE before a session, never the
  session itself. ONE ENTRY PER DISTINCT THING -- a materials list ("bring at least 3
  artefacts", "bring your first-year toile", specific fabrics or tools) explodes into one
  task per item, never a single "gather materials" task, because each is obtained
  separately and some may already be owned.
- `due_date` is when it needs to be ready -- normally the session's own date (`session_index`
  links to it), earlier only if the document states an earlier deadline explicitly.
- `session_index` is the 0-based index into `sessions` this task precedes, or null if the
  task has its own explicit deadline unconnected to any listed session.
- Extract only what the document actually states. Do NOT invent dates or items. Either
  array may be empty."""


def _response_text(response):
    return "".join(b.text for b in response.content if b.type == "text").strip()


def _create(client, prompt, max_tokens=4096):
    """The single network seam -- patched in tests, same pattern as
    briefs._create and commitment_classify._call_model."""
    return tagging._create_with_retry(
        client, model=CLAUDE_MODEL, max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )


def _run_pass(client, prompt, max_tokens):
    """Send `prompt`, insist the reply was complete and valid JSON, return the
    parsed object. Raises briefs.BriefExtractionError otherwise -- a
    supporting document is a deliberate upload, so a failed read must say so
    rather than quietly proposing nothing (same reasoning as briefs.py's)."""
    response = _create(client, prompt, max_tokens)
    if getattr(response, "stop_reason", None) == "max_tokens":
        raise briefs.BriefExtractionError(
            "truncated",
            "The document was long enough that Claude's reply was cut off before "
            "it finished, so it couldn't be read. Nothing was imported -- try again.",
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
        raise briefs.BriefExtractionError(
            "malformed",
            "Claude's reply wasn't valid JSON, so the document couldn't be read. "
            "Nothing was imported -- try again.",
            raw=raw,
        ) from e
    if not isinstance(data, dict):
        raise briefs.BriefExtractionError(
            "malformed",
            "Claude's reply wasn't the expected shape, so the document couldn't "
            "be read. Nothing was imported -- try again.",
            raw=raw,
        )
    return data


# --- group reconciliation ----------------------------------------------------


def reconcile_group(group_text, cohort_group):
    """Whether a printed group phrase ("Groups 1 & 2") is the user's own
    group, going by digit overlap against schedule_settings.cohort_group
    ("gp3" -> {3}).

    Returns "mine", "other", "unresolved" (can't be told apart -- no digits
    on one side or the other, or the digits are on both sides but disjoint
    was not what happened, this genuinely couldn't be compared) or None (the
    item names no group at all -- applies to everyone, nothing to reconcile).

    This is deliberately a different match than ics_import._session_is_mine,
    which compares an exact feed tag ("gp3") against another exact tag. A
    document is prose, not a controlled vocabulary, so "ask rather than
    guess" is the fallback instead of an exact-match miss.
    """
    if not group_text:
        return None
    doc_numbers = set(re.findall(r"\d+", group_text))
    mine_numbers = set(re.findall(r"\d+", cohort_group or ""))
    if not doc_numbers or not mine_numbers:
        return "unresolved"
    return "mine" if doc_numbers & mine_numbers else "other"


def resolve_group_scope(items, cohort_group):
    """Filter a list of dicts each optionally carrying `group` (verbatim
    printed text) down to what should be PROPOSED for this user: items with
    no group split, items matching their own group, and items whose group
    couldn't be resolved -- surfaced (via `group_match`) rather than silently
    dropped. An item for a group that is clearly not the user's is dropped
    entirely: "propose only their date" means it is not offered at all, not
    offered-and-unticked.
    """
    kept = []
    for item in items:
        match = reconcile_group(item.get("group"), cohort_group)
        if match == "other":
            continue
        out = dict(item)
        if match is not None:
            out["group_match"] = match
        kept.append(out)
    return kept


# --- date validation (shares vocabulary with briefs.py, not its code) -------


def _is_out_of_range(date_str, ctx):
    if not date_str or not ctx:
        return False
    try:
        moment = date.fromisoformat(date_str[:10])
        start = date.fromisoformat(ctx["start"])
        end = date.fromisoformat(ctx["end"])
    except ValueError:
        return False
    tolerance = timedelta(days=31)
    return moment < start - tolerance or moment > end + tolerance


def _flag_dates_out_of_range(extraction, ctx):
    if not ctx:
        return
    checked_against = [ctx["start"], ctx["end"]]
    for s in extraction.get("sessions") or []:
        if isinstance(s, dict) and _is_out_of_range(s.get("date"), ctx):
            s["date_suspect"] = {"checked_against": checked_against}
    for t in extraction.get("preparation_tasks") or []:
        if isinstance(t, dict) and _is_out_of_range(t.get("due_date"), ctx):
            t["date_suspect"] = {"checked_against": checked_against}


def _mark_matched_commitments(sessions, commitment_dates):
    """Session 15's "implies preparation" idea applied here: a session this
    document names is either already on the timetable (the normal case -- the
    workshop IS a commitment) or it isn't yet (a document arriving ahead of
    the feed catching up, or a date worth double-checking). Flagging which is
    which is exactly what makes a mismatch visible in the review sheet
    instead of silently trusting an unconfirmed date.
    """
    commitment_dates = commitment_dates or set()
    for s in sessions:
        if isinstance(s, dict) and s.get("date"):
            s["matched_commitment"] = s["date"][:10] in commitment_dates


def _slugify(text, fallback):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return s or fallback


def _assign_source_keys(preparation_tasks):
    """Stamp a stable-ish source_key onto each preparation task, from its own
    title -- there is no printed heading to key against here (unlike a
    brief's deliverables), and no re-import diff reads this key; it exists
    only so app.py's /apply can give each created task a provenance string."""
    seen = set()
    for i, t in enumerate(preparation_tasks):
        if not isinstance(t, dict):
            continue
        key = _slugify(t.get("title"), f"task-{i}")
        candidate, n = key, 2
        while candidate in seen:
            candidate, n = f"{key}-{n}", n + 1
        seen.add(candidate)
        t["source_key"] = candidate


def analyse(text, date_context=None, cohort_group=None, commitment_dates=None):
    """Ask Claude to read one supporting document, in a single pass (there is
    no deliverable-by-deliverable breakdown here, so briefs.py's two-pass
    split doesn't apply).

    `date_context` -- see briefs.date_context -- anchors a bare date and then
    validates every extracted one, never silently correcting it (see
    _flag_dates_out_of_range). `cohort_group` reconciles a group-split
    document down to the user's own group's items (see resolve_group_scope) --
    only `preparation_tasks` are filtered this way; `sessions` stays whole and
    annotated, since it's informational context rather than something to
    apply. `commitment_dates` (a set of "YYYY-MM-DD" strings) marks which
    sessions are already on the timetable.

    Returns the assembled dict. Raises briefs.BriefExtractionError if the
    reply comes back truncated or unparseable.
    """
    client = tagging.get_client()
    doc_text = text[:_MAX_DOC_CHARS]
    prompt = f"{_INSTRUCTIONS}{_date_context_paragraph(date_context)}\n\nHere is the document:\n\n{doc_text}"
    data = _run_pass(client, prompt, max_tokens=4096)

    sessions = data.get("sessions")
    sessions = [s for s in sessions if isinstance(s, dict)] if isinstance(sessions, list) else []
    prep = data.get("preparation_tasks")
    prep = [t for t in prep if isinstance(t, dict)] if isinstance(prep, list) else []

    _mark_matched_commitments(sessions, commitment_dates)
    prep = resolve_group_scope(prep, cohort_group)
    _assign_source_keys(prep)

    extraction = {
        "summary": data.get("summary") or "",
        "sessions": sessions,
        "preparation_tasks": prep,
        "date_context": date_context,
    }
    _flag_dates_out_of_range(extraction, date_context)
    return extraction
