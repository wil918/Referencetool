"""Three-layer duration/difficulty/importance estimation for tasks.

Cold start is the real constraint (SCHEDULE_SCOPE.md's "The estimator"): with
five completed tasks, "similar past tasks" means nothing, so the layers are
tried in order of how much real evidence they need.

    1. NEAREST NEIGHBOURS. Embed the description through the CLIP text path
       (embeddings.embed_text) and look up similar COMPLETED tasks in a
       dedicated Chroma collection (embeddings.get_task_collection). Their
       actuals ARE real durations/ratings, not guesses, so they're used
       as-is.
    2. CLAUDE. task_ai.generate_task_fields, for work unlike anything
       completed -- the fallback, not the default. Its raw duration guess is
       then corrected by the GLOBAL CALIBRATION ratio (actual/estimate across
       every completed chain): most people run consistently over, and this
       one number removes most of the error before any per-task data exists.
       Calibration is deliberately NOT applied to neighbour-based estimates
       above -- those are already grounded in real outcomes, not guesses, so
       multiplying them by a guess-correction factor would double-count.

Every estimate comes back with its provenance -- which layer answered, how
many similar tasks informed it, and a confidence band -- never a bare number.
False precision here is worse than an honest range: "about 2h, low
confidence, 3 similar tasks" is what the UI shows, never "2h 15m".
"""
import statistics

import db
import embeddings
import task_ai

# How many neighbours to average over, and the count thresholds for calling
# that average "high"/"medium"/"low" confidence. Deliberately small and fixed
# -- this is a personal task list, not a corpus large enough to tune against.
NEIGHBOUR_K = 5
HIGH_CONFIDENCE_NEIGHBOURS = 5
MEDIUM_CONFIDENCE_NEIGHBOURS = 2

# The band a single-neighbour or Claude-sourced duration is reported with,
# since one data point (or none) carries real uncertainty that a bare number
# would hide. Neighbour bands widen this from the actual spread of the
# neighbours found, when there's more than one.
SINGLE_NEIGHBOUR_BAND = (0.75, 1.25)
CLAUDE_BAND = (0.6, 1.6)


# --- Training data: completed work only, chains evaluated as a whole -------
#
# A task completed across several partial sittings must be evaluated as ONE
# unit: continues_task_id chains a remainder back to what it continues (see
# TASKS_SCHEMA and scheduling.resolve_partial), and SCHEDULE_SCOPE.md is
# explicit that scoring a partial's own segment against its own estimate is
# backwards -- a 3h task with 2h spent and not finished did not take 2 hours.
# The chain's summed actual is compared to the FIRST link's (the root's)
# estimate instead.


def completed_duration_chains():
    """Every task chain that has finished: the leaf (final link) is 'done'
    with a recorded actual. Each link -- including the 'partial' ones in the
    middle -- already has its own actual_minutes recorded at the moment it
    closed (see scheduling.resolve_partial/resolve_completed), so the chain's
    total is just those rows summed; nothing here needs its own persisted
    field.

    Returns a list of dicts: root/leaf task rows, the chain's total
    actual_minutes, and the segment ids that made it up.
    """
    all_tasks = db.list_tasks()
    tasks_by_id = {t["id"]: t for t in all_tasks}

    chains = []
    for leaf in all_tasks:
        if leaf["status"] != "done":
            continue
        leaf_actual = db.get_task_actual(leaf["id"])
        if not leaf_actual or leaf_actual.get("actual_minutes") is None:
            continue

        # Walk backward via continues_task_id to the root, collecting every
        # link. A task with no predecessor is its own one-link chain.
        segment_ids = [leaf["id"]]
        cur = leaf
        while cur.get("continues_task_id"):
            parent = tasks_by_id.get(cur["continues_task_id"])
            if not parent:
                break
            segment_ids.append(parent["id"])
            cur = parent
        root = cur

        total_actual = 0
        complete = True
        for seg_id in segment_ids:
            seg_actual = db.get_task_actual(seg_id)
            if not seg_actual or seg_actual.get("actual_minutes") is None:
                complete = False
                break
            total_actual += seg_actual["actual_minutes"]
        if not complete:
            # A broken chain (a link somehow closed with no actual) contributes
            # nothing rather than an understated total -- see the "never train
            # on generated values" rule this mirrors for est_minutes_source.
            continue

        chains.append({
            "root": root,
            "leaf": leaf,
            "actual_minutes": total_actual,
            "segment_ids": segment_ids,
        })
    return chains


def rated_segments(field):
    """Every task with a recorded actual_<field>, paired with that same
    task's own estimate and its source. Unlike duration, difficulty and
    importance aren't split across sittings the way time is -- each segment
    (partial or done) reported its own actual at the moment it closed, and
    that report is a legitimate independent data point on its own, so there's
    no chain aggregation here.

    `field` is 'difficulty' or 'importance'.
    """
    actual_field = "actual_" + field
    out = []
    for task in db.list_tasks():
        actual = db.get_task_actual(task["id"])
        if not actual or actual.get(actual_field) is None:
            continue
        out.append({"task": task, "actual_value": actual[actual_field]})
    return out


