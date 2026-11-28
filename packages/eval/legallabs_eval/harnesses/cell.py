"""Review-table cells without the server: one model call per cell, checked locally.

Follows the cell contract in review-tables.md §9 (context, output shape, verification,
typed parsing, null handling) so suites can run before the HTTP API exists, and so the
same local model can be scored with and without citations.
"""

import json
import re
import time
from decimal import Decimal, InvalidOperation
from typing import Any

from ..models import ModelClient, Send, model_name, parse_json
from ..schemas import Cost, Document, HarnessRequest, HarnessResult, NonRetryableError
from ..typed import fold, match_option, parse_date, parse_money, verify_quote
from .base import Harness
from .bm25 import Bm25Index, chunk

SYSTEM = (
    "You fill one cell of a contract review table. Answer only from the document text "
    "given. Every claim needs a citation: a quote copied character for character from "
    "the document. If the document does not answer the question, set not_found to true "
    "and value to null. Keep reasoning to one or two sentences."
)

CELL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "value": {"type": ["string", "null"]},
        "reasoning": {"type": "string"},
        "citations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "document_id": {"type": "string"},
                    "page": {"type": "integer"},
                    "quote": {"type": "string"},
                },
                "required": ["document_id", "page", "quote"],
            },
        },
        "not_found": {"type": "boolean"},
    },
    "required": ["value", "reasoning", "citations", "not_found"],
}

TYPE_GUIDE = {
    "date": "Give the date as written, e.g. 'March 3, 2019'.",
    "currency": "Give the amount with its currency, e.g. 'USD 1,500,000'.",
    "number": "Give the number only, with its unit if any.",
    "verbatim": "Value must be the clause quoted exactly from the document.",
    "free": "Answer briefly in plain text.",
    "classify": "Value must be exactly one of these labels: {labels}.",
}

# Rough English token size, used only to decide full text versus retrieval.
CHARS_PER_TOKEN = 4
FULL_TEXT_SHARE = 0.6


def _number(text: str | None) -> dict[str, Any] | None:
    m = re.search(r"-?\d[\d,]*(?:\.\d+)?", text or "")
    if not m:
        return None
    try:
        return {"kind": "number", "value": str(Decimal(m.group(0).replace(",", "")))}
    except InvalidOperation:
        return None


def typed_cell(
    column: dict[str, Any], reply: dict[str, Any] | None, text: str, folded: str
) -> dict[str, Any]:
    """Turns a model reply into a stored cell: status, typed value and checked citations."""
    if reply is None:
        return {"status": "error", "error_code": "INVALID_OUTPUT", "citations": []}
    raw_citations = reply.get("citations") or []
    citations = [
        {"quote": c["quote"], "verified": verify_quote(c["quote"], text, folded)}
        for c in raw_citations
        if isinstance(c, dict) and isinstance(c.get("quote"), str) and c["quote"].strip()
    ]
    value = reply.get("value")
    value = value.strip() if isinstance(value, str) else None
    cell: dict[str, Any] = {"value_text": value, "citations": citations}
    if reply.get("not_found") is True or not value:
        # A null keeps its citations off the books: nothing was claimed.
        return {**cell, "status": "null", "value_typed": None, "citations": []}
    kind = column["type"]
    typed: dict[str, Any] | None
    if kind == "date":
        typed = parse_date(value)
    elif kind == "currency":
        typed = parse_money(value)
    elif kind == "number":
        typed = _number(value)
    elif kind == "classify":
        label = match_option(value, column.get("options", []))
        typed = {"kind": "classify", "labels": [label]} if label else None
    elif kind == "verbatim":
        if not verify_quote(value, text, folded):
            return {**cell, "status": "error", "error_code": "CITATION_UNVERIFIED"}
        typed = {"kind": "verbatim", "text": value}
        # The value is itself the evidence, so it counts as one checked citation.
        if not any(fold(c["quote"]) == fold(value) for c in citations):
            cell["citations"] = [*citations, {"quote": value, "verified": True}]
    else:
        typed = {"kind": "free", "markdown": value}
    if typed is None:
        return {**cell, "status": "error", "error_code": "PARSE_FAILED"}
    return {**cell, "status": "done", "value_typed": typed}


