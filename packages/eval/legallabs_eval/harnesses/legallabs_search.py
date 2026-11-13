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
)
from .base import Harness

# The API caps a search at this many passages.
MAX_LIMIT = 50


def _check(response: httpx.Response) -> httpx.Response:
    if response.status_code == 429 or response.status_code >= 500:
        raise HarnessError(f"{response.request.url.path} returned {response.status_code}")
    if response.status_code >= 400:
        raise NonRetryableError(f"{response.request.url.path} returned {response.status_code}")
    return response


class LegalLabsSearchHarness(Harness):
    """Our stack, reached only through its public HTTP API, never its internals."""

    kinds = frozenset({"retrieval"})

    def __init__(
        self, system_name: str, system: dict, transport: httpx.BaseTransport | None = None
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
        self.client = httpx.Client(base_url=self._env("url"), timeout=60, transport=self.transport)
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

        listed = _check(self.client.get("/api/v1/documents")).json()["documents"]
        existing = {(d["name"], d["size"]): d["id"] for d in listed}
        self.document_ids = []
        for doc in corpus:
            data = doc.text.encode()
            found = existing.get((doc.name, len(data)))
            if found is None:
                files = {"file": (doc.name, data, "text/markdown")}
                found = _check(self.client.post("/api/v1/documents", files=files)).json()[
                    "document"
                ]["id"]
            self.document_ids.append(found)

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
