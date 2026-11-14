import json
from pathlib import Path

from ..config import sha256
from ..metrics import Relevant
from ..schemas import TaskDatum
from .base import Grader, Suite, limited
from .retrieval_golden import BUDGET, RetrievalGrader

DATA = Path(__file__).resolve().parent.parent / "data" / "knowledge"
SOURCES = ("us_caselaw", "eurlex", "edgar")


class RetrievalKnowledge(Suite):
    """Synthetic questions over a public-law source's indexed subset.

    Relevance is per authority, named by its primary citation, so the set holds
    no source text and stays valid whichever loader filled the index. The subset
    must be synced (or, for EDGAR's synthetic filings, loaded) before a run.
    """

    kind = "retrieval"
    instructions = "Return the passages from public-law authorities that answer the query."
    primary_metric = "ndcg_at_10"
    top_k = BUDGET

    def __init__(self, source: str, data_dir: Path = DATA) -> None:
        if source not in SOURCES:
            raise ValueError(f"unknown knowledge source {source!r}")
        self.source = source
        self.name = f"retrieval-golden-{source}"
        self._golden = (data_dir / source / "golden.jsonl").read_text()
        self.dataset_fingerprint = f"synthetic-{source}-" + sha256(self._golden)[:16]

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        tasks = []
        for i, line in enumerate(self._golden.splitlines()):
            if not line.strip():
                continue
            row = json.loads(line)
            relevant = [Relevant(r["cite"], None, None) for r in row["relevant"]]
            tasks.append(
                TaskDatum(
                    id=f"{self.source}-q{i + 1:03d}",
                    problem=row["query"],
                    answer=relevant,
                    metadata={**row, "source": self.source},
                )
            )
        return limited(tasks, limit)

    def make_grader(self, system_vendors: frozenset[str]) -> Grader:
        return RetrievalGrader()
