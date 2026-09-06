"""Cross-reference analysis.

Given a handful of references, this looks up related items already in the
library (via the vector store) for each one, then asks Claude to write up
suggested connections and new research directions across the whole set.
The resulting conversation can be continued turn-by-turn so the user can
ask follow-up questions and steer the exploration, with full context of
the references and prior replies preserved.
"""
import re
from html.parser import HTMLParser

import db
import embeddings
import tagging
from config import CLAUDE_MODEL

RELATED_PER_REFERENCE = 5


def _get_embedding(ref_id):
    collection = embeddings.get_collection()
    result = collection.get(ids=[ref_id], include=["embeddings"])
    if not result["ids"]:
        return None
    return result["embeddings"][0]


def _resolve_reference(ref_id):
    ref = db.get_reference(ref_id)
    if ref:
        return ref
    matches = db.find_by_id_prefix(ref_id)
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ValueError(f"'{ref_id}' matches multiple references, be more specific")
    raise ValueError(f"No reference found matching '{ref_id}'")


def gather_context(references):
    """For each reference, find related items already in the library.

    Returns {ref_id: [match, ...]}. The selected references themselves are
    excluded from their own results.
    """
    selected_ids = {r["id"] for r in references}
    related = {}
    for ref in references:
        embedding = _get_embedding(ref["id"])
        if embedding is None:
            related[ref["id"]] = []
            continue
        related[ref["id"]] = embeddings.query_index(
            embedding, n_results=RELATED_PER_REFERENCE, exclude_ids=selected_ids
        )
    return related


def _format_reference(ref):
    lines = [f'- "{ref["title"]}" ({ref["type"]})']
    if ref["tags"]:
        lines.append(f"  tags: {', '.join(ref['tags'])}")
    if ref["description"]:
        lines.append(f"  description: {ref['description']}")
    if ref["notes"]:
        lines.append(f"  notes: {ref['notes']}")
    return "\n".join(lines)


def _build_prompt(references, related, mode="full"):
    parts = [
        "You are helping with research for a fashion design reference library. "
        "Below are a handful of references the researcher has selected, along "
        "with other items already in their library that came up as semantically "
        "related to each one (found via embedding search).\n"
    ]

    for ref in references:
        parts.append("SELECTED REFERENCE:")
        parts.append(_format_reference(ref))
        matches = related.get(ref["id"], [])
        if matches:
            parts.append("  Related items already in the library:")
            for m in matches:
                meta = m["metadata"]
                parts.append(f'    - "{meta["title"]}" ({meta["type"]}) tags: {meta.get("tags", "")}')
        else:
            parts.append("  (no related items found in the library)")
        parts.append("")

    if mode == "summary":
        parts.append(
            "Write up:\n"
            "1. Suggested connections between the selected references and the related items.\n"
            "2. New research directions worth pursuing.\n"
            "Be concise: respond ONLY as short bullet points (3-5 per section, one line each), "
            "no prose paragraphs, no preamble. Refer to items by title."
        )
    else:
        parts.append(
            "Write up:\n"
            "1. Suggested connections between the selected references and the related "
            "items -- what visual, historical, or conceptual threads tie them together.\n"
            "2. New research directions worth pursuing based on these references and "
            "the patterns you see across the library so far.\n"
            "Be specific and refer to items by title. Write in plain prose, not JSON, "
            "with the two sections clearly headed."
        )
    return "\n".join(parts)


def _send(messages):
    client = tagging.get_client()
    response = tagging._create_with_retry(
        client,
        model=CLAUDE_MODEL,
        max_tokens=4096,
        messages=messages,
    )
    text = "".join(block.text for block in response.content if block.type == "text").strip()
    # A write-up cut off at max_tokens otherwise reads as a finished one. Mark it
    # so the reader knows to ask a follow-up rather than trust it as complete.
    if getattr(response, "stop_reason", None) == "max_tokens":
        text += "\n\n---\n_(This response was cut off before it finished. Ask a follow-up to continue it.)_"
    return text


