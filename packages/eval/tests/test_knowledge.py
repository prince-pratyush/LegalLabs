import json
from pathlib import Path

import httpx
import pytest

from legallabs_eval.harnesses.legallabs_knowledge import LegalLabsKnowledgeHarness
from legallabs_eval.metrics import Relevant
from legallabs_eval.registry import make_suite
from legallabs_eval.schemas import HarnessRequest, Hit, NonRetryableError
from legallabs_eval.suites.retrieval_knowledge import DATA, SOURCES, RetrievalKnowledge


@pytest.mark.parametrize("source", SOURCES)
def test_each_source_has_a_golden_set(source: str) -> None:
    suite = make_suite(f"retrieval-golden-{source}", None, 2)
    tasks = suite.load_tasks()
    assert len(tasks) >= 10
    assert all(t.metadata["source"] == source for t in tasks)
    assert all(t.answer and all(isinstance(r, Relevant) for r in t.answer) for t in tasks)
    assert suite.dataset_fingerprint.startswith(f"synthetic-{source}-")


def test_edgar_golden_set_names_only_loaded_filings() -> None:
    records = json.loads((DATA / "edgar/records/synthetic-filings.json").read_text())
    accessions = {c["text"] for r in records for c in r["citations"] if c["kind"] == "accession"}
    assert all(r["meta"]["synthetic"] for r in records)
    for task in RetrievalKnowledge("edgar").load_tasks():
        assert {r.doc for r in task.answer} <= accessions


def test_unknown_source_is_refused() -> None:
    with pytest.raises(ValueError):
        RetrievalKnowledge("bailii")


def fake_api(seen: list[httpx.Request], doc_count: int = 3) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        if path == "/auth/login":
            return httpx.Response(200, json={}, headers={"set-cookie": "__Host-sid=tok; Secure"})
        if request.headers.get("cookie") != "__Host-sid=tok":
            return httpx.Response(401)
        if path.startswith("/api/v1/knowledge/sources/"):
            return httpx.Response(200, json={"doc_count": doc_count})
        if path == "/api/v1/knowledge/search":
            passages = [
                {"authority_ref": "eurlex:celex:1", "citation": "CELEX:32016R0679", "text": "a"},
                {"authority_ref": "eurlex:celex:x", "citation": None, "text": "b"},
            ]
            return httpx.Response(200, json={"passages": passages})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


@pytest.fixture
def api_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key, value in {
        "URL": "http://localhost:8787",
        "WORKSPACE": "w",
        "EMAIL": "e@x.test",
    }.items():
        monkeypatch.setenv(f"LEGALLABS_{key}", value)
    monkeypatch.setenv("LEGALLABS_PASSWORD", "pw")


def test_harness_searches_one_source_and_names_hits_by_citation(
    tmp_path: Path, api_env: None
) -> None:
    seen: list[httpx.Request] = []
    harness = LegalLabsKnowledgeHarness("k", {"harness": "legallabs-knowledge"}, fake_api(seen))
    harness.prepare([])
    assert not any(r.url.path == "/api/v1/documents" for r in seen)
    task = RetrievalKnowledge("eurlex").load_tasks(1)[0]
    request = HarnessRequest(
        task, "retrieval-golden-eurlex", "", tmp_path / "a", tmp_path, top_k=50
    )
    result = harness.run(request)
    assert result.hits == [Hit("CELEX:32016R0679", text="a"), Hit("eurlex:celex:x", text="b")]
    search = seen[-1]
    assert search.url.params["source"] == "eurlex"
    assert search.url.params["limit"] == "50"
    harness.run(request)
    checks = [r for r in seen if r.url.path.startswith("/api/v1/knowledge/sources/")]
    assert len(checks) == 1


def test_harness_stops_when_the_source_is_empty(tmp_path: Path, api_env: None) -> None:
    harness = LegalLabsKnowledgeHarness("k", {"harness": "legallabs-knowledge"}, fake_api([], 0))
    harness.prepare([])
    task = RetrievalKnowledge("edgar").load_tasks(1)[0]
    request = HarnessRequest(task, "retrieval-golden-edgar", "", tmp_path / "a", tmp_path)
    with pytest.raises(NonRetryableError, match="sync or load"):
        harness.run(request)
