"""Cross-reference analysis.

Given a handful of references, this looks up related items already in the
library (via the vector store) for each one, then asks Claude to write up
suggested connections and new research directions across the whole set.
The resulting conversation can be continued turn-by-turn so the user can
ask follow-up questions and steer the exploration, with full context of
the references and prior replies preserved.
"""
import math
import re
from datetime import date
from html.parser import HTMLParser

import colour
import config
import db
import embeddings
import graph_layout
import scheduling
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
    if not config.embeddings_enabled():
        # No vectors to look neighbours up in: the write-up is about exactly
        # the references chosen, which is also what it says it is shown.
        return {ref["id"]: [] for ref in references}
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


def _cluster_colour_stats(colour_nodes):
    """Mean lightness/chroma and a circular mean hue (degrees) across a
    cluster's own colour-analysed references, or None if none of them have
    been analysed yet -- colour.backfill runs archive-wide, on its own
    schedule, independent of tagging."""
    if not colour_nodes:
        return None
    lightness = sum(n["lightness"] for n in colour_nodes) / len(colour_nodes)
    chroma = sum(n["chroma"] for n in colour_nodes) / len(colour_nodes)
    sin_sum = sum(math.sin(math.radians(n["hue"])) for n in colour_nodes)
    cos_sum = sum(math.cos(math.radians(n["hue"])) for n in colour_nodes)
    hue = (math.degrees(math.atan2(sin_sum, cos_sum)) + 360) % 360
    return {"lightness": lightness, "chroma": chroma, "hue": hue}


def _cluster_analysis_context(references):
    """The CLIP cluster structure (graph_layout.build_graph) and colour
    placement (colour.colour_map) for a set of references -- MEASURED
    groupings for the concept critique to reason about, rather than groupings
    it would otherwise have to invent from titles alone.

    Returns (clusters, bridge). `clusters` is a list of
    {"cluster": id, "members": [reference dict, ...], "colour": stats|None},
    largest first. `bridge` is the strongest cross-cluster similarity edge --
    {"cluster_a", "cluster_b", "ref_a", "ref_b", "score"}, the two clusters
    that come closest to touching -- or None if there are fewer than two
    clusters, or no similarity scores have been computed yet.
    """
    if not config.embeddings_enabled():
        return [], None  # clusters are CLIP clusters; with no CLIP there are none to measure
    ids = [r["id"] for r in references]
    graph = graph_layout.build_graph(reference_ids=ids)
    if not graph["nodes"]:
        return [], None

    colour_by_id = {n["id"]: n for n in colour.colour_map(include_ids=ids)["nodes"]}
    ref_by_id = {r["id"]: r for r in references}
    node_by_id = {n["id"]: n for n in graph["nodes"]}

    grouped = {}
    for node in graph["nodes"]:
        grouped.setdefault(node["cluster"], []).append(node)

    clusters = []
    for cluster_id, nodes in grouped.items():
        clusters.append({
            "cluster": cluster_id,
            "members": [ref_by_id[n["id"]] for n in nodes if n["id"] in ref_by_id],
            "colour": _cluster_colour_stats(
                [colour_by_id[n["id"]] for n in nodes if n["id"] in colour_by_id]
            ),
        })
    clusters.sort(key=lambda c: -len(c["members"]))

    bridge = None
    if len(grouped) > 1:
        for edge in graph["edges"]:
            if not edge["cross_cluster"]:
                continue
            a, b = node_by_id[edge["source"]], node_by_id[edge["target"]]
            if bridge is None or edge["score"] > bridge["score"]:
                bridge = {
                    "cluster_a": a["cluster"], "cluster_b": b["cluster"],
                    "ref_a": a, "ref_b": b, "score": edge["score"],
                }
    return clusters, bridge


# Matches schedule/deliverables.js's own RESOLVED set -- a task that's done or
# part-done counts as worked, so a deliverable's completion reads the same way
# here as it does in the tab that actually tracks it.
_DONE_TASK_STATUSES = {"done", "partial"}


