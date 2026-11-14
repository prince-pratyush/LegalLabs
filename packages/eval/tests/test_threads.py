import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from legallabs_eval.harnesses.legallabs_thread import LegalLabsThreadHarness
from legallabs_eval.metrics import wilson
from legallabs_eval.runner import Runner
from legallabs_eval.schemas import Document, NonRetryableError, TaskDatum
from legallabs_eval.suites.coverage_vdr import CoverageVdr, criterion_met, generate_room
from legallabs_eval.suites.thread_answers import (
    CATEGORIES,
    Hallucination200,
    ThreadAnswer,
    VerifierLive,
    build_tasks,
    classify,
    holds,
    normalise,
)

OK = {"n": 1, "status": "ok", "document_name": "a.md", "page": 1, "quote": "q"}


def task(category: str, gold: list[list[str]], other: list[str] | None = None) -> TaskDatum:
    key = "false" if category == "false_premise" else "wrong"
    return TaskDatum("t", "q", {"gold": gold, key: other or []}, {"category": category})


def answer(content: str, citations: list[dict[str, Any]] | None = None, **kw: Any) -> ThreadAnswer:
    return ThreadAnswer(content, [OK] if citations is None else citations, **kw)


# Grading


def test_wilson_interval_matches_known_values() -> None:
    low, high = wilson(5, 10)
    assert low == pytest.approx(0.2366, abs=1e-4)
    assert high == pytest.approx(0.7634, abs=1e-4)
    # At zero events the interval still has width, so 0/10 never reads as proof of 0%.
    assert wilson(0, 10) == (0.0, pytest.approx(0.2775, abs=1e-4))
    assert wilson(0, 0) == (0.0, 1.0)


def test_numbers_match_as_whole_words() -> None:
    assert holds(normalise("Damages of 412,000 crowns"), "412000")
    assert not holds(normalise("more than 5,000 data subjects"), "500")
    assert holds(normalise("the 4% cap"), "4%")


def test_cited_gold_answer_is_correct() -> None:
    assert classify(task("general", [["48 hours"]]), answer("Within 48 hours."))[0] == "correct"


def test_misgrounded_answers_are_hallucinated() -> None:
    gold = task("general", [["48 hours"]])
    flagged = [OK, {**OK, "n": 2, "status": "mismatch"}]
    assert classify(gold, answer("Within 48 hours.", flagged))[0] == "hallucinated"
    assert classify(gold, answer("Within 48 hours.", ungrounded=[[0, 5]]))[0] == "hallucinated"
    # Right words with nothing verified behind them is still not grounded.
    assert classify(gold, answer("Within 48 hours.", []))[0] == "hallucinated"


def test_wrong_value_is_hallucinated_and_missing_value_incomplete() -> None:
    gold = task("jurisdiction_time", [["48 hours"]], ["72 hours"])
    assert classify(gold, answer("It was 72 hours."))[0] == "hallucinated"
    assert classify(gold, answer("It was 72 hours, then 48 hours."))[0] == "correct"
    assert classify(gold, answer("I couldn't find this.", []))[0] == "incomplete"


def test_false_premise_grading() -> None:
    premise = task("false_premise", [["48 hours"]], ["24 hours"])
    assert classify(premise, answer("Because 24 hours is short."))[0] == "hallucinated"
    assert classify(premise, answer("It is 48 hours, not 24 hours."))[0] == "correct"
    assert (
        classify(premise, answer("Notice within 24 hours is not in the Act.", []))[0]
        == "incomplete"
    )
    assert classify(premise, answer("The clause exists to protect data.", []))[0] == "hallucinated"


def test_false_premise_needs_a_rejection_beside_the_premise() -> None:
    premise = task("false_premise", [["48 hours"]], ["24 hours"])
    # Common negations elsewhere must not excuse a repeated premise.
    repeated = "Yes, breaches must be notified within 24 hours. However, there is no other rule."
    assert classify(premise, answer(repeated))[0] == "hallucinated"
    over_lines = "- Notice period: 24 hours\n- Penalties: not covered"
    assert classify(premise, answer(over_lines, []))[0] == "hallucinated"
    assert classify(premise, answer("No, the Act sets 48 hours, not 24 hours."))[0] == "correct"


