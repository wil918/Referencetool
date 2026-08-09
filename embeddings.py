"""Embedding generation and local vector storage.

Uses CLIP (via sentence-transformers) so that images AND text land in the
SAME embedding space. That's what lets you search images with a text query,
or find an essay related to a photograph, later on.

Uses Chroma in local persistent mode -- it's just a folder on disk, no
server to run.
"""
import statistics

import numpy as np
from PIL import Image

import chromadb
from sentence_transformers import SentenceTransformer

from config import CHROMA_DIR

_model = None


def get_model():
    global _model
    if _model is None:
        # clip-ViT-B-32: general-purpose multimodal embedding model.
        # Downloads once (~600MB) on first use, then runs fully offline.
        _model = SentenceTransformer("clip-ViT-B-32")
    return _model


def embed_image(image_path):
    model = get_model()
    image = Image.open(image_path).convert("RGB")
    return model.encode(image).tolist()


def embed_text(text):
    model = get_model()
    # CLIP's text tower has a short effective context window, so trim
    # long essays -- this is used for similarity search, not summarization.
    trimmed = text[:2000] if text else ""
    return model.encode(trimmed).tolist()


def embed_combined(text=None, image_paths=None):
    """Average CLIP embeddings across text and any accompanying images.

    Used for PDFs: a lookbook PDF might be mostly images with little text,
    or mostly text with one diagram -- averaging keeps whichever content
    is present from being ignored in similarity search.
    """
    model = get_model()
    vectors = []

    if text and text.strip():
        vectors.append(np.array(model.encode(text[:2000])))

    for img_path in image_paths or []:
        try:
            image = Image.open(img_path).convert("RGB")
            vectors.append(np.array(model.encode(image)))
        except Exception:
            continue  # a corrupt embedded image shouldn't sink the whole reference

    if not vectors:
        raise ValueError("Nothing to embed: no usable text or images.")

    combined = np.mean(vectors, axis=0)
    norm = np.linalg.norm(combined)
    if norm > 0:
        combined = combined / norm
    return combined.tolist()


_client = None
_collection = None


def get_collection():
    global _client, _collection
    if _collection is None:
        _client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        _collection = _client.get_or_create_collection(
            name="references", metadata={"hnsw:space": "cosine"}
        )
    return _collection


def add_to_index(ref_id, embedding, metadata):
    collection = get_collection()
    collection.add(ids=[ref_id], embeddings=[embedding], metadatas=[metadata])


def remove_from_index(ref_id):
    """Drop a reference's vector from the index. Safe to call for an id that
    isn't there (e.g. a reference that never got embedded)."""
    collection = get_collection()
    try:
        collection.delete(ids=[ref_id])
    except Exception:
        pass


def compute_all_pairwise_similarities():
    """Cosine similarity between every pair of references currently in the
    library, computed entirely from the embeddings already stored for each
    one -- pure local vector math, no API calls of any kind.

    Returns a list of (reference_id_a, reference_id_b, score) tuples, one
    per unique pair (ids ordered so a < b, no duplicate/reverse pairs).
    """
    collection = get_collection()
    result = collection.get(include=["embeddings"])
    ids = result["ids"]
    if len(ids) < 2:
        return []

    vectors = np.array(result["embeddings"])
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1e-9  # avoid dividing by zero for a (shouldn't-happen) all-zero embedding
    normalized = vectors / norms
    # macOS's Accelerate BLAS backend raises spurious divide/overflow/invalid
    # warnings on this matmul that don't correspond to real NaN/Inf in the
    # result (a known numpy+Accelerate quirk) -- suppressed rather than left
    # to alarm anyone watching the server's console output.
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        similarity_matrix = normalized @ normalized.T

    pairs = []
    n = len(ids)
    for i in range(n):
        for j in range(i + 1, n):
            a, b = ids[i], ids[j]
            if a > b:
                a, b = b, a
            pairs.append((a, b, float(similarity_matrix[i, j])))
    return pairs


def match_label(z_score):
    """Translate a query_index() relative_score into a human label."""
    if z_score > 1.5:
        return "strong match"
    elif z_score > 0.5:
        return "related"
    else:
        return "loose / weak match"


def query_index(embedding, n_results=5, exclude_ids=None):
    """Return the n_results nearest neighbours, each with a *relative* match score.

    Raw CLIP cosine similarity runs high for almost everything -- it's a known
    quirk of CLIP's embedding space, where even unrelated items often land at
    0.5-0.8 "similarity". Treating that number as an absolute 0-100% score is
    misleading. Instead, each result's distance is compared to the spread of
    distances across your whole library, and scored as a z-score: how much of
    an outlier (in the good direction) it is relative to your other items.
    This needs a reasonable number of references in the library to be
    meaningful -- with only a few items in total, treat it as rough ranking.

    That baseline is computed *per modality* (image vs. text/PDF), and results
    are ranked by that grouped z-score rather than raw distance. CLIP has a
    well-documented "modality gap": for a text query, distances to other text
    embeddings run systematically closer than distances to image embeddings,
    even when an image is the better conceptual match. Without correcting for
    that, text/PDF references would always crowd out equally-relevant images
    (and vice versa for an image query) regardless of which is actually the
    stronger match.
    """
    exclude_ids = set(exclude_ids or [])
    collection = get_collection()
    total = collection.count()
    if total == 0:
        return []

    # Fetch every candidate rather than just the nearest few by raw distance --
    # otherwise a genuinely strong match in the smaller/rarer modality could be
    # pushed out of the fetch window before grouped re-ranking ever sees it.
    results = collection.query(query_embeddings=[embedding], n_results=total)

    ids = results["ids"][0]
    distances = results["distances"][0]
    metadatas = results["metadatas"][0]

    filtered = [(i, d, m) for i, d, m in zip(ids, distances, metadatas) if i not in exclude_ids]
    if not filtered:
        return []

    by_group = {}
    for _, distance, metadata in filtered:
        by_group.setdefault(metadata.get("type"), []).append(distance)
    group_stats = {
        group: (statistics.fmean(ds), statistics.pstdev(ds) or 1e-9) for group, ds in by_group.items()
    }

    scored = []
    for ref_id, distance, metadata in filtered:
        mean_d, std_d = group_stats[metadata.get("type")]
        z_score = (mean_d - distance) / std_d  # higher = closer than typical for this query, within its modality
        scored.append((ref_id, distance, z_score, metadata))

    scored.sort(key=lambda s: s[2], reverse=True)

    return [
        {"id": ref_id, "distance": distance, "relative_score": z_score, "metadata": metadata}
        for ref_id, distance, z_score, metadata in scored[:n_results]
    ]
