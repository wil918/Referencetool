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


# --- The constellation view --------------------------------------------------
#
# A third archive-wide layout, alongside the cluster-plane stack above and the
# LCh colour cylinder in colour.py: every reference placed by CLIP similarity
# alone, via a force-directed simulation in 3D rather than a clustered/radial
# arrangement. It is a fourth CALLER of shared/scene-host.js (see
# static/constellation-map.js), not a fourth renderer.
#
# CLIP's "modality gap" -- text and image embeddings occupy separate cones of
# the embedding space, so text-image cosine similarity runs systematically
# lower than image-image similarity regardless of actual conceptual closeness
# (embeddings.query_index's docstring covers the same effect for search). Left
# uncorrected here, it dominates: the single most valuable axis of a
# similarity-driven layout ends up spent separating "is this a text note or an
# image" -- a distinction the file extension already gives for free -- rather
# than anything about content. _corrected_similarity_matrix standardises the
# three pair blocks (image-image, text-text, image-text) onto one shared
# mean/std before anything is laid out.

# Constant, not random -- this view has to be reproducible: the same archive
# must always produce the same map (build_graph and colour.colour_map() both
# guarantee this too, the latter because its layout has no iterative step at
# all). Its actual value carries no meaning.
CONSTELLATION_SEED = 20240607

# Tuned against the real archive (131 references, 116 image / 15 text) rather
# than picked blind: this combination lands stress ~0.28 and neighbour
# retention ~0.34 there, matching the honesty figures the plan for this view
# was written against, in ~0.7s -- comfortably "well under a second".
CONSTELLATION_ITERATIONS_MAX = 1500
CONSTELLATION_ITERATIONS_MIN = 200
CONSTELLATION_REPEL_K = 0.5
CONSTELLATION_ATTRACT_K = 0.5
CONSTELLATION_INITIAL_STEP = 0.3
CONSTELLATION_COOLING = 0.994
CONSTELLATION_EDGE_TOP_FRACTION = 0.02  # sparse -- positions already carry the similarity information

# Past roughly this many references, an O(n^2)-per-iteration simulation run on
# every request starts costing multiple seconds even with the iteration count
# tapered below, and this should become a stored, versioned table --
# `constellation_layout`, the same shape as `colour_analysis` (hard rule 8) --
# recomputed on demand (a button, like Calculate Similarity Scores) rather
# than inline in the route. Not needed yet: at today's archive size (~130
# references) this whole function runs in well under a second.
CONSTELLATION_STORED_TABLE_THRESHOLD = 500


def _iteration_count(n):
    """Fewer iterations as the archive grows, so an O(n^2)-per-iteration
    simulation degrades gracefully instead of getting slower without bound.
    ~130 references (today's archive) gets close to the maximum; by the
    ~500-reference mark noted above it's already down near the floor."""
    return int(np.clip(CONSTELLATION_ITERATIONS_MAX - n, CONSTELLATION_ITERATIONS_MIN, CONSTELLATION_ITERATIONS_MAX))


def _corrected_similarity_matrix(ids, ref_by_id, scores):
    """Standardise the raw CLIP similarity matrix so image-image, text-text
    and image-text pairs share one common mean and standard deviation --
    correcting CLIP's modality gap for this layout only.

    This is purely a layout-time transform over data already in
    similarity_scores: nothing here is written back to the table, and
    /api/similarity and /api/similarity/graph are untouched.

    Returns `(corrected, known)`: `corrected` is an (n, n) matrix in [0, 1]
    with a unit diagonal (a pair with no stored score is filled with the
    archive-wide mean, post-correction, so the force layout always has a
    spring strength to work with); `known` is the (n, n) boolean mask of
    which off-diagonal entries actually came from a stored score, so the
    honesty figures below don't credit the layout for guesses it had to make.
    """
    n = len(ids)
    index = {ref_id: i for i, ref_id in enumerate(ids)}
    raw = np.full((n, n), np.nan)
    for row in scores:
        ia, ib = index.get(row["reference_id_a"]), index.get(row["reference_id_b"])
        if ia is None or ib is None:
            continue
        raw[ia, ib] = raw[ib, ia] = row["score"]

    known = ~np.isnan(raw)
    np.fill_diagonal(known, False)

    iu, ju = np.triu_indices(n, k=1)
    pair_known = known[iu, ju]
    pair_vals = raw[iu, ju]
    corrected = raw.copy()
    fill_value = 0.0

    if pair_known.any():
        global_mean = float(pair_vals[pair_known].mean())
        global_std = float(pair_vals[pair_known].std()) or 1e-9

        # A reference's type today is always "image" or "text" (ingest.py),
        # i.e. exactly the three blocks the module docstring names -- but
        # blocks are found from whatever types are actually present, so a
        # future type falls into its own block instead of crashing, and an
        # archive with only one type (no text at all, say) simply has one.
        types = [ref_by_id[ref_id]["type"] for ref_id in ids]
        # A plain "typeA::typeB" string key rather than a tuple: numpy treats
        # an object array of same-length tuples as a 2D array of their
        # elements instead of a 1D array of tuple objects, which breaks the
        # `blocks == block` comparison below.
        blocks = np.array(["::".join(sorted((types[a], types[b]))) for a, b in zip(iu, ju)])

        for block in {b for b, k in zip(blocks, pair_known) if k}:
            sel = pair_known & (blocks == block)
            block_vals = pair_vals[sel]
            block_mean = block_vals.mean()
            block_std = block_vals.std() or 1e-9
            adjusted = (block_vals - block_mean) / block_std * global_std + global_mean
            rows_sel, cols_sel = iu[sel], ju[sel]
            corrected[rows_sel, cols_sel] = adjusted
            corrected[cols_sel, rows_sel] = adjusted

        fill_value = float(np.clip(global_mean, 0.0, 1.0))

    corrected = np.clip(np.nan_to_num(corrected, nan=fill_value), 0.0, 1.0)
    np.fill_diagonal(corrected, 1.0)
    return corrected, known