def _reference_map(references, related):
    """title -> reference id, for every item Claude was shown (the selected
    references plus everything surfaced via embedding search). Lets a caller
    turn title mentions in the write-up into links back to the actual item.

    Titles aren't guaranteed unique across the library (duplicate uploads
    happen), so a collision just keeps whichever id was seen first -- best
    effort, since prose can only ever name the title, not an id.
    """
    mapping = {}
    for ref in references:
        mapping.setdefault(ref["title"], ref["id"])
    for matches in related.values():
        for m in matches:
            mapping.setdefault(m["metadata"]["title"], m["id"])
    return mapping


def start_conversation(ref_ids, mode="full"):
    """Resolve reference ids, gather related context, and ask Claude to write up
    connections and research directions.

    `mode` is "full" for a prose write-up (the default) or "summary" for a
    concise bulleted version of the same two sections.

    Returns (writeup, messages, reference_map) -- messages is the running
    conversation history (in Anthropic API message format), which can be
    handed to continue_conversation() to let the user explore the analysis
    further without re-fetching related items or losing context.
    reference_map is {title: reference_id} for every item named in the
    prompt, for turning title mentions into links.
    """
    references = [_resolve_reference(ref_id) for ref_id in ref_ids]
    related = gather_context(references)
    prompt = _build_prompt(references, related, mode=mode)

    messages = [{"role": "user", "content": prompt}]
    writeup = _send(messages)
    messages.append({"role": "assistant", "content": writeup})
    return writeup, messages, _reference_map(references, related)


def _latest_brief_extraction(project_id):
    """The most recent imported brief's extraction for this project, or None.

    briefs.extracted is an envelope {"extraction": ..., "applied": ...}; only
    the extraction (summary + deliverables) is useful as something to critique
    a concept against.
    """
    for brief in db.list_briefs(project_id):
        envelope = brief.get("extracted") or {}
        extraction = envelope.get("extraction") if isinstance(envelope, dict) else None
        if extraction:
            return extraction
    return None


def _format_brief(extraction):
    lines = []
    if extraction.get("summary"):
        lines.append(f"Summary: {extraction['summary']}")
    for d in extraction.get("deliverables", []) or []:
        bits = [f"- {d.get('title', 'Untitled deliverable')}"]
        if d.get("description"):
            bits.append(f": {d['description']}")
        lines.append("".join(bits))
        spec = d.get("spec")
        if isinstance(spec, dict):
            for item in spec.get("required_items", []) or []:
                lines.append(f"    requires: {item}")
    return "\n".join(lines)


# A Notepad's rich text (rich-text.js) encodes hierarchy in size and weight:
# a large or large-and-bold run is a heading. These thresholds decide which
# runs survive plain-text conversion as headings rather than as prose. They
# are in rem, matching the units rich-text.js writes.
_HEADING_MIN_REM = 1.25
_BOLD_HEADING_MIN_REM = 1.15


