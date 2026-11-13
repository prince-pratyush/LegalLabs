import json
from pathlib import Path

from ..config import sha256
from ..metrics import Relevant, ndcg_at, recall_at
from ..schemas import Document, GraderResult, HarnessResult, TaskDatum
from .base import Grader, Suite

DATA = Path(__file__).resolve().parent.parent / "data" / "retrieval_golden"
BUDGET = 20


def resolve(relevant: dict, documents: dict[str, str]) -> Relevant:
    """A golden item names a quote; its span is found in the document so offsets never drift."""
    if "span" in relevant:
        return Relevant(relevant["doc"], relevant.get("page"), tuple(relevant["span"]))
    text = documents.get(relevant["doc"])
    if text is None:
        raise ValueError(f"golden set names a missing document: {relevant['doc']}")
    start = text.find(relevant["quote"])
    if start < 0:
        raise ValueError(f"quote not found in {relevant['doc']}: {relevant['quote'][:40]}")
    return Relevant(relevant["doc"], 1, (start, start + len(relevant["quote"])))


class RetrievalGrader(Grader):
    def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
        relevant = task.answer
        ndcg = ndcg_at(result.hits, relevant, 10)
        return GraderResult(
            score=ndcg,
            metrics={
                "ndcg_at_10": ndcg,
                f"recall_at_{BUDGET}": recall_at(result.hits, relevant, BUDGET),
                "recall_at_5": recall_at(result.hits, relevant, 5),
            },
        )


class RetrievalGolden(Suite):
    name = "retrieval-golden"
    kind = "retrieval"
    instructions = "Return the passages that answer the query, best first."
    primary_metric = "ndcg_at_10"
    top_k = BUDGET

    def __init__(self, data_dir: Path = DATA) -> None:
        self.data_dir = data_dir
        self._docs = {p.name: p.read_text() for p in sorted(data_dir.glob("*.md"))}
        self._golden = (data_dir / "golden.jsonl").read_text()
        parts = [self._golden] + [f"{n}\n{t}" for n, t in self._docs.items()]
        self.dataset_fingerprint = "synthetic-" + sha256("\0".join(parts))[:16]

    def corpus(self) -> list[Document]:
        return [Document(name, text) for name, text in self._docs.items()]

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        tasks = []
        for i, line in enumerate(self._golden.splitlines()):
            if not line.strip():
                continue
            row = json.loads(line)
            relevant = [resolve(r, self._docs) for r in row["relevant"]]
            tasks.append(
                TaskDatum(id=f"q{i + 1:03d}", problem=row["query"], answer=relevant, metadata=row)
            )
        return tasks[:limit] if limit else tasks

    def make_grader(self, system_vendor: str) -> Grader:
        return RetrievalGrader()