# --- Layer 1 (duration): global calibration ---------------------------------


def duration_calibration():
    """The actual/estimate ratio for completed duration chains, split by the
    root task's est_minutes_source ('user' vs 'generated' -- tracked
    separately so a gap between the two is visible, even though 'overall'
    pools both for the correction actually applied) plus the pooled overall
    figure. A source is only counted if it has a real actual behind it (see
    completed_duration_chains) -- a generated estimate that was never
    completed contributes nothing, or the estimator would converge on its own
    earlier guesses.

    Returns {'user': {...}, 'generated': {...}, 'overall': {...}}, each
    {'ratio': float or None, 'n': int}.
    """
    by_source = {"user": [], "generated": []}
    for chain in completed_duration_chains():
        root = chain["root"]
        est = root.get("est_minutes")
        source = root.get("est_minutes_source")
        if not est or est <= 0 or source not in by_source:
            continue
        by_source[source].append(chain["actual_minutes"] / est)

    def summarize(ratios):
        return {"ratio": statistics.fmean(ratios) if ratios else None, "n": len(ratios)}

    return {
        "user": summarize(by_source["user"]),
        "generated": summarize(by_source["generated"]),
        "overall": summarize(by_source["user"] + by_source["generated"]),
    }


def rating_calibration(field):
    """The difficulty/importance analogue of duration_calibration. These are
    a 1-5 ordinal scale, not a duration, so "actual/estimate" has no sensible
    meaning -- mean(actual - estimate) is the bias correction instead: how
    many points off, on average, an estimate for this field tends to run.
    """
    source_field = field + "_source"
    by_source = {"user": [], "generated": []}
    for row in rated_segments(field):
        task = row["task"]
        est = task.get(field)
        source = task.get(source_field)
        if est is None or source not in by_source:
            continue
        by_source[source].append(row["actual_value"] - est)

    def summarize(diffs):
        return {"bias": statistics.fmean(diffs) if diffs else None, "n": len(diffs)}

    return {
        "user": summarize(by_source["user"]),
        "generated": summarize(by_source["generated"]),
        "overall": summarize(by_source["user"] + by_source["generated"]),
    }


# --- Layer 2: nearest neighbours ---------------------------------------------
#
# One vector per task that has ANY recorded actual, keyed by that task's own
# id and embedded from its title/description. A single index serves duration,
# difficulty and importance: duration's metadata key is only ever set on a
# completed chain's ROOT (an intermediate 'partial' link's own actual_minutes
# would be the same "backwards" signal completed_duration_chains excludes),
# while difficulty/importance are set on every segment that reported one.
# Callers filter candidates by whichever metadata key they need.


def _describe(task):
    return " ".join(p for p in (task.get("title"), task.get("description")) if p).strip()


def _index_rows():
    chain_totals = {c["root"]["id"]: c["actual_minutes"] for c in completed_duration_chains()}

    rows = {}
    for task in db.list_tasks():
        actual = db.get_task_actual(task["id"])
        if not actual:
            continue
        metadata = {}
        if task["id"] in chain_totals:
            metadata["actual_minutes"] = chain_totals[task["id"]]
        if actual.get("actual_difficulty") is not None:
            metadata["actual_difficulty"] = actual["actual_difficulty"]
        if actual.get("actual_importance") is not None:
            metadata["actual_importance"] = actual["actual_importance"]
        if not metadata:
            continue
        rows[task["id"]] = {"task": task, "metadata": metadata}
    return rows


def index_task_collection():
    """Rebuild embeddings.get_task_collection() from scratch against whatever
    is currently in the database. Rebuilding wholesale rather than maintaining
    incremental adds from every completion route is the simple choice here --
    nothing in this codebase runs anywhere near the scale where re-embedding a
    personal task list on every call would be noticeable, and it sidesteps
    keeping an index in sync with edits, corrections and deletions by
    construction.
    """
    collection = embeddings.get_task_collection()
    existing_ids = collection.get(include=[])["ids"]
    if existing_ids:
        collection.delete(ids=existing_ids)

    rows = _index_rows()
    if not rows:
        return

    ids = list(rows.keys())
    collection.add(
        ids=ids,
        embeddings=[embeddings.embed_text(_describe(rows[i]["task"])) for i in ids],
        metadatas=[rows[i]["metadata"] for i in ids],
    )


