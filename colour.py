"""Colour analysis and colour-similarity search.

Why this exists separately from `embeddings.py`: the CLIP embeddings already
in the archive are dominated by shape and semantics, not colour. Measured on
synthetic pairs where shape and colour vary independently, CLIP loses more
similarity to a shape change (0.166) than to a colour change (0.132) -- and,
decisively, searching from a red circle it scores a *blue circle* (0.87)
above a *red triangle* (0.79). Ranking a colour search by CLIP would put
colour-mismatched results on top. CLIP also offers no separable hue /
lightness / saturation axes for the search controls to weight. So colour is
represented explicitly here, and the existing embeddings are left untouched
and independently useful.

Everything is deterministic: the same image bytes and the same
ANALYSIS_VERSION always produce the same profile, which is what makes the
stored analysis safe to cache and compare.

The work happens in CIE Lab rather than RGB because Lab is approximately
perceptually uniform -- equal numeric distances look like roughly equal
colour differences, which plain RGB distance badly fails at (it treats a
near-black pair as far apart as a vivid pair).
"""
import json

import numpy as np
from PIL import Image

# Bump when the analysis algorithm changes in a way that makes previously
# stored profiles incomparable with new ones. Stored alongside every profile
# so a mixed-version archive is detectable rather than silently wrong.
ANALYSIS_VERSION = 1

# Analysis parameters. Fixed rather than tunable: they're part of what
# ANALYSIS_VERSION identifies, so changing one means bumping the version.
SAMPLE_EDGE = 128        # longest edge the image is resized to before sampling
PALETTE_SIZE = 6         # dominant colours extracted per image
KMEANS_ITERATIONS = 25
HUE_BINS = 12            # 30 degrees each
TONE_BINS = 5            # lightness and saturation histograms
# A colour covering less than this share of the image isn't part of its
# colour character -- it's an anti-aliased edge or a stray highlight. Without
# this, k-means spends most of a 2-colour image's palette on slivers of
# boundary blend, which both clutters the displayed palette strip and
# slightly dilutes the proportion comparison.
MIN_PALETTE_WEIGHT = 0.02
# Lab distance below which two palette entries are the same colour as far as
# a person is concerned (a just-noticeable difference is around 2.3). Cluster
# centres this close are merged: k-means can otherwise settle two centres on
# what is visibly one colour -- especially when pooling several images'
# palettes, where each contributes its own near-identical "black" that sits
# at a distinct local minimum and never coalesces on its own.
MERGE_LAB_DISTANCE = 6.0

# Chroma (sqrt(a^2+b^2)) at or above this counts as fully saturated when
# normalising. Real images rarely exceed it; sRGB's most vivid colours sit
# around 100-130.
CHROMA_CEILING = 110.0
# Below this chroma a pixel is effectively grey, and its hue angle is noise
# -- so it contributes to lightness but not to the hue histogram.
GREY_CHROMA = 8.0

# Thresholds for the "remove black and white" toggle: a colour counts as
# near-black or near-white only if it's BOTH lightness-extreme AND close to
# neutral -- a saturated colour is never "black" or "white" no matter how
# dark or pale it is. Checked against real archive references: plain studio
# backdrops routinely land a single palette entry at L 85-99 or L 5-20 with
# chroma under 8, at 30-97% of the whole image's weight, which is exactly the
# background-domination this toggle exists to remove.
NEUTRAL_CHROMA_MAX = 12.0
BLACK_LIGHTNESS_MAX = 20.0
WHITE_LIGHTNESS_MIN = 85.0

# --- sRGB <-> CIE Lab -------------------------------------------------------
# Standard D65 conversion. Written out rather than pulled from a colour
# library so the project gains no new dependency for ~20 lines of arithmetic.

_RGB_TO_XYZ = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
])
_XYZ_TO_RGB = np.linalg.inv(_RGB_TO_XYZ)
_D65 = np.array([0.95047, 1.0, 1.08883])
_EPS = 216 / 24389
_KAPPA = 24389 / 27


def rgb_to_lab(rgb):
    """(..., 3) uint8/float sRGB in 0-255 -> (..., 3) Lab."""
    srgb = np.asarray(rgb, dtype=np.float64) / 255.0
    linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    # macOS's Accelerate BLAS backend raises spurious divide/overflow/invalid
    # warnings on matmul that don't correspond to real NaN/Inf in the result
    # -- the same known numpy+Accelerate quirk already handled in
    # embeddings.compute_all_pairwise_similarities().
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        xyz = linear @ _RGB_TO_XYZ.T / _D65
    f = np.where(xyz > _EPS, np.cbrt(xyz), (_KAPPA * xyz + 16) / 116)
    return np.stack([
        116 * f[..., 1] - 16,
        500 * (f[..., 0] - f[..., 1]),
        200 * (f[..., 1] - f[..., 2]),
    ], axis=-1)


