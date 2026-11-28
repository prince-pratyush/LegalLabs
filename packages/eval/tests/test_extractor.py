"""A local extractor as an eval system (MDL-006 plumbing), against a fake server.

No trained model exists: the server below answers by hand-written rules, and the fixtures
are a few invented lines. Nothing here says anything about any model's quality.
"""

import csv
import io
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from legallabs_eval import models
from legallabs_eval.config import load_config
from legallabs_eval.models import ModelClient
from legallabs_eval.registry import make_harness
from legallabs_eval.runner import Runner
from legallabs_eval.schemas import HarnessError, NonRetryableError
from legallabs_eval.suites.extract_cuad import ExtractCuad
from legallabs_eval.suites.extract_maud import ExtractMaud
from legallabs_eval.suites.review_table_e2e import ReviewTableE2e

URL = "LEGALLABS_EVAL_EXTRACTOR_URL"
KEY = "LEGALLABS_EVAL_EXTRACTOR_KEY"
MODEL = "LEGALLABS_EVAL_EXTRACTOR_MODEL"
IN = "LEGALLABS_EVAL_EXTRACTOR_INPUT_USD_PER_MTOK"
OUT = "LEGALLABS_EVAL_EXTRACTOR_OUTPUT_USD_PER_MTOK"

CONTRACT = "SUPPLY AGREEMENT. This Agreement is governed by the laws of the State of New York."
LAW = "This Agreement is governed by the laws of the State of New York."
REPLY = {
    "value": LAW,
    "reasoning": "r",
    "citations": [{"document_id": "d", "page": 1, "quote": LAW}],
    "not_found": False,
}


class Fake(BaseHTTPRequestHandler):
    seen: list[dict] = []
    status = 200
    usage = True

    def do_POST(self) -> None:  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        self.seen.append(
            {"path": self.path, "auth": self.headers.get("authorization"), "body": body}
        )
        reply: dict = {"choices": [{"message": {"content": json.dumps(REPLY)}}]}
        if self.usage:
            reply["usage"] = {"prompt_tokens": 1000, "completion_tokens": 100}
        data = json.dumps(reply).encode()
        self.send_response(self.status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args: object) -> None:
        pass


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> Iterator[type[Fake]]:
    class Handler(Fake):
        seen: list[dict] = []

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    for name in (KEY, IN, OUT):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(URL, f"http://127.0.0.1:{httpd.server_address[1]}/v1/")
    monkeypatch.setenv(MODEL, "extractor-under-test")
    # A proxy in the environment is not used: the documents go to the endpoint and nowhere else.
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    yield Handler
    httpd.shutdown()
    httpd.server_close()


def cuad(tmp_path: Path) -> ExtractCuad:
    question = 'Highlight the parts related to "Governing Law" that should be reviewed.'
    qa = {"id": "x__law", "question": question, "answers": [{"text": LAW}]}
    path = tmp_path / "cuad.json"
    path.write_text(
        json.dumps({"data": [{"title": "X", "paragraphs": [{"context": CONTRACT, "qas": [qa]}]}]})
    )
    return ExtractCuad(local=path)


def maud(tmp_path: Path) -> ExtractMaud:
    out = io.StringIO()
    fields = ["data_type", "question", "subquestion", "answer", "label", "category"]
    writer = csv.DictWriter(out, [*fields, "contract_name", "text"])
    writer.writeheader()
    for label, answer in enumerate(["New York", LAW]):
        writer.writerow(
            {
                "data_type": "main",
                "question": "Governing law-Answer",
                "subquestion": "<NONE>",
                "answer": answer,
                "label": label,
                "category": "General",
                "contract_name": f"c{label}",
                "text": CONTRACT,
            }
        )
    path = tmp_path / "maud.csv"
    path.write_text(out.getvalue())
    return ExtractMaud(local=path)


def table(tmp_path: Path) -> ReviewTableE2e:
    cuad(tmp_path)
    return ReviewTableE2e(local=tmp_path / "cuad.json")


