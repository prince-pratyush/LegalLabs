from pathlib import Path
from typing import Any

from ..datasets import Pinned, load_json
from ..metrics import locate, token_f1
from ..models import parse_json
from ..schemas import Cost, GraderResult, HarnessResult, TaskDatum
from .base import Grader, Suite
from .judge import Judge

CUAD = Pinned(
    name="cuad-v1",
    url="https://github.com/TheAtticusProject/cuad/raw/67faa0e6023b04fcaae6cc09497ab00e5d63a2a2/data.zip",
    sha256="f8161d18bea4e9c05e78fa6dda61c19c846fb8087ea969c172753bc2f45b999a",
    member="test.json",
    licence="CC BY 4.0",
)

OUTPUT = {
    "type": "object",
    "properties": {"quotes": {"type": "array", "items": {"type": "string"}}},
    "required": ["quotes"],
    "additionalProperties": False,
}


def category(question: str) -> str:
    """CUAD questions read 'related to "X" that should be reviewed'; X is the category."""
    parts = question.split('"')
    return parts[1] if len(parts) > 2 else question


class CuadGrader(Grader):
    def __init__(self, judge: Judge | None) -> None:
        self.judge = judge

    def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
        parsed = parse_json(result.answer or "")
        quotes = parsed.get("quotes") if parsed else None
        if not isinstance(quotes, list) or not all(isinstance(q, str) for q in quotes):
            return GraderResult(0.0, {"valid_json": 0.0, "f1": 0.0}, "answer was not valid JSON")
        quotes = [q for q in quotes if q.strip()]
        gold: list[str] = task.answer
        context = task.context or ""
        found = [q for q in quotes if locate(q, context)]
        metrics = {
            "valid_json": 1.0,
            # A quote that is not in the contract is a made-up citation.
            "valid_quote_rate": len(found) / len(quotes) if quotes else 1.0,
        }
        if not gold:
            metrics["f1"] = 0.0 if quotes else 1.0
        else:
            metrics["f1"] = token_f1(" ".join(quotes), " ".join(gold))
        cost = Cost.free()
        notes = ""
        if self.judge is not None:
            verdict = self.judge.check(
                f'The extracted quotes are exactly the contract\'s "{task.metadata["category"]}" '
                "provisions (or correctly empty if it has none): nothing material missing, "
                "nothing unrelated included.",
                f"Reference provisions:\n{gold or '(none)'}\n\nExtracted quotes:\n{quotes}",
                trace_dir,
            )
            metrics["judge_pass"] = verdict.score
            cost, notes = verdict.cost, verdict.reasoning
        return GraderResult(metrics["f1"], metrics, notes, cost)


class ExtractCuad(Suite):
    name = "extract-cuad"
    kind = "answer"
    instructions = (
        "Find every passage of the contract that answers the request. Quote each passage "
        "verbatim from the document. If there is none, return an empty list."
    )
    primary_metric = "f1"
    output_schema = OUTPUT

    def __init__(
        self,
        judges: dict[str, dict[str, Any]] | None = None,
        local: Path | None = None,
        judges_per_criterion: int = 2,
    ) -> None:
        self.judges = judges
        self.local = local
        self.judges_per_criterion = judges_per_criterion
        self.dataset_fingerprint = CUAD.fingerprint

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        data = load_json(CUAD, self.local)
        tasks = []
        for doc in data["data"]:
            for para in doc["paragraphs"]:
                for qa in para["qas"]:
                    gold = list(dict.fromkeys(a["text"] for a in qa["answers"]))
                    tasks.append(
                        TaskDatum(
                            id=qa["id"],
                            problem=qa["question"],
                            answer=gold,
                            metadata={"category": category(qa["question"]), "title": doc["title"]},
                            context=para["context"],
                        )
                    )
        return tasks[:limit] if limit else tasks

    def make_grader(self, system_vendor: str) -> Grader:
        judge = None
        if self.judges:
            judge = Judge(self.judges, system_vendor, self.judges_per_criterion)
            judge.preflight()
        return CuadGrader(judge)
