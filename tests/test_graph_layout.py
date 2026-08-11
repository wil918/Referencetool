"""The 3D similarity graph's server-side layout, whole-archive and scoped.

The embeddings are supplied by hand rather than computed: the layout's job is
to turn vectors and scores into clusters, planes and threads, so a fake
collection with vectors chosen to fall into obvious groups makes the expected
clustering knowable. Actual CLIP behaviour is embeddings.py's problem, not
this module's.
"""
import numpy as np
import pytest
from PIL import Image

import db
import embeddings
import graph_layout
import ingest

VECTOR_DIM = 512


def image(archive, name, rgb=(120, 80, 60)):
    """A real reference in the archive, through the real ingest path."""
    img = Image.new("RGB", (64, 64), rgb)
    # One pixel keyed to the name, so two references painted the same colour
    # are still distinct files -- ingest rejects a duplicate content hash.
    img.putpixel((0, 0), (sum(ord(c) for c in name) % 256, 0, 0))
    path = archive / f"{name}.png"
    img.save(path)
    return ingest.add_reference(path, title=name)["id"]


class FakeCollection:
    """Stands in for the Chroma collection.

    `get` returns only the ids it knows about, exactly as the real collection
    does for a reference that was never embedded -- which is the case the
    layout has to survive, not a convenience of the fake.
    """

    def __init__(self, vectors):
        self._vectors = vectors

    def get(self, ids=None, include=None):
        known = [i for i in (ids if ids is not None else self._vectors) if i in self._vectors]
        return {"ids": known, "embeddings": [self._vectors[i] for i in known]}


def seed_vectors(monkeypatch, assignments):
    """`assignments` maps reference id -> a scalar the vector is built from, so
    ids given the same scalar are identical in embedding space and ids given
    different ones are far apart."""
    vectors = {
        ref_id: (np.full(VECTOR_DIM, float(value)) / np.sqrt(VECTOR_DIM)).tolist()
        for ref_id, value in assignments.items()
    }
    monkeypatch.setattr(embeddings, "get_collection", lambda: FakeCollection(vectors))


def scores(*pairs):
    db.save_similarity_scores([(a, b, s) for a, b, s in pairs])


def plane_ids(graph):
    return {p["cluster"] for p in graph["planes"]}


# --- The whole archive ------------------------------------------------------


def test_unscoped_graph_covers_every_reference(archive, monkeypatch):
    a = image(archive, "a", (200, 30, 30))
    b = image(archive, "b", (30, 200, 30))
    c = image(archive, "c", (30, 30, 200))
    seed_vectors(monkeypatch, {a: 1.0, b: 1.0, c: -1.0})
    scores((a, b, 0.9), (b, c, 0.2), (a, c, 0.1))

    graph = graph_layout.build_graph()
    assert {n["id"] for n in graph["nodes"]} == {a, b, c}
    assert graph["cluster_count"] == len(graph["planes"]) > 0


def test_passing_no_ids_is_the_unscoped_graph(archive, monkeypatch):
    """`reference_ids=None` must be the old call, byte for byte -- the whole
    point of the parameter is that existing callers didn't change."""
    a = image(archive, "a", (200, 30, 30))
    b = image(archive, "b", (30, 200, 30))
    seed_vectors(monkeypatch, {a: 1.0, b: -1.0})
    scores((a, b, 0.8))

    assert graph_layout.build_graph() == graph_layout.build_graph(reference_ids=None)


def test_an_archive_of_one_has_no_graph(archive, monkeypatch):
    a = image(archive, "a")
    seed_vectors(monkeypatch, {a: 1.0})
    assert graph_layout.build_graph()["nodes"] == []


# --- Scoping to a subset ----------------------------------------------------


def test_scoped_graph_contains_only_the_requested_references(archive, monkeypatch):
    a = image(archive, "a", (200, 30, 30))
    b = image(archive, "b", (30, 200, 30))
    c = image(archive, "c", (30, 30, 200))
    seed_vectors(monkeypatch, {a: 1.0, b: 1.0, c: -1.0})
    scores((a, b, 0.9), (b, c, 0.5), (a, c, 0.4))

    graph = graph_layout.build_graph(reference_ids=[a, b])
    assert {n["id"] for n in graph["nodes"]} == {a, b}
    assert all(c not in (e["source"], e["target"]) for e in graph["edges"])