def run(suite: object, tmp_path: Path) -> dict:
    system = load_config()["systems"]["ros-ai"]
    harness = make_harness("ros-ai", system)
    runner = Runner("ros-ai", system, harness, suite, tmp_path / "runs", retry_delay=0)
    return runner.run()


@pytest.mark.parametrize("make", [cuad, maud, table])
def test_the_extractor_runs_every_suite_an_adoption_needs(
    make: object, server: type[Fake], tmp_path: Path
) -> None:
    summary = run(make(tmp_path), tmp_path)
    assert summary["total_failed"] == 0
    assert summary["environment"] == {"model": "extractor-under-test"}
    first = server.seen[0]
    assert first["path"] == "/v1/chat/completions"
    assert first["auth"] is None
    assert first["body"]["model"] == "extractor-under-test"
    assert first["body"]["max_tokens"] == 512
    assert "max_completion_tokens" not in first["body"]
    # No price was declared, so the cost is unknown rather than free.
    assert summary["cost"]["total_cost_usd"] is None
    assert summary["cost"]["by_stage"]["agent"]["missing_cost_count"] > 0
    assert summary["dataset_fingerprint"]
    assert len(summary["task_set"]) == 64


def test_a_declared_price_and_key_are_used(
    server: type[Fake], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv(IN, "0.5")
    monkeypatch.setenv(OUT, "2")
    monkeypatch.setenv(KEY, "test-key")
    summary = run(cuad(tmp_path), tmp_path)
    # 1000 tokens in at 0.5 and 100 out at 2 USD per million.
    assert summary["cost"]["total_cost_usd"] == pytest.approx(0.0007)
    assert server.seen[0]["auth"] == "Bearer test-key"
    traces = "".join(p.read_text() for p in (tmp_path / "runs").rglob("*.json*"))
    assert "test-key" not in traces


@pytest.mark.parametrize(
    "prices",
    [{IN: "1"}, {OUT: "1"}, {IN: "0", OUT: "1"}, {IN: "x", OUT: "1"}, {IN: "-1", OUT: "1"}],
)
def test_a_half_set_or_free_price_is_refused(
    prices: dict, server: type[Fake], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    for name, value in prices.items():
        monkeypatch.setenv(name, value)
    with pytest.raises(NonRetryableError, match="USD_PER_MTOK"):
        run(cuad(tmp_path), tmp_path)
    assert server.seen == []


def test_a_change_of_model_or_price_starts_a_new_run(
    server: type[Fake], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    first = run(cuad(tmp_path), tmp_path)
    monkeypatch.setenv(MODEL, "another")
    second = run(cuad(tmp_path), tmp_path)
    monkeypatch.setenv(IN, "1")
    monkeypatch.setenv(OUT, "1")
    third = run(cuad(tmp_path), tmp_path)
    assert len({first["run_dir"], second["run_dir"], third["run_dir"]}) == 3


def test_the_endpoint_comes_from_the_environment_alone(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv(MODEL, "m")
    monkeypatch.delenv(URL, raising=False)
    with pytest.raises(NonRetryableError, match=URL):
        ModelClient("openai-compatible", "m").preflight()
    for bad in ("file:///etc/passwd", "ftp://host/v1", "localhost:8000", "http://u:p@host/v1"):
        monkeypatch.setenv(URL, bad)
        with pytest.raises(NonRetryableError, match=URL):
            ModelClient("openai-compatible", "m").preflight()
    monkeypatch.delenv(MODEL)
    with pytest.raises(NonRetryableError, match=MODEL):
        make_harness("ros-ai", load_config()["systems"]["ros-ai"])


def test_a_server_that_fails_or_gives_no_usage_is_an_error(server: type[Fake]) -> None:
    server.status = 500
    with pytest.raises(HarnessError):
        models._http("openai-compatible", {})
    server.status = 200
    server.usage = False
    # Without a token count there is no cost, and guessing none would be free.
    with pytest.raises(HarnessError):
        models._http("openai-compatible", {})


def test_other_systems_keep_their_run_hashes() -> None:
    assert ModelClient("ollama", "m").fingerprint() == ""
    assert ModelClient("anthropic", "m").fingerprint() == ""