class _NoteHTMLParser(HTMLParser):
    """Flatten Notepad HTML to text, keeping heading-sized runs as headings.

    rich-text.js only ever emits <span style="..."> and text, so the whole
    job is: track the effective font-size / font-weight down the span stack,
    and tag each text run as heading or body. Style attributes -- the bulk of
    the markup -- are dropped; the size/weight they carried is turned back
    into structure instead of thrown away.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._stack = [{}]
        self.segments = []  # (text, is_heading)

    def handle_starttag(self, tag, attrs):
        style = dict(self._stack[-1])
        if tag == "span":
            raw = dict(attrs).get("style") or ""
            m = re.search(r"font-size:\s*([\d.]+)rem", raw)
            if m:
                style["size"] = float(m.group(1))
            m = re.search(r"font-weight:\s*(bold|\d+)", raw)
            if m:
                style["bold"] = m.group(1) == "bold" or int(m.group(1)) >= 600
        self._stack.append(style)

    def handle_startendtag(self, tag, attrs):
        pass  # e.g. <br/> -- handled as data would be; no style to push

    def handle_endtag(self, tag):
        if len(self._stack) > 1:
            self._stack.pop()

    def handle_data(self, data):
        if not data:
            return
        style = self._stack[-1]
        size = style.get("size", 1.0)
        bold = style.get("bold", False)
        is_heading = size >= _HEADING_MIN_REM or (bold and size >= _BOLD_HEADING_MIN_REM)
        self.segments.append((data, is_heading))


def _structured_text_from_html(html):
    """A Notepad's stored HTML as plain text, with heading runs kept as
    Markdown headings. Plain strings (Notepads saved before per-selection
    formatting, or the migration no-op) pass straight through."""
    if not html:
        return ""
    if "<" not in html:
        return html.strip()

    parser = _NoteHTMLParser()
    parser.feed(html)
    parser.close()

    # Merge neighbouring runs of the same kind first: rich-text.js often
    # splits one visual run across several spans, and each shouldn't become
    # its own heading line.
    merged = []
    for text, is_heading in parser.segments:
        if merged and merged[-1][1] == is_heading:
            merged[-1][0] += text
        else:
            merged.append([text, is_heading])

    out = []
    for text, is_heading in merged:
        if is_heading:
            heading = " ".join(text.split())
            if heading:
                out.append(f"\n## {heading}\n")
        else:
            out.append(text)
    return re.sub(r"\n{3,}", "\n\n", "".join(out)).strip()


def _prior_critique_text(analysis_id):
    """The assistant's turns from a saved analysis -- an earlier concept
    critique placed back on the canvas as an Analysis widget. Only the
    write-up and replies, never the student's follow-up questions."""
    analysis = db.get_analysis(analysis_id)
    if not analysis:
        return ""
    turns = analysis.get("transcript") or []
    parts = [t.get("text", "") for t in turns if t.get("kind") in ("writeup", "reply")]
    return "\n\n".join(p.strip() for p in parts if p and p.strip())


def _project_canvas_text(project_id):
    """The student's own writing across the project's canvas: plain text
    nodes and Notepad widgets. Widgets that are views of data (colourspace,
    similarity, ...) are not ideas and are left out; Analysis widgets are the
    model's own earlier output and are left out of the fallback too."""
    plain, html = [], []
    for node in db.list_canvas_nodes(project_id):
        if node["kind"] == "text":
            if node.get("content"):
                plain.append(node["content"])
        elif node["kind"] == "widget":
            config = node.get("config") or {}
            if config.get("type") == "notepad":
                content = (config.get("widget") or {}).get("content")
                if content:
                    html.append(content)
    return plain, html


def _build_concept_prompt(extraction, references, related, notes, prior_critiques=None):
    parts = [
        "You are a critic helping a fashion design student pressure-test the "
        "concept behind a project. Below is the brief (if one has been "
        "imported), the visual research they have gathered, and -- separately "
        "-- their own written thinking about that research. Your job is to "
        "judge whether the second is actually carried by the first.\n"
    ]

    if extraction:
        parts.append("THE BRIEF:")
        parts.append(_format_brief(extraction))
        parts.append("")
    else:
        parts.append(
            "THE BRIEF: none imported. Critique the concept's internal "
            "coherence and the depth of its research instead, and say plainly "
            "that there is no brief to check the work against.\n"
        )

    parts.append("VISUAL RESEARCH (the reference images and material selected):")
    if references:
        for ref in references:
            parts.append(_format_reference(ref))
            matches = related.get(ref["id"], [])
            if matches:
                for m in matches:
                    meta = m["metadata"]
                    parts.append(
                        f'    (related in library: "{meta["title"]}" tags: {meta.get("tags", "")})'
                    )
    else:
        parts.append("  (nothing selected -- the student has not put research on the canvas yet)")
    parts.append("")

    parts.append(
        "THE THINKING (the student's own notes -- treat each as a claim to be "
        "tested against the research above, not as established fact):"
    )
    if notes:
        for i, note in enumerate(notes, 1):
            parts.append(f"  {i}. {note.strip()}")
    else:
        parts.append("  (no written notes selected)")
    parts.append("")

    if prior_critiques:
        parts.append(
            "EARLIER AI CRITIQUE (you wrote this on a previous pass and the "
            "student kept it on the canvas -- it is your own prior output, NOT "
            "their position. Do not simply restate or agree with it; treat its "
            "conclusions as provisional and revisit them as hard as the notes "
            "above):"
        )
        for i, critique in enumerate(prior_critiques, 1):
            parts.append(f"  [earlier critique {i}]")
            parts.append(critique.strip())
        parts.append("")

    parts.append(
        "Write a critique with these four headed sections:\n"
        "1. Strong connections -- where the research genuinely demonstrates the "
        "idea (or the brief's requirement), with the specific references that do it.\n"
        "2. Asserted, not demonstrated -- claims in the notes the research does "
        "not actually support yet.\n"
        "3. The weak link -- name the single reference doing the least "
        "argumentative work: there because it looks good rather than because it "
        "argues for anything. If every reference earns its place, say so and say why.\n"
        "4. Research directions -- specific things to look for or read that would "
        "close the gaps above.\n\n"
        "Be useful rather than flattering. A critique that says everything is "
        "fine is worthless. Refer to references by title. Plain prose under each "
        "heading, no preamble."
    )
    return "\n".join(parts)