def lab_to_rgb(lab):
    """Inverse of rgb_to_lab, clipped to displayable sRGB.

    Needed because palette entries are cluster centres computed in Lab; the
    swatch shown in the UI should be that exact centre, not an approximation
    of it averaged in some other space.
    """
    lab = np.asarray(lab, dtype=np.float64)
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200

    def inv(f):
        cubed = f ** 3
        return np.where(cubed > _EPS, cubed, (116 * f - 16) / _KAPPA)

    xyz = np.stack([inv(fx), inv(fy), inv(fz)], axis=-1) * _D65
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        linear = xyz @ _XYZ_TO_RGB.T
    srgb = np.where(
        linear <= 0.0031308, linear * 12.92, 1.055 * np.maximum(linear, 0) ** (1 / 2.4) - 0.055
    )
    return np.clip(np.rint(srgb * 255), 0, 255).astype(int)


# --- Deterministic weighted k-means -----------------------------------------


def _kmeans(points, weights, k, iterations=KMEANS_ITERATIONS):
    """Weighted k-means with deterministic seeding.

    Seeded by a fixed farthest-point rule rather than random or k-means++
    sampling: with no RNG anywhere, the same pixels always give the same
    palette, which is what lets a stored profile be trusted as a cache and
    compared against profiles computed at other times.

    Returns (centres, centre_weights) with weights summing to 1.
    """
    points = np.asarray(points, dtype=np.float64)
    weights = np.asarray(weights, dtype=np.float64)
    if len(points) == 0:
        return np.zeros((0, points.shape[1] if points.ndim > 1 else 3)), np.zeros(0)

    k = min(k, len(np.unique(points, axis=0)))
    if k <= 1:
        centre = np.average(points, axis=0, weights=weights)
        return centre[None, :], np.array([1.0])

    # Seed 1: the weighted mean's nearest actual point. Seeds 2..k: each the
    # point farthest (in Lab) from everything chosen so far -- spreading the
    # initial centres across the colour range so distinct colours survive.
    mean = np.average(points, axis=0, weights=weights)
    centres = [points[np.argmin(((points - mean) ** 2).sum(axis=1))]]
    for _ in range(k - 1):
        d = np.min(
            np.stack([((points - c) ** 2).sum(axis=1) for c in centres]), axis=0
        )
        centres.append(points[int(np.argmax(d))])
    centres = np.array(centres)

    for _ in range(iterations):
        distances = ((points[:, None, :] - centres[None, :, :]) ** 2).sum(axis=2)
        labels = np.argmin(distances, axis=1)
        moved = False
        for i in range(len(centres)):
            mask = labels == i
            mass = weights[mask].sum()
            if mass <= 0:
                continue
            new_centre = np.average(points[mask], axis=0, weights=weights[mask])
            if not np.allclose(new_centre, centres[i]):
                centres[i] = new_centre
                moved = True
        if not moved:
            break

    distances = ((points[:, None, :] - centres[None, :, :]) ** 2).sum(axis=2)
    labels = np.argmin(distances, axis=1)
    masses = np.array([weights[labels == i].sum() for i in range(len(centres))])

    keep = masses > 0
    centres, masses = centres[keep], masses[keep]
    total = masses.sum()
    if total > 0:
        masses = masses / total

    centres, masses = _merge_close_centres(centres, masses)

    # Drop negligible clusters and renormalise, but never drop everything --
    # a genuinely flat image legitimately has one cluster holding all mass.
    if len(masses) > 1:
        significant = masses >= MIN_PALETTE_WEIGHT
        if significant.any():
            centres, masses = centres[significant], masses[significant]
            masses = masses / masses.sum()

    # Largest share first, and ties broken by Lab value so the ordering is
    # itself deterministic rather than dependent on cluster index.
    order = sorted(range(len(masses)), key=lambda i: (-masses[i], tuple(centres[i])))
    return centres[order], masses[order]


