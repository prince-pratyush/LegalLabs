import json
from pathlib import Path

import pytest

from legallabs_eval.config import load_config
from legallabs_eval.harnesses.playbook_node import PlaybookNodeHarness
from legallabs_eval.registry import HARNESSES, SUITES
from legallabs_eval.runner import Runner
from legallabs_eval.schemas import HarnessError, HarnessRequest, NonRetryableError, TaskDatum
from legallabs_eval.suites.playbook_labels import accepted
from legallabs_eval.suites.playbook_review import PlaybookReview, grade_outcome, rescore

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
    # Mutuality is relabelled: the planted non-compete makes the NDA one-sided.
    assert (m["status_correct"], m["status_strict_correct"], m["status_total"]) == (2, 3, 4)
    assert m["status_wrong_unverified"] == 1  # Residuals, downgraded by the verifier
    assert m["status_wrong_misclassified"] == 1  # Mutuality called acceptable
    assert m["variant.fallback.correct"] == 1
    assert m["confusion.not_acceptable.needs_review"] == 1
    assert m["gap_recall"] == 1.0
    # The guard's gap counts for the system, not as the model's own find.
    assert (m["gaps_existing_edit_found"], m["gaps_existing_edit_found_by_model"]) == (2, 1)
    assert (m["gaps_reported_matching"], m["gaps_reported"]) == (3, 3)
    assert (m["evidence_ok"], m["evidence_total"]) == (2, 3)
    assert (m["ooxml_valid"], m["ooxml_applied"], m["ooxml_anchor_failed"]) == (1, 1, 1)
    assert m["model_calls"] == 7


def test_a_gap_of_the_wrong_kind_does_not_count():
    gold = suite().load_tasks()[0].answer
    run = recorded("nda")
    # The model flags the edited paragraph as an uncovered clause, not as the edit.
    run["outcome"]["gaps"][1]["kind"] = "uncovered_clause"
    m = grade_outcome(gold, run)
    assert m["gaps_existing_edit_found_by_model"] == 0
    assert m["gaps_existing_edit_found"] == 1
    assert (m["gaps_reported_by_model_matching"], m["gaps_reported_by_model"]) == (1, 2)


def test_a_missing_finding_counts_as_wrong():
    gold = suite().load_tasks()[0].answer
    run = recorded("nda")
    run["outcome"]["results"] = run["outcome"]["results"][3:]
    m = grade_outcome(gold, run)
    assert (m["status_correct"], m["status_total"]) == (1, 4)
    assert m["confusion.not_found.missing"] == 1


def contract(template, rules, injected=()):
    return {
        "template": template,
        "rules": [{"rule": r, "variant": v, "status": GOLD[v]} for r, v in rules],
        "injected": [{"key": k, "kind": kind} for k, kind in injected],
    }


GOLD = {
    "standard": "acceptable",
    "fallback": "acceptable",
    "unacceptable": "not_acceptable",
    "omitted": "not_found",
}


def test_accepted_labels():
    nda = accepted(contract("nda", [("Residuals", "omitted"), ("Mutuality", "standard")]))
    assert nda["Residuals"][0] == {"not_found", "acceptable"}
    # No one-sided term anywhere: a mutual clause is simply acceptable.
    assert nda["Mutuality"][0] == {"acceptable"}
    lopsided = accepted(
        contract("nda", [("Mutuality", "omitted")], [("first_refusal", "uncovered_clause")])
    )
    assert lopsided["Mutuality"][0] == {"not_found", "needs_review", "not_acceptable"}
    msa = accepted(
        contract(
            "msa",
            [
                ("Data Protection", "fallback"),
                ("Privacy Act Compliance (AU)", "omitted"),
                ("Payment Terms", "standard"),
                ("Warranties", "fallback"),
            ],
            [("minimum_commitment", "uncovered_clause")],
        )
    )
    assert msa["Data Protection"][0] == {"acceptable", "needs_review"}  # flagged rule
    assert msa["Privacy Act Compliance (AU)"][0] == {"not_found", "needs_review"}
    assert msa["Payment Terms"][0] == {"acceptable", "needs_review", "not_acceptable"}
    assert msa["Warranties"][0] == {"acceptable"}


def test_run_pools_contracts_and_applies_gates(tmp_path):
    calls: list[list[str]] = []
    system = {"harness": "playbook-node", "vendor": "ollama", "params": {"client": "ollama"}}
    harness = PlaybookNodeHarness("playbook-ollama", system, run=player(calls))
    runner = Runner("playbook-ollama", system, harness, suite(), tmp_path, "", 1, retry_delay=0)
    summary = runner.run()
    report = summary["report"]

    assert summary["completed_tasks"] == 2
    accuracy = report["playbook.rule_classification_accuracy"]
    assert (accuracy["hits"], accuracy["n"]) == (3, 5)
    assert accuracy["strict"]["hits"] == 4
    assert accuracy["by_variant"]["omitted"]["rate"] == 1.0
    low, high = accuracy["bootstrap95_over_contracts"]
    assert low <= 0.6 <= high
    recall = report["playbook.unanticipated_edit_detection_recall"]
    assert (recall["system"]["hits"], recall["system"]["n"]) == (3, 4)
    assert recall["model_only"]["hits"] == 2
    assert recall["system"]["uncovered_clause"]["rate"] == 0.5
    assert recall["model_only"]["existing_edit"]["rate"] == 0.5
    assert report["playbook.evidence_verification_rate"]["rate"] == pytest.approx(2 / 3)
    assert report["playbook.ooxml_validity_rate"]["rate"] == 1.0
    assert report["playbook.ooxml_validity_rate"]["anchor_failed"] == 1
    # Only the 40-page contract counts for the latency gate.
    assert report["latency"]["long_contract_wall_seconds_p50"] == 240
    assert [c["wall_seconds"] for c in report["latency"]["per_contract"]] == [120, 240]
    assert report["gate"]["checks"] == {
        "status_accuracy": False,
        "gap_recall": False,
        "evidence_verification": False,
        "ooxml_validity": True,
        "latency": True,
    }
    assert report["gate"]["pass"] is False
    # Local models cost nothing, but their tokens are still counted.
    assert summary["cost"]["total_cost_usd"] == 0.0
    assert report["tokens"]["input"] == 40_000
    assert calls[0][4:8] == ["--template", "nda", "--client", "ollama"]


