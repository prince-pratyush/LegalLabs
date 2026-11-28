from typing import Any

from ..models import ModelClient, Send, model_name
from ..schemas import Document, HarnessRequest, HarnessResult, NonRetryableError
from .base import Harness
from .bm25 import Bm25Index, chunk

SYSTEM = "You are a careful legal analyst. Answer only from the document provided."


class PlainModelHarness(Harness):
    """Baseline: the whole document (up to a limit) and the question, sent to one model."""

    kinds = frozenset({"answer"})

    def __init__(self, system_name: str, system: dict[str, Any], send: Send | None = None) -> None:
        super().__init__(system_name, system)
        params = system.get("params", {})
        if not self.vendor or not params.keys() & {"model", "model_env"}:
            raise NonRetryableError(f"{system_name} needs a vendor and params.model")
        self.max_context_chars = int(params.get("max_context_chars", 400_000))
        context = params.get("context_tokens")
        self.client = ModelClient(
            self.vendor,
            model_name(system_name, params),
            int(params.get("max_tokens", 2048)),
            send,
            int(context) if context else None,
        )

    def fingerprint(self) -> str:
        return self.client.fingerprint()

    def environment(self) -> dict[str, Any]:
        # A system whose model comes from the environment is otherwise one name for many.
        return {"model": self.client.model}

    def prepare(self, corpus: list[Document]) -> None:
        self.client.preflight()

    def context(self, request: HarnessRequest) -> str:
        return (request.task.context or "")[: self.max_context_chars]

    def run(self, request: HarnessRequest) -> HarnessResult:
        prompt = (
            f"{request.instructions}\n\n<document>\n{self.context(request)}\n</document>\n\n"
            f"{request.task.problem}"
        )
        text, cost = self.client.complete(
            SYSTEM, prompt, request.attempt_dir / "agent", request.output_schema
        )
        return HarnessResult(answer=text, provider=self.vendor, model=self.client.model, cost=cost)


class NaiveRagHarness(PlainModelHarness):
    """Baseline: only the top chunks by BM25 for the question, not the whole document."""

    def __init__(self, system_name: str, system: dict[str, Any], send: Send | None = None) -> None:
        super().__init__(system_name, system, send)
        params = system.get("params", {})
        self.top_k = int(params.get("top_k", 8))
        self.chunk_size = int(params.get("chunk_size", 1000))

    def context(self, request: HarnessRequest) -> str:
        doc = Document(request.task.id, request.task.context or "")
        hits = Bm25Index(chunk(doc, self.chunk_size)).search(request.task.problem, self.top_k)
        # Back in document order, so clauses read as they were written.
        return "\n...\n".join(h.text for h in sorted(hits, key=lambda h: h.char_from or 0))
