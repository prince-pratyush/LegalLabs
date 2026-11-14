from typing import Any

from ..schemas import Document, HarnessRequest, HarnessResult


class Harness:
    """One way of answering tasks: our stack over HTTP, or a baseline."""

    # Retrieval suites need hits; answer suites need text.
    kinds: frozenset[str] = frozenset()

    def __init__(self, system_name: str, system: dict[str, Any]) -> None:
        self.system_name = system_name
        self.system = system
        self.vendor: str = system.get("vendor", "")
        # Every vendor whose models this system calls; none of them may judge it.
        self.vendors = frozenset(system.get("vendors", [self.vendor]))

    def prepare(self, corpus: list[Document]) -> None:
        """Called once per run with the suite's corpus, if it has one."""

    def run(self, request: HarnessRequest) -> HarnessResult:
        raise NotImplementedError

    def close(self) -> None:
        pass
