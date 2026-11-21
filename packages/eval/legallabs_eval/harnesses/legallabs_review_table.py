"""Our review-table API end to end, over HTTP only: upload, create a table, add the suite's
columns, run them, then read every cell back. All the work happens in prepare(); run()
hands each row's cells to the grader in the same shape the offline cell harness uses.
"""

import json
import os
import time
from collections.abc import Callable
from typing import Any

import httpx

from ..io import append_jsonl, write_json
from ..schemas import (
    Cost,
    Document,
    HarnessError,
    HarnessRequest,
    HarnessResult,
    NonRetryableError,
)
from .legallabs_search import _check
from .legallabs_thread import LegalLabsThreadHarness

# A table built from loose uploads takes at most this many files (RT_LIMITS.uploads).
MAX_UPLOADS = 50
COLUMN_DONE = {"done", "partial", "stopped"}
CELL_TERMINAL = {"done", "null", "error", "blocked"}
COLORS = ["green", "red", "blue", "yellow", "purple", "orange", "teal", "gray"]


def column_body(column: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {"label": column["label"], "type": column["type"]}
    body["prompt"] = column["prompt"]
    if column["type"] == "classify":
        body["options"] = {
            "options": [
                {"id": option_id(label), "label": label, "color": COLORS[i % len(COLORS)]}
                for i, label in enumerate(column["options"])
            ],
            "allow_other": False,
        }
    return body


def option_id(label: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in label.lower())[:40] or "x"


def to_cell(api_cell: dict[str, Any], column: dict[str, Any]) -> dict[str, Any]:
    """The API cell in the offline harness's shape, so one grader reads both."""
    typed = api_cell.get("value_typed")
    if typed and typed.get("kind") == "classify":
        by_id = {option_id(label): label for label in column.get("options", [])}
        labels = [by_id.get(i, i) for i in typed.get("option_ids", [])]
        typed = {"kind": "classify", "labels": labels or [typed.get("other")]}
    total = int(api_cell.get("citation_count") or 0)
    verified = int(api_cell.get("verified_citation_count") or 0)
    return {
        "status": api_cell["status"],
        "error_code": api_cell.get("error_code"),
        "value_text": api_cell.get("value_text"),
        "value_typed": typed,
        # Counts are enough to grade citation validity; the quotes stay on the server.
        "citations": [{"verified": True}] * verified + [{"verified": False}] * (total - verified),
        "cost_usd": api_cell.get("cost_usd"),
        "usage": api_cell.get("usage"),
        "model": api_cell.get("model"),
    }


class LegalLabsReviewTableHarness(LegalLabsThreadHarness):
    kinds = frozenset({"table"})

    def __init__(
        self,
        system_name: str,
        system: dict[str, Any],
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__(system_name, system, transport, sleep, clock)
        params = system.get("params", {})
        self.table_timeout_s = float(params.get("table_timeout_seconds", 7200))
        self.cells_by_doc: dict[str, dict[str, Any]] = {}
        self.latency_per_doc: float | None = None
        self.columns: list[dict[str, Any]] = []
        self.trace: dict[str, Any] = {}

    def prepare(self, corpus: list[Document]) -> None:
        # One table suite exists; its columns are the table's columns.
        from ..suites.review_table_e2e import COLUMNS

        try:
            self._prepare_table(corpus, COLUMNS)
        except httpx.TransportError as err:
            raise HarnessError(str(err)) from err

    def _prepare_table(self, corpus: list[Document], columns: list[dict[str, Any]]) -> None:
        self._login()
        assert self.client is not None
        vault = os.environ.get(self.vault_env)
        if len(corpus) > MAX_UPLOADS and not vault:
            raise NonRetryableError(
                f"{len(corpus)} documents exceed {MAX_UPLOADS} uploads; "
                f"load them into a vault and set {self.vault_env}"
            )
        self._upload(corpus)
        self._wait_indexed()
        names = {doc_id: doc.name for doc_id, doc in zip(self.document_ids, corpus, strict=False)}
        if vault:
            source = {"kind": "vault", "vault_id": vault, "document_ids": self.document_ids}
        else:
            source = {"kind": "uploads", "upload_ids": self.document_ids}
        table = _check(
            self.client.post(
                "/api/v1/review-tables", json={"name": "eval review-table-e2e", "source": source}
            )
        ).json()["table"]
        base = f"/api/v1/review-tables/{table['id']}"
        self.columns = columns
        ids: dict[str, str] = {}
        for column in columns:
            made = _check(self.client.post(f"{base}/columns", json=column_body(column))).json()
            ids[column["key"]] = made["column"]["id"]
        started = self.clock()
        self._run_columns(base, list(ids.values()))
        elapsed = self.clock() - started
        # Columns run in parallel on the server, so per-document time is the table's wall
        # clock shared over its rows, not one row timed alone.
        self.latency_per_doc = elapsed / max(1, len(self.document_ids))
        by_column = {v: k for k, v in ids.items()}
        spec = {c["key"]: c for c in columns}
        rows, cells = self._read_rows(base)
        for row in rows:
            for doc_id in row["document_ids"]:
                name = names.get(doc_id)
                if name is None:
                    continue
                self.cells_by_doc[name] = {
                    by_column[c["column_id"]]: to_cell(c, spec[by_column[c["column_id"]]])
                    for c in cells
                    if c["row_id"] == row["id"] and c["column_id"] in by_column
                }
        self.trace = {"table_id": table["id"], "elapsed_s": elapsed, "columns": ids}

    def _run_columns(self, base: str, pending: list[str]) -> None:
        """Starts every column, retrying those the 3-running cap turns away, then waits."""
        assert self.client is not None
        deadline = self.clock() + self.table_timeout_s
        started: set[str] = set()
        while True:
            for column_id in [c for c in pending if c not in started]:
                response = self.client.post(
                    f"{base}/columns/{column_id}/run", json={"scope": "all"}
                )
                if response.status_code == 409:
                    continue  # too many columns running; try again next poll
                _check(response)
                started.add(column_id)
            columns = _check(self.client.get(base)).json()["columns"]
            states = {c["id"]: c["state"] for c in columns}
            if len(started) == len(pending) and all(states.get(c) in COLUMN_DONE for c in pending):
                return
            if self.clock() > deadline:
                raise HarnessError(f"table still running after {self.table_timeout_s:.0f}s")
            self.sleep(self.poll_s)

    def _read_rows(self, base: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        assert self.client is not None
        rows: list[dict[str, Any]] = []
        cells: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {"limit": 200}
            if cursor:
                params["cursor"] = cursor
            page = _check(self.client.get(f"{base}/rows", params=params)).json()
            rows += page["rows"]
            cells += page["cells"]
            cursor = page.get("next_cursor")
            if not cursor:
                return rows, cells

    def run(self, request: HarnessRequest) -> HarnessResult:
        name = request.task.metadata.get("name", request.task.id)
        cells = self.cells_by_doc.get(name)
        if cells is None:
            raise NonRetryableError(f"no row came back for {name}")
        trace = request.attempt_dir / "agent"
        append_jsonl(trace / "responses.jsonl", {"table": self.trace, "cells": cells})
        write_json(trace / "table.json", self.trace)
        usd = [c.get("cost_usd") for c in cells.values()]
        known = all(u is not None for u in usd)
        tokens = [c.get("usage") or {} for c in cells.values()]
        cost = Cost(
            usd=sum(u or 0.0 for u in usd) if known else None,
            cost_known=known,
            input_tokens=sum(int(t.get("input_tokens") or 0) for t in tokens),
            output_tokens=sum(int(t.get("output_tokens") or 0) for t in tokens),
        )
        answer = {"cells": cells, "latency_s": self.latency_per_doc}
        models = {c.get("model") for c in cells.values() if c.get("model")}
        model = ",".join(sorted(m for m in models if m)) or "legallabs"
        return HarnessResult(
            answer=json.dumps(answer, sort_keys=True), provider="legallabs", model=model, cost=cost
        )
