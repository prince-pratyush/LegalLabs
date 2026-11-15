"""End to end through node/run.ts with the fake client: generation, review, grading.

The fake client is deterministic, so these numbers only move when the generator, the
engine, the runner or the grading changes. Then check the change and update them.
Skipped where Node 22.18+ or the built workspace packages are missing; CI has both.
"""

import json

import pytest

from legallabs_eval.harnesses.playbook_node import (
    PlaybookNodeHarness,
    check_node,
    engine_hash,
    node_binary,
)
from legallabs_eval.runner import Runner
from legallabs_eval.schemas import NonRetryableError
from legallabs_eval.suites.playbook_review import PlaybookReview


def node_ready() -> bool:
    try:
        check_node(node_binary())
    except NonRetryableError:
        return False
    return True


pytestmark = pytest.mark.skipif(not node_ready(), reason="needs Node 22.18+ and built packages")

PINNED = {
    "contracts": 4,
    "accuracy": (16, 82),
    "strict_hits": 16,
    "system_recall": (7, 12),
    "model_recall_hits": 0,
    "evidence": (9, 9),
    "ooxml": (3, 3),
}


def test_fake_run_scores_are_pinned(tmp_path):
    system = {"harness": "playbook-node", "vendor": "local", "params": {"client": "fake"}}
    harness = PlaybookNodeHarness("playbook-fake", system)
    suite = PlaybookReview()
    summary = Runner("playbook-fake", system, harness, suite, tmp_path, "", 2).run(limit=4)
    report = summary["report"]
    accuracy = report["playbook.rule_classification_accuracy"]
    recall = report["playbook.unanticipated_edit_detection_recall"]
    evidence = report["playbook.evidence_verification_rate"]
    ooxml = report["playbook.ooxml_validity_rate"]
    got = {
        "contracts": summary["completed_tasks"],
        "accuracy": (accuracy["hits"], accuracy["n"]),
        "strict_hits": accuracy["strict"]["hits"],
        "system_recall": (recall["system"]["hits"], recall["system"]["n"]),
        "model_recall_hits": recall["model_only"]["hits"],
        "evidence": (evidence["hits"], evidence["n"]),
        "ooxml": (ooxml["hits"], ooxml["n"]),
    }
    print(json.dumps(got))
    assert summary["total_failed"] == 0
    assert got == PINNED
    # Node and Python hash the same engine files, and the hash is in the config.
    outcome = next(tmp_path.rglob("outcome.json"))
    assert json.loads(outcome.read_text())["env"]["engine_sha256"] == engine_hash()
    assert summary["environment"]["engine_sha256"] == engine_hash()
    assert (
        json.loads(next(tmp_path.rglob("run_config.json")).read_text())["harness_fingerprint"]
        == engine_hash()
    )