def test_latency_without_a_long_contract_is_not_measured(tmp_path):
    system = {"harness": "playbook-node", "params": {"client": "ollama"}}
    harness = PlaybookNodeHarness("p", system, run=player([]))
    summary = Runner("p", system, harness, suite(), tmp_path, "", 1, retry_delay=0).run(limit=1)
    assert summary["report"]["latency"]["long_contract_wall_seconds_p50"] == "not measured"
    assert summary["report"]["gate"]["checks"]["latency"] is None


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
    assert (cost.usd, cost.cost_known) == (2.0, True)
    gateway = PlaybookNodeHarness(
        "g", {"harness": "playbook-node", "params": {"client": "gateway"}}, run=player([])
    )
    assert (
        gateway.cost("anthropic/claude-haiku-5-5", {"input_tokens": 0, "output_tokens": 10**6}).usd
        == 0.5
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


def test_a_different_answering_model_fails_for_good(tmp_path):
    system = {"harness": "playbook-node", "params": {"client": "openai", "model": "gpt-5.5"}}
    harness = PlaybookNodeHarness("p", system, run=lambda args, t, err: 3)
    task = TaskDatum("x", "p", {}, {"path": "x.docx", "template": "nda"})
    with pytest.raises(NonRetryableError, match="other than gpt-5.5"):
        harness.run(HarnessRequest(task, "playbook-review", "", tmp_path, tmp_path))


def test_answered_model_is_priced(tmp_path):
    system = {"harness": "playbook-node", "params": {"client": "anthropic"}}
    harness = PlaybookNodeHarness("p", system, run=player([]))
    task = suite().load_tasks()[0]
    run = recorded("nda")
    run["answered_models"] = ["claude-sonnet-5-5"]
    harness._run = lambda args, t, err: (
        Path(args[args.index("--out") + 1]).parent.mkdir(parents=True, exist_ok=True)
        or Path(args[args.index("--out") + 1]).write_text(json.dumps(run))
        and 0
    )
    result = harness.run(HarnessRequest(task, "playbook-review", "", tmp_path, tmp_path))
    assert result.model == "claude-sonnet-5-5"
    assert result.cost.usd == pytest.approx((20_000 * 2 + 1_500 * 10) / 1e6)


def test_gateway_needs_the_key_of_its_provider(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    params = {"client": "gateway", "model": "anthropic/claude-haiku-5-5"}
    harness = PlaybookNodeHarness(
        "g", {"harness": "playbook-node", "params": params}, run=player([])
    )
    with pytest.raises(NonRetryableError, match="ANTHROPIC_API_KEY"):
        harness.prepare([])


def test_cli_can_fail_on_task_errors(monkeypatch, capsys):
    from legallabs_eval import cli

    class Failing:
        def __init__(self, *args, **kwargs):
            pass

        def run(self, limit):
            return {"total_failed": 1}

    monkeypatch.setattr(cli, "Runner", Failing)
    monkeypatch.setattr(cli, "make_suite", lambda *a: None)
    monkeypatch.setattr(cli, "make_harness", lambda *a: None)
    argv = ["run", "--system", "bm25-local", "--suite", "retrieval-golden"]
    assert cli.main(argv) == 0
    assert cli.main([*argv, "--fail-on-task-errors"]) == 1


RECORDED = (
    Path(__file__).parents[1] / "results" / "playbook-review" / "2026-11-15-playbook-ollama-limit3"
)


def test_recorded_local_run_rescores_to_the_committed_figures():
    """The qwen3:4b-instruct outcomes, graded again with no model call."""
    summary = rescore(RECORDED / "corpus-v1", RECORDED / "outcomes")
    report = summary["report"]
    accuracy = report["playbook.rule_classification_accuracy"]
    recall = report["playbook.unanticipated_edit_detection_recall"]
    assert summary["contracts"] == ["nda-001-p03", "msa-002-p03", "nda-003-p05"]
    assert (accuracy["hits"], accuracy["strict"]["hits"], accuracy["n"]) == (44, 41, 57)
    assert (recall["system"]["hits"], recall["model_only"]["hits"], recall["system"]["n"]) == (
        10,
        4,
        10,
    )
    assert recall["model_only"]["existing_edit"]["hits"] == 0
    assert report["playbook.evidence_verification_rate"]["hits"] == 46
    assert report["playbook.ooxml_validity_rate"]["hits"] == 25
    assert report["latency"]["long_contract_wall_seconds_p50"] == "not measured"
    assert summary == json.loads((RECORDED / "rescore.json").read_text())