def _force_layout_3d(similarity):
    """Force-directed 3D layout: springs proportional to corrected
    similarity pull every pair together, a Coulomb-like repulsion between
    ALL pairs (not just connected ones) keeps the whole thing from
    collapsing, and the step size cools geometrically so the simulation
    settles rather than oscillating forever.

    Deterministic by construction: `similarity`'s rows/columns are already in
    the caller's stable id-sorted order (build_constellation), and the only
    randomness -- the starting positions -- is drawn from a fixed-seed
    generator (CONSTELLATION_SEED), so the same input always produces the
    same output.
    """
    n = similarity.shape[0]
    rng = np.random.default_rng(CONSTELLATION_SEED)
    positions = rng.normal(scale=1.0, size=(n, 3))

    step = CONSTELLATION_INITIAL_STEP
    for _ in range(_iteration_count(n)):
        # diff[i, j] = positions[i] - positions[j]; diagonal is exactly zero,
        # so it contributes nothing to either force below without needing to
        # be masked out separately.
        diff = positions[:, None, :] - positions[None, :, :]
        dist = np.linalg.norm(diff, axis=2)
        dist_safe = np.maximum(dist, 1e-6)  # guards a pathological coincidence, not the (zero) diagonal

        # Repulsion pushes i away from j: Coulomb-like, direction diff/dist,
        # magnitude REPEL_K / dist^2.
        repel = diff / dist_safe[:, :, None] ** 3 * CONSTELLATION_REPEL_K
        # Attraction pulls i toward j: a spring with no fixed rest length, so
        # a highly similar pair is simply pulled harder the further apart it
        # currently is.
        attract = -diff * similarity[:, :, None] * CONSTELLATION_ATTRACT_K

        net = (repel + attract).sum(axis=1)
        norms = np.linalg.norm(net, axis=1, keepdims=True)
        norms_safe = np.maximum(norms, 1e-9)
        # Cooling: cap this iteration's displacement at `step`, which decays
        # every iteration -- an early, large step gets the layout roughly
        # right, and later, small steps settle it instead of jittering.
        positions = positions + net / norms_safe * np.minimum(norms, step)
        step *= CONSTELLATION_COOLING

    return positions


def _kruskal_stress(actual, target, mask):
    """Kruskal stress (formula 1, linear rescaling rather than a monotonic
    one): how much the 3D layout's distances distort the corrected-similarity
    distances it was actually asked to reproduce, after the best single
    rescaling between the two -- the simulation has no fixed length unit of
    its own, so `actual` and `target` start in different scales.

    0 is a perfect embedding; there is no fixed ceiling, though Kruskal's own
    rule of thumb puts a "poor" fit around 0.2, which is roughly where a
    131-reference archive lands (~0.26, measured) -- see build_constellation's
    docstring for why that's reported rather than hidden.
    """
    a = actual[mask]
    t = target[mask]
    if a.size == 0:
        return 0.0
    denom = np.sum(a * a)
    if denom == 0:
        return 0.0
    scale = np.sum(a * t) / denom
    stress_den = np.sum(t * t)
    if stress_den == 0:
        return 0.0
    return float(np.sqrt(np.sum((scale * a - t) ** 2) / stress_den))


def _neighbour_retention(actual, target, known, k=5):
    """For what fraction of references the true nearest neighbour -- by
    corrected similarity, among pairs that actually have a stored score -- is
    among its k nearest on the map, by 3D distance.

    This is the honesty figure that matters most: a browsing map is not a
    precise neighbour finder (that's what /api/references' distance search
    already is), and this number says exactly how rough it is -- around 0.32
    on a 131-reference archive, measured, which is why it ships in the UI
    rather than being rounded away.
    """
    n = target.shape[0]
    hits = 0
    considered = 0
    for i in range(n):
        row_known = known[i]
        if not row_known.any():
            continue
        considered += 1
        row_target = np.where(row_known, target[i], np.inf)
        true_neighbour = int(np.argmin(row_target))

        row_actual = actual[i].copy()
        row_actual[i] = np.inf
        nearest = np.argsort(row_actual)[:k]
        if true_neighbour in nearest:
            hits += 1

    return hits / considered if considered else 0.0


