"""Sync commitments from an ICS calendar feed -- an uploaded .ics file or a
feed URL.

Timezones: commitments.start/end are stored the same way as every other
timestamp in this app -- a naive "YYYY-MM-DDTHH:MM:SS" string holding LOCAL
WALL-CLOCK time, no offset (see COMMITMENTS_SCHEMA in db.py). A tz-aware
event time from the feed (a TZID, or UTC via a trailing "Z") is converted
with astimezone() to config.LOCAL_TIMEZONE *before* the offset is discarded,
so the wall-clock hour is right on both sides of a DST change -- a fixed
offset applied once would instead drift by an hour after the clocks change.
A floating (timezone-less) event time is RFC 5545 "local time for the
observer", which for a single-user local app already is local, so it's used
as-is. An all-day date becomes local midnight.

Recurring events (RRULE) are expanded to one commitment row per occurrence.
Instances of the same UID are told apart the RFC 5545 way, via
RECURRENCE-ID: recurring_ical_events sets one on every occurrence it
generates (even a plain single event, mirroring its own DTSTART), so a
genuinely non-recurring event deliberately keeps a bare external_uid --
see _external_uid -- meaning if it's later moved in the feed, the same local
row is updated rather than the old one being orphaned and a new one created.

A sync never touches support_level, location_id or energy_cost on a row it
updates -- those are the user's classification of a commitment (see app.py's
commitment routes) and the feed has no opinion on them.
"""
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import icalendar
import recurring_ical_events

import db
from config import LOCAL_TIMEZONE

LOCAL_ZONE = ZoneInfo(LOCAL_TIMEZONE)

# How far around "today" a feed is expanded when syncing -- wide enough to
# cover a term's timetable in both directions. An RRULE with no UNTIL/COUNT
# would otherwise expand forever.
IMPORT_WINDOW_PAST_DAYS = 90
IMPORT_WINDOW_FUTURE_DAYS = 365


class FeedFetchError(Exception):
    """A feed URL couldn't be fetched."""


class InvalidICSError(Exception):
    """The given bytes aren't a parseable .ics calendar."""


def fetch_feed(url):
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            return response.read().decode("utf-8")
    except (urllib.error.URLError, UnicodeDecodeError, TimeoutError, ValueError) as e:
        raise FeedFetchError(f"could not fetch feed: {e}") from e


def _to_local_naive(value):
    """Collapse an icalendar DTSTART/DTEND value to this app's naive
    local-wall-clock storage form -- see the module docstring."""
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(LOCAL_ZONE)
        return value.replace(tzinfo=None)
    return datetime(value.year, value.month, value.day)


def _recurring_uids(calendar):
    """UIDs of components that are genuinely recurring in the source feed
    (RRULE or RDATE present) -- see _external_uid for why this has to be
    read from the original components, not from whether an expanded
    occurrence happens to carry a RECURRENCE-ID."""
    return {
        str(component.get("UID"))
        for component in calendar.walk("VEVENT")
        if component.get("UID") and ("RRULE" in component or "RDATE" in component)
    }


def _external_uid(uid, recurrence_id, recurring_uids):
    if uid in recurring_uids and recurrence_id is not None:
        return f"{uid}#{_to_local_naive(recurrence_id.dt).isoformat()}"
    return uid


def parse_events(ics_text, window_start=None, window_days=None):
    """Every occurrence in the window -- including each instance of a
    recurring series -- plus how many events the file actually defines, so a
    sync that places nothing can say why instead of just reporting a zero
    that reads the same whether the feed was empty or the parser missed
    everything.

    Returns {"events": [...], "events_found", "window_start", "window_end"}.
    Each item in `events` is {external_uid, title, start, end}, start/end
    already collapsed to local naive ISO strings. events_found counts VEVENT
    *components* in the file -- distinct calendar entries, including a
    recurring series's own override components -- not occurrences: for an
    RRULE with no UNTIL/COUNT, occurrences are unbounded and wouldn't say
    anything meaningful about whether the file parsed sensibly. window_start
    and window_end are date objects.
    """
    try:
        calendar = icalendar.Calendar.from_ical(ics_text)
    except (ValueError, IndexError) as e:
        raise InvalidICSError(f"not a valid .ics file: {e}") from e

    window_start = window_start or (date.today() - timedelta(days=IMPORT_WINDOW_PAST_DAYS))
    window_days = window_days or (IMPORT_WINDOW_PAST_DAYS + IMPORT_WINDOW_FUTURE_DAYS)
    window_end = window_start + timedelta(days=window_days)
    recurring_uids = _recurring_uids(calendar)
    events_found = len(calendar.walk("VEVENT"))

    events = []
    for occurrence in recurring_ical_events.of(calendar).between(window_start, window_end):
        uid = str(occurrence.get("UID") or "")
        if not uid:
            continue
        start = _to_local_naive(occurrence["DTSTART"].dt)
        dtend = occurrence.get("DTEND")
        end = _to_local_naive(dtend.dt) if dtend else start
        events.append({
            "external_uid": _external_uid(uid, occurrence.get("RECURRENCE-ID"), recurring_uids),
            "title": str(occurrence.get("SUMMARY") or "Untitled"),
            "start": start.isoformat(),
            "end": end.isoformat(),
        })
    return {
        "events": events,
        "events_found": events_found,
        "window_start": window_start,
        "window_end": window_end,
    }


def sync_feed(source, ics_text, window_start=None, window_days=None):
    """Upsert every event from this feed into commitments, scoped to
    `source` (the feed URL, or the label/filename an upload was given).

    An existing row matches by external_uid and gets title/start/end
    refreshed -- never support_level/location_id/energy_cost, see the module
    docstring. A new one is inserted with support_level defaulted to 'none'
    per COMMITMENTS_SCHEMA, ready for the bulk reclassify route. Anything
    previously imported from this source that the feed no longer contains is
    deleted, so an upstream cancellation removes it here too.
    """
    parsed = parse_events(ics_text, window_start, window_days)
    events = parsed["events"]

    seen_uids = set()
    created = updated = 0
    for event in events:
        seen_uids.add(event["external_uid"])
        existing = db.get_commitment_by_external_uid(event["external_uid"])
        if existing:
            db.update_commitment(
                existing["id"], title=event["title"], start=event["start"], end=event["end"],
            )
            updated += 1
        else:
            db.create_commitment(
                str(uuid.uuid4()), event["title"], event["start"], event["end"],
                source=source, external_uid=event["external_uid"],
            )
            created += 1

    deleted = 0
    for commitment in db.list_commitments_by_source(source):
        if commitment["external_uid"] not in seen_uids:
            db.delete_commitment(commitment["id"])
            deleted += 1

    return {
        "source": source,
        "created": created,
        "updated": updated,
        "deleted": deleted,
        "events_found": parsed["events_found"],
        "events_in_window": len(events),
        "window_start": parsed["window_start"].isoformat(),
        "window_end": parsed["window_end"].isoformat(),
    }
