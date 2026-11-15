import json
from pathlib import Path

import pytest

from legallabs_eval.config import load_config
from legallabs_eval.harnesses.playbook_node import PlaybookNodeHarness
from legallabs_eval.registry import HARNESSES, SUITES
from legallabs_eval.runner import Runner
from legallabs_eval.schemas import HarnessError, HarnessRequest, NonRetryableError, TaskDatum
from legallabs_eval.suites.playbook_review import PlaybookReview, grade_outcome

FIXTURES = Path(__file__).parent / "fixtures" / "playbook"


def recorded(contract: str) -> dict:
    run = json.loads((FIXTURES / "outcome.json").read_text())
    if contract.startswith("msa"):
        # A long contract: one correct rule, the injected clause missed, 240 s for 40 pages.
        run.update(template="msa", wall_ms=240_000, pages=40)
        run["outcome"]["results"] = [
            {"rule_title": "Payment Terms", "status": "acceptable", "evidence": []}
        ]
        run["outcome"]["gaps"] = []
        run["ooxml"] = {
            "suggestions": 0,
            "applied": 0,
            "valid": 0,
            "failed": {},
            "combined": {"applied": 0, "reread_ok": True, "soffice_ok": None},
        }
    return run


def player(calls: list[list[str]]):
    """Stands in for node/run.ts: writes the recorded outcome where --out points."""

    def run(args: list[str], timeout: float, stderr: Path) -> int:
        calls.append(args)
        out = Path(args[args.index("--out") + 1])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(recorded(Path(args[args.index("--contract") + 1]).name)))
        return 0

    return run


def suite() -> PlaybookReview:
    return PlaybookReview(corpus_dir=FIXTURES, seed=1, count=2, generate=False)


def test_grade_counts_statuses_gaps_evidence_and_ooxml():
    gold = suite().load_tasks()[0].answer
    m = grade_outcome(gold, recorded("nda"))
    assert (m["status_correct"], m["status_total"]) == (3, 4)
    assert m["confusion.not_acceptable.needs_review"] == 1
    assert m["gap_recall"] == 1.0
    # The catch-all gap still counts for recall, but not as the model's own find.
    assert m["gaps_existing_edit_found"] == 2
    assert m["gaps_existing_edit_found_by_model"] == 1
    assert (m["evidence_ok"], m["evidence_total"]) == (2, 3)
    assert (m["ooxml_valid"], m["ooxml_applied"], m["ooxml_anchor_failed"]) == (1, 1, 1)
    assert m["seconds_per_40_pages"] == pytest.approx(1600)
    assert m["model_calls"] == 7


def test_a_missing_finding_counts_as_wrong():
    gold = suite().load_tasks()[0].answer
    run = recorded("nda")
    run["outcome"]["results"] = run["outcome"]["results"][:1]
    m = grade_outcome(gold, run)
    assert (m["status_correct"], m["status_total"]) == (1, 4)
    assert m["confusion.not_found.missing"] == 1


def test_run_pools_contracts_and_applies_gates(tmp_path):
    calls: list[list[str]] = []
    system = {"harness": "playbook-node", "vendor": "ollama", "params": {"client": "ollama"}}
    harness = PlaybookNodeHarness("playbook-ollama", system, run=player(calls))
    runner = Runner("playbook-ollama", system, harness, suite(), tmp_path, "", 1, retry_delay=0)
    summary = runner.run()
    report = summary["report"]

    assert summary["completed_tasks"] == 2
    assert report["playbook.rule_classification_accuracy"]["rate"] == pytest.approx(4 / 5)
    recall = report["playbook.unanticipated_edit_detection_recall"]
    assert (recall["rate"], recall["n"]) == (0.75, 4)
    assert recall["uncovered_clause"]["rate"] == 0.5
    assert recall["existing_edit_by_model"]["rate"] == 0.5
    assert report["playbook.evidence_verification_rate"]["rate"] == pytest.approx(2 / 3)
    assert report["playbook.ooxml_validity_rate"]["rate"] == 1.0
    assert report["playbook.ooxml_validity_rate"]["anchor_failed"] == 1
    assert report["latency"]["seconds_per_40_pages_p50"] == pytest.approx(920)
    assert report["latency"]["wall_seconds_p50_at_35_pages_or_more"] == 240
    assert report["confusion"]["acceptable"] == {"acceptable": 3}
    assert report["gate"]["checks"] == {
        "status_accuracy": True,
        "gap_recall": False,
        "evidence_verification": False,
        "ooxml_validity": True,
        "latency": False,
    }
    assert report["gate"]["pass"] is False
    # Local models cost nothing, but their tokens are still counted.
    assert summary["cost"]["total_cost_usd"] == 0.0
    assert report["tokens"]["input"] == 40_000
    assert calls[0][4:8] == ["--template", "nda", "--client", "ollama"]


def test_paid_clients_are_priced_and_need_their_key(tmp_path, monkeypatch):
    system = {
        "harness": "playbook-node",
        "vendor": "anthropic",
        "params": {"client": "anthropic", "model": "claude-sonnet-5-5", "parallelism": 8},
    }
    harness = PlaybookNodeHarness("p", system, run=player([]))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(NonRetryableError, match="ANTHROPIC_API_KEY"):
        harness.prepare([])
    cost = harness.cost("claude-sonnet-5-5", {"input_tokens": 1_000_000, "output_tokens": 0})
    assert (cost.usd, cost.cost_known) == (3.0, True)
    gateway = PlaybookNodeHarness(
        "g", {"harness": "playbook-node", "params": {"client": "gateway"}}, run=player([])
    )
    assert (
        gateway.cost("anthropic/claude-haiku-5-5", {"input_tokens": 0, "output_tokens": 10**6}).usd
        == 5.0
    )
    assert harness._args("c.docx", "msa", Path("o.json"))[-2:] == ["--parallelism", "8"]


def test_a_run_without_an_outcome_is_retryable(tmp_path):
    system = {"harness": "playbook-node", "params": {"client": "fake"}}
    harness = PlaybookNodeHarness("p", system, run=lambda args, t, err: 1)
    task = TaskDatum("x", "p", {}, {"path": "x.docx", "template": "nda"})
    request = HarnessRequest(task, "playbook-review", "", tmp_path, tmp_path)
    with pytest.raises(HarnessError, match="code 1"):
        harness.run(request)


def test_registered_with_systems():
    assert "playbook-review" in SUITES
    systems = load_config()["systems"]
    names = [n for n, s in systems.items() if s["harness"] == "playbook-node"]
    assert {"playbook-fake", "playbook-ollama", "playbook-gpt"} <= set(names)
    assert all(systems[n]["harness"] in HARNESSES for n in names)