def _strongest_constellation_edges(ids, corrected, known):
    """The sparse top fraction of known pairs by corrected similarity -- the
    positions themselves already carry the similarity information in this
    view (unlike the plane stack, which needs edges to show what a radial
    position alone can't), so anything more than a few strong threads would
    just be visual noise. See static/constellation-map.js.
    """
    n = len(ids)
    iu, ju = np.triu_indices(n, k=1)
    mask = known[iu, ju]
    if not mask.any():
        return []

    idx_i, idx_j, vals = iu[mask], ju[mask], corrected[iu, ju][mask]
    order = np.argsort(-vals)
    cutoff = max(1, int(len(order) * CONSTELLATION_EDGE_TOP_FRACTION))
    chosen = order[:cutoff]
    return [
        {"source": ids[idx_i[c]], "target": ids[idx_j[c]], "score": float(vals[c])}
        for c in chosen
    ]


def build_constellation(reference_ids=None):
    """The whole archive (or, scoped, one project's references) laid out by
    CLIP similarity alone -- a force-directed 3D map rather than the plane
    stack's clustered/radial arrangement. Clusters are still found (reusing
    build_graph's own k-means labels, not run twice) so the two views agree
    on colour, but here they only colour nodes; they don't shape the layout.
    """
    refs = db.list_references()
    if reference_ids is not None:
        wanted = set(reference_ids)
        refs = [r for r in refs if r["id"] in wanted]
    if len(refs) < 2:
        return {"nodes": [], "edges": [], "cluster_count": 0, "stress": 0.0, "neighbour_retention": 0.0}

    ref_by_id = {r["id"]: r for r in refs}
    collection = embeddings.get_collection()
    result = collection.get(ids=list(ref_by_id.keys()), include=["embeddings"])
    vectors_by_id = dict(zip(result["ids"], result["embeddings"]))
    # Sorted so the simulation's input order -- and so its output -- never
    # varies between calls: _force_layout_3d's only randomness is a
    # fixed-seed generator, so a fixed row/column order is what makes the
    # whole thing reproducible rather than just the first draw of it.
    ids = sorted(vectors_by_id.keys())
    if len(ids) < 2:
        # Nothing embedded in this set (a project of text notes that haven't
        # been indexed, or an index that hasn't caught up) -- same empty
        # result build_graph gives for the same case.
        return {"nodes": [], "edges": [], "cluster_count": 0, "stress": 0.0, "neighbour_retention": 0.0}

    scores = db.list_similarity_scores()
    if reference_ids is not None:
        laid_out = set(ids)
        scores = [
            row for row in scores
            if row["reference_id_a"] in laid_out and row["reference_id_b"] in laid_out
        ]

    corrected, known = _corrected_similarity_matrix(ids, ref_by_id, scores)
    positions = _force_layout_3d(corrected)

    target_dist = 1.0 - corrected
    np.fill_diagonal(target_dist, 0.0)
    diff = positions[:, None, :] - positions[None, :, :]
    actual_dist = np.linalg.norm(diff, axis=2)

    iu = np.triu_indices(len(ids), k=1)
    stress = _kruskal_stress(actual_dist[iu], target_dist[iu], known[iu])
    neighbour_retention = _neighbour_retention(actual_dist, target_dist, known)

    # The plane view's own k-means labels, reused rather than reclustered --
    # both views should visibly agree about what the groups are. build_graph
    # already handles every edge case this function needs (no embeddings,
    # fewer than two references), so nothing here duplicates that. Its planes'
    # edge_color (the average/dominant blend, saturated enough to read as a
    # small dot rather than the softer face_color meant for translucent
    # glass) rides along too, so a node's colour here is the plane view's
    # colour for that same cluster, not just a self-consistent one.
    plane_graph = build_graph(reference_ids=list(ref_by_id.keys()))
    cluster_of = {n["id"]: n["cluster"] for n in plane_graph["nodes"]}
    cluster_color = {p["cluster"]: p["edge_color"] for p in plane_graph["planes"]}

    nodes = [
        {
            "id": ref_id,
            "cluster": cluster_of.get(ref_id, 0),
            "color": cluster_color.get(cluster_of.get(ref_id, 0), list(NEUTRAL_COLOR)),
            "x": float(positions[i, 0]),
            "y": float(positions[i, 1]),
            "z": float(positions[i, 2]),
        }
        for i, ref_id in enumerate(ids)
    ]

    return {
        "nodes": nodes,
        "edges": _strongest_constellation_edges(ids, corrected, known),
        "cluster_count": plane_graph["cluster_count"],
        "stress": stress,
        "neighbour_retention": neighbour_retention,
    }