def test_a_two_reference_project_produces_a_valid_graph(archive, monkeypatch):
    """The smallest project that can be a graph at all. It must lay out rather
    than fall over on the cluster-count heuristic, and every node it places
    must have a plane to sit on."""
    a = image(archive, "a", (200, 30, 30))
    b = image(archive, "b", (30, 30, 200))
    image(archive, "spare", (30, 200, 30))
    ids = [r["id"] for r in db.list_references()]
    seed_vectors(monkeypatch, {i: float(n) for n, i in enumerate(ids)})
    scores((a, b, 0.75))

    graph = graph_layout.build_graph(reference_ids=[a, b])
    assert {n["id"] for n in graph["nodes"]} == {a, b}
    assert graph["planes"] and graph["cluster_count"] == len(graph["planes"])
    assert {n["cluster"] for n in graph["nodes"]} <= plane_ids(graph)
    assert sum(n["is_hub"] for n in graph["nodes"]) == len(graph["planes"])

    assert len(graph["edges"]) == 1
    edge = graph["edges"][0]
    assert (edge["source"], edge["target"]) == tuple(sorted((a, b)))
    assert edge["score"] == 0.75


def test_a_five_reference_project_produces_no_empty_planes(archive, monkeypatch):
    """len(ids)//8 floors to zero here, so this is the case the heuristic has
    to degrade through. Every plane must belong to a cluster that actually has
    members -- an empty plane is a floating rectangle with nothing on it."""
    ids = [image(archive, f"r{i}", (30 * i, 200 - 30 * i, 90)) for i in range(5)]
    seed_vectors(monkeypatch, {i: 1.0 if n < 3 else -1.0 for n, i in enumerate(ids)})
    scores(*[(ids[i], ids[j], 0.5) for i in range(5) for j in range(i + 1, 5)])

    graph = graph_layout.build_graph(reference_ids=ids)
    assert len(graph["nodes"]) == 5
    populated = {n["cluster"] for n in graph["nodes"]}
    assert plane_ids(graph) == populated
    assert 0 < len(populated) <= graph_layout.MAX_CLUSTERS


def test_scoped_graph_drops_scores_that_leave_the_subset(archive, monkeypatch):
    """A pair with one endpoint outside the project isn't a thread the project
    can draw, however strong it is."""
    ids = [image(archive, f"r{i}", (40 * i, 200 - 40 * i, 90)) for i in range(4)]
    inside, outside = ids[:2], ids[2:]
    seed_vectors(monkeypatch, {i: 1.0 if i in inside else -1.0 for i in ids})
    scores(
        (inside[0], outside[0], 0.99),
        (inside[1], outside[1], 0.98),
        (inside[0], inside[1], 0.30),
    )

    graph = graph_layout.build_graph(reference_ids=inside)
    assert [(e["source"], e["target"]) for e in graph["edges"]] == [tuple(sorted(inside))]


def test_the_cross_cluster_allowance_is_spent_inside_the_subset(archive, monkeypatch):
    """The long threads are the top fraction of the *score list*, so which list
    that is decides whether a scoped graph gets any at all: measured against
    the whole archive, a small project's own pairs never reach the window and
    it comes out with only its top-k local links.

    Both constants are turned right down so the window is a few pairs rather
    than a few hundred -- the arithmetic being pinned is the same one, just at
    a size a test can lay out by hand.
    """
    monkeypatch.setattr(graph_layout, "EDGES_PER_NODE", 1)
    monkeypatch.setattr(graph_layout, "CROSS_CLUSTER_TOP_FRACTION", 0.3)

    ids = [image(archive, f"r{i}", (35 * i, 200 - 35 * i, 90)) for i in range(5)]
    seed_vectors(monkeypatch, {i: 1.0 if n < 3 else -1.0 for n, i in enumerate(ids)})
    a, b, c, d, e = ids

    # Ten in-subset pairs. (a, b) is third strongest, and neither endpoint has
    # it as *its* strongest, so the top-k pass skips it -- it can only be drawn
    # by the cross-cluster window, which covers the top 3 of the ten.
    weak = [(x, y, 0.10) for i, x in enumerate(ids) for y in ids[i + 1:] if {x, y} not in ({a, c}, {b, d}, {a, b})]
    scores(
        (a, c, 0.90),
        (b, d, 0.80),
        (a, b, 0.70),
        *weak,
        # The archive dwarfs the project, and every one of its pairs outranks
        # everything above.
        *[(f"far-{n}", f"far-{n + 1}", 0.99) for n in range(200)],
    )

    drawn = {tuple(sorted((edge["source"], edge["target"]))) for edge in graph_layout.build_graph(reference_ids=ids)["edges"]}
    assert tuple(sorted((a, b))) in drawn


