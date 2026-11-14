"""extract-maud: merger-agreement deal points (MAUD v1 test, main rows) with citations.

Each task is one deal-point question over its annotated excerpt, answered by picking one
of the question's options and quoting the text that decides it. Multi-label questions are
split per option, as MAUD does, into a yes/no on that option.
"""

import csv
import hashlib
import io
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from ..datasets import Pinned, read_member
from ..models import parse_json
from ..schemas import GraderResult, HarnessResult, TaskDatum
from ..typed import fold, match_option, verify_quote
from .base import AnswerSuite, Grader
from .judge import Judge

MAUD = Pinned(
    name="maud-v1",
    url="https://github.com/TheAtticusProject/maud/raw/4640316078dcd370debb877f350c39a28b181ffe/data.zip",
    sha256="75af5a33d038e9254864f043da38072490ffe11e8488d58d0a2dd39c8f554519",
    member="data/MAUD_test.csv",
    licence="CC BY 4.0",
)

OUTPUT = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "quotes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["answer", "quotes"],
    "additionalProperties": False,
}

NONE = "<NONE>"


def deal_point(question: str) -> str:
    for suffix in ("-Answer", " Answer"):
        if question.endswith(suffix):
            return question[: -len(suffix)]
    return question


def answer_of(parsed: dict[str, Any] | None) -> tuple[str | None, list[str]] | None:
    """The chosen option and quotes, from a plain answer or from one review-table cell."""
    if not parsed:
        return None
    cells = parsed.get("cells")
    if isinstance(cells, dict) and cells:
        cell = next(iter(cells.values()))
        quotes = [c["quote"] for c in cell.get("citations", []) if isinstance(c, dict)]
        labels = (cell.get("value_typed") or {}).get("labels") or [cell.get("value_text")]
        return labels[0], quotes
    answer, quotes = parsed.get("answer"), parsed.get("quotes")
    if not isinstance(quotes, list) or not all(isinstance(q, str) for q in quotes):
        return None
    return (answer if isinstance(answer, str) else None), quotes


class MaudGrader(Grader):
    def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
        got = answer_of(parse_json(result.answer or ""))
        if got is None:
            return GraderResult(0.0, {"valid_json": 0.0, "accuracy": 0.0}, "answer was not JSON")
        answer, quotes = got
        quotes = [q for q in quotes if q.strip()]
        options: list[str] = task.metadata["options"]
        chosen = match_option(answer, options)
        right = float(chosen == task.answer)
        context = fold(task.context or "")
        verified = sum(verify_quote(q, "", context) for q in quotes)
        metrics = {
            "valid_json": 1.0,
            "accuracy": right,
            "parsed_option": float(chosen is not None),
            "citations": float(len(quotes)),
            "citations_verified": float(verified),
            # A correct answer with no checkable quote is not a grounded answer.
            "cited_correct": float(right and verified > 0),
            f"accuracy:{task.metadata['category']}": right,
        }
        if quotes:
            metrics["valid_quote_rate"] = verified / len(quotes)
        return GraderResult(right, metrics)


class ExtractMaud(AnswerSuite):
    name = "extract-maud"
    instructions = (
        "Read the merger agreement excerpt and answer the deal-point question by choosing "
        "exactly one of the listed options. Quote verbatim the passages that decide it."
    )
    primary_metric = "accuracy"
    output_schema = OUTPUT
    dataset_fingerprint = f"{MAUD.fingerprint}:main:hash-order"

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        csv.field_size_limit(1 << 30)
        text = read_member(MAUD, self.local).decode("utf-8")
        rows = [r for r in csv.DictReader(io.StringIO(text)) if r["data_type"] == "main"]
        # MAUD stores labels as numbers; the most common text per label names the option.
        names: dict[str, Counter[tuple[int, str]]] = defaultdict(Counter)
        for r in rows:
            if r["subquestion"] == NONE:
                names[r["question"]][(int(r["label"]), r["answer"])] += 1
        options: dict[str, list[str]] = {}
        for question, counts in names.items():
            best: dict[int, str] = {}
            for (label, answer), _ in counts.most_common():
                best.setdefault(label, answer)
            options[question] = [best[i] for i in sorted(best)]
        tasks = []
        for index, r in enumerate(rows):
            point = deal_point(r["question"])
            label = int(r["label"])
            if r["subquestion"] == NONE:
                opts = options[r["question"]]
                problem = f"Deal point: {point}. Which option applies to this agreement?"
            else:
                opts = ["No", "Yes"]
                problem = f"Deal point: {point}. Does it include: {r['subquestion']}?"
            if label >= len(opts):
                continue
            column = {
                "key": "deal_point",
                "label": point,
                "type": "classify",
                "options": opts,
                "prompt": problem,
            }
            tasks.append(
                TaskDatum(
                    id=f"maud-{index:05d}",
                    problem=problem + "\nOptions:\n" + "\n".join(f"- {o}" for o in opts),
                    answer=opts[label],
                    metadata={
                        "category": r["category"],
                        "options": opts,
                        "contract": r["contract_name"],
                        "columns": [column],
                    },
                    context=r["text"],
                )
            )
        # Hash order, so --limit gives a spread over deal points rather than the first few.
        tasks.sort(key=lambda t: hashlib.sha256(t.id.encode()).hexdigest())
        return tasks[:limit] if limit else tasks

    def grader(self, judge: Judge | None) -> Grader:
        return MaudGrader()

    def report(self, results: list[dict[str, Any]], tasks: list[TaskDatum]) -> dict[str, Any]:
        m = [r["metrics"] for r in results if r["metrics"].get("valid_json")]
        cited = sum(x["citations"] for x in m)
        verified = sum(x["citations_verified"] for x in m)
        rate = verified / cited if cited else None
        return {
            "valid_citation_rate": round(rate, 4) if rate is not None else None,
            "citations": int(cited),
            "gates": {"valid_citation_rate>=0.95": rate is not None and rate >= 0.95},
        }
