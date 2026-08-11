"""Builds the 3D similarity graph: references grouped into clusters (each
rendered as its own parallel plane), positioned radially within their
cluster, and connected by threads drawn from the saved similarity scores.

Everything here is local computation over data that already exists --
clustering is k-means over the CLIP embeddings already stored in Chroma, and
edges come from the similarity_scores table (Settings > Calculate Similarity
Scores). No API calls.
"""
from collections import Counter

import numpy as np
from PIL import Image

import db
import embeddings
from config import REFERENCES_DIR

MIN_CLUSTERS = 2
MAX_CLUSTERS = 6
EDGES_PER_NODE = 4  # top-k nearest neighbours per node, always drawn
CROSS_CLUSTER_TOP_FRACTION = 0.03  # sparse strongest links allowed to jump between planes
PLANE_SPACING = 6.0
PLANE_RADIUS = 5.0
TAGS_PER_NODE = 2  # kept small since they render as floating labels
NEUTRAL_COLOR = (200, 198, 192)  # fallback for a cluster with no sample-able images
COLOR_SAMPLE_SIZE = 32  # downsample each image to this before sampling -- a palette, not a copy


def _kmeans(vectors, k, iterations=25, seed=0):
    """Minimal from-scratch k-means (no sklearn dependency) -- just used to
    split the library into a handful of visual clusters, not for anything
    that needs to be statistically rigorous.
    """
    rng = np.random.default_rng(seed)
    n = len(vectors)
    k = min(k, n)
    centroids = vectors[rng.choice(n, size=k, replace=False)].copy()
    labels = np.full(n, -1)

    for _ in range(iterations):
        dists = np.linalg.norm(vectors[:, None, :] - centroids[None, :, :], axis=2)
        new_labels = dists.argmin(axis=1)
        if np.array_equal(new_labels, labels):
            break
        labels = new_labels
        for c in range(k):
            members = vectors[labels == c]
            if len(members):
                centroids[c] = members.mean(axis=0)
    return labels


