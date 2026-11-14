"""review-table-e2e: a 100-contract table with six typed columns, gold from CUAD v1 test.

Gold values come from CUAD's clause annotations by fixed rules (below), rebuilt on every
load from the pinned download; nothing derived from the dataset is committed. A cell whose
gold the rules cannot settle (a governing-law clause naming no known place, an undated
date clause) is left out of scoring rather than guessed.
"""

import statistics
from pathlib import Path
from typing import Any

from ..config import slug
from ..datasets import load_json
from ..metrics import token_f1, wilson
from ..models import parse_json
from ..schemas import Document, GraderResult, HarnessResult, TaskDatum
from ..typed import fold, match_option, money_all, norm, parse_date
from .base import Grader, Suite
from .extract_cuad import CUAD, category

DOCS = 100
UNKNOWN = "__unknown__"

COLUMNS: list[dict[str, Any]] = [
    {
        "key": "parties",
        "label": "Parties",
        "type": "free",
        "prompt": "Who are the parties to this agreement? List each party's full legal name.",
    },
    {
        "key": "agreement_date",
        "label": "Agreement date",
        "type": "date",
        "prompt": "What is the date of this agreement, as stated in the agreement itself?",
    },
    {
        "key": "governing_law",
        "label": "Governing law",
        "type": "free",
        "prompt": "Which jurisdiction's law governs this agreement? Name the jurisdiction only.",
    },
    {
        "key": "insurance_amount",
        "label": "Insurance amount",
        "type": "currency",
        "prompt": "What minimum insurance coverage amount must a party carry under this "
        "agreement? Give the amount with its currency.",
    },
    {
        "key": "exclusivity",
        "label": "Exclusivity",
        "type": "classify",
        "options": ["Yes", "No"],
        "prompt": "Does this agreement grant any exclusivity, such as an exclusive right or "
        "a commitment to deal only with one party?",
    },
    {
        "key": "termination_for_convenience",
        "label": "Termination for convenience",
        "type": "verbatim",
        "prompt": "Quote the clause that lets a party terminate this agreement for "
        "convenience, without cause.",
    },
]

INSTRUCTIONS = "Table: contract review of commercial agreements."

# Longest first, so "West Virginia" wins over "Virginia".
PLACES = sorted(
    [
        *[
            "Alabama",
            "Alaska",
            "Arizona",
            "Arkansas",
            "California",
            "Colorado",
            "Connecticut",
            "Delaware",
            "Florida",
            "Georgia",
            "Hawaii",
            "Idaho",
            "Illinois",
            "Indiana",
            "Iowa",
            "Kansas",
            "Kentucky",
            "Louisiana",
            "Maine",
            "Maryland",
            "Massachusetts",
            "Michigan",
            "Minnesota",
            "Mississippi",
            "Missouri",
            "Montana",
            "Nebraska",
            "Nevada",
            "Ohio",
            "Oklahoma",
            "Oregon",
            "Pennsylvania",
            "Tennessee",
            "Texas",
            "Utah",
            "Vermont",
            "Virginia",
            "Washington",
            "Wisconsin",
            "Wyoming",
            "Ontario",
            "Quebec",
            "Alberta",
            "Germany",
            "France",
            "Switzerland",
            "Singapore",
            "Israel",
            "Japan",
            "Korea",
            "India",
            "Ireland",
            "Netherlands",
            "Sweden",
            "Australia",
            "Bermuda",
        ],
        "New Hampshire",
        "New Jersey",
        "New Mexico",
        "New York",
        "North Carolina",
        "North Dakota",
        "Rhode Island",
        "South Carolina",
        "South Dakota",
        "West Virginia",
        "District of Columbia",
        "British Columbia",
        "England and Wales",
        "England",
        "Hong Kong",
        "People's Republic of China",
        "PRC",
        "China",
        "Cayman Islands",
        "British Virgin Islands",
    ],
    key=len,
    reverse=True,
)
# Names that mean the same place.
SAME_PLACE = {"england and wales": "england", "people s republic of china": "china", "prc": "china"}