def test_unsupported_premise_is_correct_only_when_rejected() -> None:
    unsaid = task("false_premise", [], ["exclusive"])
    assert classify(unsaid, answer("Harbourline is not the exclusive supplier.", []))[0] == (
        "correct"
    )
    # A vague negation that never names the premise is not a rejection.
    assert classify(unsaid, answer("The agreement does not say that.", []))[0] == "hallucinated"
    assert classify(unsaid, answer("Harbourline supplies exclusively.", []))[0] == "hallucinated"
    assert classify(unsaid, answer("Prices rise by 3% at most.", []))[0] == "hallucinated"


def test_two_hundred_tasks_fifty_per_category() -> None:
    tasks = build_tasks()
    assert len(tasks) == 200
    assert len({t.id for t in tasks}) == 200
    for category in CATEGORIES:
        assert sum(t.metadata["category"] == category for t in tasks) == 50
    assert [t.problem for t in tasks] == [t.problem for t in build_tasks()]
    assert all("{" not in t.problem for t in tasks)


def test_every_gold_fact_is_in_the_corpus() -> None:
    corpus = normalise(" ".join(d.text for d in Hallucination200().corpus()))
    for t in build_tasks():
        for group in t.answer["gold"]:
            assert any(holds(corpus, alt) for alt in group), (t.id, group)


# Data room


def test_room_is_deterministic_and_plants_each_issue() -> None:
    docs, criteria = generate_room(40, 3)
    again, _ = generate_room(40, 3)
    other, _ = generate_room(40, 4)
    assert [d.text for d in docs] == [d.text for d in again]
    assert [d.text for d in docs] != [d.text for d in other]
    assert len(docs) == 40
    assert {c["id"].rsplit("-", 1)[0] for c in criteria} == {
        "change_of_control",
        "uncapped_indemnity",
        "long_auto_renewal",
        "foreign_law",
    }
    by_name = {d.name: normalise(d.text) for d in docs}
    for criterion in criteria:
        text = by_name[criterion["document"]]
        assert any(holds(text, k) for k in criterion["keywords"]), criterion["id"]


def test_room_scales_issues_with_size() -> None:
    _, criteria = generate_room(500, 7)
    assert len(criteria) == 12


def test_criterion_needs_the_contract_and_the_issue() -> None:
    criterion = {
        "number": "0042",
        "document": "contract-0042.md",
        "keywords": ["esterra"],
    }
    assert criterion_met(criterion, answer("Contract 0042 is governed by Esterra law.", []))
    assert not criterion_met(criterion, answer("One contract uses Esterra law.", []))
    assert criterion_met(criterion, answer("| contract-0042.md | Esterra law |", []))
    # The number and the issue must share a sentence or line, not just the report.
    spread = "Contracts reviewed: 0007, 0042.\nOne contract uses Esterra law."
    assert not criterion_met(criterion, answer(spread, []))
    # A fee of 500,420 crowns must not read as contract 0042.
    assert not criterion_met(criterion, answer("Fee 500,420 under Esterra law.", []))


def test_numbers_are_not_matched_inside_decimals() -> None:
    assert not holds(normalise("a fee of 500.50 crowns"), "500")
    assert not holds(normalise("version 2.500"), "500")
    assert holds(normalise("500. Next sentence."), "500")


# End to end over a fake API


Reply = Callable[[str, bool], tuple[str, list[dict[str, Any]]]]