def _project_stage_context(project_id, extraction):
    """Where the project sits in time: days elapsed/remaining against the
    brief's own dates (falling back to the project's creation date and each
    deliverable's own due date), each deliverable's task completion, and
    whatever the scheduler currently flags at risk for this project.

    This only gathers the timing data -- it doesn't decide what's worth
    saying about it. That judgement (absence only matters once it's late) is
    left to the prompt instructions, so the model weighs it against
    everything else it's been shown rather than against a threshold picked
    here.
    """
    project = db.get_project(project_id)
    deliverables = db.list_deliverables(project_id)
    tasks = db.list_tasks(project_id=project_id)

    key_dates = (extraction or {}).get("key_dates") or []
    briefing_dates = [k["date"] for k in key_dates if k.get("kind") == "briefing" and k.get("date")]
    handin_dates = [k["date"] for k in key_dates if k.get("kind") == "hand-in" and k.get("date")]
    due_dates = [d["due_at"][:10] for d in deliverables if d.get("due_at")]

    start_date = min(briefing_dates) if briefing_dates else (
        project["date_created"][:10] if project and project.get("date_created") else None
    )
    end_date = max(handin_dates) if handin_dates else (max(due_dates) if due_dates else None)

    today = date.today()
    days_elapsed = days_remaining = None
    if start_date:
        try:
            days_elapsed = (today - date.fromisoformat(start_date)).days
        except ValueError:
            pass
    if end_date:
        try:
            days_remaining = (date.fromisoformat(end_date) - today).days
        except ValueError:
            pass

    deliverable_status = []
    for d in deliverables:
        d_tasks = [t for t in tasks if t.get("deliverable_id") == d["id"]]
        resolved = sum(1 for t in d_tasks if t["status"] in _DONE_TASK_STATUSES)
        deliverable_status.append({
            "title": d["title"],
            "due_at": d.get("due_at"),
            "task_count": len(d_tasks),
            "tasks_resolved": resolved,
            "is_done": bool(d_tasks) and resolved == len(d_tasks),
        })

    at_risk = []
    try:
        at_risk = [e for e in scheduling.plan()["at_risk"] if e.get("project_id") == project_id]
    except scheduling.DependencyCycleError:
        pass  # a cycle elsewhere in the schedule -- stage awareness just goes without it

    return {
        "days_elapsed": days_elapsed,
        "days_remaining": days_remaining,
        "deliverables": deliverable_status,
        "at_risk": at_risk,
    }


_NEXT_ACTIONS_RE = re.compile(r"(?im)^\s*[#*]{0,3}\s*next actions\s*[#*:]{0,3}\s*$")


def _extract_next_actions(text):
    """The bulleted list under the critique's trailing NEXT ACTIONS heading,
    as plain strings -- the structured half of an otherwise prose write-up,
    for the same review-and-apply flow brief import uses (proposed, editable,
    nothing becomes a task unasked). The prose itself is left exactly as
    written; this only reads it, it doesn't strip the section back out.
    """
    lines = text.splitlines()
    start = next((i + 1 for i, line in enumerate(lines) if _NEXT_ACTIONS_RE.match(line)), None)
    if start is None:
        return []
    actions = []
    for line in lines[start:]:
        stripped = line.strip()
        if not stripped:
            if actions:
                break
            continue
        m = re.match(r"^[-*•]\s+(.+)", stripped)
        if m:
            actions.append(m.group(1).strip())
        elif actions:
            actions[-1] = f"{actions[-1]} {stripped}"  # a soft-wrapped continuation
    return actions


