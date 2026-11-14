import json
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from ..io import append_jsonl
from ..schemas import (
    Cost,
    Document,
    HarnessError,
    HarnessRequest,
    HarnessResult,
    NonRetryableError,
)
from .legallabs_search import LegalLabsSearchHarness, _check

# The thread API takes at most this many files per turn; bigger rooms need a vault.
MAX_DOCUMENTS = 50
TERMINAL = {"done", "failed", "cancelled"}
INDEXED = {"indexed", "failed"}


class LegalLabsThreadHarness(LegalLabsSearchHarness):
    """Asks a question in a new thread and waits for the verified answer, over HTTP only.

    The answer is JSON with the text, citation verdicts, ungrounded ranges and coverage,
    so graders judge exactly what a lawyer would see.
    """

    kinds = frozenset({"thread"})

    def __init__(
        self,
        system_name: str,
        system: dict[str, Any],
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__(system_name, system, transport)
        params = system.get("params", {})
        self.poll_s = float(params.get("poll_seconds", 1.0))
        self.run_timeout_s = float(params.get("run_timeout_seconds", 900))
        self.index_timeout_s = float(params.get("index_timeout_seconds", 1800))
        self.vault_env = params.get("vault_id_env", "LEGALLABS_VAULT_ID")
        self.sleep = sleep
        self.clock = clock
        self.vault_ids: list[str] = []

    def prepare(self, corpus: list[Document]) -> None:
        # A dropped connection is worth another try, not a crash with a traceback.
        try:
            self._prepare(corpus)
        except httpx.TransportError as err:
            raise HarnessError(str(err)) from err

    def _prepare(self, corpus: list[Document]) -> None:
        self._login()
        # A preloaded vault holds rooms too big to attach file by file.
        vault = os.environ.get(self.vault_env)
        if vault:
            self.vault_ids = [vault]
            return
        if len(corpus) > MAX_DOCUMENTS:
            raise NonRetryableError(
                f"{len(corpus)} documents exceed the {MAX_DOCUMENTS}-file thread limit; "
                f"load them into a vault and set {self.vault_env}"
            )
        self._upload(corpus)
        self._wait_indexed()

    def _wait_indexed(self) -> None:
        assert self.client is not None
        waiting = set(self.document_ids)
        failed: set[str] = set()
        deadline = self.clock() + self.index_timeout_s
        while waiting:
            listed = _check(self.client.get("/api/v1/documents")).json()["documents"]
            for doc in listed:
                if doc["id"] in waiting and doc["status"] in INDEXED:
                    waiting.discard(doc["id"])
                    if doc["status"] == "failed":
                        failed.add(doc["id"])
            if not waiting:
                break
            if self.clock() > deadline:
                raise NonRetryableError(f"{len(waiting)} documents never finished indexing")
            self.sleep(self.poll_s)
        # A file that can't be read leaves the scope rather than sinking the whole run.
        self.document_ids = [d for d in self.document_ids if d not in failed]
        if not self.document_ids:
            raise NonRetryableError("no document finished indexing")

    def run(self, request: HarnessRequest) -> HarnessResult:
        if self.client is None:
            raise NonRetryableError("prepare() was not called")
        trace = request.attempt_dir / "agent"
        deep = bool(request.task.metadata.get("deep_analysis", False))
        body = {
            "content": request.task.problem,
            "scope": {
                "document_ids": [] if self.vault_ids else self.document_ids,
                "vault_ids": self.vault_ids,
                "sources": [],
            },
            "deep_analysis": deep,
        }
        append_jsonl(trace / "requests.jsonl", {"method": "POST", "path": "threads", "body": body})
        try:
            started = _check(self.client.post("/api/v1/threads", json=body)).json()
            run = self._wait(started["run_id"], trace)
            thread = _check(self.client.get(f"/api/v1/threads/{started['thread_id']}")).json()
        except httpx.TransportError as err:
            raise HarnessError(str(err)) from err
        if run["status"] != "done":
            raise HarnessError(f"run ended {run['status']}")
        messages = thread["thread"]["messages"]
        message = next((m for m in messages if m["id"] == run.get("message_id")), None)
        if message is None:
            raise HarnessError("run finished without its answer")
        append_jsonl(trace / "responses.jsonl", {"run": run, "message": message})
        answer = {
            "content": message["content"],
            "citations": message.get("citations", []),
            "ungrounded": message.get("ungrounded", []),
            "coverage": run.get("coverage"),
            "deep_analysis": deep,
        }
        usd = message.get("cost_usd")
        cost = Cost(
            usd=float(usd) if usd is not None else None,
            cost_known=usd is not None,
            input_tokens=int(message.get("input_tokens") or 0),
            output_tokens=int(message.get("output_tokens") or 0),
        )
        return HarnessResult(
            answer=json.dumps(answer, sort_keys=True),
            provider="legallabs",
            model=message.get("model") or "",
            cost=cost,
        )

    def _wait(self, run_id: str, trace: Path) -> dict[str, Any]:
        assert self.client is not None
        deadline = self.clock() + self.run_timeout_s
        approved = False
        while True:
            run = _check(self.client.get(f"/api/v1/runs/{run_id}")).json()["run"]
            if run["status"] in TERMINAL:
                return run
            # The eval approves the plan as a lawyer would: once, without edits.
            if run["status"] == "awaiting_approval" and not approved:
                _check(self.client.post(f"/api/v1/runs/{run_id}/approve"))
                append_jsonl(trace / "requests.jsonl", {"method": "POST", "path": "approve"})
                approved = True
            if self.clock() > deadline:
                raise HarnessError(f"run still {run['status']} after {self.run_timeout_s:.0f}s")
            self.sleep(self.poll_s)
