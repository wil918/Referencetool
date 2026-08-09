"""Cross-reference analysis.

Given a handful of references, this looks up related items already in the
library (via the vector store) for each one, then asks Claude to write up
suggested connections and new research directions across the whole set.
The resulting conversation can be continued turn-by-turn so the user can
ask follow-up questions and steer the exploration, with full context of
the references and prior replies preserved.
"""
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
    return "".join(block.text for block in response.content if block.type == "text").strip()


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
