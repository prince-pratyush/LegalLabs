import json

import httpx
import pytest

from legallabs_eval.harnesses.bm25 import Bm25Harness, chunk
from legallabs_eval.harnesses.legallabs_search import LegalLabsSearchHarness
from legallabs_eval.metrics import Relevant, ndcg_at, recall_at, span_iou, token_f1
from legallabs_eval.runner import Runner
from legallabs_eval.schemas import Document, HarnessRequest, Hit, NonRetryableError
from legallabs_eval.suites.retrieval_golden import RetrievalGolden

REL = [Relevant("a.md", 1, (0, 10)), Relevant("b.md", 1, (50, 60))]


def test_ndcg_is_one_for_a_perfect_ranking():
    hits = [Hit("a.md", 1, 0, 20), Hit("b.md", 1, 40, 70)]
    assert ndcg_at(hits, REL, 10) == pytest.approx(1.0)


def test_ndcg_rewards_earlier_hits():
    late = [Hit("x.md"), Hit("a.md", 1, 0, 20), Hit("b.md", 1, 40, 70)]
    assert 0 < ndcg_at(late, REL, 10) < 1


def test_repeated_hits_on_one_item_earn_once():
    hits = [Hit("a.md", 1, 0, 20), Hit("a.md", 1, 5, 9)]
    assert recall_at(hits, REL, 10) == 0.5


def test_hit_on_wrong_span_does_not_count():
    assert recall_at([Hit("a.md", 1, 11, 30)], REL, 10) == 0.0


def test_recall_respects_budget():
    hits = [Hit("x.md"), Hit("a.md", 1, 0, 5)]
    assert recall_at(hits, REL, 1) == 0.0
    assert recall_at(hits, REL, 2) == 0.5


def test_token_f1_and_iou():
    assert token_f1("the fee is due", "fee is due") == pytest.approx(6 / 7)
    assert token_f1("", "") == 1.0
    assert span_iou({1, 2}, {2, 3}) == pytest.approx(1 / 3)


def test_every_golden_quote_resolves():
    suite = RetrievalGolden()
    tasks = suite.load_tasks()
    assert len(tasks) >= 20
    assert all(t.answer for t in tasks)
    assert suite.dataset_fingerprint.startswith("synthetic-")


def test_chunks_cover_the_document_in_order():
    doc = Document("d.md", "para one\n\npara two\n\n" + "x" * 2000)
    chunks = chunk(doc, size=100)
    assert len(chunks) == 2
    assert all(doc.text[c.char_from : c.char_to] == c.text for c in chunks)


def test_bm25_baseline_produces_a_summary(tmp_path):
    system = {"harness": "bm25"}
    summary = Runner("bm25", system, Bm25Harness("bm25", system), RetrievalGolden(), tmp_path).run()
    assert summary["completed_tasks"] == summary["selected_tasks"]
    assert 0.3 < summary["failed_as_zero"] <= 1.0
    assert (tmp_path / summary["run_dir"].split("/")[-1] / "summary.json").exists()


def fake_api(seen: list[httpx.Request]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        if path == "/auth/login":
            return httpx.Response(200, json={}, headers={"set-cookie": "__Host-sid=tok; Secure"})
        if request.headers.get("cookie") != "__Host-sid=tok":
            return httpx.Response(401)
        if path == "/api/v1/documents" and request.method == "GET":
            return httpx.Response(
                200, json={"documents": [{"id": "d1", "name": "a.md", "size": 3}]}
            )
        if path == "/api/v1/documents":
            return httpx.Response(201, json={"document": {"id": "d2"}})
        if path == "/api/v1/documents/search":
            passage = {
                "document_name": "a.md",
                "page": 1,
                "char_from": 0,
                "char_to": 3,
                "text": "abc",
            }
            return httpx.Response(200, json={"passages": [passage]})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


@pytest.fixture
def api_env(monkeypatch):
    for key, value in {"URL": "http://api.test", "WORKSPACE": "w", "EMAIL": "e@x.test"}.items():
        monkeypatch.setenv(f"LEGALLABS_{key}", value)
    monkeypatch.setenv("LEGALLABS_PASSWORD", "pw")


def test_legallabs_search_uploads_missing_docs_and_scopes_search(tmp_path, api_env):
    seen: list[httpx.Request] = []
    harness = LegalLabsSearchHarness("ll", {"harness": "legallabs-search"}, fake_api(seen))
    harness.prepare([Document("a.md", "abc"), Document("b.md", "new")])
    uploads = [r for r in seen if r.method == "POST" and r.url.path == "/api/v1/documents"]
    assert len(uploads) == 1
    assert harness.document_ids == ["d1", "d2"]

    task = RetrievalGolden().load_tasks(1)[0]
    request = HarnessRequest(task, "retrieval-golden", "", tmp_path / "a", tmp_path, top_k=20)
    result = harness.run(request)
    assert result.hits == [Hit("a.md", 1, 0, 3, "abc")]
    search = seen[-1]
    assert search.url.params.get_list("document_id") == ["d1", "d2"]
    trace = (tmp_path / "a/agent/requests.jsonl").read_text()
    assert "pw" not in trace and "tok" not in trace
    assert json.loads(trace)["params"]["limit"] == 20


def test_legallabs_search_needs_credentials(monkeypatch):
    monkeypatch.delenv("LEGALLABS_URL", raising=False)
    harness = LegalLabsSearchHarness("ll", {"harness": "legallabs-search"})
    with pytest.raises(NonRetryableError, match="LEGALLABS_URL"):
        harness.prepare([])
