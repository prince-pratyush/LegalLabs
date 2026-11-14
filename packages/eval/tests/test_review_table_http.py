import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from legallabs_eval.harnesses.legallabs_review_table import LegalLabsReviewTableHarness, option_id
from legallabs_eval.runner import Runner
from legallabs_eval.suites.review_table_e2e import ReviewTableE2e
from tests.test_review_table import CONTRACT, cuad_file  # noqa: F401  (fixture)

# What the fake server answers per column key: (status, value_text, value_typed, cited, ok).
ANSWERS: dict[str, tuple[str, str | None, dict[str, Any] | None, int, int]] = {
    "Parties": ("done", "Acme Widgets, Inc. and Beta Stores LLC", None, 1, 1),
    "Agreement date": (
        "done",
        "April 6, 1999",
        {"kind": "date", "iso": "1999-04-06", "precision": "day"},
        1,
        1,
    ),  # noqa: E501
    "Governing law": ("done", "New York", {"kind": "free", "markdown": "New York"}, 1, 1),
    "Insurance amount": ("null", None, None, 0, 0),
    "Exclusivity": ("done", "Yes", {"kind": "classify", "option_ids": ["yes"]}, 1, 0),
    "Termination for convenience": ("error", None, None, 1, 0),
}


def fake_api(seen: list[httpx.Request]) -> httpx.MockTransport:
    columns: list[dict[str, Any]] = []
    busy = {"turned_away": False}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path, method = request.url.path, request.method
        if path == "/auth/login":
            return httpx.Response(200, json={}, headers={"set-cookie": "__Host-sid=tok; Secure"})
        if request.headers.get("cookie") != "__Host-sid=tok":
            return httpx.Response(401)
        if path == "/api/v1/documents" and method == "POST":
            return httpx.Response(201, json={"document": {"id": "d1", "status": "queued"}})
        if path == "/api/v1/documents":
            return httpx.Response(200, json={"documents": [{"id": "d1", "status": "indexed"}]})
        if path == "/api/v1/review-tables" and method == "POST":
            assert json.loads(request.content)["source"] == {
                "kind": "uploads",
                "upload_ids": ["d1"],
            }  # noqa: E501
            return httpx.Response(201, json={"table": {"id": "t1"}})
        if path == "/api/v1/review-tables/t1/columns":
            body = json.loads(request.content)
            column = {"id": f"c{len(columns)}", "state": "pending", **body}
            columns.append(column)
            return httpx.Response(201, json={"column": column})
        if path.endswith("/run"):
            # The first try is turned away, as the 3-running cap would.
            if not busy["turned_away"]:
                busy["turned_away"] = True
                return httpx.Response(409, json={"error": {"code": "TOO_MANY_RUNNING"}})
            column = next(c for c in columns if c["id"] == path.split("/")[-2])
            column["state"] = "done"
            return httpx.Response(202, json={"run_id": "r", "estimate": {}})
        if path == "/api/v1/review-tables/t1":
            return httpx.Response(200, json={"table": {"id": "t1"}, "columns": columns})
        if path == "/api/v1/review-tables/t1/rows":
            cells = []
            for c in columns:
                status, text, typed, cited, ok = ANSWERS[c["label"]]
                cells.append(
                    {
                        "id": f"x{c['id']}",
                        "row_id": "row1",
                        "column_id": c["id"],
                        "status": status,
                        "error_code": "CITATION_UNVERIFIED" if status == "error" else None,
                        "value_text": text,
                        "value_typed": typed,
                        "citation_count": cited,
                        "verified_citation_count": ok,
                        "cost_usd": 0.0,
                        "usage": {"input_tokens": 10, "output_tokens": 2},
                        "model": "ollama/qwen3:4b-instruct",
                    }
                )
            rows = [{"id": "row1", "document_ids": ["d1"]}]
            return httpx.Response(200, json={"rows": rows, "cells": cells, "next_cursor": None})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


@pytest.fixture
def api_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LEGALLABS_URL", "http://localhost:8787")
    monkeypatch.setenv("LEGALLABS_WORKSPACE", "w")
    monkeypatch.setenv("LEGALLABS_EMAIL", "e@x.test")
    monkeypatch.setenv("LEGALLABS_PASSWORD", "pw")
    monkeypatch.delenv("LEGALLABS_VAULT_ID", raising=False)


def test_http_table_run_is_graded_like_offline(
    cuad_file: Path,  # noqa: F811
    tmp_path: Path,
    api_env: None,
) -> None:
    seen: list[httpx.Request] = []
    system = {"harness": "legallabs-review-table", "params": {"poll_seconds": 0}}
    harness = LegalLabsReviewTableHarness(
        "rt", system, fake_api(seen), sleep=lambda _: None, clock=iter(range(0, 10_000, 5)).__next__
    )
    suite = ReviewTableE2e(local=cuad_file)
    summary = Runner("rt", system, harness, suite, tmp_path, retry_delay=0).run()
    report = summary["report"]
    assert summary["completed_tasks"] == 1
    # Right: parties, date, law, exclusivity. Wrong: missed insurance, errored clause.
    assert report["cell_accuracy"] == pytest.approx(4 / 6, abs=1e-3)
    assert report["valid_citation_rate"] == pytest.approx(3 / 5, abs=1e-3)
    assert report["null_precision"] == 0.0
    assert report["latency_median_s_per_doc"] > 0
    made = [json.loads(r.content) for r in seen if r.url.path.endswith("/columns")]
    exclusivity = next(c for c in made if c["type"] == "classify")
    assert [o["id"] for o in exclusivity["options"]["options"]] == ["yes", "no"]
    assert exclusivity["options"]["allow_other"] is False
    assert option_id("Mixed Cash/Stock") == "mixed_cash_stock"
    assert CONTRACT  # the fixture's document was uploaded
