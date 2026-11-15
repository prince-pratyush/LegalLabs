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
from .legallabs_search import MAX_LIMIT, LegalLabsSearchHarness, _check


class LegalLabsKnowledgeHarness(LegalLabsSearchHarness):
    """Public-law search over the HTTP API. Nothing is uploaded: the source must be synced."""

    def __init__(
        self, system_name: str, system: dict[str, Any], transport: httpx.BaseTransport | None = None
    ) -> None:
        super().__init__(system_name, system, transport)
        self.loaded: set[str] = set()

    def prepare(self, corpus: list[Document]) -> None:
        # Signs in through the parent with an empty corpus, so nothing is uploaded.
        super().prepare([])

    def _require_loaded(self, source: str) -> None:
        if source in self.loaded or self.client is None:
            return
        detail = _check(self.client.get(f"/api/v1/knowledge/sources/{source}")).json()
        if not detail.get("doc_count"):
            raise NonRetryableError(f"{source} has no documents: sync or load its subset first")
        self.loaded.add(source)

    def run(self, request: HarnessRequest) -> HarnessResult:
        if self.client is None:
            raise NonRetryableError("prepare() was not called")
        source = request.task.metadata.get("source")
        if not isinstance(source, str):
            raise NonRetryableError("knowledge tasks must name their source")
        self._require_loaded(source)
        params: dict[str, Any] = {
            "q": request.task.problem,
            "source": source,
            "limit": min(request.top_k or 10, MAX_LIMIT),
            **self.extra,
        }
        trace = request.attempt_dir / "agent"
        append_jsonl(
            trace / "requests.jsonl",
            {"method": "GET", "path": "knowledge/search", "params": params},
        )
        try:
            response = self.client.get("/api/v1/knowledge/search", params=params)
        except httpx.TransportError as err:
            raise HarnessError(str(err)) from err
        passages = _check(response).json()["passages"]
        append_jsonl(
            trace / "responses.jsonl", {"status": response.status_code, "passages": passages}
        )
        # An authority is named by its primary citation, as the golden sets name it.
        hits = [
            Hit(p.get("citation") or p["authority_ref"], None, None, None, p["text"])
            for p in passages
        ]
        return HarnessResult(hits=hits, provider="legallabs", model="knowledge", cost=Cost.free())