def _merge_close_centres(centres, masses, threshold=MERGE_LAB_DISTANCE):
    """Fold cluster centres that are the same colour to the eye into one.

    Heaviest centre first, absorbing any lighter one within `threshold`; the
    survivor moves to the mass-weighted mean of what it absorbed, so the
    merged swatch is where the colour actually sits rather than at whichever
    centre happened to win. Deterministic: the order is fixed by mass then
    Lab value, never by cluster index.
    """
    if len(centres) <= 1:
        return centres, masses

    order = sorted(range(len(masses)), key=lambda i: (-masses[i], tuple(centres[i])))
    merged_centres, merged_masses = [], []
    absorbed = set()

    for i in order:
        if i in absorbed:
            continue
        group = [i]
        for j in order:
            if j == i or j in absorbed:
                continue
            if np.linalg.norm(centres[i] - centres[j]) <= threshold:
                group.append(j)
                absorbed.add(j)
        absorbed.add(i)

        group_mass = masses[list(group)].sum()
        if group_mass > 0:
            centre = np.average(centres[list(group)], axis=0, weights=masses[list(group)])
        else:
            centre = centres[i]
        merged_centres.append(centre)
        merged_masses.append(group_mass)

    return np.array(merged_centres), np.array(merged_masses)


# --- Analysis ---------------------------------------------------------------


def analyse_image(path):
    """Colour profile for one image file. Deterministic for given bytes."""
    with Image.open(path) as img:
        img = img.convert("RGB")
        img.thumbnail((SAMPLE_EDGE, SAMPLE_EDGE), Image.Resampling.LANCZOS)
        pixels = np.asarray(img, dtype=np.uint8).reshape(-1, 3)

    if len(pixels) == 0:
        raise ValueError("image has no pixels")

    lab = rgb_to_lab(pixels)
    return _profile_from_lab(lab, np.ones(len(lab)))


def _profile_from_lab(lab, weights):
    """Build the stored profile from Lab pixels (or weighted Lab points)."""
    lab = np.asarray(lab, dtype=np.float64)
    weights = np.asarray(weights, dtype=np.float64)
    total = weights.sum()
    if total <= 0:
        raise ValueError("no weight to analyse")
    weights = weights / total

    lightness = lab[:, 0] / 100.0
    chroma = np.sqrt(lab[:, 1] ** 2 + lab[:, 2] ** 2)
    saturation = np.clip(chroma / CHROMA_CEILING, 0, 1)

    centres, masses = _kmeans(lab, weights, PALETTE_SIZE)
    palette = [
        {
            "lab": [round(float(v), 3) for v in centre],
            "rgb": [int(v) for v in lab_to_rgb(centre)],
            "weight": round(float(mass), 5),
        }
        for centre, mass in zip(centres, masses)
    ]

    # Hue is only meaningful where there's enough chroma to have one; a near
    # -grey pixel's hue angle is numerical noise and would smear the
    # histogram. Contributions are weighted by chroma so a vivid pixel counts
    # for more than a barely-tinted one.
    hue_weights = weights * np.where(chroma >= GREY_CHROMA, chroma, 0.0)
    hues = (np.degrees(np.arctan2(lab[:, 2], lab[:, 1])) + 360) % 360
    hue_hist = _histogram(hues, hue_weights, bins=HUE_BINS, lo=0.0, hi=360.0)

    return {
        "version": ANALYSIS_VERSION,
        "palette": palette,
        "hue_histogram": hue_hist,
        "lightness_histogram": _histogram(lightness, weights, TONE_BINS, 0.0, 1.0),
        "saturation_histogram": _histogram(saturation, weights, TONE_BINS, 0.0, 1.0),
        "mean_lab": [round(float(v), 3) for v in np.average(lab, axis=0, weights=weights)],
        "lightness": round(float(np.average(lightness, weights=weights)), 5),
        "saturation": round(float(np.average(saturation, weights=weights)), 5),
        # How much of the image has any real colour at all. Separates "muted
        # palette" from "greyscale", which mean saturation alone blurs.
        "chromatic_fraction": round(float(weights[chroma >= GREY_CHROMA].sum()), 5),
    }


def _histogram(values, weights, bins, lo, hi):
    """Normalised weighted histogram, as a plain list for JSON storage."""
    if weights.sum() <= 0:
        return [0.0] * bins
    idx = np.clip(((values - lo) / (hi - lo) * bins).astype(int), 0, bins - 1)
    hist = np.bincount(idx, weights=weights, minlength=bins).astype(float)
    total = hist.sum()
    if total > 0:
        hist = hist / total
    return [round(float(v), 6) for v in hist]


# --- Combining several references into one profile --------------------------