def _nearest(metadata_key, description, k, exclude_task_id=None):
    """The up-to-k nearest indexed tasks that carry `metadata_key`, nearest
    first. Fetches every candidate and filters/sorts in Python rather than a
    server-side `where` filter -- the same approach embeddings.query_index
    already takes for its own grouped re-ranking, and it keeps a test double
    for the task collection to the same small surface (get/add/delete/query)
    that one already needs."""
    collection = embeddings.get_task_collection()
    total = collection.count()
    if total == 0:
        return []

    query_vector = embeddings.embed_text(description)
    results = collection.query(query_embeddings=[query_vector], n_results=total)

    candidates = []
    for task_id, metadata, distance in zip(
        results["ids"][0], results["metadatas"][0], results["distances"][0]
    ):
        if task_id == exclude_task_id or metadata.get(metadata_key) is None:
            continue
        candidates.append((task_id, metadata[metadata_key], distance))
    candidates.sort(key=lambda c: c[2])
    return candidates[:k]


def _confidence_for_neighbours(n):
    if n >= HIGH_CONFIDENCE_NEIGHBOURS:
        return "high"
    if n >= MEDIUM_CONFIDENCE_NEIGHBOURS:
        return "medium"
    return "low"


def _band(values):
    if len(values) == 1:
        lo_mult, hi_mult = SINGLE_NEIGHBOUR_BAND
        return (max(1, round(values[0] * lo_mult)), round(values[0] * hi_mult))
    lo, hi = min(values), max(values)
    if lo == hi:
        lo_mult, hi_mult = SINGLE_NEIGHBOUR_BAND
        return (max(1, round(lo * lo_mult)), round(hi * hi_mult))
    return (round(lo), round(hi))


def _clamp_rating(value):
    if value is None:
        return None
    return max(1, min(5, round(value)))


# --- Public estimates ---------------------------------------------------


def estimate_duration(description, exclude_task_id=None):
    """A duration estimate in minutes, with its provenance. Tries similar
    completed tasks first (layer 2); only when none exist does it fall
    through to Claude's guess (layer 3), corrected by the global calibration
    ratio (layer 1)."""
    index_task_collection()
    neighbours = _nearest(
        "actual_minutes", description, NEIGHBOUR_K, exclude_task_id=exclude_task_id
    )
    if neighbours:
        values = [v for _, v, _ in neighbours]
        low, high = _band(values)
        return {
            "minutes": round(statistics.fmean(values)),
            "low": low,
            "high": high,
            "provenance": "neighbours",
            "n": len(values),
            "confidence": _confidence_for_neighbours(len(values)),
        }

    generated = task_ai.generate_task_fields(description)
    raw = generated.get("est_minutes")
    calibration = duration_calibration()["overall"]
    ratio = calibration["ratio"]
    minutes = round(raw * ratio) if raw and ratio else raw
    low, high = (None, None)
    if minutes:
        lo_mult, hi_mult = CLAUDE_BAND
        low, high = max(1, round(minutes * lo_mult)), round(minutes * hi_mult)
    return {
        "minutes": minutes,
        "low": low,
        "high": high,
        "provenance": "claude",
        "n": 0,
        "confidence": "low",
        "calibration_ratio": ratio,
    }


def estimate_rating(field, description, exclude_task_id=None):
    """A difficulty/importance estimate (1-5), with the same provenance
    shape as estimate_duration. `field` is 'difficulty' or 'importance'."""
    index_task_collection()
    metadata_key = "actual_" + field
    neighbours = _nearest(metadata_key, description, NEIGHBOUR_K, exclude_task_id=exclude_task_id)
    if neighbours:
        values = [v for _, v, _ in neighbours]
        return {
            "value": _clamp_rating(statistics.fmean(values)),
            "provenance": "neighbours",
            "n": len(values),
            "confidence": _confidence_for_neighbours(len(values)),
        }

    generated = task_ai.generate_task_fields(description)
    raw = generated.get(field)
    calibration = rating_calibration(field)["overall"]
    bias = calibration["bias"]
    value = _clamp_rating(raw + bias) if raw is not None and bias is not None else raw
    return {
        "value": value,
        "provenance": "claude",
        "n": 0,
        "confidence": "low",
        "calibration_bias": bias,
    }


def estimate_task_fields(description, est_minutes=None, importance=None, difficulty=None,
                         exclude_task_id=None):
    """Fill in whatever the caller left as None, the same shape
    task_ai.generate_task_fields answers but backed by the three-layer
    estimator. A field the caller already supplied is passed through
    untouched under provenance 'given' -- this only ever estimates what's
    actually missing."""
    result = {}

    if est_minutes is not None:
        result["est_minutes"] = {"minutes": est_minutes, "provenance": "given"}
    else:
        result["est_minutes"] = estimate_duration(description, exclude_task_id=exclude_task_id)

    for field, value in (("difficulty", difficulty), ("importance", importance)):
        if value is not None:
            result[field] = {"value": value, "provenance": "given"}
        else:
            result[field] = estimate_rating(field, description, exclude_task_id=exclude_task_id)

    return result
