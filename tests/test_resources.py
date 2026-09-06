"""The resources library: places to get things, what they stock, and the link
from a task to the resources a trip is for.

The backend CRUD existed from session 1 but nothing exercised it; these tests
cover it along with the two things this session adds -- one-box search over
stock, and the task link that carries a resource's location onto the task.
"""
import uuid

import db


# --- CRUD + items -----------------------------------------------------------


def test_resource_crud_and_items(client):
    r = client.post("/api/resources", json={"name": "Cloth House", "url": "https://x"}).get_json()
    assert r["name"] == "Cloth House"
    assert r["items"] == []

    client.put(f"/api/resources/{r['id']}", json={"notes": "Berwick St"})
    client.post(f"/api/resources/{r['id']}/items",
                json={"item": "Horsehair canvas", "tags": ["tailoring", "interfacing"]})
    items = client.post(f"/api/resources/{r['id']}/items",
                        json={"item": "Silk organza", "tags": ["sheer"]}).get_json()
    assert {i["item"] for i in items} == {"Horsehair canvas", "Silk organza"}

    listed = client.get("/api/resources").get_json()
    assert listed[0]["notes"] == "Berwick St"
    assert len(listed[0]["items"]) == 2

    client.delete(f"/api/resources/{r['id']}/items", json={"item": "Silk organza"})
    assert len(client.get("/api/resources").get_json()[0]["items"]) == 1

    client.delete(f"/api/resources/{r['id']}")
    assert client.get("/api/resources").get_json() == []


def test_resource_needs_a_name(client):
    assert client.post("/api/resources", json={"name": "  "}).status_code == 400


def test_list_resources_carries_location_name(client, archive):
    loc = str(uuid.uuid4())
    db.create_location(loc, "MacCulloch & Wallis")
    r = client.post("/api/resources", json={"name": "M&W", "location_id": loc}).get_json()
    assert r["location_name"] == "MacCulloch & Wallis"
    assert client.get("/api/resources").get_json()[0]["location_name"] == "MacCulloch & Wallis"


# --- Search ---------------------------------------------------------------


def test_search_matches_item_text_and_tags(client):
    a = client.post("/api/resources", json={"name": "Cloth House"}).get_json()
    b = client.post("/api/resources", json={"name": "Kleins"}).get_json()
    client.post(f"/api/resources/{a['id']}/items",
                json={"item": "Horsehair canvas", "tags": ["tailoring"]})
    client.post(f"/api/resources/{b['id']}/items",
                json={"item": "Petersham ribbon", "tags": ["haberdashery"]})

    by_text = client.get("/api/resources/search?q=horsehair").get_json()
    assert [x["name"] for x in by_text] == ["Cloth House"]
    assert [i["item"] for i in by_text[0]["matched_items"]] == ["Horsehair canvas"]

    by_tag = client.get("/api/resources/search?q=haberdashery").get_json()
    assert [x["name"] for x in by_tag] == ["Kleins"]

    assert client.get("/api/resources/search?q=corduroy").get_json() == []
    assert client.get("/api/resources/search?q=").get_json() == []


def test_search_matches_resource_name_with_no_matched_items(client):
    r = client.post("/api/resources", json={"name": "Whaleys of Bradford"}).get_json()
    client.post(f"/api/resources/{r['id']}/items", json={"item": "Calico"})
    hit = client.get("/api/resources/search?q=whaleys").get_json()
    assert hit[0]["matched_items"] == []


# --- Task links ---------------------------------------------------------------


def _task(client, **body):
    body.setdefault("title", "A task")
    return client.post("/api/tasks", json=body).get_json()


def test_link_and_unlink_task_resource(client):
    r = client.post("/api/resources", json={"name": "Cloth House"}).get_json()
    t = _task(client)

    linked = client.post(f"/api/tasks/{t['id']}/resources",
                         json={"resource_id": r["id"]}).get_json()
    assert [x["id"] for x in linked] == [r["id"]]
    assert client.get(f"/api/tasks/{t['id']}").get_json()["resource_ids"] == [r["id"]]

    emptied = client.delete(f"/api/tasks/{t['id']}/resources",
                            json={"resource_id": r["id"]}).get_json()
    assert emptied == []


def test_link_rejects_unknown_resource(client):
    t = _task(client)
    assert client.post(f"/api/tasks/{t['id']}/resources",
                       json={"resource_id": "nope"}).status_code == 400


def test_task_inherits_resource_location_when_it_has_none(client, archive):
    loc = str(uuid.uuid4())
    db.create_location(loc, "Goldhawk Road")
    r = client.post("/api/resources", json={"name": "A-One Fabrics", "location_id": loc}).get_json()
    t = _task(client)
    assert t["required_location_id"] is None

    client.post(f"/api/tasks/{t['id']}/resources", json={"resource_id": r["id"]})
    assert client.get(f"/api/tasks/{t['id']}").get_json()["required_location_id"] == loc

    # Unlinking leaves the inherited location in place.
    client.delete(f"/api/tasks/{t['id']}/resources", json={"resource_id": r["id"]})
    assert client.get(f"/api/tasks/{t['id']}").get_json()["required_location_id"] == loc


def test_task_keeps_its_own_location(client, archive):
    own = str(uuid.uuid4())
    shop = str(uuid.uuid4())
    db.create_location(own, "Studio")
    db.create_location(shop, "Goldhawk Road")
    r = client.post("/api/resources", json={"name": "A-One", "location_id": shop}).get_json()
    t = _task(client, required_location_id=own)

    client.post(f"/api/tasks/{t['id']}/resources", json={"resource_id": r["id"]})
    assert client.get(f"/api/tasks/{t['id']}").get_json()["required_location_id"] == own


# --- Reset boundary ---------------------------------------------------------


def test_reset_clears_task_links_but_not_the_library(client, archive):
    loc = str(uuid.uuid4())
    db.create_location(loc, "Goldhawk Road")
    r = client.post("/api/resources", json={"name": "A-One", "location_id": loc}).get_json()
    t = _task(client)
    client.post(f"/api/tasks/{t['id']}/resources", json={"resource_id": r["id"]})

    deleted = db.reset_schedule()
    assert deleted["task_resources"] == 1
    assert deleted["tasks"] == 1
    assert db.list_resources() != []  # the place itself is configuration, kept

    assert db.reset_schedule(clear_resources=True)["resources"] == 1