def combine_profiles(profiles):
    """One colour profile representing a *group* of references.

    Deliberately not "search for each, then merge results": the question is
    "what has a colour character like this collection", which is a property
    of the group's aggregate distribution, not of any single member. So the
    members' palettes are pooled -- each entry's weight divided by the number
    of images, so every image contributes equally regardless of how many
    colours it happens to have -- and re-clustered with the same k-means used
    for a single image. A colour that several images share accumulates mass
    and merges into one dominant entry; a colour unique to one image survives
    as a smaller one.

    Histograms and scalars are averaged across members, which is the same
    aggregation applied consistently.
    """
    profiles = [p for p in profiles if p]
    if not profiles:
        raise ValueError("no profiles to combine")
    if len(profiles) == 1:
        return dict(profiles[0])

    n = len(profiles)
    points, weights = [], []
    for profile in profiles:
        for entry in profile.get("palette") or []:
            points.append(entry["lab"])
            weights.append(entry["weight"] / n)

    if not points:
        raise ValueError("profiles contain no palette entries")

    centres, masses = _kmeans(np.array(points), np.array(weights), PALETTE_SIZE)
    palette = [
        {
            "lab": [round(float(v), 3) for v in centre],
            "rgb": [int(v) for v in lab_to_rgb(centre)],
            "weight": round(float(mass), 5),
        }
        for centre, mass in zip(centres, masses)
    ]

    def mean_hist(key):
        stacked = np.array([p[key] for p in profiles], dtype=np.float64)
        averaged = stacked.mean(axis=0)
        total = averaged.sum()
        if total > 0:
            averaged = averaged / total
        return [round(float(v), 6) for v in averaged]

    def mean_scalar(key):
        return round(float(np.mean([p[key] for p in profiles])), 5)

    return {
        "version": ANALYSIS_VERSION,
        "palette": palette,
        "hue_histogram": mean_hist("hue_histogram"),
        "lightness_histogram": mean_hist("lightness_histogram"),
        "saturation_histogram": mean_hist("saturation_histogram"),
        "mean_lab": [
            round(float(v), 3)
            for v in np.mean([p["mean_lab"] for p in profiles], axis=0)
        ],
        "lightness": mean_scalar("lightness"),
        "saturation": mean_scalar("saturation"),
        "chromatic_fraction": mean_scalar("chromatic_fraction"),
        "combined_from": len(profiles),
    }


def _is_near_black_or_white(lab):
    L, a, b = lab
    if np.hypot(a, b) > NEUTRAL_CHROMA_MAX:
        return False  # saturated -- never treated as black or white
    return L <= BLACK_LIGHTNESS_MAX or L >= WHITE_LIGHTNESS_MIN


def remove_black_and_white(profile):
    """A copy of `profile` with near-black/near-white palette entries
    dropped and every derived statistic rebuilt from what's left.

    Applied at query time -- to the combined query profile and to every
    candidate before comparison -- never to the stored analysis, so the
    toggle is free to flip without re-analysing anything. It rebuilds from
    the palette, the same compact representation already shown to the user,
    rather than needing the original pixels back.

    Exists because a plain white or black backdrop, extremely common in
    reference photography, can dominate an image's proportions -- one studio
    background regularly claims 30-97% of a real image's palette weight in
    this archive -- without being part of what makes two garments look
    alike. Also reaches the hue/lightness/saturation histograms, not just
    the palette: those are recomputed from the surviving entries too, so a
    white background stops inflating the lightness dimension even when
    "proportions" isn't the slider in play.

    If every entry would be removed -- the image genuinely is black, white,
    or near-neutral throughout -- filtering is skipped and the original
    profile is returned: there is no other colour to fall back to, and an
    empty profile can't be compared against anything.
    """
    palette = profile.get("palette") or []
    kept = [e for e in palette if not _is_near_black_or_white(e["lab"])]
    if len(kept) == len(palette) or not kept:
        return profile

    total = sum(e["weight"] for e in kept)
    new_palette = [{**e, "weight": round(e["weight"] / total, 5)} for e in kept]
    new_palette.sort(key=lambda e: (-e["weight"], tuple(e["lab"])))  # dominant first, deterministic

    lab_points = np.array([e["lab"] for e in new_palette], dtype=np.float64)
    weights = np.array([e["weight"] for e in new_palette], dtype=np.float64)

    lightness = lab_points[:, 0] / 100.0
    chroma = np.sqrt(lab_points[:, 1] ** 2 + lab_points[:, 2] ** 2)
    saturation = np.clip(chroma / CHROMA_CEILING, 0, 1)
    hue_weights = weights * np.where(chroma >= GREY_CHROMA, chroma, 0.0)
    hues = (np.degrees(np.arctan2(lab_points[:, 2], lab_points[:, 1])) + 360) % 360

    return {
        **profile,
        "palette": new_palette,
        "hue_histogram": _histogram(hues, hue_weights, HUE_BINS, 0.0, 360.0),
        "lightness_histogram": _histogram(lightness, weights, TONE_BINS, 0.0, 1.0),
        "saturation_histogram": _histogram(saturation, weights, TONE_BINS, 0.0, 1.0),
        "mean_lab": [round(float(v), 3) for v in np.average(lab_points, axis=0, weights=weights)],
        "lightness": round(float(np.average(lightness, weights=weights)), 5),
        "saturation": round(float(np.average(saturation, weights=weights)), 5),
        "chromatic_fraction": round(float(weights[chroma >= GREY_CHROMA].sum()), 5),
        "black_white_removed": True,
    }


