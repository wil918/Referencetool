"""The scheduler, and the helpers it stands on.

Two layers live here. The first sits on top of the locations and commitments
data in db.py -- travel_minutes, location opening hours, supported windows,
and daily capacity (free_intervals, available_minutes, inferred energy). The
second is the scheduler proper: plan() turns tasks, deadlines, commitments,
locations and capacity into placed blocks and an at-risk list, and replan()
commits that plan to scheduled_blocks.

Every date this module takes or returns is a "YYYY-MM-DD" string, and every
datetime is the naive local-wall-clock form commitments.start/end are stored
in (see COMMITMENTS_SCHEMA in db.py, and ics_import.py's module docstring for
why that's the form that survives a DST change without drifting).
"""
import hashlib
import uuid
from bisect import insort
from datetime import date, datetime, time, timedelta

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

# HOME IS NOT A ROW IN `locations`. It is the absence of one, so it is spelled
# None -- and the same None does double duty as "this task doesn't care where
# it happens". The two readings never collide because they appear in different
# positions: a *context* of None means you are at home, an *item's* location of
# None means the item doesn't move you, so the context carries through it.
HOME = None

# A commitment's support_level, from COMMITMENT_SUPPORT_LEVELS. 'priority' is
# your timetabled session (a tutor whose attention you have first claim on),
# 'ambient' is staff usually being around, NO_SUPPORT is everything else.
PRIORITY = "priority"
AMBIENT = "ambient"
NO_SUPPORT = "none"

# ...and a task's, from TASK_SUPPORT_LEVELS. A different vocabulary describing
# a different thing -- what the WORK needs, not what the WINDOW offers -- which
# is why the two are matched by _eligible_intervals rather than compared.
NEEDS_SUPPORT = "needs"
PREFERS_SUPPORT = "prefers"
INDEPENDENT = "independent"


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


def leg_minutes(from_location_id, to_location_id):
    """Minutes for one leg of a day's travel, where either end may be HOME.

    travel_minutes() deliberately cannot express home: it reads a missing side
    as "there is nothing to travel" and returns 0, which is right for a task
    with no required location but wrong for the first and last leg of a day,
    which really do start and end at home and really do cost the time recorded
    in locations.travel_minutes_from_home.
    """
    if from_location_id == to_location_id:
        return 0
    if from_location_id is HOME:
        return _minutes_from_home(to_location_id)
    if to_location_id is HOME:
        return _minutes_from_home(from_location_id)
    return travel_minutes(from_location_id, to_location_id)


def _minutes_from_home(location_id):
    location = db.get_location(location_id) or {}
    return location.get("travel_minutes_from_home") or 0


def location_open_intervals(location_id, date_str):
    """When `location_id` is open on `date_str`, as (start, end) datetimes.

    A date override beats the weekly pattern: `closed` shuts the place for the
    day outright, and an override naming only one side keeps the other from
    the weekly row -- otherwise "the studio closes at 16:00 today" would have
    to restate the opening time as well or be read as closed all day.

    A location with no hours for that weekday and no override is shut, same
    convention as a missing working_hours row (see free_intervals).
    """
    if not location_id:
        return []
    weekday = date.fromisoformat(date_str).weekday()
    hours = next(
        (h for h in db.get_location_hours(location_id) if h["weekday"] == weekday), None
    )
    opens = hours["opens"] if hours else None
    closes = hours["closes"] if hours else None

    # Sorted by id so two overrides recorded for one date resolve the same way
    # on every run rather than in whatever order the query happened to return.
    overrides = sorted(
        (o for o in db.list_location_overrides(location_id) if o["date"] == date_str),
        key=lambda o: o["id"],
    )
    if overrides:
        override = overrides[0]
        if override["closed"]:
            return []
        opens = override["opens"] or opens
        closes = override["closes"] or closes

    if not opens or not closes:
        return []
    start = datetime.fromisoformat(f"{date_str}T{opens}:00")
    end = datetime.fromisoformat(f"{date_str}T{closes}:00")
    return [(start, end)] if end > start else []


def support_windows(date_str):
    """The supported stretches of `date_str`: every commitment that offers a
    tutor or staff, as {start, end, level, location_id} in time order.

    These are the windows a task's own support_level is matched against, and
    the reason a supported commitment is not subtracted from free time -- see
    free_intervals.
    """
    windows = []
    for commitment in _commitments_on(date_str):
        if _offers_support(commitment):
            windows.append({
                "start": datetime.fromisoformat(commitment["start"]),
                "end": datetime.fromisoformat(commitment["end"]),
                "level": commitment["support_level"],
                "location_id": commitment["location_id"],
                "id": commitment["id"],
            })
    windows.sort(key=lambda w: (w["start"], w["end"], w["id"]))
    return windows


def _commitments_on(date_str):
    following = (date.fromisoformat(date_str) + timedelta(days=1)).isoformat()
    return db.list_commitments_between(f"{date_str}T00:00:00", f"{following}T00:00:00")


def _offers_support(commitment):
    """Whether this commitment is a window you can work inside.

    A COMMITMENT BLOCKS THE DAY UNLESS IT OFFERS SUPPORT. A lecture, a shift or
    a dentist appointment is time you cannot work in; a timetabled studio
    session is time you spend working on your own project with a tutor to hand.
    Subtracting the second along with the first would leave a 'needs' task
    nowhere to go -- the only windows it is allowed in would be the ones the
    day had already declared busy -- and would under-report every supported day
    by the length of its own sessions.
    """
    return (commitment.get("support_level") or NO_SUPPORT) != NO_SUPPORT


# --- Personal events: home-first chains -----------------------------------------
#
# A home_first commitment carries a prep_minutes the user entered by hand --
# no Claude involvement, see SCHEDULE_SCOPE.md's "Home first" section. The
# time recorded on the commitment itself is always the START of the event,
# never when you have to leave, so home_first_chain works backwards from it.


def home_first_chain(commitment):
    """The immovable blocks a home_first commitment inserts before itself, in
    chronological order, ending exactly at the commitment's own start:

        [ travel to home ] -> [ get ready, prep_minutes ] -> [ travel home -> venue ]

    Each is a dict with start/end (naive datetimes), kind ('travel' or
    'prep'), commitment_id, and from_location_id/to_location_id. Empty if
    home_first isn't set.

    The venue leg is sized from the commitment's OWN travel_minutes, entered
    directly or pre-filled from a matching saved location and then left
    editable (see COMMITMENTS_SCHEMA) -- never looked up fresh from
    location_id, so a personal event never needs an entry in the locations
    table at all. It's omitted when travel_minutes isn't set (there's nothing
    to size it from, and the entered time still means arrival, just without a
    costed trip in front of it -- the caller marks the chain incomplete for
    that reason) or when it's genuinely zero (nothing to travel).

    The leading travel-to-home leg is omitted when you're already home when
    the chain would start -- there's nothing to travel. "Already home" is
    read from other COMMITMENTS alone (see _location_before), never from
    where the day's tasks end up: task placement is an output of the walk
    that this chain feeds into as blocked time, and asking it to look ahead
    at its own output would be circular.
    """
    if not commitment.get("home_first"):
        return []
    event_start = datetime.fromisoformat(commitment["start"])
    prep_minutes = commitment.get("prep_minutes") or 0
    venue_name = commitment.get("location_name")
    venue_travel = commitment.get("travel_minutes")

    blocks = []  # built latest-first (working backwards); reversed before return

    prep_end = event_start
    if venue_name and venue_travel:
        prep_end = event_start - timedelta(minutes=venue_travel)
        blocks.append(_chain_block(commitment, "travel", prep_end, event_start,
                                   HOME, commitment.get("location_id")))

    prep_start = prep_end - timedelta(minutes=prep_minutes)
    if prep_minutes:
        blocks.append(_chain_block(commitment, "prep", prep_start, prep_end, None, None))

    context = _location_before(prep_start, exclude_commitment_id=commitment.get("id"))
    home_travel = leg_minutes(context, HOME)
    if context is not HOME and home_travel:
        travel_start = prep_start - timedelta(minutes=home_travel)
        blocks.append(_chain_block(commitment, "travel", travel_start, prep_start, context, HOME))

    blocks.reverse()
    return blocks


def _chain_block(commitment, kind, start, end, from_location_id, to_location_id):
    return {
        "commitment_id": commitment["id"],
        "kind": kind,
        "start": start,
        "end": end,
        "from_location_id": from_location_id,
        "to_location_id": to_location_id,
    }


def _location_before(moment, exclude_commitment_id=None):
    """Where you are at `moment`, read from commitments alone: the last one
    ending at or before it that names a location, reading through any that
    don't (an appointment with no location doesn't move you, same convention
    _context_before later uses for placed task items). HOME if nothing does.

    Sorted by END, not start -- two commitments can overlap (nothing stops
    that at the API level), and it's the one that finishes latest among
    those already over that puts you wherever you are, regardless of which
    one started first.
    """
    location = HOME
    for commitment in sorted(db.list_commitments(), key=lambda c: (c["end"], c["start"], c["id"])):
        if commitment["id"] == exclude_commitment_id:
            continue
        if datetime.fromisoformat(commitment["end"]) > moment:
            continue
        if commitment.get("location_id"):
            location = commitment["location_id"]
    return location


def _home_first_blocks_between(window_start, window_end):
    """Every prep/travel block a home_first commitment inserts before itself
    that overlaps [window_start, window_end) at all -- these are as immovable
    as the commitment itself, so free_intervals and domestic_free_intervals
    cut them out exactly like a commitment.
    """
    blocks = []
    for commitment in db.list_commitments():
        if not commitment.get("home_first"):
            continue
        for block in home_first_chain(commitment):
            if block["start"] < window_end and block["end"] > window_start:
                blocks.append(block)
    return blocks


def _band_window(date_str, weekly_rows, band):
    """The (start, end) window one weekly band (working or domestic hours)
    opens for on `date_str`, or None if it's shut.

    Shared arithmetic behind free_intervals and domestic_free_intervals: a
    date override beats the weekly pattern (`off` shuts the band for the day
    outright, and an override naming only one side keeps the other from the
    weekly row -- same convention as location_open_intervals), and no weekly
    row for that weekday with no override means shut, same "absence is the
    closed case" convention as WORKING_HOURS_SCHEMA.
    """
    weekday = date.fromisoformat(date_str).weekday()
    hours = next((h for h in weekly_rows if h["weekday"] == weekday), None)
    opens = hours["opens"] if hours else None
    closes = hours["closes"] if hours else None

    overrides = sorted(
        (o for o in db.list_hours_overrides(band) if o["date"] == date_str),
        key=lambda o: o["id"],
    )
    if overrides:
        override = overrides[0]
        if override["off"]:
            return None
        opens = override["opens"] or opens
        closes = override["closes"] or closes

    if not opens or not closes:
        return None
    start = datetime.fromisoformat(f"{date_str}T{opens}:00")
    end = datetime.fromisoformat(f"{date_str}T{closes}:00")
    return (start, end) if end > start else None


