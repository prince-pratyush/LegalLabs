from pathlib import Path

from ..schemas import Document, GraderResult, HarnessResult, TaskDatum


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
    output_schema: dict | None = None

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        raise NotImplementedError

    def corpus(self) -> list[Document]:
        return []

    def make_grader(self, system_vendor: str) -> Grader:
        raise NotImplementedError