def fake_threads(seen: list[httpx.Request], reply: Reply, docs: int = 0) -> httpx.MockTransport:
    runs: dict[str, dict[str, Any]] = {}
    threads: dict[str, dict[str, Any]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path, method = request.url.path, request.method
        if path == "/auth/login":
            return httpx.Response(200, json={}, headers={"set-cookie": "__Host-sid=tok; Secure"})
        if request.headers.get("cookie") != "__Host-sid=tok":
            return httpx.Response(401)
        if path == "/api/v1/documents" and method == "POST":
            n = sum(1 for r in seen if r.method == "POST" and r.url.path == path)
            return httpx.Response(201, json={"document": {"id": f"d{n}", "status": "queued"}})
        if path == "/api/v1/documents":
            n = sum(1 for r in seen if r.method == "POST" and r.url.path == path)
            listed = [{"id": f"d{i}", "status": "indexed"} for i in range(1, n + 1)]
            return httpx.Response(200, json={"documents": listed})
        if path == "/api/v1/threads" and method == "POST":
            body = json.loads(request.content)
            n = str(len(threads) + 1)
            content, citations = reply(body["content"], body["deep_analysis"])
            message = {
                "id": f"m{n}",
                "role": "assistant",
                "content": content,
                "model": "ollama/qwen3:4b-instruct",
                "input_tokens": 100,
                "output_tokens": 20,
                "cost_usd": 0,
                "citations": citations,
                "ungrounded": [],
            }
            threads[n] = {"messages": [message], "scope": body["scope"]}
            runs[n] = {
                "id": f"r{n}",
                "status": "awaiting_approval" if body["deep_analysis"] else "running",
                "message_id": f"m{n}",
                "deep": body["deep_analysis"],
                "cost_usd": 0,
            }
            return httpx.Response(202, json={"thread_id": n, "message_id": f"m{n}", "run_id": n})
        if path.startswith("/api/v1/runs/") and path.endswith("/approve"):
            run = runs[path.split("/")[4]]
            run["status"] = "running"
            return httpx.Response(202, json={})
        if path.startswith("/api/v1/runs/"):
            run = runs[path.split("/")[4]]
            shown = dict(run)
            if run["status"] == "running":
                run["status"] = "done"
            read = docs if run["deep"] else 3
            coverage = {"docs_in_scope": docs, "docs_read": read, "mode": "retrieval"}
            return httpx.Response(200, json={"run": {**shown, "coverage": coverage}})
        if path.startswith("/api/v1/threads/"):
            return httpx.Response(200, json={"thread": threads[path.split("/")[4]]})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


@pytest.fixture
def api_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LEGALLABS_URL", "http://localhost:8787")
    monkeypatch.setenv("LEGALLABS_WORKSPACE", "w")
    monkeypatch.setenv("LEGALLABS_EMAIL", "e@x.test")
    monkeypatch.setenv("LEGALLABS_PASSWORD", "pw")
    monkeypatch.delenv("LEGALLABS_VAULT_ID", raising=False)


SYSTEM = {"harness": "legallabs-thread", "vendors": ["ollama"], "params": {"poll_seconds": 0}}


def harness(transport: httpx.MockTransport) -> LegalLabsThreadHarness:
    return LegalLabsThreadHarness("threads", SYSTEM, transport, sleep=lambda _: None)


def test_hallucination_run_reports_rates_and_gate(tmp_path: Path, api_env: None) -> None:
    seen: list[httpx.Request] = []

    def reply(question: str, deep: bool) -> tuple[str, list[dict[str, Any]]]:
        return "Notification is due within 48 hours.", [OK]

    suite = Hallucination200()
    run = Runner("threads", SYSTEM, harness(fake_threads(seen, reply)), suite, tmp_path)
    summary = run.run(limit=10)
    report = summary["report"]
    assert summary["completed_tasks"] == 10
    assert report["n"] == 10
    assert set(report["by_category"]) == {"general"}
    assert report["by_category"]["general"]["n"] == 10
    rates = report["overall"]
    assert sum(rates[k]["rate"] for k in ("correct", "incomplete", "hallucinated")) == 1.0
    assert report["gate"]["pass"] is (rates["hallucinated"]["rate"] <= 0.05)
    posted = [json.loads(r.content) for r in seen if r.url.path == "/api/v1/threads"]
    assert posted[0]["scope"]["document_ids"] == ["d1", "d2", "d3", "d4", "d5", "d6"]
    assert posted[0]["deep_analysis"] is False


def test_verifier_live_pools_citations(tmp_path: Path, api_env: None) -> None:
    seen: list[httpx.Request] = []
    flagged = [OK, {**OK, "n": 2, "status": "mismatch"}]

    def reply(question: str, deep: bool) -> tuple[str, list[dict[str, Any]]]:
        return "Answer.", flagged

    summary = Runner(
        "threads", SYSTEM, harness(fake_threads(seen, reply)), VerifierLive(), tmp_path
    ).run(limit=4)
    report = summary["report"]
    assert report["citations"] == 8
    assert report["verified_rate"] == 0.5
    assert report["gate"]["pass"] is False
    assert report["uncited_answers"]["rate"] == 0.0


def test_coverage_vdr_approves_plan_and_compares_with_baseline(
    tmp_path: Path, api_env: None
) -> None:
    seen: list[httpx.Request] = []
    suite = CoverageVdr(docs=20, seed=1)
    criteria = suite.load_tasks()[0].answer
    found = " ".join(f"Contract {c['number']}: {c['keywords'][0]}." for c in criteria)

    def reply(question: str, deep: bool) -> tuple[str, list[dict[str, Any]]]:
        return (found if deep else "Nothing found."), []

    summary = Runner(
        "threads", SYSTEM, harness(fake_threads(seen, reply, docs=20)), suite, tmp_path
    ).run()
    report = summary["report"]
    assert report["deep_analysis"]["criterion_pass"] == 1.0
    assert report["deep_analysis"]["read_fraction"] == 1.0
    assert report["baseline"]["criterion_pass"] == 0.0
    assert report["gate"]["pass"] is True
    approvals = [r for r in seen if r.url.path.endswith("/approve")]
    assert len(approvals) == 1


def test_big_room_needs_a_vault(api_env: None) -> None:
    thread = harness(fake_threads([], lambda q, d: ("", [])))
    with pytest.raises(NonRetryableError, match="LEGALLABS_VAULT_ID"):
        thread.prepare([Document(f"c{i}.md", "x") for i in range(51)])


def test_vault_scope_skips_uploads(
    tmp_path: Path, api_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LEGALLABS_VAULT_ID", "v1")
    seen: list[httpx.Request] = []
    suite = CoverageVdr(docs=60, seed=1)
    Runner(
        "threads",
        SYSTEM,
        harness(fake_threads(seen, lambda q, d: ("", []), docs=60)),
        suite,
        tmp_path,
    ).run(limit=1)
    assert not [r for r in seen if r.method == "POST" and r.url.path == "/api/v1/documents"]
    body = json.loads(next(r for r in seen if r.url.path == "/api/v1/threads").content)
    assert body["scope"] == {"document_ids": [], "vault_ids": ["v1"], "sources": []}


# Gates


def graded(task_id: str, **metrics: float) -> dict[str, Any]:
    return {"task_id": task_id, "score": 0.0, "metrics": metrics}


def test_missing_answers_fail_the_hallucination_gate() -> None:
    tasks = build_tasks()[:10]
    results = [graded(t.id, correct=1.0, hallucinated=0.0) for t in tasks[:9]]
    report = Hallucination200().report(results, tasks)
    assert report["errors"] == {"count": 1, "rate": 0.1}
    assert report["gate"]["pass"] is False
    full = Hallucination200().report(results + [graded(tasks[9].id, correct=1.0)], tasks)
    assert full["gate"]["pass"] is True


def test_missing_answers_fail_the_verifier_gate() -> None:
    tasks = VerifierLive().load_tasks(2)
    results = [graded(tasks[0].id, citations_total=3.0, citations_ok=3.0)]
    assert VerifierLive().report(results, tasks)["gate"]["pass"] is False


def test_vdr_gate_fails_without_both_runs() -> None:
    suite = CoverageVdr(docs=10, seed=1)
    tasks = suite.load_tasks()
    deep = graded("deep-analysis", criterion_pass=1.0, read_fraction=1.0)
    report = suite.report([deep], tasks)
    assert report["baseline"] is None
    assert report["lift"] is None
    assert report["gate"]["pass"] is False
    base = graded("baseline", criterion_pass=0.0)
    assert suite.report([deep, base], tasks)["gate"]["pass"] is True