def _window_minus_commitments(window_start, window_end):
    """`(window_start, window_end)` with every blocking commitment (see
    _offers_support) and every home-first chain block (see home_first_chain)
    cut out of it, as a list of (start, end) naive datetimes in order.

    Shared by free_intervals and domestic_free_intervals -- the two bands
    differ only in which window they start from, not in what blocks it. A
    commitment or chain block outside the window doesn't subtract anything --
    it was never available time to begin with -- and one that only partially
    overlaps only costs the overlapping part.

    A commitment that offers support is not cut out at all (see
    _offers_support): it is a window you work inside, not one that stops you.
    Home-first chain blocks are never supported -- they're prep and travel,
    not a tutor's session -- so they always cut.

    Overlapping busy spans are cut out as one span rather than one at a time.
    A lunch inside a shift is a single busy stretch, and charging the window
    for both would under-report it.
    """
    busy = []
    for commitment in db.list_commitments_between(window_start.isoformat(), window_end.isoformat()):
        if _offers_support(commitment):
            continue
        overlap_start = max(datetime.fromisoformat(commitment["start"]), window_start)
        overlap_end = min(datetime.fromisoformat(commitment["end"]), window_end)
        if overlap_end > overlap_start:
            busy.append((overlap_start, overlap_end))
    for block in _home_first_blocks_between(window_start, window_end):
        overlap_start = max(block["start"], window_start)
        overlap_end = min(block["end"], window_end)
        if overlap_end > overlap_start:
            busy.append((overlap_start, overlap_end))
    busy.sort()

    intervals = []
    cursor = window_start
    for start, end in busy:
        if start > cursor:
            intervals.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < window_end:
        intervals.append((cursor, window_end))
    return intervals


def free_intervals(date_str):
    """The stretches of `date_str` that are genuinely free for work: that
    weekday's working-hours window with every blocking commitment and
    home-first chain block cut out of it (see _band_window,
    _window_minus_commitments), as a list of (start, end) naive datetimes in
    order.

    A day off (no working-hours row for that weekday and no override) means
    no intervals at all, same as an empty window. Availability is never
    created beyond what the working hours grant: the cut only ever happens
    inside that window, so a Saturday studio session with no working hours on
    a Saturday is still not workable time.
    """
    window = _band_window(date_str, db.get_working_hours(), "working")
    if window is None:
        return []
    return _window_minus_commitments(*window)


def domestic_free_intervals(date_str):
    """The stretches of `date_str` free for domestic work: the same rule as
    free_intervals, but against the domestic-hours band instead of working
    hours (see _band_window). A commitment or home-first chain block during
    what would otherwise be domestic time blocks it exactly as it blocks
    working time -- getting ready to go out stops you doing laundry too.
    """
    window = _band_window(date_str, db.get_domestic_hours(), "domestic")
    if window is None:
        return []
    return _window_minus_commitments(*window)


# --- Interval arithmetic ---------------------------------------------------------
#
# Every constraint in the walk narrows the same thing: a list of (start, end)
# stretches, kept sorted and non-overlapping. Working hours minus commitments
# gives the day; intersecting with the location's opening hours makes it a day
# at the studio; intersecting again with a priority window makes it a day at
# the studio with a tutor. Three functions do all of it.


def _merge(spans):
    """Overlapping or touching spans folded into one list of disjoint ones."""
    merged = []
    for start, end in sorted(spans):
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _intersect(left, right):
    """The stretches covered by both lists. Both must be sorted and disjoint."""
    result, i, j = [], 0, 0
    while i < len(left) and j < len(right):
        start = max(left[i][0], right[j][0])
        end = min(left[i][1], right[j][1])
        if end > start:
            result.append((start, end))
        if left[i][1] <= right[j][1]:
            i += 1
        else:
            j += 1
    return result


def _subtract(intervals, spans):
    """`intervals` with every span in `spans` cut out of it."""
    remaining = list(intervals)
    for cut_start, cut_end in _merge(spans):
        next_remaining = []
        for start, end in remaining:
            if cut_end <= start or cut_start >= end:
                next_remaining.append((start, end))
                continue
            if start < cut_start:
                next_remaining.append((start, cut_start))
            if cut_end < end:
                next_remaining.append((cut_end, end))
        remaining = next_remaining
    return remaining


def _contains(intervals, start, end):
    """Whether one stretch sits wholly inside a single one of `intervals`."""
    if end <= start:
        return True
    return any(i_start <= start and end <= i_end for i_start, i_end in intervals)


def available_minutes(date_str):
    """Minutes free for work on `date_str` -- the scalar view of exactly what
    free_intervals returns, so the number a day reports and the slots the
    scheduler packs into it can never disagree.
    """
    return sum(_interval_minutes(start, end) for start, end in free_intervals(date_str))


