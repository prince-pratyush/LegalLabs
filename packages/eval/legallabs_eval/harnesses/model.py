from ..models import ModelClient, Send
from ..schemas import Document, HarnessRequest, HarnessResult, NonRetryableError
from .base import Harness
from .bm25 import Bm25Harness

SYSTEM = "You are a careful legal analyst. Answer only from the document provided."


class PlainModelHarness(Harness):
    """Baseline: the whole document (up to a limit) and the question, sent to one model."""

    kinds = frozenset({"answer"})

    def __init__(self, system_name: str, system: dict, send: Send | None = None) -> None:
        super().__init__(system_name, system)
        params = system.get("params", {})
        if not self.vendor or "model" not in params:
            raise NonRetryableError(f"{system_name} needs a vendor and params.model")
        self.max_context_chars = int(params.get("max_context_chars", 400_000))
        self.client = ModelClient(
            self.vendor, params["model"], int(params.get("max_tokens", 2048)), send
        )

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

    def __init__(self, system_name: str, system: dict, send: Send | None = None) -> None:
        super().__init__(system_name, system, send)
        params = system.get("params", {})
        self.top_k = int(params.get("top_k", 8))
        self.chunk_size = int(params.get("chunk_size", 1000))

    def context(self, request: HarnessRequest) -> str:
        index = Bm25Harness("bm25", {"harness": "bm25", "params": {"chunk_size": self.chunk_size}})
        index.prepare([Document(request.task.id, request.task.context or "")])
        found = index.run(
            HarnessRequest(
                request.task, request.suite, "", request.attempt_dir, request.run_dir, self.top_k
            )
        )
        # Back in document order, so clauses read as they were written.
        hits = sorted(found.hits, key=lambda h: h.char_from or 0)
        return "\n...\n".join(h.text for h in hits)
