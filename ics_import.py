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

A sync never touches support_level or energy_cost on a row it updates --
those are the user's classification of a commitment (see app.py's commitment
routes) and the feed has no opinion on them. location_id is the one
exception: a row the feed classifies but the user hasn't (location_id still
NULL) gets one filled in from the feed's own site, via _resolve_import_location
-- see sync_feed. Once the user (or a previous sync) has set it, later syncs
leave it alone, same as the other two.

House-format parsing: institutional timetables like Westminster's pack
several fields into SUMMARY, LOCATION and DESCRIPTION that RFC 5545 has no
property for -- delivery type, site, room, session detail, module name and
code, lecturer. _parse_meta below pulls out what it can confidently identify
into commitments.meta (see COMMITMENTS_SCHEMA) and leaves the rest in meta's
own "raw" object, both so nothing is silently dropped and so a future reparse
never needs to re-fetch the feed. Written against a real fetch of the user's
own feed (see tests/fixtures/westminster_feed_sample.ics, extracted verbatim
from it) rather than a guess at the format -- guessing produces a parser that
works on nothing.
"""
import re
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


# --- House-format parsing: DESCRIPTION/LOCATION into structured meta -----------
#
# Westminster's DESCRIPTION is newline-separated fields in a fixed order --
# module code(s), module name(s), delivery type(s), [the LOCATION line, only
# when LOCATION is actually set], [a recurrence blurb, only for a re-run
# session -- "Wkly 1 Oct to 22 Oct"], [a lecturer line, only when staff are
# assigned], "Event id NNNN", [a details line], the teaching-term category
# ("Teaching" or "Teaching SEM2"), then week numbers and group tags neither of
# which anything here needs. Every bracketed part is genuinely optional and
# absent lines are not blank placeholders -- they're just not there -- so this
# locates the two fixed markers (the Event id line and the teaching-term
# category after it) and reads everything between them by shape rather than
# by a fixed offset. Confirmed against every VEVENT in a real fetch of the
# user's feed (66 events, one missing LOCATION entirely, several with no
# lecturer, several with no details line) before being written this way.
_EVENT_ID_LINE = re.compile(r"^Event id \d+$")
_TEACHING_CATEGORY_LINE = re.compile(r"^Teaching(?:\s+SEM\d+)?$")
_RECURRENCE_BLURB = re.compile(r"^(Every\s+\d+\s+wks?|Wkly)\b", re.I)
_WHITESPACE_RUN = re.compile(r"\s+")


def _normalize_ws(text):
    return _WHITESPACE_RUN.sub(" ", text).strip()


def _uniform(parts):
    """The one value every part of a "; "-joined field agrees on, or None if
    they differ.

    A single VEVENT sometimes bundles more than one group's session into one
    entry -- "Studio; Studio" at two different rooms for two different
    seminar groups, or even two different modules sharing a slot. Where every
    part agrees (the delivery type, usually the site) that's a real answer.
    Where they don't (which room, which module) picking one anyway would be a
    guess wearing the shape of an answer, so this reports None and leaves the
    raw text as the honest record instead.
    """
    normalized = {_normalize_ws(p) for p in parts}
    return normalized.pop() if len(normalized) == 1 else None


def _split_site_room(location_group):
    site, _, room = location_group.partition(", ")
    return _normalize_ws(site), (_normalize_ws(room) if room else None)


def _parse_meta(summary, location, description):
    """Structured fields pulled from one VEVENT's SUMMARY/LOCATION/DESCRIPTION,
    for commitments.meta -- see this module's docstring and COMMITMENTS_SCHEMA.

    site/room come from the LOCATION property directly (already unfolded and
    decoded by icalendar) rather than by re-finding it inside DESCRIPTION's
    text, since LOCATION is sometimes entirely absent and DESCRIPTION simply
    skips the line in that case -- there is no fixed position to trust it at.
    module_code/module_name/delivery_type come from DESCRIPTION's first three
    lines, which are unconditionally present. lecturer and details are found
    by shape (see the marker regexes above), not by counting lines from the
    top, because whether a recurrence blurb or a lecturer line comes next
    depends on what the session actually has.
    """
    raw = {"summary": summary, "location": location, "description": description}
    meta = {
        "module_code": None, "module_name": None, "delivery_type": None,
        "site": None, "room": None, "details": None, "lecturer": None, "raw": raw,
    }

    if location:
        pairs = [_split_site_room(group) for group in location.split("; ")]
        meta["site"] = _uniform(p[0] for p in pairs)
        rooms = [p[1] for p in pairs if p[1] is not None]
        if len(rooms) == len(pairs):
            meta["room"] = _uniform(rooms)

    lines = [line.strip() for line in (description or "").split("\n") if line.strip()]
    if len(lines) > 0:
        meta["module_code"] = _uniform(lines[0].split("; "))
    if len(lines) > 1:
        meta["module_name"] = _uniform(lines[1].split("; "))
    if len(lines) > 2:
        meta["delivery_type"] = _uniform(lines[2].split("; "))

    # The LOCATION line is only present in DESCRIPTION when LOCATION itself
    # is set -- confirmed by exact match rather than assumed at a fixed
    # index, since its absence shifts everything after it up by one line.
    cursor = 3
    if location and cursor < len(lines) and _normalize_ws(lines[cursor]) == _normalize_ws(location):
        cursor += 1

    event_id_index = next(
        (i for i in range(cursor, len(lines)) if _EVENT_ID_LINE.match(lines[i])), None
    )
    if event_id_index is None:
        return meta  # structure didn't match at all -- everything stays in raw

    between = lines[cursor:event_id_index]
    lecturer_line = None
    if len(between) == 1:
        lecturer_line = None if _RECURRENCE_BLURB.match(between[0]) else between[0]
    elif len(between) == 2 and _RECURRENCE_BLURB.match(between[0]):
        lecturer_line = between[1]
    # 0 lines: no recurrence blurb and no lecturer. Anything else (an
    # unrecognised shape) is left alone -- the raw text still has it.

    if lecturer_line:
        tokens = [t.strip() for t in lecturer_line.split(", ")]
        # Names are "Last, First" pairs joined by the same ", " the tokens
        # were just split on, so only an even count can be repaired into
        # pairs with any confidence -- an odd one stays unparsed in raw.
        if tokens and len(tokens) % 2 == 0:
            meta["lecturer"] = [
                f"{tokens[i]}, {tokens[i + 1]}" for i in range(0, len(tokens), 2)
            ]

    category_index = next(
        (i for i in range(event_id_index + 1, len(lines))
         if _TEACHING_CATEGORY_LINE.match(lines[i])),
        None,
    )
    if category_index is not None and category_index > event_id_index + 1:
        meta["details"] = " ".join(lines[event_id_index + 1:category_index])

    return meta


def parse_events(ics_text, window_start=None, window_days=None):
    """Every occurrence in the window -- including each instance of a
    recurring series -- plus how many events the file actually defines, so a
    sync that places nothing can say why instead of just reporting a zero
    that reads the same whether the feed was empty or the parser missed
    everything.

    Returns {"events": [...], "events_found", "window_start", "window_end"}.
    Each item in `events` is {external_uid, title, start, end, meta}, start/end
    already collapsed to local naive ISO strings and meta the structured
    fields _parse_meta could pull from this occurrence's SUMMARY/LOCATION/
    DESCRIPTION (see COMMITMENTS_SCHEMA and this module's docstring).
    events_found counts VEVENT *components* in the file -- distinct calendar
    entries, including a recurring series's own override components -- not
    occurrences: for an RRULE with no UNTIL/COUNT, occurrences are unbounded
    and wouldn't say anything meaningful about whether the file parsed
    sensibly. window_start and window_end are date objects.
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
        summary = str(occurrence.get("SUMMARY") or "Untitled")
        location = str(occurrence.get("LOCATION")) if occurrence.get("LOCATION") is not None else None
        description = str(occurrence.get("DESCRIPTION")) if occurrence.get("DESCRIPTION") is not None else ""
        events.append({
            "external_uid": _external_uid(uid, occurrence.get("RECURRENCE-ID"), recurring_uids),
            "title": summary,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "meta": _parse_meta(summary, location, description),
        })
    return {
        "events": events,
        "events_found": events_found,
        "window_start": window_start,
        "window_end": window_end,
    }


def _resolve_import_location(site):
    """The location a feed's `site` maps onto, creating one under the
    configured default umbrella the first time this site is seen -- see
    schedule_settings.default_location_umbrella_id and this module's
    docstring for why sync_feed only ever calls this to FILL IN a blank
    location_id, never to overwrite one.

    Matched by name case-insensitively so a stray case difference in the feed
    doesn't spawn a second "A building" alongside "A Building". Never invents
    a travel_minutes_from_home for a location it creates -- that's the user's
    number to supply, not the parser's to guess (see LOCATIONS_SCHEMA).
    Flagged is_online on creation when the site IS the feed's own "Online" --
    after that, everything downstream reads the flag, not the name (see
    scheduling.travel_minutes). Returns None when there's no site to map.
    """
    if not site:
        return None
    existing = next(
        (loc for loc in db.list_locations() if loc["name"].strip().lower() == site.strip().lower()),
        None,
    )
    if existing:
        return existing["id"]
    settings = db.get_schedule_settings()
    location_id = str(uuid.uuid4())
    db.create_location(
        location_id, site,
        parent_location_id=settings.get("default_location_umbrella_id"),
        is_online=(site.strip().lower() == "online"),
    )
    return location_id


def sync_feed(source, ics_text, window_start=None, window_days=None):
    """Upsert every event from this feed into commitments, scoped to
    `source` (the feed URL, or the label/filename an upload was given).

    An existing row matches by external_uid and gets title/start/end/meta
    refreshed -- meta always, on both a new row and an update, so a re-sync
    backfills the structured fields onto commitments imported before this
    parser existed. support_level and energy_cost are never touched, and
    location_id only gets a value when the row doesn't already have one (see
    _resolve_import_location) -- those three are the user's own
    classification of a commitment (see app.py's commitment routes), and
    filling in a location the feed can now identify is not the same as
    overwriting one the user already set.

    A new commitment is inserted with support_level defaulted to 'none' per
    COMMITMENTS_SCHEMA, ready for the bulk reclassify route. Anything
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
            fields = {"title": event["title"], "start": event["start"], "end": event["end"],
                      "meta": event["meta"]}
            if not existing["location_id"]:
                location_id = _resolve_import_location(event["meta"].get("site"))
                if location_id:
                    fields["location_id"] = location_id
            db.update_commitment(existing["id"], **fields)
            updated += 1
        else:
            location_id = _resolve_import_location(event["meta"].get("site"))
            db.create_commitment(
                str(uuid.uuid4()), event["title"], event["start"], event["end"],
                source=source, external_uid=event["external_uid"],
                location_id=location_id, meta=event["meta"],
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