def test_scoping_to_one_reference_or_none_is_an_empty_graph(archive, monkeypatch):
    a = image(archive, "a", (200, 30, 30))
    b = image(archive, "b", (30, 30, 200))
    seed_vectors(monkeypatch, {a: 1.0, b: -1.0})
    scores((a, b, 0.5))

    empty = {"nodes": [], "edges": [], "planes": [], "cluster_count": 0}
    assert graph_layout.build_graph(reference_ids=[a]) == empty
    assert graph_layout.build_graph(reference_ids=[]) == empty


def test_a_subset_with_nothing_embedded_is_empty_rather_than_a_crash(archive, monkeypatch):
    """A project of text notes, or an index that hasn't caught up: there are
    references but no vectors, and k-means on an empty array raises."""
    a = image(archive, "a", (200, 30, 30))
    b = image(archive, "b", (30, 30, 200))
    seed_vectors(monkeypatch, {})
    scores((a, b, 0.5))

    assert graph_layout.build_graph(reference_ids=[a, b])["nodes"] == []


def test_scoped_clusters_are_found_within_the_subset(archive, monkeypatch):
    """Scoping is not a filter over the archive's layout: two references that
    share the archive's cluster are still split from each other when they are
    the only two being laid out."""
    a = image(archive, "a", (200, 30, 30))
    b = image(archive, "b", (190, 40, 40))
    others = [image(archive, f"far{i}", (30, 30, 200)) for i in range(6)]
    seed_vectors(monkeypatch, {a: 1.0, b: 0.9, **{i: -1.0 for i in others}})
    scores((a, b, 0.4))

    whole = {n["id"]: n["cluster"] for n in graph_layout.build_graph()["nodes"]}
    assert whole[a] == whole[b]

    scoped = graph_layout.build_graph(reference_ids=[a, b])
    assert len({n["cluster"] for n in scoped["nodes"]}) == 2


# --- The routes -------------------------------------------------------------


def project_with(client, refs):
    project = client.post("/api/projects", json={"title": "P"}).get_json()
    for ref_id in refs:
        client.post(f"/api/projects/{project['id']}/references", json={"reference_id": ref_id})
    return project["id"]


def test_project_graph_route_scopes_to_the_project(client, archive, monkeypatch):
    a = image(archive, "a", (200, 30, 30))
    b = image(archive, "b", (30, 30, 200))
    c = image(archive, "c", (30, 200, 30))
    seed_vectors(monkeypatch, {a: 1.0, b: -1.0, c: 1.0})
    scores((a, b, 0.9), (a, c, 0.8), (b, c, 0.7))
    pid = project_with(client, [a, b])

    body = client.get(f"/api/projects/{pid}/similarity/graph").get_json()
    assert {n["id"] for n in body["nodes"]} == {a, b}


def test_project_graph_route_reports_missing_scores_like_the_archive_route(client, archive, monkeypatch):
    a = image(archive, "a", (200, 30, 30))
    b = image(archive, "b", (30, 30, 200))
    seed_vectors(monkeypatch, {a: 1.0, b: -1.0})
    pid = project_with(client, [a, b])

    scoped = client.get(f"/api/projects/{pid}/similarity/graph")
    unscoped = client.get("/api/similarity/graph")
    assert scoped.status_code == unscoped.status_code == 400
    assert scoped.get_json()["error"] == unscoped.get_json()["error"]


def test_project_graph_route_404s_for_an_unknown_project(client, archive, monkeypatch):
    a = image(archive, "a", (200, 30, 30))
    b = image(archive, "b", (30, 30, 200))
    seed_vectors(monkeypatch, {a: 1.0, b: -1.0})
    scores((a, b, 0.5))

    assert client.get("/api/projects/nope/similarity/graph").status_code == 404