# --- Similarity -------------------------------------------------------------

DEFAULT_WEIGHTS = {"hue": 1.0, "lightness": 1.0, "saturation": 1.0, "proportions": 1.0}


def similarity(a, b, weights=None):
    """Colour similarity in 0..1 (1 = identical), under the given weights.

    Four independent distances, one per control, combined as a weighted mean.
    Keeping them separate is the point: each slider raises or lowers exactly
    one dimension's influence, so the control has an explainable meaning
    rather than nudging an opaque blend.
    """
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    w = {k: max(0.0, float(v)) for k, v in w.items()}
    if sum(w.values()) <= 0:
        w = dict(DEFAULT_WEIGHTS)

    distances = {
        "hue": _circular_histogram_distance(a["hue_histogram"], b["hue_histogram"]),
        "lightness": _tone_distance(
            a["lightness_histogram"], b["lightness_histogram"], a["lightness"], b["lightness"]
        ),
        "saturation": _tone_distance(
            a["saturation_histogram"], b["saturation_histogram"], a["saturation"], b["saturation"]
        ),
        "proportions": palette_distance(a["palette"], b["palette"]),
    }

    total_weight = sum(w.values())
    distance = sum(distances[k] * w[k] for k in distances) / total_weight
    return max(0.0, min(1.0, 1.0 - distance))


def palette_distance(pa, pb):
    """Transport distance between two weighted palettes, normalised to 0..1.

    This is the "proportions" dimension, and it's what separates
    (black 70 / cream 30) vs (black 65 / cream 35) -- nearly identical -- from
    (red 70 / cream 30), which merely shares one colour. Matching by colour
    alone would call the second pair similar; accounting for how much mass
    sits at each colour is what makes it not.

    Greedy transport rather than exact optimal transport: it repeatedly moves
    as much mass as possible along the cheapest remaining pair. With
    PALETTE_SIZE=6 the gap to optimal is negligible, and it needs no solver
    dependency. The signature is the natural seam to swap in an exact EMD
    later without touching callers.
    """
    if not pa or not pb:
        return 1.0

    a_lab = np.array([e["lab"] for e in pa], dtype=np.float64)
    b_lab = np.array([e["lab"] for e in pb], dtype=np.float64)
    a_w = np.array([e["weight"] for e in pa], dtype=np.float64)
    b_w = np.array([e["weight"] for e in pb], dtype=np.float64)
    a_w = a_w / a_w.sum() if a_w.sum() > 0 else a_w
    b_w = b_w / b_w.sum() if b_w.sum() > 0 else b_w

    cost = np.sqrt(((a_lab[:, None, :] - b_lab[None, :, :]) ** 2).sum(axis=2))

    remaining_a, remaining_b = a_w.copy(), b_w.copy()
    pairs = sorted(
        ((cost[i, j], i, j) for i in range(len(a_w)) for j in range(len(b_w))),
        key=lambda t: (t[0], t[1], t[2]),  # ties broken by index, so it's deterministic
    )

    moved_cost = 0.0
    for c, i, j in pairs:
        if remaining_a[i] <= 0 or remaining_b[j] <= 0:
            continue
        mass = min(remaining_a[i], remaining_b[j])
        moved_cost += mass * c
        remaining_a[i] -= mass
        remaining_b[j] -= mass

    # Normalised by a large-but-reachable Lab distance: 100 is roughly
    # black-to-white, about as far apart as two colours get in practice.
    return float(min(1.0, moved_cost / 100.0))


