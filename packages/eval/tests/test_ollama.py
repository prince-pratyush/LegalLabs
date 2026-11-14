from pathlib import Path

import httpx
import pytest

from legallabs_eval import models
from legallabs_eval.costs import price
from legallabs_eval.models import ModelClient


def test_ollama_body_sets_window_and_schema(tmp_path: Path) -> None:
    sent = []

    def send(vendor: str, body: dict) -> tuple[str, int, int]:
        sent.append(body)
        return '{"quotes": []}', 50, 5

    client = ModelClient("ollama", "qwen3:4b-instruct", 300, send, context_tokens=4096)
    client.preflight()  # no key needed
    text, cost = client.complete("sys", "prompt", tmp_path, {"type": "object"})
    body = sent[0]
    assert body["options"] == {"temperature": 0, "num_predict": 300, "num_ctx": 4096}
    assert body["format"] == {"type": "object"}
    assert body["stream"] is False
    assert text == '{"quotes": []}'
    assert cost.cost_known and cost.usd == 0.0 and cost.input_tokens == 50


def test_ollama_http_reads_native_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    def post(url: str, **kwargs: object) -> httpx.Response:
        assert url == "http://box:11434/api/chat"
        reply = {"message": {"content": "hi"}, "prompt_eval_count": 7, "eval_count": 2}
        return httpx.Response(200, json=reply)

    monkeypatch.setenv("OLLAMA_BASE_URL", "http://box:11434/")
    monkeypatch.setattr(models.httpx, "post", post)
    assert models._http("ollama", {}) == ("hi", 7, 2)


def test_local_model_is_free() -> None:
    assert price("qwen3:4b-instruct", 10_000, 1_000).usd == 0.0
