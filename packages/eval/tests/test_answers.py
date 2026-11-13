import json

import pytest

from legallabs_eval.cli import main
from legallabs_eval.harnesses.model import NaiveRagHarness, PlainModelHarness
from legallabs_eval.models import ModelClient, recorded
from legallabs_eval.runner import Runner
from legallabs_eval.schemas import HarnessResult, NonRetryableError
from legallabs_eval.suites.extract_cuad import CuadGrader, ExtractCuad
from legallabs_eval.suites.judge import Judge
from legallabs_eval.suites.nli_contractnli import NliContractNli, NliGrader

CONTRACT = "1. Term. This agreement lasts two years.\n\n2. Law. Governed by the laws of Ruritania."
JUDGES = {
    "gpt": {"vendor": "openai", "model": "gpt-5.5"},
    "claude": {"vendor": "anthropic", "model": "claude-sonnet-5-5"},
}
PASS = json.dumps({"pass": True, "reasoning": "ok"})


@pytest.fixture
def cuad_file(tmp_path):
    question = 'Highlight the parts (if any) of this contract related to "Governing Law" that...'
    data = {
        "data": [
            {
                "title": "Sample",
                "paragraphs": [
                    {
                        "context": CONTRACT,
                        "qas": [
                            {
                                "id": "sample__Governing Law",
                                "question": question,
                                "answers": [{"text": "Governed by the laws of Ruritania."}] * 2,
                                "is_impossible": False,
                            },
                            {
                                "id": "sample__Non-Compete",
                                "question": question.replace("Governing Law", "Non-Compete"),
                                "answers": [],
                                "is_impossible": True,
                            },
                        ],
                    }
                ],
            }
        ]
    }
    path = tmp_path / "cuad.json"
    path.write_text(json.dumps(data))
    return path


@pytest.fixture
def nli_file(tmp_path):
    data = {
        "documents": [
            {
                "id": 7,
                "text": CONTRACT,
                "spans": [[0, 40], [42, 84]],
                "annotation_sets": [
                    {
                        "annotations": {
                            "nda-1": {"choice": "Entailment", "spans": [0]},
                            "nda-2": {"choice": "NotMentioned", "spans": []},
                        }
                    }
                ],
            }
        ],
        "labels": {
            "nda-1": {"hypothesis": "The agreement lasts two years."},
            "nda-2": {"hypothesis": "There is a non-compete."},
        },
    }
    path = tmp_path / "nli.json"
    path.write_text(json.dumps(data))
    return path


def test_cuad_loader_reads_categories_and_dedupes_gold(cuad_file):
    tasks = ExtractCuad(local=cuad_file).load_tasks()
    assert [t.metadata["category"] for t in tasks] == ["Governing Law", "Non-Compete"]
    assert tasks[0].answer == ["Governed by the laws of Ruritania."]
    assert tasks[1].answer == []


def test_cuad_grader_scores_quotes_and_flags_invented_ones(cuad_file, tmp_path):
    task = ExtractCuad(local=cuad_file).load_tasks()[0]
    grader = CuadGrader(None)
    good = grader.grade(
        task, HarnessResult('{"quotes": ["Governed by the laws of Ruritania."]}'), tmp_path
    )
    assert good.score == 1.0 and good.metrics["valid_quote_rate"] == 1.0
    made_up = grader.grade(
        task, HarnessResult('{"quotes": ["Governed by Atlantis law."]}'), tmp_path
    )
    assert made_up.metrics["valid_quote_rate"] == 0.0
    assert made_up.score < 1.0
    prose = grader.grade(task, HarnessResult("The law is Ruritania."), tmp_path)
    assert prose.score == 0.0 and prose.metrics["valid_json"] == 0.0


def test_cuad_empty_answer_is_right_when_there_is_no_clause(cuad_file, tmp_path):
    task = ExtractCuad(local=cuad_file).load_tasks()[1]
    assert CuadGrader(None).grade(task, HarnessResult('{"quotes": []}'), tmp_path).score == 1.0


def test_nli_loader_maps_span_indexes_to_characters(nli_file):
    tasks = NliContractNli(local=nli_file).load_tasks()
    assert tasks[0].answer["label"] == "Entailment"
    assert tasks[0].answer["evidence"] == list(range(0, 40))