def _circular_histogram_distance(ha, hb):
    """Distance between hue histograms, respecting that hue wraps around.

    Plain bin-by-bin comparison would call red (bin 0) and magenta (bin 11)
    completely unrelated despite being adjacent on the wheel. This compares
    cumulative mass around the circle instead, so neighbouring hues score as
    close regardless of where the bin boundaries happen to fall.
    """
    a = np.asarray(ha, dtype=np.float64)
    b = np.asarray(hb, dtype=np.float64)
    if a.sum() <= 0 and b.sum() <= 0:
        return 0.0  # both effectively greyscale -- alike, not maximally different
    if a.sum() <= 0 or b.sum() <= 0:
        return 1.0  # one has colour, the other doesn't
    a, b = a / a.sum(), b / b.sum()

    n = len(a)
    diff = a - b
    # Circular earth-mover's distance: the minimum over all rotations of the
    # cumulative difference, which is the standard closed form for 1-D
    # transport on a ring.
    cumulative = np.cumsum(diff)
    best = min(np.abs(cumulative - shift).sum() for shift in cumulative)
    # Worst case is mass sitting exactly opposite on the wheel: n/2 bins of
    # travel for all of it.
    return float(min(1.0, best / (n / 2)))


def _tone_distance(hist_a, hist_b, scalar_a, scalar_b):
    """Distance for lightness or saturation.

    Blends the overall level (are these both dark?) with the shape of the
    distribution (is one evenly mid-toned while the other is half black and
    half white, averaging to the same number?). Neither alone is enough:
    the scalar misses distribution, the histogram alone is jumpy across bin
    boundaries.
    """
    a = np.asarray(hist_a, dtype=np.float64)
    b = np.asarray(hist_b, dtype=np.float64)
    if a.sum() > 0:
        a = a / a.sum()
    if b.sum() > 0:
        b = b / b.sum()

    # 1-D earth mover's on an ordered (non-circular) axis.
    emd = float(np.abs(np.cumsum(a - b)).sum() / max(1, len(a) - 1))
    level = abs(float(scalar_a) - float(scalar_b))
    return float(min(1.0, 0.5 * emd + 0.5 * level))


# --- Search -----------------------------------------------------------------


def rank(query_profile, candidates, weights=None, limit=None):
    """Rank candidate profiles against a query profile.

    `candidates` is an iterable of (reference_id, profile). Returns a list of
    {reference_id, score} sorted best first.

    Deliberately a plain in-memory scan over precomputed profiles: the
    per-comparison work is tiny (six palette entries and a few short
    histograms), and no image is ever touched here -- that's what keeps
    slider changes cheap. If the archive outgrows a linear scan, this
    function is the single place to swap in an index; nothing above it needs
    to know.
    """
    scored = []
    for ref_id, profile in candidates:
        if not profile:
            continue
        scored.append({"reference_id": ref_id, "score": similarity(query_profile, profile, weights)})

    # Ties broken by id so equal scores don't reorder between identical calls.
    scored.sort(key=lambda r: (-r["score"], r["reference_id"]))
    return scored[:limit] if limit else scored


def profile_to_json(profile):
    return json.dumps(profile)


