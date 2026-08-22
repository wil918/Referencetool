"""The scheduler, and the helpers it stands on.

Two layers live here. The first sits on top of the locations and commitments
data in db.py -- travel_minutes, and daily capacity (free_intervals,
available_minutes, inferred energy). The second is the scheduler proper:
plan() turns tasks, deadlines, commitments and capacity into placed blocks
and an at-risk list, and replan() commits that plan to scheduled_blocks.

Every date this module takes or returns is a "YYYY-MM-DD" string, and every
datetime is the naive local-wall-clock form commitments.start/end are stored
in (see COMMITMENTS_SCHEMA in db.py, and ics_import.py's module docstring for
why that's the form that survives a DST change without drifting).
"""
import hashlib
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


def free_intervals(date_str):
    """The stretches of `date_str` that are genuinely free for work: that
    weekday's working-hours window with every commitment cut out of it, as a
    list of (start, end) naive datetimes in order.

    A commitment outside the window doesn't subtract anything -- it was never
    available time to begin with -- and one that only partially overlaps only
    costs the overlapping part. No working-hours row for that weekday (a day
    off, by omission -- see WORKING_HOURS_SCHEMA) means no intervals at all,
    same as an empty window.

    Overlapping commitments are cut out as one span rather than one at a
    time. A lunch inside a studio session is a single busy stretch, and
    charging the day for both would under-report it.
    """
    weekday = date.fromisoformat(date_str).weekday()
    hours = next((h for h in db.get_working_hours() if h["weekday"] == weekday), None)
    if not hours or not hours["opens"] or not hours["closes"]:
        return []

    window_start = datetime.fromisoformat(f"{date_str}T{hours['opens']}:00")
    window_end = datetime.fromisoformat(f"{date_str}T{hours['closes']}:00")
    if window_end <= window_start:
        return []

    busy = []
    for commitment in db.list_commitments_between(window_start.isoformat(), window_end.isoformat()):
        overlap_start = max(datetime.fromisoformat(commitment["start"]), window_start)
        overlap_end = min(datetime.fromisoformat(commitment["end"]), window_end)
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
# plan() is PURE: it reads tasks, dependencies, deadlines, commitments, hours
# and capacity, and returns a plan. It writes nothing. replan() is what
# commits that plan to scheduled_blocks. The split is what makes the
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

# Why a task could not be placed before its deadline. Codes rather than prose
# so a UI can style them; every at-risk entry carries a written message too.
AT_RISK_OVERDUE = "overdue"
AT_RISK_BLOCKED = "blocked"
AT_RISK_ENERGY = "energy"
AT_RISK_TOO_LONG = "too_long"
AT_RISK_NO_CAPACITY = "no_capacity"


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


def plan(now=None):
    """Work out where everything outstanding goes between now and the
    furthest deadline in play, and what cannot be reached at all.

    `now` anchors the walk: a datetime, a "YYYY-MM-DD" string, or a date (both
    of the latter meaning the start of that day). It defaults to the actual
    current time, and today's already-passed hours are never planned into.
    Tests pass it explicitly, which is what makes the whole thing reproducible
    offline.

    Returns the plan; writes nothing. See replan() to commit it.
    """
    anchor = _anchor(now)
    today = anchor.date()

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
    days = _build_days(anchor, horizon_end)

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

    placements = _walk(days, ranked, deps, deadlines, minutes, difficulty)
    at_risk = _at_risk(tasks, placements, deps, deadlines, minutes, difficulty, days,
                       deliverables, anchor)
    blocks = _blocks(placements)

    slot_days = [d for d in days if d["granularity"] == "slot"]
    return {
        "anchor": anchor.isoformat(),
        "today": today.isoformat(),
        "horizon_end": horizon_end.isoformat(),
        "slot_detail_until": slot_days[-1]["date"] if slot_days else today.isoformat(),
        "blocks": blocks,
        "at_risk": at_risk,
        "at_risk_by_deliverable": _at_risk_by_deliverable(at_risk, tasks, deliverables),
        "summary": {
            "tasks": len(tasks),
            "placed": len(placements),
            "at_risk": len(at_risk),
            "planned_minutes": sum(b["minutes"] for b in blocks),
            "capacity_minutes": sum(d["capacity"] for d in days),
        },
    }


