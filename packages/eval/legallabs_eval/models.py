import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from .costs import price
from .io import append_jsonl
from .schemas import Cost, HarnessError, NonRetryableError

ENDPOINTS = {
    "openai": ("https://api.openai.com", "OPENAI_API_KEY"),
    "anthropic": ("https://api.anthropic.com", "ANTHROPIC_API_KEY"),
}

# Takes the request body, returns (text, input_tokens, output_tokens). Swapped out in tests.
Send = Callable[[str, dict[str, Any]], tuple[str, int, int]]


class ModelClient:
    """One vendor and model, always at temperature 0, with every call traced."""

    def __init__(
        self, vendor: str, model: str, max_tokens: int = 2048, send: Send | None = None
    ) -> None:
        if vendor not in ENDPOINTS:
            raise NonRetryableError(f"unknown vendor {vendor}")
        self.vendor = vendor
        self.model = model
        self.max_tokens = max_tokens
        self._send = send or self._http

    def preflight(self) -> None:
        if self._send == self._http and not os.environ.get(ENDPOINTS[self.vendor][1]):
            raise NonRetryableError(f"{ENDPOINTS[self.vendor][1]} is not set")

    def complete(
        self, system: str, prompt: str, trace_dir: Path, schema: dict[str, Any] | None = None
    ) -> tuple[str, Cost]:
        body = self._body(system, prompt, schema)
        append_jsonl(trace_dir / "requests.jsonl", body)
        text, input_tokens, output_tokens = self._send(self.vendor, body)
        append_jsonl(
            trace_dir / "responses.jsonl",
            {"text": text, "usage": {"input": input_tokens, "output": output_tokens}},
        )
        return text, price(self.model, input_tokens, output_tokens)

    def _body(self, system: str, prompt: str, schema: dict[str, Any] | None) -> dict[str, Any]:
        if schema:
            # In the prompt for every vendor; the reply is still parsed strictly.
            system += "\nReply with only a JSON object matching this schema:\n" + json.dumps(schema)
        if self.vendor == "anthropic":
            return {
                "model": self.model,
                "max_tokens": self.max_tokens,
                "temperature": 0,
                "system": system,
                "messages": [{"role": "user", "content": prompt}],
            }
        body = {
            "model": self.model,
            "max_completion_tokens": self.max_tokens,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        }
        if schema:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "answer", "strict": True, "schema": schema},
            }
        return body

    @staticmethod
    def _http(vendor: str, body: dict[str, Any]) -> tuple[str, int, int]:
        base, key_env = ENDPOINTS[vendor]
        key = os.environ.get(key_env, "")
        if vendor == "anthropic":
            path = "/v1/messages"
            headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
        else:
            path = "/v1/chat/completions"
            headers = {"authorization": f"Bearer {key}"}
        try:
            response = httpx.post(base + path, json=body, headers=headers, timeout=300)
        except httpx.TransportError as err:
            raise HarnessError(str(err)) from err
        if response.status_code == 429 or response.status_code >= 500:
            raise HarnessError(f"{vendor} returned {response.status_code}")
        if response.status_code >= 400:
            raise NonRetryableError(f"{vendor} returned {response.status_code}")
        data = response.json()
        if vendor == "anthropic":
            text = "".join(b.get("text", "") for b in data["content"])
            usage = data["usage"]
            return text, usage["input_tokens"], usage["output_tokens"]
        usage = data["usage"]
        text = data["choices"][0]["message"]["content"] or ""
        return text, usage["prompt_tokens"], usage["completion_tokens"]


def parse_json(text: str) -> dict[str, Any] | None:
    """Strict: the whole reply must be one JSON object, or the answer counts as invalid."""
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def recorded(replies: list[str], tokens: tuple[int, int] = (100, 10)) -> Send:
    """Plays back fixed replies in order, for tests and dry runs."""
    queue = list(replies)

    def send(vendor: str, body: dict[str, Any]) -> tuple[str, int, int]:
        if not queue:
            raise NonRetryableError("no recorded reply left")
        return queue.pop(0), *tokens

    return send