def places(text: str) -> list[str]:
    """Known jurisdictions in the text, in order of first mention."""
    lowered = f" {norm(text)} "
    found: list[tuple[int, str]] = []
    for place in PLACES:
        key = norm(place)
        at = lowered.find(f" {key} ")
        if at >= 0 and not any(key in other for _, other in found):
            found.append((at, key))
    return [SAME_PLACE.get(k, k) for _, k in sorted(found)]


def gold_values(spans: dict[str, list[str]]) -> dict[str, Any]:
    """The fixed rules from CUAD clause spans to one gold value per column."""
    gold: dict[str, Any] = {}
    names = [n for n in dict.fromkeys(norm(p) for p in spans.get("Parties", [])) if len(n) >= 4]
    gold["parties"] = names or UNKNOWN

    dates = spans.get("Agreement Date", [])
    parsed = parse_date(dates[0]) if dates else None
    gold["agreement_date"] = None if not dates else (parsed or UNKNOWN)

    law = spans.get("Governing Law", [])
    found = places(" ".join(law))
    gold["governing_law"] = None if not law else (found or UNKNOWN)

    insurance = spans.get("Insurance", [])
    amounts = [m for text in insurance for m in money_all(text)]
    # An insurance clause with no figure has no amount to find.
    gold["insurance_amount"] = amounts or None

    gold["exclusivity"] = "Yes" if spans.get("Exclusivity") else "No"
    gold["termination_for_convenience"] = spans.get("Termination For Convenience") or None
    return gold


def _overlaps(quote: str, golds: list[str]) -> bool:
    q = fold(quote).lower()
    for g in golds:
        g = fold(g).lower()
        if q in g or g in q or token_f1(q, g) >= 0.5:
            return True
    return False


def cell_correct(column: dict[str, Any], gold: Any, cell: dict[str, Any]) -> bool:
    """Typed exact match after normalisation; a null is right only when gold is null."""
    if cell.get("status") != "done":
        # An error cell is wrong whatever the gold; a null is right only against a null.
        return cell.get("status") == "null" and gold is None
    if gold is None:
        return False
    typed = cell.get("value_typed") or {}
    text = cell.get("value_text") or ""
    key = column["key"]
    if key == "parties":
        said = f" {norm(text)} "
        return sum(f" {n} " in said for n in gold) * 2 >= len(gold)
    if key == "agreement_date":
        return typed.get("iso") == gold["iso"]
    if key == "governing_law":
        said = places(text) or [norm(text)]
        return said[0] in gold
    if key == "insurance_amount":
        return any(
            typed.get("amount") == g["amount"] and typed.get("currency") == g["currency"]
            for g in gold
        )
    if key == "exclusivity":
        labels = typed.get("labels") or [match_option(text, ["Yes", "No"])]
        return labels[0] == gold
    if key == "termination_for_convenience":
        return _overlaps(typed.get("text") or text, gold)
    return False


def cells_of(answer: str | None) -> dict[str, Any] | None:
    parsed = parse_json(answer or "")
    cells = parsed.get("cells") if parsed else None
    return cells if isinstance(cells, dict) else None


class TableGrader(Grader):
    def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
        cells = cells_of(result.answer)
        if cells is None:
            return GraderResult(0.0, {"valid_output": 0.0}, "answer had no cells")
        parsed = parse_json(result.answer or "") or {}
        metrics: dict[str, float] = {"valid_output": 1.0}
        scored = right = 0
        cited = verified = nulls = true_nulls = 0
        cost = 0.0
        for column in COLUMNS:
            key = column["key"]
            cell = cells.get(key) or {"status": "missing"}
            citations = cell.get("citations") or []
            cited += len(citations)
            verified += sum(1 for c in citations if c.get("verified"))
            cost += float(cell.get("cost_usd") or 0.0)
            gold = task.answer[key]
            if gold == UNKNOWN:
                continue
            ok = cell_correct(column, gold, cell)
            scored += 1
            right += ok
            metrics[f"acc:{key}"] = float(ok)
            if cell.get("status") == "null":
                nulls += 1
                true_nulls += gold is None
        metrics.update(
            {
                "cells_scored": scored,
                "cells_right": right,
                "cell_accuracy": right / scored if scored else 0.0,
                "citations": cited,
                "citations_verified": verified,
                "nulls": nulls,
                "true_nulls": true_nulls,
                "cost_usd": cost,
                "latency_s": float(parsed.get("latency_s") or 0.0),
            }
        )
        return GraderResult(metrics["cell_accuracy"], metrics)