def replan(now=None):
    """Run the scheduler and replace scheduled_blocks with its output.

    Wholesale, not a merge: the blocks table is the plan, and a plan that
    kept fragments of an older one would drift out of step with the tasks it
    claims to place. Task rows are untouched -- blocks are the only output.
    """
    result = plan(now)
    db.replace_scheduled_blocks(result["blocks"])
    return result


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


# --- The day walk --------------------------------------------------------------


def _build_days(anchor, horizon_end):
    """One record per day from the anchor to the horizon: what is free on it,
    what energy it is expected to carry, and whether it is close enough to be
    planned to the slot.

    Today is clipped to the anchor. Planning work into hours that have already
    passed is the fastest way to make a schedule look like it isn't paying
    attention.
    """
    days = []
    current = anchor.date()
    while current <= horizon_end:
        date_str = current.isoformat()
        intervals = free_intervals(date_str)
        if current == anchor.date():
            intervals = [(max(start, anchor), end) for start, end in intervals if end > anchor]
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
        })
        current += timedelta(days=1)
    return days


def admissible_difficulty(energy):
    """The hardest work a day of this energy will admit -- the one place the
    energy-to-difficulty mapping is decided (see ENERGY_MAX_DIFFICULTY)."""
    if energy is None:
        energy = BASELINE_ENERGY
    return ENERGY_MAX_DIFFICULTY[max(1, min(5, int(energy)))]


def _first_fit(intervals, minutes, not_before):
    """(index, start) of the first free stretch that can hold `minutes` at or
    after `not_before`, or None. First fit, not best fit: the point is to
    start work as early as the day allows, and a best-fit search would leave
    the morning empty to pack an afternoon gap more neatly."""
    needed = timedelta(minutes=minutes)
    for index, (start, end) in enumerate(intervals):
        begin = max(start, not_before)
        if end - begin >= needed:
            return index, begin
    return None


def _consume(intervals, index, start, minutes):
    """Take `minutes` out of one free stretch from `start`, leaving whatever
    is still free either side of it."""
    stretch_start, stretch_end = intervals[index]
    finish = start + timedelta(minutes=minutes)
    remainder = []
    if start > stretch_start:
        remainder.append((stretch_start, start))
    if finish < stretch_end:
        remainder.append((finish, stretch_end))
    intervals[index:index + 1] = remainder
    return finish


def _walk(days, ranked, deps, deadlines, minutes, difficulty):
    """Walk the days forward, filling each with the best work it can take.

    For every day: what is free on it is already known, so the eligible set is
    whatever is still unplaced, whose difficulty the day's energy admits, and
    whose dependencies are all finished by the time the new block would start.
    The highest-scoring eligible task takes the first slot that fits, and the
    day is offered round again until nothing else can be squeezed in.

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
    """
    placements = {}
    completion = {}
    for day in days:
        day_date = date.fromisoformat(day["date"])
        floor, ceiling = _day_floor(day["date"]), _day_ceiling(day["date"])
        by_day = day["granularity"] == "day"
        intervals = day["intervals"]
        while True:
            placed = False
            for task in ranked:
                tid = task["id"]
                if tid in placements:
                    continue
                if difficulty[tid] > day["max_difficulty"]:
                    continue
                if any(dep not in completion for dep in deps[tid]):
                    continue

                last_dependency = max([floor] + [completion[dep] for dep in deps[tid]])
                if by_day and last_dependency > floor:
                    continue  # the day IS the block, so its dependencies had to end before it
                not_before = floor if by_day else last_dependency

                fit = _first_fit(intervals, minutes[tid], not_before)
                if fit is None:
                    continue
                index, start = fit
                finish = start + timedelta(minutes=minutes[tid])
                if day_date > deadlines[tid].date() or (not by_day and finish > deadlines[tid]):
                    continue

                _consume(intervals, index, start, minutes[tid])
                placements[tid] = {
                    "date": day["date"],
                    "granularity": day["granularity"],
                    "start": day["date"] if by_day else start.isoformat(),
                    "end": day["date"] if by_day else finish.isoformat(),
                    "minutes": minutes[tid],
                }
                completion[tid] = ceiling if by_day else finish
                placed = True
                break
            if not placed:
                break
    return placements