class ReviewCellHarness(Harness):
    """Offline review-table system: each task is a row, each column one isolated call."""

    kinds = frozenset({"answer", "table"})

    def __init__(self, system_name: str, system: dict[str, Any], send: Send | None = None) -> None:
        super().__init__(system_name, system)
        params = system.get("params", {})
        if not self.vendor or not params.keys() & {"model", "model_env"}:
            raise NonRetryableError(f"{system_name} needs a vendor and params.model")
        self.context_tokens = int(params.get("context_tokens", 4096))
        self.chunk_size = int(params.get("chunk_size", 1200))
        self.client = ModelClient(
            self.vendor,
            model_name(system_name, params),
            int(params.get("max_tokens", 512)),
            send,
            self.context_tokens,
        )

    def fingerprint(self) -> str:
        return self.client.fingerprint()

    def environment(self) -> dict[str, Any]:
        # A system whose model comes from the environment is otherwise one name for many.
        return {"model": self.client.model}

    def prepare(self, corpus: list[Document]) -> None:
        self.client.preflight()

    def context(self, doc_id: str, text: str, column: dict[str, Any]) -> tuple[str, dict]:
        """Whole text when it fits 60% of the window, else the best chunks for the prompt."""
        budget = int(self.context_tokens * FULL_TEXT_SHARE * CHARS_PER_TOKEN)
        if len(text) <= budget:
            return text, {"mode": "full", "chunks_read": 1}
        chunks = chunk(Document(doc_id, text), self.chunk_size)
        query = f"{column.get('label', '')} {column['prompt']}"
        picked, used = [], 0
        for hit in Bm25Index(chunks).search(query, len(chunks)):
            piece = hit.text[: budget - used]
            if len(piece) < 200:
                break
            picked.append((hit.char_from or 0, piece))
            used += len(piece)
        # Back in document order, so clauses read as they were written.
        body = "\n...\n".join(p for _, p in sorted(picked))
        return body, {"mode": "retrieval", "chunks_read": len(picked), "queries": [query]}

    def prompt(self, doc_id: str, context: str, column: dict[str, Any], instructions: str) -> str:
        guide = TYPE_GUIDE.get(column["type"], "").format(
            labels=", ".join(column.get("options", []))
        )
        # The document first, so cells of one row share a cacheable prefix.
        return (
            f'<document id="{doc_id}" page="1">\n{context}\n</document>\n\n'
            f"{instructions}\nColumn: {column.get('label', column['key'])}\n"
            f"Question: {column['prompt']}\n{guide}"
        )

    def run(self, request: HarnessRequest) -> HarnessResult:
        task = request.task
        columns = task.metadata.get("columns")
        if not columns:
            raise NonRetryableError(f"{request.suite} tasks carry no columns for review-cell")
        text = task.context or ""
        folded = fold(text)
        doc_id = task.metadata.get("document_id", task.id)
        cells: dict[str, Any] = {}
        total = Cost.free()
        started = time.monotonic()
        for column in columns:
            t0 = time.monotonic()
            context, looked = self.context(doc_id, text, column)
            reply_text, cost = self.client.complete(
                SYSTEM,
                self.prompt(doc_id, context, column, task.metadata.get("instructions", "")),
                request.attempt_dir / "agent",
                CELL_SCHEMA,
            )
            total = total + cost
            cell = typed_cell(column, parse_json(reply_text), text, folded)
            cell["latency_s"] = round(time.monotonic() - t0, 3)
            cell["usage"] = {"input_tokens": cost.input_tokens, "output_tokens": cost.output_tokens}
            cell["cost_usd"] = cost.usd
            if cell["status"] == "null":
                cell["looked_at"] = looked
            cells[column["key"]] = cell
        answer = {"cells": cells, "latency_s": round(time.monotonic() - started, 3)}
        return HarnessResult(
            answer=json.dumps(answer, sort_keys=True),
            provider=self.vendor,
            model=self.client.model,
            cost=total,
        )