def test_nli_grader_measures_accuracy_and_evidence_overlap(nli_file, tmp_path):
    task = NliContractNli(local=nli_file).load_tasks()[0]
    answer = json.dumps(
        {"label": "Entailment", "evidence": ["1. Term. This agreement lasts two years."]}
    )
    graded = NliGrader(None).grade(task, HarnessResult(answer), tmp_path)
    assert graded.score == 1.0
    assert graded.metrics["evidence_iou"] == pytest.approx(1.0)
    wrong = json.dumps({"label": "Contradiction", "evidence": []})
    assert NliGrader(None).grade(task, HarnessResult(wrong), tmp_path).score == 0.0


def test_judge_never_shares_the_systems_vendor(tmp_path):
    judge = Judge(JUDGES, "anthropic", count=2, send=recorded([PASS]))
    assert [c.vendor for _, c in judge.clients] == ["openai"]
    with pytest.raises(NonRetryableError):
        Judge({"claude": JUDGES["claude"]}, "anthropic")


def test_judge_makes_one_call_per_criterion_per_judge(tmp_path):
    fail = json.dumps({"pass": False, "reasoning": "missing"})
    judge = Judge(JUDGES, "legallabs", count=2, send=recorded([PASS, fail]))
    verdict = judge.check("criterion", "material", tmp_path)
    assert verdict.score == 0.5
    assert verdict.cost.cost_known
    for name in ("gpt", "claude"):
        body = json.loads((tmp_path / f"judge-{name}/requests.jsonl").read_text())
        assert body["temperature"] == 0


def test_malformed_verdict_counts_as_a_fail(tmp_path):
    judge = Judge(JUDGES, "anthropic", count=1, send=recorded(["yes it passes"]))
    assert judge.check("criterion", "material", tmp_path).score == 0.0


def test_unknown_model_price_is_unknown_not_free(tmp_path):
    client = ModelClient("openai", "some-new-model", send=recorded(["{}"]))
    _, cost = client.complete("s", "p", tmp_path)
    assert cost.cost_known is False and cost.usd is None


def test_missing_key_stops_before_any_call(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(NonRetryableError, match="ANTHROPIC_API_KEY"):
        ModelClient("anthropic", "claude-sonnet-5-5").preflight()


def test_plain_model_run_end_to_end_with_recorded_replies(cuad_file, tmp_path):
    system = {"harness": "model", "vendor": "anthropic", "params": {"model": "claude-sonnet-5-5"}}
    replies = ['{"quotes": ["Governed by the laws of Ruritania."]}', '{"quotes": []}']
    harness = PlainModelHarness("claude-plain", system, send=recorded(replies))
    suite = ExtractCuad(local=cuad_file)
    summary = Runner("claude-plain", system, harness, suite, tmp_path / "runs", concurrency=1).run()
    assert summary["failed_as_zero"] == 1.0
    assert summary["cost"]["cost_known"] is True
    assert summary["cost"]["total_cost_usd"] > 0


def test_naive_rag_sends_only_matching_chunks(cuad_file, tmp_path):
    system = {
        "harness": "naive-rag",
        "vendor": "anthropic",
        "params": {"model": "claude-sonnet-5-5", "top_k": 1, "chunk_size": 50},
    }
    harness = NaiveRagHarness("rag", system, send=recorded(['{"quotes": []}']))
    task = ExtractCuad(local=cuad_file).load_tasks()[0]
    from legallabs_eval.schemas import HarnessRequest

    request = HarnessRequest(task, "extract-cuad", "", tmp_path, tmp_path)
    context = harness.context(request)
    assert "Ruritania" in context and "two years" not in context


def test_cli_lists_and_runs_the_offline_baseline(tmp_path, capsys):
    assert main(["list"]) == 0
    assert "legallabs-keyword" in capsys.readouterr().out
    code = main(
        [
            "run",
            "--system",
            "bm25-local",
            "--suite",
            "retrieval-golden",
            "--runs-dir",
            str(tmp_path),
        ]
    )
    assert code == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["selected_tasks"] == summary["completed_tasks"] == 20