def _blocks(placements):
    """The plan's blocks, in the order they happen.

    A day-granularity block carries the date alone in start and end, with no
    time of day -- the honest shape for "this task, that day, no promise about
    when". It sorts correctly against timed blocks either way, since
    "2026-03-15" precedes "2026-03-15T09:00:00" as a string, and it is what
    a caller tests to tell the two apart (see block_granularity).
    """
    rows = []
    for tid, placement in sorted(placements.items(), key=lambda kv: (kv[1]["start"], kv[0])):
        rows.append({
            "id": _block_id(tid, placement["start"], placement["end"]),
            "task_id": tid,
            "start": placement["start"],
            "end": placement["end"],
            "kind": "task",
            "is_locked": False,
            "granularity": placement["granularity"],
            "minutes": placement["minutes"],
        })
    return rows


def _block_id(task_id, start, end):
    """Derived from what the block is, not drawn from uuid4. Two runs over
    unchanged data have to produce byte-identical output, and it means a
    placement that did not move keeps its id across replans -- so what changed
    between two plans is something a caller can actually see."""
    material = f"{task_id}|{start}|{end}".encode("utf-8")
    return hashlib.blake2b(material, digest_size=16).hexdigest()


def block_granularity(block):
    """"slot" if this block promises a time of day, "day" if it only claims a
    date. Stored blocks carry no granularity column -- the shape of start is
    the fact itself."""
    return "slot" if "T" in (block.get("start") or "") else "day"


# --- At risk --------------------------------------------------------------------


def _at_risk(tasks, placements, deps, deadlines, minutes, difficulty, days, deliverables,
             anchor):
    """Everything that could not be placed before its deadline, and why.

    THIS IS THE POINT. A plan that quietly drops what it cannot fit is worse
    than no plan: being told in week three that Part 2 is unreachable is worth
    more than any amount of clever packing in weeks one and two. So this is a
    first-class return value, one entry per task, each with a reason a person
    can act on -- and the reasons are checked in a fixed order, most
    fundamental first, so the same failure always reports the same cause.
    """
    entries = []
    for task in tasks:  # id-sorted, so the list is stable run to run
        tid = task["id"]
        if tid in placements:
            continue
        deadline = deadlines[tid]
        window = [d for d in days if date.fromisoformat(d["date"]) <= deadline.date()]
        workable = [d for d in window if d["capacity"] > 0]
        admitting = [d for d in workable if difficulty[tid] <= d["max_difficulty"]]
        blocked_by = [dep for dep in deps[tid] if dep not in placements]
        longest = max((d["longest_interval"] for d in admitting), default=0)

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
                f"no day before its deadline has the energy for difficulty {difficulty[tid]}"
            )
        elif minutes[tid] > longest:
            reason = AT_RISK_TOO_LONG
            message = (
                f"needs {_hours(minutes[tid])} in one sitting; the longest free stretch on "
                f"any usable day before its deadline is {_hours(longest)}"
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
            "est_minutes": minutes[tid],
            "difficulty": difficulty[tid],
            "importance": _level(task.get("importance"), DEFAULT_IMPORTANCE),
            "deadline": task.get("deadline"),
            "effective_deadline": deadline.isoformat(),
            "project_id": task.get("project_id"),
            "deliverable_id": task.get("deliverable_id"),
            "deliverable_title": deliverable["title"] if deliverable else None,
        })
    # Built in id order so the CONTENT is stable, reported in deadline order
    # because that is the order someone has to act in -- ties still broken by
    # id, so the list itself stays stable run to run.
    entries.sort(key=lambda e: (e["effective_deadline"], e["task_id"]))
    return entries


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