class ReviewTableE2e(Suite):
    name = "review-table-e2e"
    kind = "table"
    instructions = (
        INSTRUCTIONS
        + " Columns: "
        + "; ".join(f"{c['key']}={c['type']}:{c['prompt']}" for c in COLUMNS)
    )
    primary_metric = "cell_accuracy"
    dataset_fingerprint = f"{CUAD.fingerprint}:table{DOCS}"

    def __init__(self, local: Path | None = None) -> None:
        self.local = local
        self.docs: list[Document] = []

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        data = load_json(CUAD, self.local)
        # Sorted by title so the 100 are the same on every machine.
        contracts = sorted(data["data"], key=lambda d: d["title"])[:DOCS]
        tasks = []
        for doc in contracts:
            para = doc["paragraphs"][0]
            spans = {
                category(qa["question"]): list(dict.fromkeys(a["text"] for a in qa["answers"]))
                for qa in para["qas"]
            }
            doc_id = slug(doc["title"])
            tasks.append(
                TaskDatum(
                    id=doc_id,
                    problem=doc["title"],
                    answer=gold_values(spans),
                    metadata={
                        "columns": COLUMNS,
                        "instructions": INSTRUCTIONS,
                        "document_id": doc_id,
                        "name": f"{doc_id[:80]}.txt",
                    },
                    context=para["context"],
                )
            )
        tasks = tasks[:limit] if limit else tasks
        self.docs = [Document(t.metadata["name"], t.context or "") for t in tasks]
        return tasks

    def corpus(self) -> list[Document]:
        return self.docs

    def make_grader(self, system_vendors: frozenset[str]) -> Grader:
        return TableGrader()

    def report(self, results: list[dict[str, Any]], tasks: list[TaskDatum]) -> dict[str, Any]:
        """Rates pooled over cells, not averaged over rows, plus the release gates."""
        m = [r["metrics"] for r in results if r["metrics"].get("valid_output")]

        def total(name: str) -> float:
            return sum(x.get(name, 0.0) for x in m)

        scored, right = total("cells_scored"), total("cells_right")
        cited, verified = total("citations"), total("citations_verified")
        nulls, true_nulls = total("nulls"), total("true_nulls")
        latencies = [x["latency_s"] for x in m if x.get("latency_s")]
        valid_rate = verified / cited if cited else None
        median = statistics.median(latencies) if latencies else None
        by_column = {}
        for column in COLUMNS:
            values = [x[f"acc:{column['key']}"] for x in m if f"acc:{column['key']}" in x]
            if values:
                by_column[column["key"]] = {
                    "accuracy": round(sum(values) / len(values), 4),
                    "n": len(values),
                }
        return {
            "rows": len(m),
            "cell_accuracy": round(right / scored, 4) if scored else None,
            "cell_accuracy_ci95": [round(v, 4) for v in wilson(right, int(scored))],
            "cells_scored": int(scored),
            "valid_citation_rate": round(valid_rate, 4) if valid_rate is not None else None,
            "citations": int(cited),
            "null_precision": round(true_nulls / nulls, 4) if nulls else None,
            "nulls": int(nulls),
            "latency_median_s_per_doc": round(median, 2) if median is not None else None,
            "cost_usd": round(total("cost_usd"), 6),
            "by_column": by_column,
            "gates": {
                "valid_citation_rate>=0.95": valid_rate is not None and valid_rate >= 0.95,
                "latency_median<=30s": median is not None and median <= 30,
            },
        }
