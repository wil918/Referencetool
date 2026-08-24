"""estimation.py's three layers: global calibration, nearest neighbours and
the Claude fallback -- plus the rule the whole module exists to protect:
never train on a partial's own segment, or on a generated guess nobody ever
finished.

embeddings.embed_text is stubbed by the `archive` fixture to a constant
vector regardless of input (see conftest.py), so these tests don't depend on
CLIP actually judging two descriptions similar -- they only need to know
whether a candidate was indexed at all, which is estimation.py's job, not
embeddings.py's. Real vector ranking is exercised elsewhere.
"""
import pytest

import db
import embeddings
import estimation
import scheduling


def task(task_id, title=None, **fields):
    db.create_task(task_id, title or task_id, **fields)
    return task_id


class FakeCollection:
    """A minimal stand-in for a Chroma collection -- just enough of
    get/add/delete/query/count for estimation.py and embeddings.query_index
    to run against, with no real vector math (irrelevant to what these tests
    check; see the module docstring)."""

    def __init__(self):
        self.ids = []
        self.embeddings = []
        self.metadatas = []

    def count(self):
        return len(self.ids)

    def get(self, ids=None, include=None):
        selected = range(len(self.ids)) if ids is None else [
            i for i, id_ in enumerate(self.ids) if id_ in ids
        ]
        result = {"ids": [self.ids[i] for i in selected]}
        if include and "embeddings" in include:
            result["embeddings"] = [self.embeddings[i] for i in selected]
        if include and "metadatas" in include:
            result["metadatas"] = [self.metadatas[i] for i in selected]
        return result

    def add(self, ids, embeddings, metadatas):
        self.ids.extend(ids)
        self.embeddings.extend(embeddings)
        self.metadatas.extend(metadatas)

    def delete(self, ids):
        keep = [i for i, id_ in enumerate(self.ids) if id_ not in ids]
        self.ids = [self.ids[i] for i in keep]
        self.embeddings = [self.embeddings[i] for i in keep]
        self.metadatas = [self.metadatas[i] for i in keep]

    def query(self, query_embeddings, n_results):
        n = min(n_results, len(self.ids))
        return {
            "ids": [self.ids[:n]],
            "metadatas": [self.metadatas[:n]],
            "distances": [[0.0] * n],
        }


# --- Chains: the whole point of continues_task_id ---------------------------


def test_a_chains_summed_actuals_are_compared_to_the_original_estimate(archive):
    root = task("root", est_minutes=180, est_minutes_source="user")
    split = scheduling.resolve_partial(root, actual_minutes=80, est_minutes=100)
    remainder = split["remainder"]["id"]
    scheduling.resolve_completed(remainder, actual_minutes=70)

    chains = estimation.completed_duration_chains()

    assert len(chains) == 1
    chain = chains[0]
    assert chain["root"]["id"] == root
    assert chain["root"]["est_minutes"] == 180
    # 80 (the original's own segment) + 70 (the remainder's), never 70 alone
    # against a 100-minute estimate that was never the ORIGINAL estimate.
    assert chain["actual_minutes"] == 150
    assert set(chain["segment_ids"]) == {root, remainder}


def test_a_three_link_chain_sums_every_segment(archive):
    root = task("root", est_minutes=90, est_minutes_source="user")
    first = scheduling.resolve_partial(root, actual_minutes=30, est_minutes=60)
    link2 = first["remainder"]["id"]
    second = scheduling.resolve_partial(link2, actual_minutes=20, est_minutes=40)
    link3 = second["remainder"]["id"]
    scheduling.resolve_completed(link3, actual_minutes=35)

    chains = estimation.completed_duration_chains()

    assert len(chains) == 1
    assert chains[0]["root"]["id"] == root
    assert chains[0]["actual_minutes"] == 30 + 20 + 35


def test_an_unfinished_chain_is_not_yet_a_training_example(archive):
    root = task("root", est_minutes=90, est_minutes_source="user")
    scheduling.resolve_partial(root, actual_minutes=30, est_minutes=60)
    # The remainder is still pending -- nobody has finished the chain yet.

    assert estimation.completed_duration_chains() == []


# --- Global calibration ------------------------------------------------------


def test_the_calibration_ratio_is_right_on_a_known_set(archive):
    task("t-a", est_minutes=60, est_minutes_source="user")
    scheduling.resolve_completed("t-a", actual_minutes=90)  # ratio 1.5
    task("t-b", est_minutes=100, est_minutes_source="user")
    scheduling.resolve_completed("t-b", actual_minutes=120)  # ratio 1.2
    task("t-c", est_minutes=40, est_minutes_source="generated")
    scheduling.resolve_completed("t-c", actual_minutes=60)  # ratio 1.5

    calibration = estimation.duration_calibration()

    assert calibration["user"]["n"] == 2
    assert calibration["user"]["ratio"] == pytest.approx((1.5 + 1.2) / 2)
    assert calibration["generated"]["n"] == 1
    assert calibration["generated"]["ratio"] == pytest.approx(1.5)
    # Pools both sources -- the correction actually applied to a Claude guess.
    assert calibration["overall"]["n"] == 3
    assert calibration["overall"]["ratio"] == pytest.approx((1.5 + 1.2 + 1.5) / 3)


