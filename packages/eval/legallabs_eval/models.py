import hashlib
import json
import math
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from .costs import price
from .io import append_jsonl
from .schemas import Cost, HarnessError, NonRetryableError, raise_for_status


@dataclass(frozen=True)
class Vendor:
    url: str
    key_env: str
    style: str  # "anthropic", "openai", "ollama" or "openai-compatible": request and reply
    url_env: str = ""  # overrides url when set, for servers that move (a local Ollama)


VENDORS = {
    "anthropic": Vendor("https://api.anthropic.com/v1/messages", "ANTHROPIC_API_KEY", "anthropic"),
    "openai": Vendor("https://api.openai.com/v1/chat/completions", "OPENAI_API_KEY", "openai"),
    # Gemini's OpenAI-compatible endpoint, so a third vendor can judge.
    "google": Vendor(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "GEMINI_API_KEY",
        "openai",
    ),
    # Local and free. The native API, since only it takes num_ctx and a JSON schema format.
    "ollama": Vendor("http://localhost:11434/api/chat", "", "ollama", "OLLAMA_BASE_URL"),
    # A server of the operator's own that speaks the OpenAI chat API, such as a local
    # extractor under trial. It has no default address, and its key is optional.
    "openai-compatible": Vendor(
        "",
        "LEGALLABS_EVAL_EXTRACTOR_KEY",
        "openai-compatible",
        "LEGALLABS_EVAL_EXTRACTOR_URL",
    ),
}

# What the operator says that server costs to run, in USD per million tokens.
EXTRACTOR_PRICES = (
    "LEGALLABS_EVAL_EXTRACTOR_INPUT_USD_PER_MTOK",
    "LEGALLABS_EVAL_EXTRACTOR_OUTPUT_USD_PER_MTOK",
)


def model_name(system_name: str, params: dict[str, Any]) -> str:
    """The model a system names, or reads from the environment variable it names."""
    variable = params.get("model_env")
    if variable is None:
        return params["model"]
    value = os.environ.get(variable, "").strip()
    if not value:
        raise NonRetryableError(f"{system_name}: {variable} is not set")
    return value


def endpoint(spec: "Vendor") -> str:
    """The operator's own server, from the environment and nowhere else."""
    base = os.environ.get(spec.url_env, "").strip().rstrip("/")
    parts = urlsplit(base)
    if parts.scheme not in ("http", "https") or not parts.hostname or "@" in parts.netloc:
        raise NonRetryableError(f"{spec.url_env} must be set to an http(s) base URL")
    return f"{base}/chat/completions"


def extractor_rates() -> tuple[float, float] | None:
    """Both prices or neither. A server someone runs is never free, so zero is refused."""
    given = [os.environ.get(name, "").strip() for name in EXTRACTOR_PRICES]
    if not any(given):
        return None
    try:
        rates = (float(given[0]), float(given[1]))
    except ValueError:
        rates = (0.0, 0.0)
    if not all(math.isfinite(rate) and rate > 0 for rate in rates):
        names = " and ".join(EXTRACTOR_PRICES)
        raise NonRetryableError(f"set both {names} to numbers above zero, or neither")
    return rates


# Takes the vendor and request body, returns (text, input_tokens, output_tokens).
Send = Callable[[str, dict[str, Any]], tuple[str, int, int]]