def _build_concept_prompt(extraction, stage, clusters, bridge, references, notes, prior_critiques=None):
    parts = [
        "You are helping a fashion design student read their own moodboard: the "
        "canvas of visual research and clusters they have been gathering. "
        "Connection in this kind of work is associative and lateral, not "
        "argumentative -- a real chain from a student on this course ran: an "
        "artist who builds architecture out of other materials, some of them "
        "translucent -> that recalls animals moulting, a lizard's shed skin -> a "
        "photograph of wallpaper peeling -> the pattern printed on that "
        "wallpaper. Each step is a jump on a shared physical quality, not a "
        "deduction, and nobody could defend it as an argument -- being asked to "
        "would have killed it at the second step. Early on, the designer is "
        "finding a vibe and gathering clusters that feel right; the connection "
        "is the designer's eye. Your job is to widen that eye, not grade it.\n"
    ]

    if extraction:
        parts.append("THE BRIEF:")
        parts.append(_format_brief(extraction))
        parts.append("")
    else:
        parts.append("THE BRIEF: none imported -- treat brief compliance as not applicable.\n")

    parts.append("STAGE:")
    if stage["days_elapsed"] is not None or stage["days_remaining"] is not None:
        bits = []
        if stage["days_elapsed"] is not None:
            bits.append(f"{stage['days_elapsed']} day(s) in")
        if stage["days_remaining"] is not None:
            bits.append(f"{stage['days_remaining']} day(s) to the deadline")
        parts.append("  " + ", ".join(bits) + ".")
    else:
        parts.append("  No dates on record -- treat this as early-stage.")
    for d in stage["deliverables"]:
        status = (
            "done" if d["is_done"]
            else f"{d['tasks_resolved']}/{d['task_count']} tasks resolved" if d["task_count"]
            else "no tasks yet"
        )
        due = f", due {d['due_at'][:10]}" if d.get("due_at") else ""
        parts.append(f"  - {d['title']}: {status}{due}")
    if stage["at_risk"]:
        parts.append(f"  {len(stage['at_risk'])} task(s) currently flagged at risk by the scheduler:")
        for e in stage["at_risk"][:5]:
            parts.append(f'    - "{e["title"]}": {e["message"]}')
    parts.append(
        "  Absence is only worth raising when it is late: no garment research in "
        "week one is what a project that has just started looks like; in week "
        "five it is the finding. Brief compliance is the same -- a late-stage "
        "concern, nearly silent early.\n"
    )

    ref_by_id = {r["id"]: r for r in references}
    if clusters:
        parts.append(
            "VISUAL RESEARCH, AS MEASURED CLUSTERS (grouped by CLIP visual "
            "similarity -- not by title, not invented):"
        )
        for c in clusters:
            n = len(c["members"])
            parts.append(f'CLUSTER {c["cluster"]} ({n} reference{"s" if n != 1 else ""}):')
            if c["colour"]:
                col = c["colour"]
                parts.append(
                    f"  measured colour -- lightness {col['lightness']:.2f} (0 black, 1 "
                    f"white), chroma {col['chroma']:.1f} (Lab units, higher = more "
                    f"saturated), hue {col['hue']:.0f}° (0/360 red, 60 yellow, 120 "
                    "green, 180 cyan, 240 blue, 300 magenta)"
                )
            for ref in c["members"]:
                parts.append(_format_reference(ref))
            parts.append("")
        if bridge:
            parts.append(
                f'CLOSEST TWO CLUSTERS: cluster {bridge["cluster_a"]} and cluster '
                f'{bridge["cluster_b"]} come nearest to touching, via '
                f'"{bridge["ref_a"]["title"]}" and "{bridge["ref_b"]["title"]}".\n'
            )
    elif references:
        parts.append("VISUAL RESEARCH (too few references yet for meaningful clusters):")
        for ref in references:
            parts.append(_format_reference(ref))
        parts.append("")
    else:
        parts.append("VISUAL RESEARCH: nothing selected -- the student has not put research on the canvas yet.\n")

    parts.append(
        "THE THINKING (the student's own notes -- their working ideas about "
        "this research, not established fact):"
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
            "conclusions as provisional and revisit them as hard as the "
            "research above):"
        )
        for i, critique in enumerate(prior_critiques, 1):
            parts.append(f"  [earlier critique {i}]")
            parts.append(critique.strip())
        parts.append("")

    parts.append(
        "Write this up in five headed sections. Head each with its name in "
        "capitals, alone on its own line -- no markdown, no numbering. Track "
        "length to how much there is to say; a thin canvas gets a short "
        "answer.\n\n"
        "READ -- one to three sentences on where the work stands right now.\n\n"
        "CLUSTERS -- for each cluster above, one or two sentences on what "
        "seems to bind it: a form, a surface, a colour behaviour, a process, "
        "a quality of light. Offer this, don't assert it -- name what you "
        "see, since the eye may have been after something else.\n\n"
        "LATERAL DIRECTIONS -- this is the main point of the exercise. One "
        "sub-heading per cluster (its name from above), then 2-4 bullets: "
        "take the quality that binds the cluster and say where else in the "
        "world it turns up -- nature, decay, industry, architecture, other "
        "cultures, other materials. Make every bullet something to look at, "
        "search for, or go and photograph -- \"look at snake sheds and "
        "blistered paint\", never \"consider the theme of transformation\".\n\n"
        "THE WHOLE BODY -- judge the set of clusters together, never "
        "reference by reference. Do they speak to each other, or read as "
        "unrelated projects sharing a folder? Is a through-line emerging, and "
        "what is it? Is one cluster carrying everything while another hasn't "
        "grown past a single image? Say which two clusters come closest to "
        "touching (named above, if given) and what might sit between them -- "
        "that gap is usually where the project actually is. A cluster with "
        "only one reference in it might be a fourth direction or might be a "
        "stray; say so and leave the call to the designer. Fold in brief "
        "compliance and any at-risk deadlines here, only as far as STAGE "
        "above says they're worth raising yet.\n\n"
        "NEXT ACTIONS -- this MUST be the last section, and nothing follows "
        "it. A bulleted list, one line each, every bullet a concrete "
        "directive a student could act on today (\"add garment research on "
        "trench coats\"), never a suggestion (\"the project would benefit "
        "from...\"). Each should be liftable straight into a task as written.\n\n"
        "Never ask a reference to justify itself. One that's there because it "
        "looks right is doing its job -- that's what a mood is made of. Refer "
        "to references by title. Plain prose under every heading but NEXT "
        "ACTIONS, no preamble."
    )
    return "\n".join(parts)