def test_generated_but_uncompleted_tasks_are_excluded_from_training(archive):
    task("t-a", est_minutes=45, est_minutes_source="generated", status="pending")

    assert estimation.completed_duration_chains() == []
    calibration = estimation.duration_calibration()
    assert calibration["generated"] == {"ratio": None, "n": 0}
    assert calibration["overall"] == {"ratio": None, "n": 0}

    result = estimation.estimate_duration("Sketch three silhouettes")
    assert result["provenance"] == "claude"
    assert result["n"] == 0


def test_rating_calibration_bias_on_a_known_set(archive):
    task("t-a", difficulty=2, difficulty_source="user")
    scheduling.resolve_completed("t-a", actual_minutes=30, actual_difficulty=4)  # +2
    task("t-b", difficulty=3, difficulty_source="user")
    scheduling.resolve_completed("t-b", actual_minutes=30, actual_difficulty=3)  # +0

    calibration = estimation.rating_calibration("difficulty")

    assert calibration["user"]["n"] == 2
    assert calibration["user"]["bias"] == pytest.approx(1.0)
    assert calibration["overall"]["n"] == 2


# --- Nearest neighbours, and the Claude fallback -----------------------------


def test_a_task_with_no_neighbours_falls_through_to_claude(archive):
    result = estimation.estimate_duration("Hem the sample skirt")

    assert result["provenance"] == "claude"
    assert result["n"] == 0
    assert result["confidence"] == "low"
    # No calibration data yet, so the stubbed task_ai answer passes through
    # uncorrected rather than being multiplied by a ratio that doesn't exist.
    assert result["minutes"] == 30
    assert result["calibration_ratio"] is None


def test_a_rating_with_no_neighbours_falls_through_to_claude(archive):
    result = estimation.estimate_rating("difficulty", "Assemble the final lookbook")

    assert result["provenance"] == "claude"
    assert result["n"] == 0
    assert result["value"] == 2
    assert result["calibration_bias"] is None


def test_neighbours_are_preferred_over_claude_and_averaged(archive):
    task("t-a", est_minutes=60, est_minutes_source="user")
    scheduling.resolve_completed("t-a", actual_minutes=60)
    task("t-b", est_minutes=60, est_minutes_source="user")
    scheduling.resolve_completed("t-b", actual_minutes=80)

    result = estimation.estimate_duration("Baste the lining")

    assert result["provenance"] == "neighbours"
    assert result["n"] == 2
    assert result["minutes"] == 70
    assert result["confidence"] == "medium"  # meets the 2-neighbour floor, short of 5


def test_estimate_rating_uses_neighbours_when_available(archive):
    task("t-a", importance=3, importance_source="user")
    scheduling.resolve_completed("t-a", actual_minutes=30, actual_importance=5)

    result = estimation.estimate_rating("importance", "Prepare the presentation boards")

    assert result["provenance"] == "neighbours"
    assert result["value"] == 5
    assert result["n"] == 1
    assert result["confidence"] == "low"  # a single neighbour is not enough for more


def test_estimate_task_fields_passes_through_given_values(archive):
    result = estimation.estimate_task_fields(
        "Iron the interfacing", est_minutes=20, importance=4, difficulty=1
    )

    assert result["est_minutes"] == {"minutes": 20, "provenance": "given"}
    assert result["importance"] == {"value": 4, "provenance": "given"}
    assert result["difficulty"] == {"value": 1, "provenance": "given"}


# --- Isolation from the reference library ------------------------------------


def test_task_vectors_do_not_appear_in_reference_search_results(archive, monkeypatch):
    ref_collection = FakeCollection()
    ref_collection.add(
        ids=["ref-a", "ref-b"],
        embeddings=[[0.2] * 512, [0.2] * 512],
        metadatas=[{"type": "image"}, {"type": "image"}],
    )
    task_collection = FakeCollection()
    monkeypatch.setattr(embeddings, "get_collection", lambda: ref_collection)
    monkeypatch.setattr(embeddings, "get_task_collection", lambda: task_collection)

    task("t-a", est_minutes=60, est_minutes_source="user")
    scheduling.resolve_completed("t-a", actual_minutes=75, actual_difficulty=3, actual_importance=3)

    estimation.index_task_collection()

    assert task_collection.count() == 1
    assert ref_collection.count() == 2
    assert set(ref_collection.get()["ids"]) == {"ref-a", "ref-b"}

    results = embeddings.query_index([0.2] * 512, n_results=5)
    assert {r["id"] for r in results} == {"ref-a", "ref-b"}