def _cluster_colors(image_paths):
    """(average_rgb, dominant_rgb) sampled from a cluster's own images --
    each downsampled to a small palette rather than read at full size, since
    this only needs a rough colourspace, not the images themselves.

    Falls back to a neutral grey if the cluster has no sample-able images
    (e.g. an all-text/PDF cluster).
    """
    sum_r = sum_g = sum_b = 0
    pixel_count = 0
    bucket_counts = Counter()

    for path in image_paths:
        try:
            img = Image.open(path).convert("RGB")
            img.thumbnail((COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE))
            pixels = list(img.getdata())
        except Exception:
            continue
        for r, g, b in pixels:
            sum_r += r
            sum_g += g
            sum_b += b
            pixel_count += 1
            # Quantize so near-identical shades count as the same "common" colour.
            bucket_counts[(r // 24 * 24, g // 24 * 24, b // 24 * 24)] += 1

    if pixel_count == 0:
        return NEUTRAL_COLOR, NEUTRAL_COLOR

    average = (sum_r // pixel_count, sum_g // pixel_count, sum_b // pixel_count)
    dominant = bucket_counts.most_common(1)[0][0]
    return average, dominant


def build_graph(reference_ids=None):
    """The whole archive laid out, or -- given `reference_ids` -- only those
    references, clustered and connected among themselves.

    A scoped graph is the same graph one level down, not a filtered view of
    the archive's: clusters are found within the subset and the planes are
    coloured from the subset's own images, so a project reads as its own
    visual grouping rather than as whichever archive-wide clusters it happens
    to land in.
    """
    refs = db.list_references()
    if reference_ids is not None:
        wanted = set(reference_ids)
        refs = [r for r in refs if r["id"] in wanted]
    if len(refs) < 2:
        return {"nodes": [], "edges": [], "planes": [], "cluster_count": 0}

    ref_by_id = {r["id"]: r for r in refs}
    collection = embeddings.get_collection()
    result = collection.get(ids=list(ref_by_id.keys()), include=["embeddings"])
    ids = result["ids"]
    vectors = np.array(result["embeddings"])
    # Nothing in this set is embedded (a project of text notes, or an index
    # that hasn't caught up) -- there is no vector to cluster, and k-means
    # indexes the empty result as 2-D and raises rather than returning nothing.
    if not ids:
        return {"nodes": [], "edges": [], "planes": [], "cluster_count": 0}

    # //8 floors to 0 below eight references, so the `or` is what keeps a
    # small set (a five-reference project) at MIN_CLUSTERS instead of asking
    # for zero clusters. _kmeans then clamps k to the number of vectors, and
    # a cluster that ends up with no members never becomes a plane -- planes
    # are built from the labels that were actually assigned.
    k = max(MIN_CLUSTERS, min(MAX_CLUSTERS, len(ids) // 8 or MIN_CLUSTERS))
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        labels = _kmeans(vectors, k)
    cluster_of = dict(zip(ids, labels.tolist()))

    scores = db.list_similarity_scores()
    if reference_ids is not None:
        # Only pairs with both endpoints inside the subset. Dropping them here
        # rather than at draw time also fixes the cross-cluster cutoff below,
        # which is a fraction of `scores`: taken over the whole archive it
        # would spend a small project's entire allowance on pairs that aren't
        # in it, and the scoped graph would come out with no long threads.
        laid_out = set(ids)
        scores = [
            row for row in scores
            if row["reference_id_a"] in laid_out and row["reference_id_b"] in laid_out
        ]

    adjacency = {i: [] for i in ids}
    for row in scores:
        a, b, s = row["reference_id_a"], row["reference_id_b"], row["score"]
        if a in adjacency and b in adjacency:
            adjacency[a].append((b, s))
            adjacency[b].append((a, s))

    # Sum of similarity to everything else -- used to pick each cluster's
    # "hub" (goes in the centre of its plane) and to order the rest.
    degree = {i: sum(s for _, s in neighbours) for i, neighbours in adjacency.items()}

    clusters = {}
    for i in ids:
        clusters.setdefault(cluster_of[i], []).append(i)

    nodes = []
    planes = []
    for cluster_id, members in clusters.items():
        hub = max(members, key=lambda i: degree[i])
        hub_scores = dict(adjacency[hub])
        ordered = sorted(members, key=lambda i: -degree[i])
        z = (cluster_id - (len(clusters) - 1) / 2) * PLANE_SPACING

        image_paths = [
            REFERENCES_DIR / ref_by_id[i]["filepath"] for i in members if ref_by_id[i]["type"] == "image"
        ]
        average, dominant = _cluster_colors(image_paths)
        # The edge/rim colour is the average and the dominant colour blended
        # together, rather than either alone.
        edge_color = tuple((a + d) // 2 for a, d in zip(average, dominant))
        planes.append({"cluster": cluster_id, "z": z, "face_color": list(average), "edge_color": list(edge_color)})

        for idx, i in enumerate(ordered):
            if i == hub:
                x, y = 0.0, 0.0
            else:
                # Closer to the hub in similarity -> closer to the plane's
                # centre, so the strongest local connections visually
                # converge -- the "starburst" look.
                sim_to_hub = max(0.0, min(hub_scores.get(i, 0.2), 0.95))
                radius = PLANE_RADIUS * (1.0 - sim_to_hub)
                angle = (idx / max(1, len(ordered) - 1)) * 2 * np.pi
                x, y = radius * np.cos(angle), radius * np.sin(angle)

            ref = ref_by_id[i]
            ext = ("." + ref["filepath"].rsplit(".", 1)[-1].lower()) if "." in ref["filepath"] else ""
            nodes.append(
                {
                    "id": i,
                    "title": ref["title"],
                    "type": ref["type"],
                    "ext": ext,
                    "is_own_work": ref["is_own_work"],
                    "tags": ref["tags"][:TAGS_PER_NODE],
                    "cluster": cluster_id,
                    "is_hub": i == hub,
                    "x": x,
                    "y": y,
                    "z": z,
                }
            )

    # Edges: each node's strongest local links (always drawn, keeps every
    # node connected to its own plane) plus a sparse set of the globally
    # strongest links overall, which -- because most of those sit between
    # different clusters -- become the long threads crossing between planes.
    edge_keys = set()
    edges = []

    def add_edge(a, b, score):
        key = tuple(sorted((a, b)))
        if key in edge_keys:
            return
        edge_keys.add(key)
        edges.append(
            {"source": key[0], "target": key[1], "score": score, "cross_cluster": cluster_of[a] != cluster_of[b]}
        )

    for i in ids:
        top = sorted(adjacency[i], key=lambda pair: -pair[1])[:EDGES_PER_NODE]
        for other, score in top:
            add_edge(i, other, score)

    ranked = sorted(scores, key=lambda r: -r["score"])
    cutoff = max(1, int(len(ranked) * CROSS_CLUSTER_TOP_FRACTION))
    for row in ranked[:cutoff]:
        a, b, s = row["reference_id_a"], row["reference_id_b"], row["score"]
        if a in cluster_of and b in cluster_of:
            add_edge(a, b, s)

    return {"nodes": nodes, "edges": edges, "planes": planes, "cluster_count": len(clusters)}