def start_concept_analysis(
    project_id, reference_ids=None, notes=None, note_html=None, prior_analysis_ids=None
):
    """Critique a project's concept against its imported brief.

    The canvas selection is the picker. `reference_ids` are the lassoed
    reference nodes -- the visual research. The student's own thinking arrives
    two ways, because it lives two ways: `notes` are plain text nodes'
    contents, `note_html` are Notepad widgets' stored HTML (flattened here,
    keeping heading-sized runs as headings). `prior_analysis_ids` are Analysis
    widgets in the selection -- earlier critiques, fed back in but labelled as
    the model's own prior output so it doesn't just agree with itself.

    An empty selection falls back to the whole project: every reference in it
    AND every bit of writing on its canvas, by the same rules.

    Returns (writeup, messages, reference_map) -- the same shape as
    start_conversation, so the in-memory session store, the follow-up /reply
    route and the save path all work against it unchanged.
    """
    ref_ids = list(reference_ids or [])
    plain_notes = [n for n in (notes or []) if n and n.strip()]
    note_html = list(note_html or [])
    prior_ids = list(prior_analysis_ids or [])

    if ref_ids or plain_notes or note_html or prior_ids:
        references = [_resolve_reference(rid) for rid in ref_ids] if ref_ids else []
        notepad_notes = [_structured_text_from_html(h) for h in note_html]
        prior_critiques = [_prior_critique_text(a) for a in prior_ids]
    else:
        references = db.list_project_references(project_id)
        canvas_plain, canvas_html = _project_canvas_text(project_id)
        plain_notes = [n for n in canvas_plain if n and n.strip()]
        notepad_notes = [_structured_text_from_html(h) for h in canvas_html]
        prior_critiques = []

    all_notes = plain_notes + [n for n in notepad_notes if n and n.strip()]
    prior_critiques = [c for c in prior_critiques if c and c.strip()]

    related = gather_context(references) if references else {}
    extraction = _latest_brief_extraction(project_id)
    prompt = _build_concept_prompt(
        extraction, references, related, all_notes, prior_critiques
    )

    messages = [{"role": "user", "content": prompt}]
    writeup = _send(messages)
    messages.append({"role": "assistant", "content": writeup})
    return writeup, messages, _reference_map(references, related)


def continue_conversation(messages, user_message):
    """Send a follow-up within an existing analysis conversation.

    Appends the user's message and Claude's reply to `messages` in place
    (so the caller can keep reusing the same list across turns) and
    returns the reply text.
    """
    messages.append({"role": "user", "content": user_message})
    reply = _send(messages)
    messages.append({"role": "assistant", "content": reply})
    return reply