def profile_from_json(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


# --- Storage-facing helpers -------------------------------------------------
#
# These are the seam between the pure colour maths above and the archive.
# Imports are deferred to keep the maths independently importable and
# testable without a database.


def profile_for_reference(reference_id, compute_if_missing=True):
    """A reference's colour profile, computing and storing it if needed.

    This is the on-demand half of the analysis strategy: the handful of
    references a user has actually selected get analysed the moment they're
    searched with, so the feature works immediately on a fresh archive
    without anyone having run a backfill first. The archive-wide backfill
    exists to make the *candidate* side complete, not to gate usage.

    Returns None for a reference with no analysable image (a text note, or a
    file that's gone missing).
    """
    import db
    from config import REFERENCES_DIR

    stored = db.get_colour_analysis(reference_id, version=ANALYSIS_VERSION)
    ref = db.get_reference(reference_id)
    if not ref:
        return None

    # A stored profile is only a cache hit if the image behind it hasn't
    # changed since; otherwise it describes a picture that's no longer there.
    if stored and (not ref.get("content_hash") or stored["content_hash"] == ref["content_hash"]):
        return profile_from_json(stored["profile"])

    if not compute_if_missing or ref["type"] != "image":
        return None

    path = REFERENCES_DIR / ref["filepath"]
    if not path.exists():
        return None

    try:
        profile = analyse_image(path)
    except Exception:
        return None

    db.save_colour_analysis(
        reference_id, ANALYSIS_VERSION, ref.get("content_hash"), profile_to_json(profile)
    )
    return profile


def build_combined_profile(reference_ids):
    """The single colour profile representing a selection of references.

    One reference gives that reference's profile; several give a genuine
    aggregate (see combine_profiles) rather than a set of separate queries.
    Returns (profile, used_ids) so the caller can tell which selections
    actually contributed -- a selection of three where one is a text note
    should still work, and should say so.
    """
    profiles, used = [], []
    for ref_id in reference_ids:
        profile = profile_for_reference(ref_id)
        if profile:
            profiles.append(profile)
            used.append(ref_id)

    if not profiles:
        return None, []
    return combine_profiles(profiles), used


def backfill(limit=None, progress=None):
    """Compute analyses for images that don't have a current one.

    Returns (analysed, failed). Skips anything already current, so it's safe
    to run repeatedly and cheap when there's nothing to do -- which is what
    lets it be offered as a button as well as a CLI command.
    """
    import db
    from config import REFERENCES_DIR

    pending = db.list_references_needing_colour(ANALYSIS_VERSION, limit=limit)
    analysed = failed = 0

    for i, row in enumerate(pending, 1):
        path = REFERENCES_DIR / row["filepath"]
        try:
            profile = analyse_image(path)
            db.save_colour_analysis(
                row["id"], ANALYSIS_VERSION, row["content_hash"], profile_to_json(profile)
            )
            analysed += 1
        except Exception:
            # One unreadable image shouldn't stop the run; it stays in the
            # queue and will be retried on the next backfill.
            failed += 1
        if progress:
            progress(i, len(pending), row["id"])

    return analysed, failed


def coverage():
    """How much of the archive is ready to be searched by colour."""
    import db

    total = db.count_image_references()
    analysed = db.count_colour_analyses(ANALYSIS_VERSION)
    return {
        "version": ANALYSIS_VERSION,
        "images": total,
        "analysed": min(analysed, total),
        "pending": max(0, total - analysed),
    }


# --- The colour map -----------------------------------------------------------

# The cylinder the references are arranged in. Comparable in scale to the
# similarity graph's planes (PLANE_RADIUS 5, PLANE_SPACING 6) so the camera
# framing and thumbnail sizes carry over between the two modes unchanged.
MAP_RADIUS = 7.0
MAP_HEIGHT = 12.0

# Where the hue ring's reference swatches are sampled from. Mid lightness and a
# moderate chroma is simply where most hues are legible at once -- pushed
# further out, blues go black and yellows blow out, and the ring stops reading
# as a colour wheel.
HUE_TICK_LAB = (60.0, 45.0)
HUE_TICKS = 12


def map_colour(profile):
    """The single LCh a reference sits at on the map: (lightness, chroma, hue).

    Lightness is the profile's overall lightness -- every pixel counts, since
    "how light is this image" is a question about all of it.

    Hue and chroma come from a palette average weighted by area *and* chroma,
    which is the same rule `_profile_from_lab` already uses to build the hue
    histogram: a near-grey has no meaningful hue to contribute, so letting it
    vote would drag every image toward whatever direction its noise pointed.
    Averaging `mean_lab` instead was measured against this archive and is
    clearly worse -- it sends a red-and-green image to the neutral axis, the
    one place it doesn't belong, and left 95 of 108 references inside the
    chroma < 8 core where they can't be told apart.
    """
    palette = profile.get("palette") or []
    if not palette:
        return None

    lab = np.array([e["lab"] for e in palette], dtype=np.float64)
    area = np.array([e["weight"] for e in palette], dtype=np.float64)
    chroma = np.hypot(lab[:, 1], lab[:, 2])

    weights = area * np.maximum(chroma, 1e-6)
    if weights.sum() <= 0:
        weights = area
    if weights.sum() <= 0:
        return None

    a, b = np.average(lab[:, 1], weights=weights), np.average(lab[:, 2], weights=weights)
    return (
        float(profile.get("lightness", lab[:, 0].mean() / 100.0)),
        float(np.hypot(a, b)),
        float((np.degrees(np.arctan2(b, a)) + 360) % 360),
    )


def colour_map(exclude_black_white=False):
    """Every analysed reference placed in an LCh cylinder: lightness up the
    axis, chroma outward, hue around.

    Reads the stored profiles only -- nothing is re-analysed, so switching the
    map on (or flipping `exclude_black_white`) costs one query, not a pass over
    the archive.

    Radius is the chroma *rank* rather than chroma scaled against its
    theoretical ceiling. Both order the references identically -- more
    saturated is always further out, which is what makes the placement
    perceptually honest -- but the raw scale is unusable on a real archive:
    measured here, chroma runs to a median of 5.5 against a ceiling of 110, so
    a linear radius stacks 88% of the library into the middle 8% of the disc
    and no clustering is visible at all. Ranking spends the whole radius on
    the range the archive actually occupies.
    """
    # Version-pinned, like the search: a profile written by an older algorithm
    # would be placed against rules it was never computed under.
    rows = list(db_list_colour_analyses(set()))
    entries = []
    for ref_id, raw in rows:
        profile = profile_from_json(raw)
        if not profile:
            continue
        if exclude_black_white:
            profile = remove_black_and_white(profile)
        placed = map_colour(profile)
        if placed is None:
            continue
        lightness, chroma, hue = placed
        entries.append({"id": ref_id, "profile": profile, "L": lightness, "C": chroma, "h": hue})

    if not entries:
        return {"nodes": [], "radius": MAP_RADIUS, "height": MAP_HEIGHT, "hue_ticks": _hue_ticks()}

    # Ties broken by id so the same archive always produces the same map.
    order = sorted(range(len(entries)), key=lambda i: (entries[i]["C"], entries[i]["id"]))
    span = max(1, len(entries) - 1)
    for rank, i in enumerate(order):
        entries[i]["radius_fraction"] = rank / span

    nodes = []
    for e in entries:
        angle = np.radians(e["h"])
        radius = e["radius_fraction"] * MAP_RADIUS
        nodes.append({
            "id": e["id"],
            "lightness": round(e["L"], 5),
            "chroma": round(e["C"], 3),
            "hue": round(e["h"], 2),
            "palette": e["profile"].get("palette", []),
            # y is the lightness axis: three.js is y-up, and OrbitControls
            # orbits around y, so "dark at the bottom, light at the top" is
            # the axis the existing navigation already turns around.
            "x": round(float(radius * np.cos(angle)), 4),
            "y": round(float((e["L"] - 0.5) * MAP_HEIGHT), 4),
            "z": round(float(radius * np.sin(angle)), 4),
        })

    nodes.sort(key=lambda n: n["id"])
    return {
        "nodes": nodes,
        "radius": MAP_RADIUS,
        "height": MAP_HEIGHT,
        "hue_ticks": _hue_ticks(),
    }


def _hue_ticks():
    """Swatches marking which direction round the map each hue lies in.

    Converted here rather than in the browser so the ring is coloured by the
    same Lab -> sRGB conversion that produced every palette swatch on screen;
    a second implementation in JS would be free to drift from this one.
    """
    L, C = HUE_TICK_LAB
    ticks = []
    for i in range(HUE_TICKS):
        hue = i * 360.0 / HUE_TICKS
        rad = np.radians(hue)
        lab = [L, C * np.cos(rad), C * np.sin(rad)]
        ticks.append({"hue": round(hue, 2), "rgb": [int(v) for v in lab_to_rgb(lab)]})
    return ticks


def search(reference_ids, weights=None, exclude_ids=None, limit=40, exclude_black_white=False):
    """Colour search: combined profile of `reference_ids` against the archive.

    `exclude_ids` is how the project's own references are kept out of its
    results -- the point of the search is finding things *not* already there.

    Ranking is colour only. The existing CLIP embeddings are deliberately not
    blended in: they rank by shape and semantics (measurably so -- see this
    module's header), and silently mixing them would make the sliders stop
    explaining the result order.

    `exclude_black_white` applies remove_black_and_white() to the query
    profile AND to every candidate before ranking, so a shared white or black
    studio backdrop doesn't drive the match on its own -- comparing an
    unfiltered query against filtered candidates (or vice versa) would be
    comparing two different colour spaces, so both sides always get the same
    treatment.
    """
    profile, used_ids = build_combined_profile(reference_ids)
    if not profile:
        return {"profile": None, "used_ids": [], "results": []}

    if exclude_black_white:
        profile = remove_black_and_white(profile)

    # Never rank a selected reference against itself.
    excluded = set(exclude_ids or []) | set(reference_ids)
    candidates = []
    for ref_id, raw in db_list_colour_analyses(excluded):
        candidate = profile_from_json(raw)
        if not candidate:
            continue
        if exclude_black_white:
            candidate = remove_black_and_white(candidate)
        candidates.append((ref_id, candidate))

    return {
        "profile": profile,
        "used_ids": used_ids,
        "results": rank(profile, candidates, weights=weights, limit=limit),
    }


def db_list_colour_analyses(exclude_ids):
    import db

    return db.list_colour_analyses(version=ANALYSIS_VERSION, exclude_ids=exclude_ids)
