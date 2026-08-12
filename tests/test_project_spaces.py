"""Project spaces: folders, widgets, settings and the canvas.

These cover the semantics that are easy to "fix" by accident -- a folder being
a view rather than an owner, nesting staying one level deep, the permanent
widgets surviving a delete -- plus the cascade that has to happen when a
project or a reference goes away.
"""
import itertools

from conftest import png_bytes

import db
import ingest


def make_project(client, title="A Project"):
    return client.post("/api/projects", json={"title": title}).get_json()["id"]


# These images are a single flat colour, so two references built from the same
# colour would be byte-identical and the second would be rejected as a
# duplicate. A counter spread across two channels keeps every one distinct.
_colours = itertools.count()


def add_reference(archive, name):
    """A real reference in the archive, through the real ingest path."""
    n = next(_colours)
    path = archive / f"{name}.png"
    path.write_bytes(png_bytes((n % 256, (n // 256) % 256, 60)))
    return ingest.add_reference(path, title=name)["id"]


def folder_named(client, project_id, name):
    folders = client.get(f"/api/projects/{project_id}/folders").get_json()
    return next(f for f in folders if f["name"] == name)


def widget_of_type(client, project_id, widget_type):
    widgets = client.get(f"/api/projects/{project_id}/widgets").get_json()
    return next(w for w in widgets if w["type"] == widget_type)


# --- Seeding a new project --------------------------------------------------


def test_new_project_gets_the_six_default_folders_in_order(client):
    project_id = make_project(client)
    folders = client.get(f"/api/projects/{project_id}/folders").get_json()

    assert [f["name"] for f in folders] == list(db.DEFAULT_FOLDER_NAMES)
    assert [f["position"] for f in folders] == [0, 1, 2, 3, 4, 5]
    assert all(f["is_default"] for f in folders)
    assert all(f["reference_count"] == 0 for f in folders)


def test_new_project_gets_the_default_widget_set_and_nothing_else(client):
    project_id = make_project(client)
    widgets = client.get(f"/api/projects/{project_id}/widgets").get_json()

    assert {w["type"] for w in widgets} == {"title", "canvas", "settings", "exit"}
    # The title sits at the top, and everything starts on the grid rather than
    # inside a container.
    assert widget_of_type(client, project_id, "title")["y"] == 0
    assert all(w["parent_id"] is None for w in widgets)


def test_a_default_folder_can_be_renamed_and_deleted(client):
    """is_default records origin, not protection."""
    project_id = make_project(client)
    texture = folder_named(client, project_id, "Texture")

    renamed = client.put(f"/api/folders/{texture['id']}", json={"name": "Surface"})
    assert renamed.status_code == 200
    assert renamed.get_json()["name"] == "Surface"
    # Renaming doesn't rewrite where the folder came from.
    assert renamed.get_json()["is_default"] is True

    assert client.delete(f"/api/folders/{texture['id']}").status_code == 200
    names = [f["name"] for f in client.get(f"/api/projects/{project_id}/folders").get_json()]
    assert "Surface" not in names


def test_folders_reorder_densely(client):
    """A moved folder lands where it was dropped, and the rest renumber with no
    gaps or ties -- otherwise the order falls back on date_created on reload."""
    project_id = make_project(client)
    narrative = folder_named(client, project_id, "Narrative")

    client.put(f"/api/folders/{narrative['id']}", json={"position": 0})

    folders = client.get(f"/api/projects/{project_id}/folders").get_json()
    assert [f["name"] for f in folders][:2] == ["Narrative", "Texture"]
    assert [f["position"] for f in folders] == [0, 1, 2, 3, 4, 5]


# --- Folders are views, not owners ------------------------------------------


def test_a_reference_can_sit_in_two_folders_at_once(client, archive):
    project_id = make_project(client)
    ref_id = add_reference(archive, "swatch")
    texture = folder_named(client, project_id, "Texture")
    colour = folder_named(client, project_id, "Colour")

    for folder in (texture, colour):
        response = client.post(
            f"/api/folders/{folder['id']}/references", json={"reference_ids": [ref_id]}
        )
        assert response.status_code == 200

    for folder in (texture, colour):
        filed = client.get(f"/api/folders/{folder['id']}/references").get_json()
        assert [r["id"] for r in filed] == [ref_id]


def test_filing_a_reference_adds_it_to_the_project(client, archive):
    """A folder shows a slice of its project, so filing into one can't leave the
    reference absent from the project page it belongs to."""
    project_id = make_project(client)
    ref_id = add_reference(archive, "swatch")

    client.post(
        f"/api/folders/{folder_named(client, project_id, 'Form')['id']}/references",
        json={"reference_ids": [ref_id]},
    )

    project = client.get(f"/api/projects/{project_id}").get_json()
    assert [r["id"] for r in project["references"]] == [ref_id]


def test_removing_from_a_folder_leaves_the_project_and_archive_intact(client, archive):
    project_id = make_project(client)
    ref_id = add_reference(archive, "swatch")
    texture = folder_named(client, project_id, "Texture")
    colour = folder_named(client, project_id, "Colour")
    for folder in (texture, colour):
        client.post(f"/api/folders/{folder['id']}/references", json={"reference_ids": [ref_id]})

    removed = client.delete(f"/api/folders/{texture['id']}/references/{ref_id}")
    assert removed.status_code == 200

    assert client.get(f"/api/folders/{texture['id']}/references").get_json() == []
    # Still filed in the other folder, still in the project, still in the archive.
    assert [r["id"] for r in client.get(f"/api/folders/{colour['id']}/references").get_json()] == [ref_id]
    project = client.get(f"/api/projects/{project_id}").get_json()
    assert [r["id"] for r in project["references"]] == [ref_id]
    assert db.get_reference(ref_id) is not None


def test_deleting_a_folder_unfiles_without_deleting(client, archive):
    project_id = make_project(client)
    ref_id = add_reference(archive, "swatch")
    texture = folder_named(client, project_id, "Texture")
    client.post(f"/api/folders/{texture['id']}/references", json={"reference_ids": [ref_id]})

    client.delete(f"/api/folders/{texture['id']}")

    project = client.get(f"/api/projects/{project_id}").get_json()
    assert [r["id"] for r in project["references"]] == [ref_id]
    assert db.get_reference(ref_id) is not None


def test_folder_reference_count_tracks_filing(client, archive):
    project_id = make_project(client)
    texture = folder_named(client, project_id, "Texture")
    ids = [add_reference(archive, name) for name in ("one", "two")]

    client.post(f"/api/folders/{texture['id']}/references", json={"reference_ids": ids})
    assert folder_named(client, project_id, "Texture")["reference_count"] == 2


def test_folder_routes_404_for_an_unknown_folder(client):
    assert client.get("/api/folders/nope/references").status_code == 404
    assert client.put("/api/folders/nope", json={"name": "x"}).status_code == 404
    assert client.delete("/api/folders/nope").status_code == 404


# --- Cross-project folder roll-up --------------------------------------------


def test_rollup_unions_same_named_folders_across_projects(client, archive):
    project_a = make_project(client)
    project_b = make_project(client)
    texture_a = folder_named(client, project_a, "Texture")
    texture_b = folder_named(client, project_b, "Texture")

    shared_id = add_reference(archive, "shared")
    only_a_id = add_reference(archive, "only-a")
    only_b_id = add_reference(archive, "only-b")

    client.post(f"/api/folders/{texture_a['id']}/references", json={"reference_ids": [shared_id, only_a_id]})
    client.post(f"/api/folders/{texture_b['id']}/references", json={"reference_ids": [shared_id, only_b_id]})

    rollup = client.get("/api/folders/rollup").get_json()
    texture = next(f for f in rollup if f["name"] == "Texture")
    # The shared reference counts once, not twice.
    assert texture["reference_count"] == 3
    project_ids = {p["id"] for p in texture["projects"]}
    assert project_ids == {project_a, project_b}
    counts = {p["id"]: p["count"] for p in texture["projects"]}
    assert counts[project_a] == 2
    assert counts[project_b] == 2

    refs = client.get("/api/folders/rollup/Texture/references").get_json()
    ref_ids = {r["id"] for r in refs}
    assert ref_ids == {shared_id, only_a_id, only_b_id}


def test_rollup_reference_count_ignores_a_folder_with_nothing_filed(client):
    make_project(client)  # its default folders, including Texture, are all empty
    rollup = client.get("/api/folders/rollup").get_json()
    texture = next(f for f in rollup if f["name"] == "Texture")
    assert texture["reference_count"] == 0
    assert texture["projects"][0]["count"] == 0


# --- Widgets: anti-stacking -------------------------------------------------


def add_widget(client, project_id, widget_type, parent_id=None):
    return client.post(
        f"/api/projects/{project_id}/widgets",
        json={"type": widget_type, "parent_id": parent_id, "x": 0, "y": 0, "w": 2, "h": 2},
    )


def test_a_leaf_widget_goes_inside_a_container(client):
    project_id = make_project(client)
    sidebar = add_widget(client, project_id, "sidebar").get_json()

    inside = add_widget(client, project_id, "colourspace", parent_id=sidebar["id"])
    assert inside.status_code == 200
    assert inside.get_json()["parent_id"] == sidebar["id"]


def test_a_container_cannot_go_inside_another_container(client):
    project_id = make_project(client)
    sidebar = add_widget(client, project_id, "sidebar").get_json()

    response = add_widget(client, project_id, "sidebar", parent_id=sidebar["id"])
    assert response.status_code == 400
    assert "container" in response.get_json()["error"]


def test_a_widget_cannot_go_inside_a_nested_widget(client):
    """Nesting is one level deep: the thing inside a sidebar can't itself hold
    anything."""
    project_id = make_project(client)
    sidebar = add_widget(client, project_id, "sidebar").get_json()
    nested = add_widget(client, project_id, "colourspace", parent_id=sidebar["id"]).get_json()

    response = add_widget(client, project_id, "moodboard", parent_id=nested["id"])
    assert response.status_code == 400
    assert "one level deep" in response.get_json()["error"]


def test_a_widget_cannot_go_inside_a_leaf_widget_on_the_grid(client):
    project_id = make_project(client)
    leaf = add_widget(client, project_id, "colourspace").get_json()

    response = add_widget(client, project_id, "moodboard", parent_id=leaf["id"])
    assert response.status_code == 400
    assert "cannot contain" in response.get_json()["error"]


def test_a_parent_from_another_project_is_rejected(client):
    first = make_project(client, "First")
    second = make_project(client, "Second")
    sidebar = add_widget(client, first, "sidebar").get_json()

    response = add_widget(client, second, "colourspace", parent_id=sidebar["id"])
    assert response.status_code == 400


def test_the_bulk_layout_save_also_enforces_nesting(client):
    """Re-parenting a container in a layout save would push what was already
    inside it a level too deep."""
    project_id = make_project(client)
    outer = add_widget(client, project_id, "sidebar").get_json()
    inner = add_widget(client, project_id, "colourspace", parent_id=outer["id"]).get_json()
    other = add_widget(client, project_id, "sidebar").get_json()

    response = client.put(
        f"/api/projects/{project_id}/widgets",
        json={"widgets": [{**outer, "parent_id": other["id"]}]},
    )
    assert response.status_code == 400
    # Nothing was written -- the layout is all-or-nothing.
    assert db.get_widget(outer["id"])["parent_id"] is None
    assert db.get_widget(inner["id"])["parent_id"] == outer["id"]


# --- Widgets: permanence and layout -----------------------------------------


def test_permanent_widgets_cannot_be_deleted(client):
    project_id = make_project(client)
    for widget_type in ("settings", "exit", "canvas"):
        widget = widget_of_type(client, project_id, widget_type)
        response = client.delete(f"/api/widgets/{widget['id']}")
        assert response.status_code == 400
        assert widget_type in response.get_json()["error"]
        assert db.get_widget(widget["id"]) is not None


def test_permanent_widgets_can_still_be_moved(client):
    project_id = make_project(client)
    settings = widget_of_type(client, project_id, "settings")

    response = client.put(
        f"/api/projects/{project_id}/widgets",
        json={"widgets": [{**settings, "x": 8, "y": 9}]},
    )
    assert response.status_code == 200
    moved = db.get_widget(settings["id"])
    assert (moved["x"], moved["y"]) == (8, 9)


def test_an_ordinary_widget_can_be_deleted(client):
    project_id = make_project(client)
    widget = add_widget(client, project_id, "colourspace").get_json()

    assert client.delete(f"/api/widgets/{widget['id']}").status_code == 200
    assert db.get_widget(widget["id"]) is None


def test_deleting_a_container_takes_its_children_with_it(client):
    project_id = make_project(client)
    sidebar = add_widget(client, project_id, "sidebar").get_json()
    inside = add_widget(client, project_id, "colourspace", parent_id=sidebar["id"]).get_json()

    client.delete(f"/api/widgets/{sidebar['id']}")
    assert db.get_widget(inside["id"]) is None


def test_the_bulk_layout_save_round_trips(client):
    project_id = make_project(client)
    sidebar = add_widget(client, project_id, "sidebar").get_json()
    leaf = add_widget(client, project_id, "colourspace").get_json()
    title = widget_of_type(client, project_id, "title")

    layout = [
        {"id": title["id"], "x": 0, "y": 0, "w": 12, "h": 1, "locked": True},
        {"id": sidebar["id"], "x": 0, "y": 1, "w": 3, "h": 8},
        {"id": leaf["id"], "parent_id": sidebar["id"], "x": 0, "y": 0, "w": 3, "h": 2,
         "config": {"mode": "lch"}},
    ]
    saved = client.put(f"/api/projects/{project_id}/widgets", json={"widgets": layout})
    assert saved.status_code == 200

    stored = {w["id"]: w for w in client.get(f"/api/projects/{project_id}/widgets").get_json()}
    assert (stored[title["id"]]["w"], stored[title["id"]]["h"]) == (12, 1)
    assert stored[title["id"]]["locked"] is True
    assert stored[leaf["id"]]["parent_id"] == sidebar["id"]
    assert stored[leaf["id"]]["config"] == {"mode": "lch"}
    # Position falls back to the order the editor sent them in.
    assert [stored[e["id"]]["position"] for e in layout] == [0, 1, 2]


def test_the_bulk_layout_save_ignores_ids_from_elsewhere(client):
    """A stale editor tab must not resurrect a deleted widget or reach into
    another project."""
    first = make_project(client, "First")
    second = make_project(client, "Second")
    stranger = add_widget(client, second, "colourspace").get_json()
    deleted = add_widget(client, first, "moodboard").get_json()
    client.delete(f"/api/widgets/{deleted['id']}")

    response = client.put(
        f"/api/projects/{first}/widgets",
        json={"widgets": [{**stranger, "x": 5}, {**deleted, "x": 5}]},
    )
    assert response.status_code == 200
    assert db.get_widget(deleted["id"]) is None
    assert db.get_widget(stranger["id"])["x"] == 0
    assert db.get_widget(stranger["id"])["project_id"] == second


def test_widget_routes_require_a_real_project(client):
    assert client.get("/api/projects/nope/widgets").status_code == 404
    assert add_widget(client, "nope", "colourspace").status_code == 404
    assert client.delete("/api/widgets/nope").status_code == 404


# --- Settings ---------------------------------------------------------------


def test_settings_start_empty_and_round_trip(client):
    project_id = make_project(client)
    assert client.get(f"/api/projects/{project_id}/settings").get_json() == {"settings": {}}

    settings = {"grid_visible": False, "accent": "warm", "columns": 12}
    saved = client.put(f"/api/projects/{project_id}/settings", json={"settings": settings})
    assert saved.status_code == 200
    assert client.get(f"/api/projects/{project_id}/settings").get_json()["settings"] == settings


def test_saving_settings_replaces_rather_than_merges(client):
    """The frontend holds the whole settings object, and a merge would make
    removing a key impossible."""
    project_id = make_project(client)
    client.put(f"/api/projects/{project_id}/settings", json={"settings": {"a": 1, "b": 2}})
    client.put(f"/api/projects/{project_id}/settings", json={"settings": {"a": 3}})

    assert client.get(f"/api/projects/{project_id}/settings").get_json()["settings"] == {"a": 3}


def test_settings_must_be_an_object(client):
    project_id = make_project(client)
    response = client.put(f"/api/projects/{project_id}/settings", json={"settings": [1, 2]})
    assert response.status_code == 400


# --- Canvas -----------------------------------------------------------------


def test_canvas_starts_empty(client):
    project_id = make_project(client)
    assert client.get(f"/api/projects/{project_id}/canvas").get_json() == {"nodes": [], "edges": []}


def test_canvas_nodes_of_all_three_kinds_persist(client, archive):
    project_id = make_project(client)
    ref_id = add_reference(archive, "swatch")

    reference_node = client.post(
        f"/api/projects/{project_id}/canvas/nodes",
        json={"kind": "reference", "reference_id": ref_id, "x": 120.5, "y": -40.25},
    ).get_json()
    text_node = client.post(
        f"/api/projects/{project_id}/canvas/nodes",
        json={"kind": "text", "content": "a note to self", "x": 0, "y": 0},
    ).get_json()
    widget_node = client.post(
        f"/api/projects/{project_id}/canvas/nodes",
        json={"kind": "widget", "config": {"type": "colourspace"}},
    ).get_json()

    nodes = {n["id"]: n for n in client.get(f"/api/projects/{project_id}/canvas").get_json()["nodes"]}
    assert len(nodes) == 3
    # World coordinates are stored as given, fractional values included.
    assert (nodes[reference_node["id"]]["x"], nodes[reference_node["id"]]["y"]) == (120.5, -40.25)
    assert nodes[reference_node["id"]]["reference_id"] == ref_id
    assert nodes[text_node["id"]]["content"] == "a note to self"
    assert nodes[widget_node["id"]]["config"] == {"type": "colourspace"}


def test_an_unknown_node_kind_is_rejected(client):
    project_id = make_project(client)
    response = client.post(f"/api/projects/{project_id}/canvas/nodes", json={"kind": "sticker"})
    assert response.status_code == 400


def test_a_reference_node_needs_a_real_reference(client):
    project_id = make_project(client)
    response = client.post(
        f"/api/projects/{project_id}/canvas/nodes",
        json={"kind": "reference", "reference_id": "nope"},
    )
    assert response.status_code == 404


def test_patching_a_node_leaves_untouched_fields_alone(client):
    project_id = make_project(client)
    node = client.post(
        f"/api/projects/{project_id}/canvas/nodes",
        json={"kind": "text", "content": "keep me", "x": 10, "y": 10},
    ).get_json()

    patched = client.patch(f"/api/canvas/nodes/{node['id']}", json={"x": 99.5, "y": 12})
    assert patched.status_code == 200
    assert patched.get_json()["content"] == "keep me"
    assert patched.get_json()["x"] == 99.5


def test_deleting_a_node_deletes_the_edges_that_touched_it(client):
    project_id = make_project(client)
    first, second = (
        client.post(f"/api/projects/{project_id}/canvas/nodes", json={"kind": "text"}).get_json()
        for _ in range(2)
    )
    edge = client.post(
        f"/api/projects/{project_id}/canvas/edges",
        json={"source_node_id": first["id"], "target_node_id": second["id"], "style": {"dashed": True}},
    ).get_json()
    assert edge["style"] == {"dashed": True}

    client.delete(f"/api/canvas/nodes/{first['id']}")

    canvas = client.get(f"/api/projects/{project_id}/canvas").get_json()
    assert [n["id"] for n in canvas["nodes"]] == [second["id"]]
    assert canvas["edges"] == []


def test_an_edge_needs_both_ends_on_this_canvas(client):
    project_id = make_project(client)
    other_project = make_project(client, "Elsewhere")
    here = client.post(f"/api/projects/{project_id}/canvas/nodes", json={"kind": "text"}).get_json()
    there = client.post(
        f"/api/projects/{other_project}/canvas/nodes", json={"kind": "text"}
    ).get_json()

    response = client.post(
        f"/api/projects/{project_id}/canvas/edges",
        json={"source_node_id": here["id"], "target_node_id": there["id"]},
    )
    assert response.status_code == 400


def test_replacing_the_canvas_swaps_it_wholesale(client):
    project_id = make_project(client)
    old = client.post(
        f"/api/projects/{project_id}/canvas/nodes", json={"kind": "text", "content": "old"}
    ).get_json()

    replacement = {
        "nodes": [
            {"id": "n1", "kind": "text", "content": "first", "x": 1.5, "y": 2.5, "z_index": 3},
            {"id": "n2", "kind": "text", "content": "second", "x": 4, "y": 5},
        ],
        "edges": [{"id": "e1", "source_node_id": "n1", "target_node_id": "n2"}],
    }
    response = client.put(f"/api/projects/{project_id}/canvas", json=replacement)
    assert response.status_code == 200

    canvas = client.get(f"/api/projects/{project_id}/canvas").get_json()
    assert {n["id"] for n in canvas["nodes"]} == {"n1", "n2"}
    assert old["id"] not in {n["id"] for n in canvas["nodes"]}
    assert [e["source_node_id"] for e in canvas["edges"]] == ["n1"]


def test_replacing_the_canvas_rejects_an_edge_to_a_node_it_is_deleting(client):
    project_id = make_project(client)
    doomed = client.post(f"/api/projects/{project_id}/canvas/nodes", json={"kind": "text"}).get_json()

    response = client.put(
        f"/api/projects/{project_id}/canvas",
        json={
            "nodes": [{"id": "n1", "kind": "text"}],
            "edges": [{"source_node_id": "n1", "target_node_id": doomed["id"]}],
        },
    )
    assert response.status_code == 400
    # Rejected outright, so the canvas that was there is still there.
    assert [n["id"] for n in client.get(f"/api/projects/{project_id}/canvas").get_json()["nodes"]] == [
        doomed["id"]
    ]


def test_canvas_routes_require_a_real_project(client):
    assert client.get("/api/projects/nope/canvas").status_code == 404
    assert client.post("/api/projects/nope/canvas/nodes", json={"kind": "text"}).status_code == 404
    assert client.patch("/api/canvas/nodes/nope", json={"x": 1}).status_code == 404
    assert client.delete("/api/canvas/nodes/nope").status_code == 404
    assert client.delete("/api/canvas/edges/nope").status_code == 404


# --- Cascades ---------------------------------------------------------------


def project_space_row_counts(project_id):
    """How many rows each of the six project-space tables holds for a project."""
    with db.get_conn() as conn:
        counts = {}
        for table in ("folders", "widgets", "project_settings", "canvas_nodes", "canvas_edges"):
            counts[table] = conn.execute(
                f"SELECT COUNT(*) AS c FROM {table} WHERE project_id = ?", (project_id,)
            ).fetchone()["c"]
        counts["folder_references"] = conn.execute(
            """SELECT COUNT(*) AS c FROM folder_references
               WHERE folder_id IN (SELECT id FROM folders WHERE project_id = ?)""",
            (project_id,),
        ).fetchone()["c"]
        return counts


def populate(client, archive, project_id):
    """A project with something in every project-space table."""
    ref_id = add_reference(archive, f"ref-{project_id[:8]}")
    client.post(
        f"/api/folders/{folder_named(client, project_id, 'Texture')['id']}/references",
        json={"reference_ids": [ref_id]},
    )
    client.put(f"/api/projects/{project_id}/settings", json={"settings": {"grid": True}})
    first = client.post(
        f"/api/projects/{project_id}/canvas/nodes",
        json={"kind": "reference", "reference_id": ref_id},
    ).get_json()
    second = client.post(
        f"/api/projects/{project_id}/canvas/nodes", json={"kind": "text", "content": "note"}
    ).get_json()
    client.post(
        f"/api/projects/{project_id}/canvas/edges",
        json={"source_node_id": first["id"], "target_node_id": second["id"]},
    )
    return ref_id


def test_deleting_a_project_cascades_to_every_project_space_table(client, archive):
    project_id = make_project(client)
    ref_id = populate(client, archive, project_id)
    assert all(count > 0 for count in project_space_row_counts(project_id).values())

    assert client.delete(f"/api/projects/{project_id}").status_code == 200

    assert project_space_row_counts(project_id) == {
        "folders": 0,
        "folder_references": 0,
        "widgets": 0,
        "project_settings": 0,
        "canvas_nodes": 0,
        "canvas_edges": 0,
    }
    # The work itself is untouched -- only the grouping was deleted.
    assert db.get_reference(ref_id) is not None


def test_deleting_a_project_leaves_other_projects_alone(client, archive):
    kept = make_project(client, "Kept")
    doomed = make_project(client, "Doomed")
    populate(client, archive, kept)
    populate(client, archive, doomed)

    client.delete(f"/api/projects/{doomed}")

    assert all(count > 0 for count in project_space_row_counts(kept).values())


def test_deleting_a_reference_unfiles_it_and_clears_its_canvas_nodes(client, archive):
    project_id = make_project(client)
    ref_id = populate(client, archive, project_id)
    texture = folder_named(client, project_id, "Texture")

    assert client.delete(f"/api/references/{ref_id}").status_code == 200

    assert client.get(f"/api/folders/{texture['id']}/references").get_json() == []
    canvas = client.get(f"/api/projects/{project_id}/canvas").get_json()
    assert all(n["reference_id"] != ref_id for n in canvas["nodes"])
    # The edge that pointed at the reference node went with it, rather than
    # being left as a line into empty space.
    assert canvas["edges"] == []
    # The folder itself survives -- deleting a reference isn't deleting a folder.
    assert folder_named(client, project_id, "Texture")["reference_count"] == 0


def test_deleting_a_folder_removes_the_folder_widget_that_pointed_at_it(client):
    """A folder widget (widgets/folder.js) is seeded with config.folder_id at
    creation time. Deleting the folder it points at must remove the widget
    too, rather than leaving a permanent "Folder deleted" tile on the grid."""
    project_id = make_project(client)
    texture = folder_named(client, project_id, "Texture")
    narrative = folder_named(client, project_id, "Narrative")

    texture_widget = client.post(
        f"/api/projects/{project_id}/widgets",
        json={"type": "folder", "config": {"folder_id": texture["id"]}},
    ).get_json()
    narrative_widget = client.post(
        f"/api/projects/{project_id}/widgets",
        json={"type": "folder", "config": {"folder_id": narrative["id"]}},
    ).get_json()

    assert client.delete(f"/api/folders/{texture['id']}").status_code == 200

    widget_ids = {w["id"] for w in client.get(f"/api/projects/{project_id}/widgets").get_json()}
    assert texture_widget["id"] not in widget_ids
    # A folder widget for a different, still-live folder is untouched.
    assert narrative_widget["id"] in widget_ids


def orphan_rows():
    """Rows in each project-space table whose parent no longer exists --
    proof a cascade fired all the way through rather than stopping partway.
    """
    with db.get_conn() as conn:
        queries = {
            "folders": """
                SELECT id FROM folders
                WHERE project_id NOT IN (SELECT id FROM projects)
            """,
            "folder_references": """
                SELECT folder_id, reference_id FROM folder_references
                WHERE folder_id NOT IN (SELECT id FROM folders)
                   OR reference_id NOT IN (SELECT id FROM reference_items)
            """,
            "widgets": """
                SELECT id FROM widgets
                WHERE project_id NOT IN (SELECT id FROM projects)
                   OR (parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM widgets))
            """,
            "project_settings": """
                SELECT project_id FROM project_settings
                WHERE project_id NOT IN (SELECT id FROM projects)
            """,
            "canvas_nodes": """
                SELECT id FROM canvas_nodes
                WHERE project_id NOT IN (SELECT id FROM projects)
                   OR (reference_id IS NOT NULL
                       AND reference_id NOT IN (SELECT id FROM reference_items))
            """,
            "canvas_edges": """
                SELECT id FROM canvas_edges
                WHERE project_id NOT IN (SELECT id FROM projects)
                   OR source_node_id NOT IN (SELECT id FROM canvas_nodes)
                   OR target_node_id NOT IN (SELECT id FROM canvas_nodes)
            """,
        }
        return {table: conn.execute(query).fetchall() for table, query in queries.items()}


def test_no_orphan_rows_survive_project_reference_and_folder_deletes(client, archive):
    """The general sweep behind the three targeted cascade tests above: after
    deleting a project, a reference and a folder -- each from a project with
    a sibling project left untouched -- no table anywhere in the database
    holds a row whose parent is gone."""
    kept_project = make_project(client, "Kept")
    populate(client, archive, kept_project)

    doomed_project = make_project(client, "Doomed")
    populate(client, archive, doomed_project)

    survivor_project = make_project(client, "Survivor")
    doomed_ref = populate(client, archive, survivor_project)
    doomed_folder = folder_named(client, survivor_project, "Vibe")
    client.post(
        f"/api/projects/{survivor_project}/widgets",
        json={"type": "folder", "config": {"folder_id": doomed_folder["id"]}},
    )

    assert client.delete(f"/api/projects/{doomed_project}").status_code == 200
    assert client.delete(f"/api/references/{doomed_ref}").status_code == 200
    assert client.delete(f"/api/folders/{doomed_folder['id']}").status_code == 200

    orphans = orphan_rows()
    assert all(len(rows) == 0 for rows in orphans.values()), orphans
    # The untouched project's own space is still intact.
    assert all(count > 0 for count in project_space_row_counts(kept_project).values())
