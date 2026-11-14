import os
from typing import Any

import httpx

from ..io import append_jsonl
from ..schemas import (
    Cost,
    Document,
    HarnessError,
    HarnessRequest,
    HarnessResult,
    Hit,
    NonRetryableError,
    raise_for_status,
)
from .base import Harness

# The API caps a search at this many passages.
MAX_LIMIT = 50
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _check(response: httpx.Response) -> httpx.Response:
    raise_for_status(response.status_code, response.request.url.path)
    return response


class LegalLabsSearchHarness(Harness):
    """Our stack, reached only through its public HTTP API, never its internals."""

    kinds = frozenset({"retrieval"})

    def __init__(
        self, system_name: str, system: dict[str, Any], transport: httpx.BaseTransport | None = None
    ) -> None:
        super().__init__(system_name, system)
        params = system.get("params", {})
        self.env = {
            key: params.get(f"{key}_env", f"LEGALLABS_{key.upper()}")
            for key in ("url", "workspace", "email", "password")
        }
        self.extra: dict[str, Any] = params.get("search_params", {})
        self.transport = transport
        self.client: httpx.Client | None = None
        self.document_ids: list[str] = []

    def _env(self, key: str) -> str:
        value = os.environ.get(self.env[key])
        if not value:
            raise NonRetryableError(f"{self.env[key]} is not set")
        return value

    def prepare(self, corpus: list[Document]) -> None:
        url = httpx.URL(self._env("url"))
        # The session cookie is sent by hand, so plain http is only safe on this machine.
        if url.scheme != "https" and url.host not in LOCAL_HOSTS:
            raise NonRetryableError("LegalLabs URL must use https unless it is localhost")
        self.client = httpx.Client(base_url=url, timeout=60, transport=self.transport)
        login = _check(
            self.client.post(
                "/auth/login",
                json={
                    "workspace": self._env("workspace"),
                    "email": self._env("email"),
                    "password": self._env("password"),
                },
            )
        )
        token = login.cookies.get("__Host-sid")
        if not token:
            raise NonRetryableError("login returned no session cookie")
        # Set by hand: a Secure cookie is not sent back over plain http to localhost.
        self.client.headers["cookie"] = f"__Host-sid={token}"

        # Uploaded fresh each run: a same-named old copy could hold different text.
        self.document_ids = []
        for doc in corpus:
            files = {"file": (doc.name, doc.text.encode(), "text/markdown")}
            response = _check(self.client.post("/api/v1/documents", files=files))
            self.document_ids.append(response.json()["document"]["id"])

    def run(self, request: HarnessRequest) -> HarnessResult:
        if self.client is None:
            raise NonRetryableError("prepare() was not called")
        # Scoped to the corpus, so other documents in the workspace can't affect the score.
        params: dict[str, Any] = {
            "q": request.task.problem,
            "limit": min(request.top_k or 10, MAX_LIMIT),
            "document_id": self.document_ids,
            **self.extra,
        }
        trace = request.attempt_dir / "agent"
        append_jsonl(
            trace / "requests.jsonl", {"method": "GET", "path": "search", "params": params}
        )
        try:
            response = self.client.get("/api/v1/documents/search", params=params)
        except httpx.TransportError as err:
            raise HarnessError(str(err)) from err
        passages = _check(response).json()["passages"]
        append_jsonl(
            trace / "responses.jsonl", {"status": response.status_code, "passages": passages}
        )
        hits = [
            Hit(p["document_name"], p.get("page"), p.get("char_from"), p.get("char_to"), p["text"])
            for p in passages
        ]
        return HarnessResult(hits=hits, provider="legallabs", model="search", cost=Cost.free())

    def close(self) -> None:
        if self.client is not None:
            self.client.close()