def start_concept_analysis(
    project_id, reference_ids=None, notes=None, note_html=None, prior_analysis_ids=None
):
    """Read a project's moodboard: the measured clusters in its visual
    research, named and pushed lateral, evaluated as a whole body of work
    rather than reference by reference.

    The canvas selection is the picker. `reference_ids` are the lassoed
    reference nodes -- the visual research. The student's own thinking arrives
    two ways, because it lives two ways: `notes` are plain text nodes'
    contents, `note_html` are Notepad widgets' stored HTML (flattened here,
    keeping heading-sized runs as headings). `prior_analysis_ids` are Analysis
    widgets in the selection -- earlier critiques, fed back in but labelled as
    the model's own prior output so it doesn't just agree with itself.

    An empty selection falls back to the whole project: every reference in it
    AND every bit of writing on its canvas, by the same rules.

    Returns (writeup, messages, reference_map, next_actions). The first three
    are the same shape start_conversation returns, so the in-memory session
    store, the follow-up /reply route and the save path all work against it
    unchanged. `next_actions` is the trailing NEXT ACTIONS bullets, pulled out
    as plain strings for a review-and-apply UI -- see _extract_next_actions.
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

    extraction = _latest_brief_extraction(project_id)
    stage = _project_stage_context(project_id, extraction)
    clusters, bridge = _cluster_analysis_context(references) if references else ([], None)
    prompt = _build_concept_prompt(
        extraction, stage, clusters, bridge, references, all_notes, prior_critiques
    )

    messages = [{"role": "user", "content": prompt}]
    writeup = _send(messages)
    messages.append({"role": "assistant", "content": writeup})
    next_actions = _extract_next_actions(writeup)
    return writeup, messages, _reference_map(references, {}), next_actions


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
