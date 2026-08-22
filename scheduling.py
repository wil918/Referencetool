"""Scheduling helpers that sit on top of the locations and commitments data
in db.py -- travel_minutes, and daily capacity (available_minutes and
inferred energy). Kept separate from db.py's raw storage and from app.py's
routes because the scheduler proper leans on all of it heavily.

Every date this module takes or returns is a "YYYY-MM-DD" string, and every
datetime is the naive local-wall-clock form commitments.start/end are stored
in (see COMMITMENTS_SCHEMA in db.py, and ics_import.py's module docstring for
why that's the form that survives a DST change without drifting).
"""
from datetime import date, datetime, timedelta

import db

# Energy is a small 1-5 scale, same range as tasks.importance/difficulty.
# BASELINE is the ordinary day; LOW is what a rough start knocks it down to.
BASELINE_ENERGY = 3
LOW_ENERGY = 2

# What "a high-cost commitment ending late" means, concretely -- see
# infer_energy. Both are deliberately simple, fixed thresholds rather than
# anything tuned or learned: an obvious guess is one the user can correct.
HIGH_ENERGY_COST = 4
LATE_HOUR = 20


def travel_minutes(from_location_id, to_location_id):
    """Minutes to travel between two locations.

    0 if either side is missing or they're the same location -- there's
    nothing to travel. Otherwise, a direct location_travel row wins if one
    exists, checked in both directions since travel is symmetric by default
    (a row for the reverse pair still covers this one, unless a row for
    *this* pair says otherwise). Failing that, falls back to going via home:
    travel_minutes_from_home(from) + travel_minutes_from_home(to). That's
    deliberately pessimistic -- there are no coordinates in this system and
    no routing API, so a studio-to-fabric-shop trip is estimated as
    studio->home->fabric shop unless someone adds the direct pair. If that
    produces a silly number, the fix is to add the pair in the travel editor,
    not to invent a distance model here.
    """
    if not from_location_id or not to_location_id:
        return 0
    if from_location_id == to_location_id:
        return 0

    direct = db.get_travel_minutes(from_location_id, to_location_id)
    if direct is not None:
        return direct
    reverse = db.get_travel_minutes(to_location_id, from_location_id)
    if reverse is not None:
        return reverse

    from_location = db.get_location(from_location_id) or {}
    to_location = db.get_location(to_location_id) or {}
    from_minutes = from_location.get("travel_minutes_from_home") or 0
    to_minutes = to_location.get("travel_minutes_from_home") or 0
    return from_minutes + to_minutes


def available_minutes(date_str):
    """Minutes free for work on `date_str`: that weekday's working-hours
    window, minus whatever of it a commitment already covers.

    A commitment outside the window doesn't subtract anything -- it was never
    available time to begin with -- and one that only partially overlaps only
    costs the overlapping part. No working-hours row for that weekday (a
    day off, by omission -- see WORKING_HOURS_SCHEMA) means zero, same as an
    empty window.
    """
    weekday = date.fromisoformat(date_str).weekday()
    hours = next((h for h in db.get_working_hours() if h["weekday"] == weekday), None)
    if not hours or not hours["opens"] or not hours["closes"]:
        return 0

    window_start = datetime.fromisoformat(f"{date_str}T{hours['opens']}:00")
    window_end = datetime.fromisoformat(f"{date_str}T{hours['closes']}:00")
    total = int((window_end - window_start).total_seconds() // 60)
    if total <= 0:
        return 0

    busy = 0
    for commitment in db.list_commitments_between(window_start.isoformat(), window_end.isoformat()):
        overlap_start = max(datetime.fromisoformat(commitment["start"]), window_start)
        overlap_end = min(datetime.fromisoformat(commitment["end"]), window_end)
        if overlap_end > overlap_start:
            busy += int((overlap_end - overlap_start).total_seconds() // 60)

    return max(total - busy, 0)


def infer_energy(date_str):
    """Baseline energy for `date_str`, dropped one level if the day before
    held a high-cost commitment that ran late (see HIGH_ENERGY_COST,
    LATE_HOUR). That's the entire rule -- deliberately just one obvious
    threshold rather than a weighted combination of the day's commitments, so
    a wrong guess is easy to see and correct (which is what the manual
    override in daily_capacity.manual_energy is for).
    """
    yesterday = (date.fromisoformat(date_str) - timedelta(days=1)).isoformat()
    commitments = db.list_commitments_between(f"{yesterday}T00:00:00", f"{date_str}T00:00:00")
    rough_start = any(
        (commitment["energy_cost"] or 0) >= HIGH_ENERGY_COST
        and datetime.fromisoformat(commitment["end"]).hour >= LATE_HOUR
        for commitment in commitments
    )
    return LOW_ENERGY if rough_start else BASELINE_ENERGY


def effective_energy(capacity_row):
    """manual_energy always wins over inferred_energy when it's set -- the
    whole point of the override in daily_capacity."""
    if not capacity_row:
        return None
    if capacity_row.get("manual_energy") is not None:
        return capacity_row["manual_energy"]
    return capacity_row.get("inferred_energy")


def compute_daily_capacity(date_str):
    """Recompute available_minutes and inferred_energy for `date_str` from
    the current working hours and commitments, and persist them -- derived,
    recomputable data, same as colour_analysis. Any existing manual_energy
    override is carried forward untouched: recomputing must never clear a
    day the user has already overridden (see app.py's capacity routes for
    the control that sets and clears it).
    """
    existing = db.get_daily_capacity(date_str)
    manual_energy = existing["manual_energy"] if existing else None
    db.save_daily_capacity(
        date_str,
        inferred_energy=infer_energy(date_str),
        manual_energy=manual_energy,
        available_minutes=available_minutes(date_str),
    )
    return db.get_daily_capacity(date_str)