def _interval_minutes(start, end):
    return max(int((end - start).total_seconds() // 60), 0)


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


def day_energy(date_str):
    """The energy the scheduler plans `date_str` against: the user's manual
    override when there is one, otherwise the value inferred from the day
    before.

    Read-only on purpose. Planning never persists a daily_capacity row as a
    side effect -- that is compute_daily_capacity's job, called from the
    capacity routes -- so a plan can be run as often as you like without
    quietly rewriting the record of what the day looked like. It also means a
    stored inferred_energy that has since gone stale (a commitment added
    after it was computed) is recomputed here rather than trusted.
    """
    row = db.get_daily_capacity(date_str)
    if row and row.get("manual_energy") is not None:
        return row["manual_energy"]
    return infer_energy(date_str)




# --- The scheduler ------------------------------------------------------------
#
# plan() is PURE: it reads tasks, dependencies, deadlines, commitments, hours,
# locations and capacity, and returns a plan. It writes nothing. replan() is
# what commits that plan to scheduled_blocks. The split is what makes the
# determinism requirement testable -- two plan() calls over unchanged data
# return byte-identical dicts, block ids included -- and it keeps the promise
# that the scheduler's only output is blocks: no task row is ever mutated
# here, not its status, not its slip_count.
#
# DETERMINISM, throughout this section: tasks are iterated in id-sorted order,
# every ranking breaks ties by id, ready queues stay id-ordered, and block ids
# are derived from their contents rather than drawn from uuid4. Nothing may
# depend on wall-clock time (the anchor is passed in), on dict insertion order
# out of a query, or on set iteration order. Without that the schedule
# reshuffles between replans of data that did not change, and a schedule that
# moves on its own is one nobody follows.

# A replan only places work that is still outstanding. 'partial' is a closed
# state -- the unfinished remainder is a separate task chained by
# continues_task_id (see TASKS_SCHEMA) -- and 'done'/'abandoned' are finished
# with, so all three are out.
SCHEDULABLE_STATUSES = ("pending", "scheduled")

# DETAIL DECAYS WITH DISTANCE. Inside this many days from the anchor a task is
# placed to the slot, with a real start and end time. Beyond it a task is
# allocated to a day and no more: five weeks out, an exact time is a fiction
# that would be rewritten by every replan before it was ever worked. Both
# kinds consume the same capacity -- only the reported precision decays.
SLOT_DETAIL_DAYS = 7

# The horizon runs to the furthest deadline in play, but never less than this
# far ahead: undated work still needs somewhere to go, and a horizon that
# stopped at the last deadline would have nowhere to put it.
DEFAULT_HORIZON_DAYS = 14

# ...and never further than this. A deadline typed as 2126 instead of 2026
# should produce a wrong-looking schedule, not a walk through 36,000 days.
MAX_HORIZON_DAYS = 365

# What an unestimated or unrated task is worth. Mid-scale for the 1-5 ratings,
# an hour for a duration -- deliberately unremarkable values, since the
# estimator (session 8) is what will fill these in properly.
DEFAULT_EST_MINUTES = 60
DEFAULT_IMPORTANCE = 3
DEFAULT_DIFFICULTY = 3

MINUTES_PER_DAY = 24 * 60

# Used only when there are no working hours on file at all, to convert an
# estimate in work minutes into calendar time for the slack formula. With
# hours configured, the real average is used instead -- see _work_rate.
NOMINAL_WORKING_MINUTES_PER_DAY = 8 * 60

# Slack at which urgency is exactly half its maximum. A week is the unit the
# work is actually felt in -- "it's due next week" is a different feeling from
# "it's due this week" -- so a week of spare time halves how loudly a task
# asks to be done next.
SLACK_HALF_LIFE_MINUTES = 7 * MINUTES_PER_DAY

# ENERGY GATES DIFFICULTY, and this is the only place that mapping lives, so
# it can be tuned in one edit. Energy and difficulty share the same 1-5 scale.
#
# The gate only bites BELOW baseline. An ordinary day (3) admits anything --
# it has to, or the hardest work in a project would need a manual "good day"
# override before it could ever be scheduled, since inference itself only ever
# produces 3 or 2 (see infer_energy). What the gate is for is the day after a
# late, costly commitment: a rough morning gets the trimming and the
# tidying, not the sleeve heads.
ENERGY_MAX_DIFFICULTY = {1: 1, 2: 3, 3: 5, 4: 5, 5: 5}

# HOW CLOSE TWO SCORES HAVE TO BE to count as the same for the same-location
# tie-break. Scores run 0-5 (urgency 0-1 x importance 1-5), so this is a
# twentieth of the range: wide enough that two comparably pressing tasks are
# actually grouped -- with exact equality the tie-break would almost never
# fire, since scores are floats out of a decay curve -- and narrow enough that
# a materially more urgent task is never displaced by a merely convenient one.
COMPARABLE_SCORE_TOLERANCE = 0.25

# HOW MUCH TIME BEFORE A DEADLINE IS RESERVED FOR FINISHING. A day, so the
# deadline's own working hours are the protected window (deadlines are read as
# the end of their day -- see _parse_moment). Overridable per plan() call
# rather than stored, since nothing yet has a place to store a scheduler
# setting; when one exists this is the default it should fall back to.
FINISHING_BUFFER_MINUTES = 24 * 60

# BREAKS. A rest is due after this many minutes of UNINTERRUPTED task work --
# consecutive task blocks only; travel, prep, a commitment, an existing break
# or a plain gap all reset the run (see _uninterrupted_task_minutes_ending_at).
# Named constants because both numbers are exactly the kind of thing a later
# session (or the user) will want to tune without hunting through the walk.
BREAK_AFTER_MINUTES = 2 * 60
BREAK_MINUTES = 30

# Breaks (like travel) are only ever inserted where there's a timeline to put
# them on -- slot-precision days, the near-term week (see SLOT_DETAIL_DAYS). A
# day-granularity allocation five weeks out has no real ordering between the
# tasks assigned to it, so "uninterrupted" there would be fiction dressed up
# as a rule.

# Why a task could not be placed before its deadline. Codes rather than prose
# so a UI can style them; every at-risk entry carries a written message too.
AT_RISK_OVERDUE = "overdue"
AT_RISK_BLOCKED = "blocked"
AT_RISK_ENERGY = "energy"
AT_RISK_TOO_LONG = "too_long"
AT_RISK_NO_CAPACITY = "no_capacity"
AT_RISK_LOCATION = "location"
AT_RISK_NO_SUPPORT = "no_support"
AT_RISK_FINISHING = "finishing"

# How many times a task can slip before it says so on its own, rather than
# just quietly reappearing in a later plan every time. Three, not one --
# missing a single slot is normal life; a task that keeps missing is
# underestimated, blocked, or landing on days whose energy can't carry it,
# and that pattern is only visible once it's repeated (see
# SCHEDULE_SCOPE.md's "three outcomes" section).
CHRONIC_SLIP_THRESHOLD = 3

# The three ways a scheduled block can resolve (see SCHEDULE_SCOPE.md's "The
# three outcomes"). Not stored anywhere -- these are the values a caller
# passes to describe which of resolve_completed/resolve_partial/
# resolve_not_completed it wants, kept here so app.py can validate against
# the same list rather than hard-coding its own.
OUTCOME_COMPLETED = "completed"
OUTCOME_PARTIAL = "partial"
OUTCOME_NOT_COMPLETED = "not_completed"
OUTCOMES = (OUTCOME_COMPLETED, OUTCOME_PARTIAL, OUTCOME_NOT_COMPLETED)


class DependencyCycleError(Exception):
    """task_dependencies contains a cycle, so no order satisfies it.

    Planning refuses rather than picking one. A silent reorder would hand back
    a schedule that quietly breaks a dependency the user recorded, which is
    worse than no schedule at all -- so this names the tasks involved and
    stops, the same contract as the check that refuses the edge at the point
    it is added.
    """

    def __init__(self, task_ids, chain):
        self.task_ids = list(task_ids)
        super().__init__(f"dependency cycle: {' -> '.join(chain)}")


def plan(now=None, finishing_buffer_minutes=None):
    """Work out where everything outstanding goes between now and the
    furthest deadline in play, and what cannot be reached at all.

    `now` anchors the walk: a datetime, a "YYYY-MM-DD" string, or a date (both
    of the latter meaning the start of that day). It defaults to the actual
    current time, and today's already-passed hours are never planned into.
    Tests pass it explicitly, which is what makes the whole thing reproducible
    offline.

    `finishing_buffer_minutes` overrides how much time before each deadline is
    protected for finishing work (see FINISHING_BUFFER_MINUTES).

    Returns the plan; writes nothing. See replan() to commit it.
    """
    anchor = _anchor(now)
    today = anchor.date()
    buffer_minutes = (
        FINISHING_BUFFER_MINUTES if finishing_buffer_minutes is None
        else max(int(finishing_buffer_minutes), 0)
    )

    tasks = sorted(
        (t for t in db.list_tasks() if t["status"] in SCHEDULABLE_STATUSES),
        key=lambda t: t["id"],
    )
    by_id = {t["id"]: t for t in tasks}
    deps, dependents = _dependency_graph(by_id)
    order = _topological_order(by_id, deps, dependents)

    deliverable_ids = sorted({t["deliverable_id"] for t in tasks if t["deliverable_id"]})
    deliverables = {d["id"]: d for d in db.get_deliverables_by_ids(deliverable_ids)}

    horizon_end = _horizon_end(today, tasks, deliverables)
    required_locations = sorted({t["required_location_id"] for t in tasks
                                 if t["required_location_id"]})
    days = _build_days(anchor, horizon_end, required_locations)
    legs = _leg_table(days, required_locations)
    slot_dates = {d["date"] for d in days if d["granularity"] == "slot"}
    # Every locked block for a task still in this plan's schedulable set,
    # grouped by the date it falls on -- what _walk seeds into each day
    # before its own greedy placement runs, so a pin survives a replan (see
    # SCHEDULE_SCOPE.md's "Pinning"). A lock on a task that's since been
    # completed, gone partial, been abandoned or deleted is simply not in
    # `by_id` any more and drops out here -- nothing left to keep pinned.
    # Restricted to slot-precision days for the same reason chain_blocks is
    # below: a lock names a real time of day, which day-granularity days
    # don't have.
    locked_by_date = {}
    for block in db.list_locked_scheduled_blocks():
        if block["task_id"] not in by_id:
            continue
        day_str = block["start"][:10]
        if day_str not in slot_dates:
            continue
        locked_by_date.setdefault(day_str, []).append(block)
    # Every home-first chain block that falls on a slot-precision day, for
    # EMISSION only -- the blocking itself already happened inside
    # free_intervals/domestic_free_intervals via _home_first_blocks_between,
    # independent of this. Filtered the same way travel is (see _blocks):
    # a chain block five weeks out was still made room for, but there's no
    # timeline that far ahead to place a real row on.
    chain_blocks = [
        block for block in _home_first_blocks_between(anchor, _day_ceiling(horizon_end.isoformat()))
        if block["start"].date().isoformat() in slot_dates
    ]

    minutes = {t["id"]: _est_minutes(t) for t in tasks}
    difficulty = {t["id"]: _level(t["difficulty"], DEFAULT_DIFFICULTY) for t in tasks}
    deadlines = _effective_deadlines(order, by_id, dependents, deliverables, horizon_end)
    critical = _critical_minutes(order, dependents, minutes)

    rate = _work_rate(days)
    scores = {
        tid: _score(by_id[tid], deadlines[tid], critical[tid], anchor, rate) for tid in by_id
    }
    # THE ranking. Highest score first, ties broken by id so that two tasks
    # that genuinely rank the same never swap places between replans.
    ranked = sorted(tasks, key=lambda t: (-scores[t["id"]], t["id"]))

    protected = _protected_spans(tasks, deliverables, buffer_minutes)
    meta = _task_meta(tasks, deliverables, minutes, difficulty, deadlines, scores, protected)
    finishing = _finishing_plan(ranked, meta, days, protected, buffer_minutes)
    for tid, info in meta.items():
        info["held"] = tid in finishing["held"]

    no_break_dates = set()
    placements, travel, breaks, break_dates = _walk(
        days, ranked, deps, meta, legs, protected, locked_by_date, no_break_dates
    )
    at_risk = _at_risk(tasks, placements, deps, meta, days, deliverables, anchor,
                       protected, finishing, legs)
    at_risk_ids = {e["task_id"] for e in at_risk}

    # BREAKS ARE DROPPED ONLY WHEN KEEPING THEM WOULD COST A DEADLINE, never
    # pre-emptively because a day looks tight. Tried one candidate day at a
    # time, a full re-walk each time -- dropping one day's break can shift
    # what fits on every day after it, so only re-running the walk tells the
    # truth -- and a drop is kept only when it actually clears something off
    # the at-risk list, never for a day that merely looks tight.
    #
    # A worklist, not a single pass over the original break_dates: dropping
    # one day's break can shift enough that a LATER day, which didn't need a
    # break before, now does -- that new date has to be tried too, or a task
    # rescuable only by dropping it would stay at risk for no visible reason.
    # `seen` keeps this from cycling; since breaks only exist on slot-precision
    # days (see SLOT_DETAIL_DAYS), the whole thing is still bounded.
    breaks_dropped = set()
    queue = sorted(break_dates)
    seen = set(queue)
    while queue and at_risk_ids:
        day_date = queue.pop(0)
        trial_no_break = no_break_dates | {day_date}
        trial_placements, trial_travel, trial_breaks, trial_break_dates = _walk(
            days, ranked, deps, meta, legs, protected, locked_by_date, trial_no_break
        )
        trial_at_risk = _at_risk(tasks, trial_placements, deps, meta, days, deliverables, anchor,
                                 protected, finishing, legs)
        trial_at_risk_ids = {e["task_id"] for e in trial_at_risk}
        if trial_at_risk_ids < at_risk_ids:  # strictly fewer at risk, nothing new added
            no_break_dates = trial_no_break
            placements, travel, breaks, break_dates = (
                trial_placements, trial_travel, trial_breaks, trial_break_dates
            )
            at_risk, at_risk_ids = trial_at_risk, trial_at_risk_ids
            breaks_dropped.add(day_date)
            for new_date in sorted(trial_break_dates - seen):
                seen.add(new_date)
                queue.append(new_date)

    blocks = _blocks(placements, travel, breaks, chain_blocks)

    slot_days = [d for d in days if d["granularity"] == "slot"]
    return {
        "anchor": anchor.isoformat(),
        "today": today.isoformat(),
        "horizon_end": horizon_end.isoformat(),
        "slot_detail_until": slot_days[-1]["date"] if slot_days else today.isoformat(),
        "finishing_buffer_minutes": buffer_minutes,
        "blocks": blocks,
        "at_risk": at_risk,
        "at_risk_by_deliverable": _at_risk_by_deliverable(at_risk, tasks, deliverables),
        # Surfaced alongside at-risk rather than folded into it: a chronic
        # slipper may have placed just fine THIS time (see
        # CHRONIC_SLIP_THRESHOLD) -- its problem is the pattern across past
        # replans, not today's placement, so it needs its own list rather
        # than hijacking a reason code that means "didn't fit."
        "chronically_slipping": _chronically_slipping(tasks),
        # A day loses its break ONLY to save something on the at-risk list --
        # this is how that trade says so, rather than the break just quietly
        # not being there.
        "breaks_dropped": sorted(breaks_dropped),
        "summary": {
            "tasks": len(tasks),
            "placed": len(placements),
            "at_risk": len(at_risk),
            # TRAVEL IS NOT WORK, so it is counted separately and never added
            # into a task's minutes. The estimator learns from what a task
            # actually took; a duration padded with the trip to get there
            # would teach it that pattern cutting takes an hour longer at the
            # studio than at home. This total covers every leg the walk had to
            # make room for, including the ones on day-granularity days that
            # are too far out to be given a time of day (see _blocks).
            "planned_minutes": sum(p["minutes"] for p in placements.values()),
            "travel_minutes": sum(leg["minutes"] for leg in travel),
            "break_minutes": len(breaks) * BREAK_MINUTES,
            "capacity_minutes": sum(d["capacity"] for d in days),
        },
    }


def replan(now=None, finishing_buffer_minutes=None):
    """Resolve whatever the calendar has already decided on its own, then run
    the scheduler and replace the future with its output.

    Two steps, in order:

    1. resolve_lapsed_blocks(now) -- every past task block nobody ever
       explicitly resolved is treated as NOT COMPLETED (see
       SCHEDULE_SCOPE.md's "three outcomes"). This is the only place that
       happens automatically; plan() itself stays pure and never mutates a
       task row.
    2. plan(now, ...), committed via db.replace_scheduled_blocks with a
       cutoff at the same anchor. That commit only replaces `scheduled_blocks`
       from the anchor forward -- anything already in the past is left alone,
       whether it's a completed/partial task's genuine history or a
       not-completed block resolve_lapsed_blocks hasn't reached yet. A locked
       block in the future window is still replaced *as a row* (same id, same
       content) rather than literally untouched, because plan() re-seeds it
       into the walk itself (see _seed_locked_blocks) -- "survives a replan"
       means its slot doesn't move, not that the row is never rewritten.

    Safe to call repeatedly with an unchanged anchor and unchanged data: step
    1 finds nothing new to resolve (already-resolved blocks are gone, not
    just marked), and step 2's replace is a no-op in content even though it
    still runs (see db.replace_scheduled_blocks and _block_id).
    """
    anchor = _anchor(now)
    resolve_lapsed_blocks(anchor)
    result = plan(anchor, finishing_buffer_minutes)
    db.replace_scheduled_blocks(result["blocks"], cutoff=result["anchor"])
    return result


# --- Outcomes: completing, partially completing, and not completing --------------
#
# A scheduled block resolves one of three ways (SCHEDULE_SCOPE.md's "three
# outcomes"), and each is its own function here rather than one with an
# `outcome` flag: the three do genuinely different things to the task, its
# blocks and (for partial) the dependency graph, and a shared function would
# just be an if/elif in a trench coat. app.py calls whichever of these a
# scoped route needs; none of them touch plan()'s purity, since none of them
# run as part of it.


def resolve_completed(task_id, actual_minutes, actual_difficulty=None,
                      actual_importance=None, notes=None, now=None):
    """Record a COMPLETED outcome: the actuals as given, the task closed as
    'done', and any of its own blocks still ahead of `now` dropped -- see
    _drop_future_blocks. A block already in the past (the ordinary case: you
    did the work, then tapped Done) is left exactly where it is, becoming the
    durable record of when it actually happened.
    """
    db.save_task_actual(task_id, actual_minutes=actual_minutes,
                        actual_difficulty=actual_difficulty,
                        actual_importance=actual_importance, notes=notes)
    db.update_task(task_id, status="done")
    _drop_future_blocks(task_id, now)
    return {"task": db.get_task(task_id), "actual": db.get_task_actual(task_id)}


# Everything a remainder task inherits from the original unless the caller
# overrides it -- every field SCHEDULE_SCOPE.md's "three outcomes" names
# (title, description, project, deliverable, location, support level,
# importance, difficulty, is_finishing) plus deadline, measurable_goal and
# is_domestic, which the same reasoning obviously extends to: nothing here
# should silently reset just because it wasn't named explicitly. est_minutes
# is deliberately absent -- see resolve_partial.
REMAINDER_INHERITED_COLUMNS = (
    "title", "description", "measurable_goal", "deadline", "project_id", "deliverable_id",
    "required_location_id", "support_level", "importance", "difficulty", "is_finishing",
    "is_domestic",
)


def resolve_partial(task_id, actual_minutes, est_minutes, actual_difficulty=None,
                    actual_importance=None, notes=None, now=None, **remainder_overrides):
    """Record a PARTIALLY COMPLETED outcome: the original is closed with the
    time actually spent, and a remainder task is spawned to pick up where it
    left off, chained back by continues_task_id.

    `actual_minutes` is what this segment took, recorded on the ORIGINAL --
    but never read as a completed data point against the original's own
    estimate in isolation (that reading is backwards: a 3h task with 2h spent
    and not finished did not take 2 hours). The estimator instead trains on
    the whole chain once its final link completes, summing every segment's
    actual against the FIRST link's estimate -- a job for the estimator
    (session 8), not for this function, but the reason actual_minutes is
    still recorded here rather than withheld.

    `est_minutes` is a FRESH estimate for what remains, always supplied by
    the caller and never inherited -- "the same estimate as before" is never
    right for a task that's already partly done. Every field in
    REMAINDER_INHERITED_COLUMNS carries over unless named in
    `remainder_overrides`, keeping the remainder editable without making
    every field mandatory input.

    Dependents of the original are repointed to the remainder (see
    _repoint_dependents) -- the single most likely bug in this whole feature
    if it's missed.
    """
    task = db.get_task(task_id)
    if not task:
        raise ValueError(f"no such task: {task_id}")

    db.save_task_actual(task_id, actual_minutes=actual_minutes,
                        actual_difficulty=actual_difficulty,
                        actual_importance=actual_importance, notes=notes)
    db.update_task(task_id, status="partial")
    _drop_future_blocks(task_id, now)

    fields = {column: task[column] for column in REMAINDER_INHERITED_COLUMNS}
    fields.update({
        key: value for key, value in remainder_overrides.items()
        if key in REMAINDER_INHERITED_COLUMNS
    })
    title = fields.pop("title")
    remainder_id = str(uuid.uuid4())
    db.create_task(
        remainder_id, title, est_minutes=est_minutes, status="pending",
        continues_task_id=task_id, **fields
    )
    _repoint_dependents(task_id, remainder_id)
    return {"original": db.get_task(task_id), "remainder": db.get_task(remainder_id)}


def resolve_not_completed(task_id):
    """Record a NOT COMPLETED outcome: the task returns to the pool
    unchanged and slip_count goes up by one. No actual is recorded -- never
    starting a task says nothing about how long it takes, and an actual built
    from that would teach the estimator from a number that never happened.

    Every one of the task's own scheduled blocks, past or future, is dropped:
    none of them describe anything true any more once the task is back in the
    pool, and the durable trace of the slip is slip_count, not a stale block
    (see db.replace_scheduled_blocks's "history" note). The same function
    serves an explicit tap and resolve_lapsed_blocks's automatic detection of
    a block nobody ever acted on -- the outcome is identical either way.
    """
    task = db.get_task(task_id)
    if not task:
        raise ValueError(f"no such task: {task_id}")
    db.update_task(task_id, status="pending", slip_count=task["slip_count"] + 1)
    for block in db.list_scheduled_blocks_for_task(task_id):
        db.delete_scheduled_block(block["id"])
    return db.get_task(task_id)


def resolve_lapsed_blocks(now=None):
    """Auto-resolve every past task block nobody ever explicitly resolved, as
    NOT COMPLETED -- the fallback half of SCHEDULE_SCOPE.md's "a past block
    that was never resolved is treated as NOT COMPLETED and returns to the
    pool". Returns the ids of the tasks it resolved.

    Only a task still in SCHEDULABLE_STATUSES qualifies: one whose status has
    already moved to done, partial or abandoned was resolved explicitly
    before the scanner got to it, and its block is left alone precisely
    because nothing here touches it -- that's the "is history and is never
    rewritten" half of the same rule.

    Idempotent by construction rather than by checking a flag:
    resolve_not_completed deletes the block it resolves, so a block already
    processed simply isn't found the next time this runs. Called from
    replan(), never from plan() -- plan() stays pure, and this is the
    mutation that makes replanning safe to repeat.
    """
    anchor = _anchor(now)
    resolved = []
    for block in db.list_past_task_blocks(anchor.isoformat()):
        task = db.get_task(block["task_id"])
        if not task or task["status"] not in SCHEDULABLE_STATUSES:
            continue
        resolve_not_completed(task["id"])
        resolved.append(task["id"])
    return resolved


def _drop_future_blocks(task_id, now=None):
    """Delete this task's own scheduled blocks that are still ahead of `now`
    -- called after resolving an outcome, when the task no longer needs
    whatever slot it used to hold. Left otherwise, a stale future block would
    sit in the table misdescribing the plan until the next replan happened to
    sweep it up. A block already in the past is left alone: it's genuine
    history, not a stale placeholder (see resolve_completed and
    resolve_partial, the only callers).
    """
    anchor = _anchor(now)
    cutoff = anchor.isoformat()
    for block in db.list_scheduled_blocks_for_task(task_id):
        if block["start"] >= cutoff:
            db.delete_scheduled_block(block["id"])


def _repoint_dependents(old_task_id, new_task_id):
    """Move every dependency edge pointing at old_task_id onto new_task_id.

    THE SINGLE MOST LIKELY BUG in a partial outcome (SCHEDULE_SCOPE.md's own
    words): if B depends on A and A goes partial, leaving B's edge pointed at
    the now-closed A would let the scheduler treat B's prerequisite as
    finished and place B too early. A fresh edge to the remainder carries no
    cycle risk -- the remainder is a brand new task with no dependencies of
    its own yet -- so this trusts the move rather than running
    task_dependency_cycle for it.
    """
    for dependent_id in db.list_dependent_task_ids(old_task_id):
        db.remove_task_dependency(dependent_id, old_task_id)
        db.add_task_dependency(dependent_id, new_task_id)


# --- Anchoring and dates -------------------------------------------------------


def _anchor(now):
    if now is None:
        return datetime.now().replace(microsecond=0)
    if isinstance(now, datetime):
        return now.replace(microsecond=0)
    if isinstance(now, date):
        return datetime.combine(now, time.min)
    moment = _parse_moment(now)
    if moment is None:
        raise ValueError(f"could not read a date or time from {now!r}")
    return moment


def _parse_moment(value, end_of_day=False):
    """Read a stored deadline or due date into a naive local datetime, or None
    if there isn't one to read.

    Deadlines arrive as a bare "YYYY-MM-DD" from a date input, occasionally as
    a full timestamp from an import. A bare date means the END of that day: a
    task due the 20th may be worked on all through the 20th, and treating it
    as midnight would quietly lose a working day off every deadline in the
    system. Any zone marker is dropped rather than converted, since everything
    in this module is local wall clock (see the module docstring). Unreadable
    values return None -- an odd deadline should make a task undated, not stop
    the whole plan.
    """
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1]
    date_part, _, time_part = text.partition("T")
    if time_part:
        for marker in ("+", "-"):
            cut = time_part.find(marker)
            if cut != -1:
                time_part = time_part[:cut]
        text = f"{date_part}T{time_part}"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if not time_part and end_of_day:
        return moment.replace(hour=23, minute=59, second=59)
    return moment


def _day_floor(date_str):
    return datetime.combine(date.fromisoformat(date_str), time.min)


def _day_ceiling(date_str):
    return datetime.combine(date.fromisoformat(date_str), time(23, 59, 59))


# --- The dependency graph ------------------------------------------------------


def _dependency_graph(by_id):
    """(what each task waits on, what waits on each task), both id-sorted.

    Edges pointing outside the schedulable set -- to a task already done, or
    abandoned, or deleted -- are dropped as already satisfied. A dependency on
    finished work is exactly that, and one on abandoned work must not block
    its dependent forever.
    """
    deps = {tid: [] for tid in by_id}
    dependents = {tid: [] for tid in by_id}
    for edge in db.list_all_task_dependencies():
        task_id, depends_on = edge["task_id"], edge["depends_on_task_id"]
        if task_id not in by_id or depends_on not in by_id:
            continue
        deps[task_id].append(depends_on)
        dependents[depends_on].append(task_id)
    for mapping in (deps, dependents):
        for tid in mapping:
            mapping[tid] = sorted(set(mapping[tid]))
    return deps, dependents


def _topological_order(by_id, deps, dependents):
    """Task ids with every dependency ahead of what depends on it.

    Kahn's algorithm with an id-ordered ready queue, so the order is the same
    every run for the same graph. Anything left over is in a cycle, which is
    an error naming the tasks, never a quietly chosen order.
    """
    waiting = {tid: len(deps[tid]) for tid in by_id}
    ready = sorted(tid for tid, count in waiting.items() if count == 0)
    order = []
    while ready:
        tid = ready.pop(0)
        order.append(tid)
        for dependent in dependents[tid]:
            waiting[dependent] -= 1
            if waiting[dependent] == 0:
                insort(ready, dependent)
    if len(order) < len(by_id):
        _raise_cycle(set(by_id) - set(order), deps)
    return order


def _raise_cycle(stuck, deps):
    """Name the cycle the topological sort ran into, by asking db's existing
    check about an edge that is already there.

    task_dependency_cycle answers "would this edge close a loop?" by walking
    depends_on forward from one end looking for the other. Asked about an edge
    the graph already contains, that is the same question as "is this edge in
    a cycle?", so the check that refuses a bad edge at the point it is added
    is the check that names one here -- one implementation of the walk, not
    two that could disagree.
    """
    for tid in sorted(stuck):
        for depends_on in deps[tid]:
            if depends_on not in stuck:
                continue
            chain = db.task_dependency_cycle(tid, depends_on)
            if chain:
                titles = {t["id"]: t["title"] for t in db.get_tasks_by_ids(chain)}
                raise DependencyCycleError(chain, [titles.get(c, c) for c in chain])
    # Kahn already proved there is one, so this is unreachable in practice --
    # but a cycle that couldn't be named is still a cycle, and refusing to
    # plan matters more than the quality of the message.
    stuck_ids = sorted(stuck)
    titles = {t["id"]: t["title"] for t in db.get_tasks_by_ids(stuck_ids)}
    raise DependencyCycleError(stuck_ids, [titles.get(s, s) for s in stuck_ids])


# --- Deadlines, duration and score ---------------------------------------------


def _est_minutes(task):
    value = task.get("est_minutes")
    if value is None or value <= 0:
        return DEFAULT_EST_MINUTES
    return int(value)


def _level(value, default):
    """A 1-5 rating, defaulted and clamped -- nothing downstream should have
    to wonder whether difficulty 9 is a thing."""
    if value is None:
        return default
    return max(1, min(5, int(value)))


def _own_deadline(task, deliverables):
    """A task's own deadline, or the due date of the deliverable it belongs
    to. A task under a deliverable inherits its date unless it states an
    earlier one of its own -- otherwise every task on a brief would look
    undated while the brief itself has a hand-in date."""
    moment = _parse_moment(task.get("deadline"), end_of_day=True)
    if moment:
        return moment
    deliverable = deliverables.get(task.get("deliverable_id"))
    if deliverable:
        return _parse_moment(deliverable.get("due_at"), end_of_day=True)
    return None


def _horizon_end(today, tasks, deliverables):
    """The last day the walk covers: the FURTHEST deadline in play, not a
    fixed window. A six-week project has to be plannable to its end, or the
    at-risk list cannot tell you in week three that week six is unreachable --
    which is the single most valuable thing it says."""
    furthest = None
    for task in tasks:
        moment = _own_deadline(task, deliverables)
        if moment and (furthest is None or moment > furthest):
            furthest = moment
    floor = today + timedelta(days=DEFAULT_HORIZON_DAYS)
    end = floor if furthest is None else max(furthest.date(), floor)
    return min(end, today + timedelta(days=MAX_HORIZON_DAYS))


def _effective_deadlines(order, by_id, dependents, deliverables, horizon_end):
    """When each task must actually be finished by.

    Two rules on top of its own (or its deliverable's) date:

    A task with no deadline anywhere is treated as due at the end of the
    horizon. It then competes on the same terms as everything else, quietly,
    instead of needing a special "no deadline" case in the scoring.

    A task inherits the earliest deadline of anything that depends on it,
    walking the topological order backwards so a whole chain settles in one
    pass. Without this, an undated prerequisite of an urgent task scores as
    the least urgent thing in the system and sinks to the bottom of the queue
    -- taking the urgent task, which cannot start until it is done, with it.
    """
    horizon_moment = _day_ceiling(horizon_end.isoformat())
    deadlines = {}
    for tid in order:
        deadlines[tid] = _own_deadline(by_id[tid], deliverables) or horizon_moment
    for tid in reversed(order):
        for dependent in dependents[tid]:
            if deadlines[dependent] < deadlines[tid]:
                deadlines[tid] = deadlines[dependent]
    return deadlines


def _critical_minutes(order, dependents, minutes):
    """How much work still has to happen from each task onward: its own
    estimate plus the longest chain of work waiting behind it.

    Slack has to account for everything the deadline covers, not just this
    task. A one-hour task that unblocks four days of sewing has one hour of
    its own duration and four days of commitment sitting behind it, and
    scoring it on the hour alone is how the four days end up starting too
    late. The longest chain rather than the sum of all of them: a diamond in
    the graph would double-count a shared descendant, and the longest path is
    what actually has to fit.
    """
    critical = {}
    for tid in reversed(order):
        downstream = max((critical[d] for d in dependents[tid]), default=0)
        critical[tid] = minutes[tid] + downstream
    return critical


def _work_rate(days):
    """Average working minutes per calendar day across the horizon -- the
    exchange rate between an estimate in work minutes and the calendar time it
    will actually take up. Measured from the real hours and commitments rather
    than assumed, so a three-day working week converts accordingly."""
    if not days:
        return NOMINAL_WORKING_MINUTES_PER_DAY
    rate = sum(d["capacity"] for d in days) / len(days)
    return rate if rate > 0 else NOMINAL_WORKING_MINUTES_PER_DAY


def _slack_minutes(deadline, anchor, work_minutes, rate):
    """Spare calendar time: how long until the deadline, minus how long the
    work behind it will actually occupy.

    URGENCY COMES FROM SLACK, NOT FROM THE DEADLINE, and this is the formula
    that decides it. A task due Friday needing four days is in more trouble
    than one due Thursday needing an hour, and ordering by deadline gets that
    exactly backwards -- which is the most common way a scheduler starts
    feeling wrong.

    The estimate is converted from work minutes into calendar minutes before
    being subtracted (four days of work is not four hours of wall clock).
    Subtracting raw work minutes from a calendar span would flatter every long
    task: five days of sewing inside a fortnight would look like it needed 40
    minutes of the 20,000 available, and would rank as though it had almost
    two weeks spare.
    """
    calendar_minutes_of_work = work_minutes / rate * MINUTES_PER_DAY
    return (deadline - anchor).total_seconds() / 60.0 - calendar_minutes_of_work


def _urgency(slack):
    """Slack turned into a 0-1 pressure. Out of slack (or past it) is 1: there
    is no more urgent state than "this no longer fits". From there it decays
    smoothly with room to spare, halving every SLACK_HALF_LIFE_MINUTES, so
    nothing ever reaches zero and a distant task still eventually gets its
    turn once the pressing work is placed."""
    if slack <= 0:
        return 1.0
    return SLACK_HALF_LIFE_MINUTES / (SLACK_HALF_LIFE_MINUTES + slack)


def _score(task, deadline, critical, anchor, rate):
    """Urgency x importance. Urgency says when it has to happen, importance
    says how much it matters that it does; a task needs both to earn a slot
    ahead of the rest."""
    slack = _slack_minutes(deadline, anchor, critical, rate)
    return _urgency(slack) * _level(task.get("importance"), DEFAULT_IMPORTANCE)


# --- What the walk needs to know about each task ---------------------------------


def _task_meta(tasks, deliverables, minutes, difficulty, deadlines, scores, protected):
    """Everything the walk asks of a task, gathered once.

    A bundle rather than eight parallel dicts threaded through every helper:
    location, support, finishing and the protected window it belongs to are
    all consulted together at each placement, and passing them separately made
    the signatures longer than the bodies.
    """
    meta = {}
    for task in tasks:
        own = _own_deadline(task, deliverables)
        finishing = bool(task.get("is_finishing"))
        meta[task["id"]] = {
            "minutes": minutes[task["id"]],
            "difficulty": difficulty[task["id"]],
            "deadline": deadlines[task["id"]],
            "score": scores[task["id"]],
            "location": task.get("required_location_id") or None,
            "support": task.get("support_level") or INDEPENDENT,
            "finishing": finishing,
            "domestic": bool(task.get("is_domestic")),
            # Only a REAL deadline earns a protected window. An undated task
            # is treated as due at the end of the horizon for scoring, but
            # protecting time before a date nobody set would reserve the far
            # end of the horizon against work that has nowhere else to go.
            "buffer": _span_containing(protected, own) if finishing else None,
            "held": False,
        }
    return meta


def _protected_spans(tasks, deliverables, buffer_minutes):
    """The finishing time reserved before each deadline that has finishing
    work waiting on it.

    ONLY A DEADLINE WITH FINISHING WORK EARNS A PROTECTED WINDOW. The window
    exists to stop finishing work being squeezed; where nothing is flagged
    is_finishing there is nothing to squeeze, and reserving the hours anyway
    would idle the day before every deadline in the system against work that
    does not exist. The flag is the input, and this is what it buys.

    Merged, so two deliverables due the same week produce one protected
    stretch rather than two overlapping ones that would each be measured
    separately and between them reserve the same hours twice.
    """
    if buffer_minutes <= 0:
        return []
    spans = []
    for task in tasks:
        if not task.get("is_finishing"):
            continue
        moment = _own_deadline(task, deliverables)
        if moment:
            spans.append((moment - timedelta(minutes=buffer_minutes), moment))
    return _merge(spans)


def _span_containing(spans, moment):
    if moment is None:
        return None
    return next((s for s in spans if s[0] <= moment <= s[1]), None)


def _finishing_plan(ranked, meta, days, protected, buffer_minutes):
    """Which finishing tasks the walk holds back for their protected window.

    A PROTECTED WINDOW IS ONLY WORTH ANYTHING IF IT GETS USED. The walk is
    greedy and forward-only: it places a finishing task the first moment it
    fits, which is days before the window reserved for it, leaving that window
    empty and the protection pointless. Holding the task back for it is what
    "if the buffer is empty and finishing tasks exist elsewhere, pull them in"
    amounts to in a walk that never revisits its own output.

    Held greedily in score order against the window's real free time, so when
    finishing work overflows the window the most pressing of it gets the
    protected hours and the rest competes for ordinary time like anything
    else -- and says so on the at-risk list if it cannot find any.
    """
    capacity = {}
    for span in protected:
        capacity[span] = sum(
            _interval_minutes(start, end)
            for day in days
            for start, end in _intersect(day["intervals"], [span])
        )
    used = {span: 0 for span in protected}
    held = set()
    for task in ranked:
        info = meta[task["id"]]
        span = info["buffer"]
        if not info["finishing"] or span is None:
            continue
        if used[span] + info["minutes"] <= capacity[span]:
            used[span] += info["minutes"]
            held.add(task["id"])
    return {"held": held, "capacity": capacity, "buffer_minutes": buffer_minutes}


# --- The day walk --------------------------------------------------------------


def _build_days(anchor, horizon_end, location_ids):
    """One record per day from the anchor to the horizon: what is free on it,
    what energy it is expected to carry, when the locations the work needs are
    open, which of its windows come with support, and whether it is close
    enough to be planned to the slot.

    Today is clipped to the anchor. Planning work into hours that have already
    passed is the fastest way to make a schedule look like it isn't paying
    attention.
    """
    days = []
    current = anchor.date()
    while current <= horizon_end:
        date_str = current.isoformat()
        intervals = free_intervals(date_str)
        domestic_intervals = domestic_free_intervals(date_str)
        if current == anchor.date():
            intervals = [(max(start, anchor), end) for start, end in intervals if end > anchor]
            domestic_intervals = [
                (max(start, anchor), end) for start, end in domestic_intervals if end > anchor
            ]
        energy = day_energy(date_str)
        longest = max((_interval_minutes(s, e) for s, e in intervals), default=0)
        days.append({
            "date": date_str,
            "granularity": "slot" if len(days) < SLOT_DETAIL_DAYS else "day",
            "energy": energy,
            "max_difficulty": admissible_difficulty(energy),
            "capacity": sum(_interval_minutes(s, e) for s, e in intervals),
            "longest_interval": longest,
            "intervals": intervals,
            "domestic_intervals": domestic_intervals,
            "location_open": {
                location_id: location_open_intervals(location_id, date_str)
                for location_id in location_ids
            },
            "support": support_windows(date_str),
        })
        current += timedelta(days=1)
    return days


def _leg_table(days, location_ids):
    """Every home-to-place and place-to-place travel time the walk can need,
    priced once. The walk asks for a leg on every candidate placement it tries
    and most of them are rejected, so pricing them on demand would be dozens
    of queries per placed task."""
    places = set(location_ids)
    for day in days:
        for window in day["support"]:
            if window["location_id"]:
                places.add(window["location_id"])
    ends = [HOME] + sorted(places)
    return {(a, b): leg_minutes(a, b) for a in ends for b in ends}


def admissible_difficulty(energy):
    """The hardest work a day of this energy will admit -- the one place the
    energy-to-difficulty mapping is decided (see ENERGY_MAX_DIFFICULTY)."""
    if energy is None:
        energy = BASELINE_ENERGY
    return ENERGY_MAX_DIFFICULTY[max(1, min(5, int(energy)))]


def _eligible_intervals(day, info, protected):
    """The stretches of `day` this task is allowed in, as (intervals, location)
    tiers in the order they should be tried.

    Four constraints narrow the day's free time, and they are different kinds
    of thing:

    REQUIRED LOCATION is hard and has nothing to do with travel cost. Pattern
    cutting cannot happen at home at 22:00 because the studio is shut, not
    because the studio is far away, so the day is intersected with the
    location's opening hours (overrides included) before anything else.

    SUPPORT is a match between two vocabularies, not a comparison. A task says
    what it needs of the people around it; a window says what it offers.

    Only 'needs' makes it a requirement: it yields one tier per priority
    window and nothing else, so work you cannot do unaided is either placed
    against a tutor or reported as unreachable. 'prefers' is a PREFERENCE and
    not a gate -- priority windows first, then ambient ones, then the ordinary
    day -- so the order of the tiers is the whole of its meaning, and a week
    with no session in it still gets the work done rather than declaring it at
    risk. 'independent' yields the whole day as a single tier.

    A supported tier carries the window's location, because a task placed in a
    supported window is where that support is, which is what makes the trip to
    it real. The ordinary-hours fallback carries none: it is not being placed
    anywhere in particular.

    PROTECTED FINISHING TIME is subtracted from everything that isn't finishing
    work, however late that work is running. Being behind is exactly when the
    buffer would get taken, and that is exactly how finishing work gets
    squeezed out -- so this is a hard cut, not a preference.
    """
    base = day["intervals"]
    if info["location"]:
        base = _intersect(base, day["location_open"].get(info["location"], []))
    if info["finishing"]:
        if info["held"] and info["buffer"]:
            base = _intersect(base, [info["buffer"]])
    else:
        base = _subtract(base, protected)
    if not base:
        return []

    if info["support"] == INDEPENDENT:
        return [(base, None)]

    levels = (PRIORITY, AMBIENT) if info["support"] == PREFERS_SUPPORT else (PRIORITY,)
    tiers = []
    for level in levels:
        for location_id, spans in _windows_by_location(day, level):
            # A supported window somewhere else is no use to work that has to
            # happen at the studio; a window with no location recorded is
            # taken to be wherever the task already needs to be.
            if info["location"] and location_id and location_id != info["location"]:
                continue
            tier = _intersect(base, spans)
            if tier:
                tiers.append((tier, location_id))
    if info["support"] == PREFERS_SUPPORT:
        tiers.append((base, None))  # last resort: supported was a preference
    return tiers


def _windows_by_location(day, level):
    """This day's support windows at one level, grouped and merged per
    location so two back-to-back sessions in the same room read as one
    stretch rather than two a task cannot span."""
    grouped = {}
    for window in day["support"]:
        if window["level"] != level:
            continue
        grouped.setdefault(window["location_id"], []).append((window["start"], window["end"]))
    merged = [(location_id, _merge(spans)) for location_id, spans in grouped.items()]
    merged.sort(key=lambda entry: (entry[1][0][0], entry[0] or ""))
    return merged


def _domestic_tiers(day, info, away_remains, protected):
    """Where a domestic task is allowed today, as (intervals, location) tiers
    in the order they should be tried -- see SCHEDULE_SCOPE.md's "Domestic
    tasks" section.

    Domestic hours are always available. Working hours are a FALLBACK tier,
    added only when nothing away from home is left to compete for them
    (`away_remains` is False -- see _away_work_remains). Support isn't
    considered -- domestic work doesn't have a tutor to match -- but
    required_location_id is: a food shop is domestic AND located (see
    SCHEDULE_SCOPE.md's own example), and it can't be placed while that shop
    is shut just because the rest of domestic hours is free.

    A finer rule -- "or the schedule already has you at home for THIS
    stretch" -- reads naturally out of SCHEDULE_SCOPE.md too, but a forward
    greedy walk can't answer it honestly: whether a given morning stays
    home-only depends on where an away-from-home task lands later that same
    day, which isn't decided until it's walked, and domestic work is commonly
    the higher-scoring (nearer-deadline) side of that pair. Gating on the
    whole day being clear is the version that can't be fooled by evaluating
    the domestic task first.

    Protected finishing time is subtracted from both tiers, same rule as
    _eligible_intervals: a domestic task is ordinary work for that purpose,
    never entitled to the buffer.
    """
    domestic = _subtract(day["domestic_intervals"], protected)
    tiers = [(domestic, None)]
    if not away_remains:
        working = _subtract(day["intervals"], protected)
        if working:
            tiers.append((working, None))
    if info["location"]:
        location_open = day["location_open"].get(info["location"], [])
        tiers = [(_intersect(interval, location_open), loc) for interval, loc in tiers]
    return tiers


def _away_work_remains(day, ranked, meta, placements, protected):
    """Whether any unplaced, non-domestic task that needs a location could
    still use this day at all -- energy and location-hours checked, the same
    gates _eligible_intervals applies, but not weighed against what else is
    competing for the day's time.

    Deliberately conservative: the question domestic placement asks is "is
    this day still needed for away-from-home work", not "will it definitely
    get some", and answering the sharper question would mean re-running the
    walk's own contention to answer the walk's own question. Erring towards
    "yes, it's still needed" is the safer default -- it keeps a domestic task
    out of working hours, which is exactly the outcome SCHEDULE_SCOPE.md's
    "stops a food shop being wedged between two studio blocks" describes.
    """
    for task in ranked:
        tid = task["id"]
        if tid in placements:
            continue
        info = meta[tid]
        if info["domestic"] or not info["location"]:
            continue
        if info["difficulty"] > day["max_difficulty"]:
            continue
        if _eligible_intervals(day, info, protected):
            return True
    return False


def _context_before(items, moment):
    """Where you are at `moment`, given what is already placed on the day.

    An item with no location doesn't move you -- writing up notes happens
    wherever you already are -- so the context reads through it to the last
    placement that actually names a place, and home when there is none.
    """
    for item in reversed(items):
        if item["finish"] <= moment and item["location"] is not None:
            return item["location"]
    return HOME


def _day_layout(free, items, legs):
    """The travel the day's placements imply, or None if it doesn't fit.

    Derived from the placements rather than tracked alongside them, and
    rederived from scratch each time one is added, so travel can never fall
    out of step with the work it connects: inserting a task between two others
    replaces the leg that used to join them instead of leaving it stranded.

    Each leg sits immediately before the placement it delivers you to, and the
    day closes with the leg home from wherever you ended up. THE FIRST LEG OF
    A DAY COMES FROM HOME AND THE LAST RETURNS TO IT. Both have to fit inside
    the day's genuinely free time -- travel consumes capacity like anything
    else, which is the whole point of making it visible.
    """
    legs_out = []
    context = HOME
    context_task_id = None
    previous_finish = None
    for item in items:
        minutes = 0 if item["location"] is None else legs[(context, item["location"])]
        if minutes:
            start = item["start"] - timedelta(minutes=minutes)
            if previous_finish is not None and start < previous_finish:
                return None
            if not _contains(free, start, item["start"]):
                return None
            legs_out.append(_leg(item["task_id"], start, item["start"],
                                 context, item["location"], minutes))
        if item["location"] is not None:
            context = item["location"]
            context_task_id = item["task_id"]
        previous_finish = item["finish"]

    if context is not HOME:
        minutes = legs[(context, HOME)]
        if minutes:
            end = previous_finish + timedelta(minutes=minutes)
            if not _contains(free, previous_finish, end):
                return None
            # Attributed to the task that put you at `context`, not
            # necessarily items[-1] -- a break sitting last in the day has no
            # location of its own, so it never becomes the trip home's owner.
            legs_out.append(_leg(context_task_id, previous_finish, end,
                                 context, HOME, minutes))
    return legs_out


def _leg(task_id, start, end, from_location_id, to_location_id, minutes):
    return {
        "task_id": task_id,
        "start": start,
        "end": end,
        "from_location_id": from_location_id,
        "to_location_id": to_location_id,
        "minutes": minutes,
    }


def _try_place(day, items, info, task_id, not_before, legs, protected, away_remains=False):
    """Where this task could go on this day, travel included, or None.

    First fit, not best fit, same as before: the point is to start work as
    early as the day allows, and a best-fit search would leave the morning
    empty to pack an afternoon gap more neatly. What is new is that a fit has
    to survive the whole day being laid out again with the new placement in
    it -- the trip to get there has to fit in front of it, and the trip home
    or on to the next thing has to fit after.

    A domestic task draws its tiers from _domestic_tiers instead of
    _eligible_intervals -- see SCHEDULE_SCOPE.md's "Domestic tasks" section;
    `away_remains` is only consulted there.
    """
    by_day = day["granularity"] == "day"
    deadline = info["deadline"]
    if date.fromisoformat(day["date"]) > deadline.date():
        return None

    duration = timedelta(minutes=info["minutes"])
    occupied = [(item["start"], item["finish"]) for item in items]

    tiers = (
        _domestic_tiers(day, info, away_remains, protected) if info["domestic"]
        else _eligible_intervals(day, info, protected)
    )
    for tier, tier_location in tiers:
        location = info["location"] or tier_location
        for stretch_start, stretch_end in _subtract(tier, occupied):
            travel_in = 0 if location is None else legs[
                (_context_before(items, stretch_start), location)
            ]
            # Two candidate starts: as early as the stretch allows, and far
            # enough in to hold the trip there. The first is usually right --
            # the trip fits in free time before the stretch begins, because a
            # location's opening hours or a tutor's session start later than
            # the working day does -- and the second is the fallback for a
            # stretch that starts where the free time itself does.
            starts = [max(stretch_start, not_before),
                      max(stretch_start + timedelta(minutes=travel_in), not_before)]
            for begin in dict.fromkeys(starts):
                finish = begin + duration
                if finish > stretch_end:
                    continue
                if not by_day and finish > deadline:
                    continue
                candidate = {"task_id": task_id, "start": begin, "finish": finish,
                             "location": location, "kind": "task"}
                merged = sorted(items + [candidate],
                                key=lambda item: (item["start"], item["task_id"] or ""))
                day_legs = _day_layout(day["intervals"], merged, legs)
                if day_legs is None:
                    continue
                return {"start": begin, "finish": finish, "location": location,
                        "items": merged, "legs": day_legs}
    return None


def _uninterrupted_task_minutes_ending_at(items, moment):
    """Minutes of back-to-back TASK work ending exactly at `moment`, walking
    backward through `items` (sorted by start) until something that isn't
    task work -- travel, prep, a commitment's absence being a gap, an
    existing break, or simply not touching -- breaks the run.

    A live counter over the day's actual timeline rather than a lookback
    search: the very first item checked has to touch `moment` by construction
    (it's the block that was just placed), and the loop only continues
    through items that touch the one before them, so nothing here has to ask
    what "interrupted" means for a stretch that was never contiguous.
    """
    total = 0
    cursor = moment
    for item in reversed(items):
        if item["finish"] != cursor or item.get("kind") != "task":
            break
        total += _interval_minutes(item["start"], item["finish"])
        cursor = item["start"]
    return total


def _maybe_insert_break(day, items, legs, meta):
    """If the task just added to `items` pushed this day's run of
    uninterrupted work to BREAK_AFTER_MINUTES or more, insert a BREAK_MINUTES
    break right after it and return the day's travel relaid out around it --
    or None if nothing was inserted.

    `items` arrives already sorted by start -- it's _try_place's own `merged`,
    unchanged since -- so there's nothing to re-sort here.

    The trip home (or on to whatever comes next) has to shift too, since it's
    no longer allowed to start until the break ends -- so this isn't just an
    append: _day_layout is rerun over the candidate day, and the break is only
    kept if that still lays out cleanly. Returns None -- doing nothing --
    if the run is short of the threshold, if there's no room for the break
    itself, or if laying the day out with it fails (the trip home no longer
    fits before the working day closes): a day that runs out of room at
    exactly this point interrupts the run on its own, and forcing a break
    that breaks the day around it would trade one problem for a worse one.

    "Room for the break" is checked against whichever band the run was
    actually running in -- domestic hours if the task it follows is
    is_domestic, working hours otherwise -- not always working hours: a
    domestic task placed in an evening domestic window that has nothing to
    do with the working day still earns a break the same way any other run
    does.
    """
    last = items[-1]
    if last.get("kind") != "task":
        return None
    if _uninterrupted_task_minutes_ending_at(items, last["finish"]) < BREAK_AFTER_MINUTES:
        return None
    free = day["domestic_intervals"] if meta[last["task_id"]]["domestic"] else day["intervals"]
    start = last["finish"]
    end = start + timedelta(minutes=BREAK_MINUTES)
    if not _contains(free, start, end):
        return None
    candidate = items + [{"task_id": None, "start": start, "finish": end, "location": None,
                          "kind": "break"}]
    day_legs = _day_layout(free, candidate, legs)
    if day_legs is None:
        return None
    items.append(candidate[-1])
    return day_legs


def _seed_locked_blocks(day, items, day_legs, locked, meta, legs):
    """Fold this day's locked blocks into `items`/`day_legs` before the
    walk's own placement runs, exactly as if an earlier round of the walk had
    just placed them -- so the greedy loop's own `occupied` check keeps
    everything else off their time, and _day_layout routes the day's other
    travel around wherever they put you.

    Returns (items, day_legs, placed) where placed is [(task_id, start,
    finish)] for the caller to fold into `placements`/`completion`, the same
    bookkeeping the greedy loop itself does after a placement.

    A lock is honoured regardless of whether the day's free time still
    contains it -- that's what "immovable" means (see SCHEDULE_SCOPE.md's
    "Pinning"). Only the travel *around* it is best-effort: if working hours
    have since narrowed enough that _day_layout can no longer lay the day out
    cleanly, the existing `day_legs` are kept rather than dropping the lock
    to make room.
    """
    placed = []
    for block in sorted(locked, key=lambda b: (b["start"], b["id"])):
        tid = block["task_id"]
        info = meta.get(tid)
        if info is None:
            continue  # its task left the schedulable set since the block was locked
        start = datetime.fromisoformat(block["start"])
        finish = datetime.fromisoformat(block["end"])
        candidate = {"task_id": tid, "start": start, "finish": finish,
                     "location": info["location"], "kind": "task"}
        items = sorted(items + [candidate], key=lambda item: (item["start"], item["task_id"] or ""))
        layout = _day_layout(day["intervals"], items, legs)
        if layout is not None:
            day_legs = layout
        placed.append((tid, start, finish))
    return items, day_legs, placed


def _walk(days, ranked, deps, meta, legs, protected, locked_by_date=None,
         no_break_dates=frozenset()):
    """Walk the days forward, filling each with the best work it can take.

    For every day: what is free on it is already known, so the eligible set is
    whatever is still unplaced, whose difficulty the day's energy admits,
    whose dependencies are all finished by the time the new block would start,
    and which has somewhere on the day it is allowed to sit -- a location open
    with the support it needs, outside anyone's protected finishing time (see
    _eligible_intervals). The day is offered round again until nothing else
    can be squeezed in.

    Locked blocks are seeded into each slot-precision day FIRST, before any of
    that -- see _seed_locked_blocks. They are placed, not merely eligible: the
    greedy loop never reconsiders them, and everything else is laid out
    (travel included) around wherever they already sit.

    AMONG ELIGIBLE TASKS OF COMPARABLE SCORE, THE ONE THAT MOVES YOU LEAST
    WINS. A strictly greedy urgency-first walk will send you studio -> shop ->
    studio in a day and split two fabric-shop errands across two days when one
    trip would do, which is the kind of output that makes a scheduler stop
    being believed. So the choice is made over everything within
    COMPARABLE_SCORE_TOLERANCE of the best placeable score, and the winner is
    whichever adds the least travel to the day -- a task at the location you
    are already at adds none -- with rank breaking the tie after that. Only
    tasks not yet placed are considered: nothing already placed is ever pulled
    forward to join a trip, because that would need the walk to reconsider its
    own output.

    A task is never split across days. It is one block or it is at risk --
    which is what makes "this doesn't fit anywhere" a thing the plan can say
    out loud, rather than something hidden by slicing the task into pieces
    that each fit and a total that never happens.

    Dependencies are honoured by comparing times, not positions: a task can
    start the moment the last thing it waits on has finished, later the same
    day if the slot allows. A day-granularity allocation has no time inside
    the day, so it counts as running from the start of the day to the end of
    it -- which comes to the same thing as "the day after", conservatively and
    without a second rule.

    BREAKS are inserted as the walk goes, not retrofitted: after every task
    commit on a slot-precision day (see BREAK_AFTER_MINUTES), a break is
    appended to that day's items if the run just crossed the threshold and
    there's room right there (_maybe_insert_break) -- so later placements in
    the SAME day see it as occupied and schedule around it exactly like a
    task or a trip. `no_break_dates` suppresses this for specific dates: plan()
    retries a day without breaks when keeping them would cost something on
    the at-risk list, and this is how that retry asks for a clean pass.
    """
    placements = {}
    completion = {}
    travel = []
    breaks = []
    break_dates = set()
    # _away_work_remains only ever matters to a domestic task's own tiering
    # (see _domestic_tiers) -- skip computing it every round of every day when
    # there's no domestic task in the plan at all, which is every plan until
    # someone flags one.
    any_domestic = any(info["domestic"] for info in meta.values())
    for day in days:
        floor, ceiling = _day_floor(day["date"]), _day_ceiling(day["date"])
        by_day = day["granularity"] == "day"
        allow_breaks = not by_day and day["date"] not in no_break_dates
        items, day_legs = [], []
        if not by_day and locked_by_date and day["date"] in locked_by_date:
            items, day_legs, seeded = _seed_locked_blocks(
                day, items, day_legs, locked_by_date[day["date"]], meta, legs
            )
            for tid, start, finish in seeded:
                placements[tid] = {
                    "date": day["date"],
                    "granularity": day["granularity"],
                    "start": start.isoformat(),
                    "end": finish.isoformat(),
                    "minutes": meta[tid]["minutes"],
                    "location_id": meta[tid]["location"],
                    "locked": True,
                }
                completion[tid] = finish
        while True:
            away_remains = (
                _away_work_remains(day, ranked, meta, placements, protected)
                if any_domestic else False
            )
            candidates = []
            best_score = None
            for rank, task in enumerate(ranked):  # score order, ties by id
                tid = task["id"]
                if tid in placements:
                    continue
                info = meta[tid]
                # ranked is score-descending, so once something placeable has
                # been found, anything scoring materially below it can no
                # longer win the tie-break and nor can anything after it.
                if best_score is not None and best_score - info["score"] > COMPARABLE_SCORE_TOLERANCE:
                    break
                if info["difficulty"] > day["max_difficulty"]:
                    continue
                if any(dep not in completion for dep in deps[tid]):
                    continue

                last_dependency = max([floor] + [completion[dep] for dep in deps[tid]])
                if by_day and last_dependency > floor:
                    continue  # the day IS the block, so its dependencies had to end before it
                not_before = floor if by_day else last_dependency

                attempt = _try_place(day, items, info, tid, not_before, legs, protected,
                                     away_remains=away_remains)
                if attempt is None:
                    continue
                if best_score is None:
                    best_score = info["score"]
                candidates.append((rank, tid, attempt))

            if not candidates:
                break
            travelled = sum(leg["minutes"] for leg in day_legs)
            rank, tid, attempt = min(
                candidates,
                key=lambda c: (sum(leg["minutes"] for leg in c[2]["legs"]) - travelled, c[0]),
            )
            items, day_legs = attempt["items"], attempt["legs"]
            placements[tid] = {
                "date": day["date"],
                "granularity": day["granularity"],
                "start": day["date"] if by_day else attempt["start"].isoformat(),
                "end": day["date"] if by_day else attempt["finish"].isoformat(),
                "minutes": meta[tid]["minutes"],
                "location_id": attempt["location"],
            }
            completion[tid] = ceiling if by_day else attempt["finish"]
            if allow_breaks:
                new_day_legs = _maybe_insert_break(day, items, legs, meta)
                if new_day_legs is not None:
                    day_legs = new_day_legs
                    break_dates.add(day["date"])
        for leg in day_legs:
            leg["granularity"] = day["granularity"]
            leg["date"] = day["date"]
        travel.extend(day_legs)
        for item in items:
            if item.get("kind") == "break":
                breaks.append({**item, "granularity": day["granularity"], "date": day["date"]})
    return placements, travel, breaks, break_dates


def _blocks(placements, travel, breaks, chain_blocks):
    """The plan's blocks, in the order they happen.

    A day-granularity block carries the date alone in start and end, with no
    time of day -- the honest shape for "this task, that day, no promise about
    when". It sorts correctly against timed blocks either way, since
    "2026-03-15" precedes "2026-03-15T09:00:00" as a string, and it is what
    a caller tests to tell the two apart (see block_granularity).

    TRAVEL, BREAKS AND HOME-FIRST CHAIN BLOCKS ARE EMITTED ONLY WHERE THERE IS
    A TIME OF DAY TO EMIT THEM AT. On the near days a leg (or a break, or a
    prep block) is a real row with a real start and end, visible in the
    calendar, so a day that is full because of three trips -- or a rest, or
    getting ready to go out -- looks full and says why. Further out, where a
    task itself only claims a date, none of these were even computed for that
    day (breaks and chain blocks aren't inserted past slot precision; see
    BREAK_AFTER_MINUTES and the caller for why chain_blocks is pre-filtered),
    so there's nothing here to skip the way travel's own check still has to.
    """
    rows = []
    for tid, placement in placements.items():
        rows.append({
            "id": _block_id(tid, placement["start"], placement["end"]),
            "task_id": tid,
            "commitment_id": None,
            "start": placement["start"],
            "end": placement["end"],
            "kind": "task",
            "is_locked": placement.get("locked", False),
            "granularity": placement["granularity"],
            "minutes": placement["minutes"],
            "location_id": placement["location_id"],
        })
    for leg in travel:
        if leg["granularity"] != "slot":
            continue
        start, end = leg["start"].isoformat(), leg["end"].isoformat()
        rows.append({
            "id": _block_id(leg["task_id"], start, end, kind="travel"),
            "task_id": leg["task_id"],
            "commitment_id": None,
            "start": start,
            "end": end,
            "kind": "travel",
            "is_locked": False,
            "granularity": "slot",
            "minutes": leg["minutes"],
            "from_location_id": leg["from_location_id"],
            "to_location_id": leg["to_location_id"],
        })
    for br in breaks:
        start, end = br["start"].isoformat(), br["finish"].isoformat()
        rows.append({
            "id": _block_id(None, start, end, kind="break"),
            "task_id": None,
            "commitment_id": None,
            "start": start,
            "end": end,
            "kind": "break",
            "is_locked": False,
            "granularity": "slot",
            "minutes": BREAK_MINUTES,
        })
    for block in chain_blocks:
        start, end = block["start"].isoformat(), block["end"].isoformat()
        rows.append({
            "id": _block_id(block["commitment_id"], start, end, kind=block["kind"]),
            "task_id": None,
            "commitment_id": block["commitment_id"],
            "start": start,
            "end": end,
            "kind": block["kind"],
            "is_locked": False,
            "granularity": "slot",
            "minutes": _interval_minutes(block["start"], block["end"]),
            "from_location_id": block["from_location_id"],
            "to_location_id": block["to_location_id"],
        })
    rows.sort(key=lambda b: (b["start"], b["kind"], b["task_id"] or ""))
    return rows


def _block_id(task_id, start, end, kind="task"):
    """Derived from what the block is, not drawn from uuid4. Two runs over
    unchanged data have to produce byte-identical output, and it means a
    placement that did not move keeps its id across replans -- so what changed
    between two plans is something a caller can actually see.

    Only a non-task kind is named in the material, so a task block's id is the
    same value it was before travel blocks existed and an unmoved block keeps
    its id across the change.
    """
    material = f"{task_id}|{start}|{end}"
    if kind != "task":
        material = f"{kind}|{material}"
    return hashlib.blake2b(material.encode("utf-8"), digest_size=16).hexdigest()


def block_granularity(block):
    """"slot" if this block promises a time of day, "day" if it only claims a
    date. Stored blocks carry no granularity column -- the shape of start is
    the fact itself."""
    return "slot" if "T" in (block.get("start") or "") else "day"


# --- At risk --------------------------------------------------------------------


def _at_risk(tasks, placements, deps, meta, days, deliverables, anchor, protected, finishing,
             legs):
    """Everything that could not be placed before its deadline, and why.

    THIS IS THE POINT. A plan that quietly drops what it cannot fit is worse
    than no plan: being told in week three that Part 2 is unreachable is worth
    more than any amount of clever packing in weeks one and two. So this is a
    first-class return value, one entry per task, each with a reason a person
    can act on -- and the reasons are checked in a fixed order, most
    fundamental first, so the same failure always reports the same cause.

    "No priority window before the deadline" and "no time before the deadline"
    are deliberately different answers. The first is fixed by asking for a
    session; the second by moving a deadline or dropping something. Reporting
    both as "it didn't fit" would hide which.
    """
    entries = []
    for task in tasks:  # id-sorted, so the list is stable run to run
        tid = task["id"]
        if tid in placements:
            continue
        info = meta[tid]
        deadline = info["deadline"]
        window = [d for d in days if date.fromisoformat(d["date"]) <= deadline.date()]
        workable = [d for d in window if d["capacity"] > 0]
        admitting = [d for d in workable if info["difficulty"] <= d["max_difficulty"]]
        blocked_by = [dep for dep in deps[tid] if dep not in placements]

        open_days = [
            d for d in admitting
            if _intersect(d["intervals"], d["location_open"].get(info["location"], []))
        ]
        # Only 'needs' can fail for want of support: 'prefers' falls back to
        # ordinary hours, so a week without a tutor delays that work at worst.
        unsupported = info["support"] == NEEDS_SUPPORT and not any(
            _has_priority_window(d, info) for d in admitting
        )
        # The stretches this task could genuinely have used, every constraint
        # applied -- so "needs longer in one sitting than it can get" is
        # measured against the windows it was allowed in, not against a free
        # afternoon it was never eligible for.
        eligible = [
            span
            for d in admitting
            for tier, _location in _eligible_intervals(d, info, protected)
            for span in tier
        ]
        longest = max((_interval_minutes(s, e) for s, e in eligible), default=0)
        # The cheapest trip that could ever include this task: out from home
        # and back again. Work at a location cannot have the whole stretch,
        # and a day that looks long enough until the travel is paid for should
        # say so rather than fall through to "everything was already full".
        # A lower bound, since a task sharing a trip with another at the same
        # location pays less -- but this is only ever reached for a task that
        # already failed to be placed, so it picks the wording, not the verdict.
        round_trip = 0
        if info["location"]:
            round_trip = legs[(HOME, info["location"])] + legs[(info["location"], HOME)]

        if deadline < anchor:
            reason = AT_RISK_OVERDUE
            message = f"its deadline ({deadline.date().isoformat()}) has already passed"
        elif blocked_by:
            names = ", ".join(_title(dep, tasks) for dep in blocked_by)
            reason = AT_RISK_BLOCKED
            message = f"waiting on work that could not be placed either: {names}"
        elif not workable:
            reason = AT_RISK_NO_CAPACITY
            message = "there are no working hours at all before its deadline"
        elif not admitting:
            reason = AT_RISK_ENERGY
            message = (
                f"no day before its deadline has the energy for difficulty {info['difficulty']}"
            )
        elif info["location"] and not open_days:
            reason = AT_RISK_LOCATION
            message = (
                f"{_location_name(info['location'])} is not open during any working hours "
                "before its deadline"
            )
        elif unsupported:
            reason = AT_RISK_NO_SUPPORT
            message = "it needs a priority session and there is none before its deadline"
        elif info["finishing"] and info["buffer"]:
            reason = AT_RISK_FINISHING
            message = _finishing_message(tid, info, finishing)
        elif info["minutes"] + round_trip > longest:
            reason = AT_RISK_TOO_LONG
            needed = _hours(info["minutes"])
            if round_trip:
                needed = f"{needed} in one sitting plus {_hours(round_trip)} getting there and back"
            else:
                needed = f"{needed} in one sitting"
            message = (
                f"needs {needed}; the longest stretch it is allowed in before its deadline "
                f"is {_hours(longest)}"
            )
        else:
            reason = AT_RISK_NO_CAPACITY
            message = "every day that could have taken it was already full"

        deliverable = deliverables.get(task.get("deliverable_id"))
        entries.append({
            "task_id": tid,
            "title": task["title"],
            "reason": reason,
            "message": message,
            "est_minutes": info["minutes"],
            "difficulty": info["difficulty"],
            "importance": _level(task.get("importance"), DEFAULT_IMPORTANCE),
            "deadline": task.get("deadline"),
            "effective_deadline": deadline.isoformat(),
            "required_location_id": info["location"],
            "support_level": info["support"],
            "is_finishing": info["finishing"],
            "project_id": task.get("project_id"),
            "deliverable_id": task.get("deliverable_id"),
            "deliverable_title": deliverable["title"] if deliverable else None,
        })
    # Built in id order so the CONTENT is stable, reported in deadline order
    # because that is the order someone has to act in -- ties still broken by
    # id, so the list itself stays stable run to run.
    entries.sort(key=lambda e: (e["effective_deadline"], e["task_id"]))
    return entries


def _has_priority_window(day, info):
    """Whether this day offers a tutor to a task that cannot proceed without
    one -- counting only the part of a window that is free to work in, and
    only windows somewhere the task is allowed to be."""
    for window in day["support"]:
        if window["level"] != PRIORITY:
            continue
        if info["location"] and window["location_id"] and window["location_id"] != info["location"]:
            continue
        if _intersect(day["intervals"], [(window["start"], window["end"])]):
            return True
    return False


def _finishing_message(task_id, info, finishing):
    """Why the protected finishing window could not take this task.

    Two different failures, and the fix differs: the window is full of other
    finishing work, or the window is not long enough for this task at all.
    """
    available = finishing["capacity"].get(info["buffer"], 0)
    if task_id in finishing["held"]:
        return (
            f"the {_hours(available)} of protected finishing time before its deadline "
            "could not take it"
        )
    return (
        f"the finishing work due then needs more than the {_hours(available)} protected "
        "before the deadline"
    )


def _location_name(location_id):
    location = db.get_location(location_id) or {}
    return location.get("name") or location_id


def _at_risk_by_deliverable(at_risk, tasks, deliverables):
    """The same risk aggregated per deliverable -- "three of the six tasks for
    Part 2 don't fit" is the sentence that makes someone act, where six
    separate task warnings scroll past.

    Tasks with no deliverable appear in the per-task list only; there is
    nothing to aggregate them onto, and inventing a bucket would put standalone
    errands next to coursework."""
    totals = {}
    for task in tasks:
        if task.get("deliverable_id"):
            totals[task["deliverable_id"]] = totals.get(task["deliverable_id"], 0) + 1

    grouped = {}
    for entry in at_risk:
        deliverable_id = entry["deliverable_id"]
        if not deliverable_id:
            continue
        bucket = grouped.setdefault(deliverable_id, {"task_ids": [], "minutes": 0})
        bucket["task_ids"].append(entry["task_id"])
        bucket["minutes"] += entry["est_minutes"]

    rows = []
    for deliverable_id, bucket in grouped.items():
        deliverable = deliverables.get(deliverable_id) or {}
        rows.append({
            "deliverable_id": deliverable_id,
            "title": deliverable.get("title"),
            "project_id": deliverable.get("project_id"),
            "due_at": deliverable.get("due_at"),
            "at_risk_tasks": len(bucket["task_ids"]),
            "total_tasks": totals.get(deliverable_id, 0),
            "at_risk_minutes": bucket["minutes"],
            "task_ids": bucket["task_ids"],
        })
    # Soonest due first, and by id where two share a date -- the order someone
    # reading the list would put them in themselves.
    rows.sort(key=lambda r: (r["due_at"] or "9999-12-31", r["deliverable_id"]))
    return rows


def _chronically_slipping(tasks):
    """Every still-outstanding task that has slipped CHRONIC_SLIP_THRESHOLD
    times or more -- highest slip_count first, ties by id, so the worst
    offender always leads. Not filtered by at-risk status: a task can be
    placed cleanly this run and still be the one that keeps getting bumped
    plan after plan, and that pattern is exactly what this surfaces (see
    SCHEDULE_SCOPE.md's "three outcomes")."""
    rows = [
        {
            "task_id": task["id"],
            "title": task["title"],
            "slip_count": task["slip_count"],
            "project_id": task.get("project_id"),
            "deliverable_id": task.get("deliverable_id"),
        }
        for task in tasks
        if task.get("slip_count", 0) >= CHRONIC_SLIP_THRESHOLD
    ]
    rows.sort(key=lambda r: (-r["slip_count"], r["task_id"]))
    return rows


def _title(task_id, tasks):
    for task in tasks:
        if task["id"] == task_id:
            return task["title"]
    return task_id


def _hours(minutes):
    """Minutes as something readable in a sentence -- "2h 30m", not "150"."""
    hours, rest = divmod(int(minutes), 60)
    if hours and rest:
        return f"{hours}h {rest}m"
    if hours:
        return f"{hours}h"
    return f"{rest}m"