class ModelClient:
    """One vendor and model, always at temperature 0, with every call traced."""

    def __init__(
        self,
        vendor: str,
        model: str,
        max_tokens: int = 2048,
        send: Send | None = None,
        context_tokens: int | None = None,
    ) -> None:
        if vendor not in VENDORS:
            raise NonRetryableError(f"unknown vendor {vendor}")
        self.vendor = vendor
        self.spec = VENDORS[vendor]
        self.model = model
        self.max_tokens = max_tokens
        # Ollama serves 4k unless told otherwise; other vendors ignore it.
        self.context_tokens = context_tokens
        self._send = send or _http
        self._own = self.spec.style == "openai-compatible"
        self._rates = extractor_rates() if self._own else None

    def preflight(self) -> None:
        if self._send is not _http:
            return
        if self._own:
            endpoint(self.spec)
        elif self.spec.key_env and not os.environ.get(self.spec.key_env):
            raise NonRetryableError(f"{self.spec.key_env} is not set")

    def fingerprint(self) -> str:
        """For the operator's own server, what the environment decides about a run."""
        if not self._own:
            return ""
        said = json.dumps([os.environ.get(self.spec.url_env, ""), self.model, self._rates])
        return hashlib.sha256(said.encode()).hexdigest()[:16]

    def cost(self, input_tokens: int, output_tokens: int) -> Cost:
        # The price table is for the vendors' models, whatever this server calls its own.
        if not self._own:
            return price(self.model, input_tokens, output_tokens)
        if self._rates is None:
            return Cost(None, False, input_tokens, output_tokens)
        usd = (input_tokens * self._rates[0] + output_tokens * self._rates[1]) / 1_000_000
        return Cost(usd, True, input_tokens, output_tokens)

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
        return text, self.cost(input_tokens, output_tokens)

    def _body(self, system: str, prompt: str, schema: dict[str, Any] | None) -> dict[str, Any]:
        if schema:
            # In the prompt for every vendor; the reply is still parsed strictly.
            system += "\nReply with only a JSON object matching this schema:\n" + json.dumps(schema)
        if self.spec.style == "ollama":
            options: dict[str, Any] = {"temperature": 0, "num_predict": self.max_tokens}
            if self.context_tokens:
                options["num_ctx"] = self.context_tokens
            ollama: dict[str, Any] = {
                "model": self.model,
                "stream": False,
                "options": options,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
            }
            if schema:
                ollama["format"] = schema
            return ollama
        if self.spec.style == "anthropic":
            return {
                "model": self.model,
                "max_tokens": self.max_tokens,
                "temperature": 0,
                "system": system,
                "messages": [{"role": "user", "content": prompt}],
            }
        # Servers other than OpenAI's mostly know only the older name of the limit.
        limit = "max_tokens" if self._own else "max_completion_tokens"
        body: dict[str, Any] = {
            "model": self.model,
            limit: self.max_tokens,
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


def _http(vendor: str, body: dict[str, Any]) -> tuple[str, int, int]:
    spec = VENDORS[vendor]
    key = os.environ.get(spec.key_env, "") if spec.key_env else ""
    url = spec.url
    own = spec.style == "openai-compatible"
    if own:
        url = endpoint(spec)
    elif spec.url_env and os.environ.get(spec.url_env):
        url = os.environ[spec.url_env].rstrip("/") + "/api/chat"
    if spec.style == "anthropic":
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    elif key:
        headers = {"authorization": f"Bearer {key}"}
    else:
        headers = {}
    try:
        # A small local model on a busy laptop can take minutes on one long prompt.
        # No proxy from the environment on the way to the operator's own server.
        direct = {"trust_env": False} if own else {}
        response = httpx.post(url, json=body, headers=headers, timeout=900, **direct)
    except httpx.TransportError as err:
        raise HarnessError(str(err)) from err
    raise_for_status(response.status_code, vendor)
    try:
        data = response.json()
        if spec.style == "anthropic":
            text = "".join(b.get("text", "") for b in data["content"])
            return text, data["usage"]["input_tokens"], data["usage"]["output_tokens"]
        if spec.style == "ollama":
            text = data["message"]["content"] or ""
            return text, int(data.get("prompt_eval_count", 0)), int(data.get("eval_count", 0))
        usage = data["usage"]
        text = data["choices"][0]["message"]["content"] or ""
        return text, usage["prompt_tokens"], usage["completion_tokens"]
    except (KeyError, IndexError, TypeError, ValueError) as err:
        raise HarnessError(f"{vendor} sent a reply we could not read") from err


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
