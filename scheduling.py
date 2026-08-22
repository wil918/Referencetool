"""Scheduling helpers that sit on top of the locations data in db.py.

Just travel_minutes for now -- the scheduler proper leans on this heavily,
so it's kept separate from db.py's raw storage and from app.py's routes.
"""
import db


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
