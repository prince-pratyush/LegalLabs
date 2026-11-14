from pathlib import Path
from typing import Any

from ..schemas import Document, GraderResult, HarnessResult, TaskDatum
from .judge import Judge


class Grader:
    def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
        raise NotImplementedError


class Suite:
    name: str
    kind: str  # "retrieval" or "answer"
    instructions: str
    primary_metric: str
    dataset_fingerprint: str
    top_k: int | None = None
    output_schema: dict[str, Any] | None = None
    judges: dict[str, dict[str, Any]] | None = None

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        raise NotImplementedError

    def corpus(self) -> list[Document]:
        return []

    def make_grader(self, system_vendors: frozenset[str]) -> Grader:
        raise NotImplementedError

    def report(self, results: list[dict[str, Any]], tasks: list[TaskDatum]) -> dict[str, Any]:
        """Suite-specific totals beyond the averages, such as rates with intervals and gates."""
        return {}


def limited(tasks: list[TaskDatum], limit: int | None) -> list[TaskDatum]:
    return tasks[:limit] if limit else tasks


class AnswerSuite(Suite):
    """A suite where the system writes a JSON answer, optionally checked by judges."""

    kind = "answer"

    def __init__(
        self,
        judges: dict[str, dict[str, Any]] | None = None,
        local: Path | None = None,
        judges_per_criterion: int = 2,
    ) -> None:
        self.judges = judges
        self.local = local
        self.judges_per_criterion = judges_per_criterion

    def grader(self, judge: Judge | None) -> Grader:
        raise NotImplementedError

    def make_grader(self, system_vendors: frozenset[str]) -> Grader:
        judge = None
        if self.judges:
            judge = Judge(self.judges, system_vendors, self.judges_per_criterion)
            judge.preflight()
        return self.grader(judge)
