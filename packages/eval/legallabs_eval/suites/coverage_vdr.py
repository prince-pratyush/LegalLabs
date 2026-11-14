import os
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import sha256
from ..schemas import Document, GraderResult, HarnessResult, TaskDatum
from .base import Grader, Suite, limited
from .thread_answers import ThreadAnswer, errors, has_any, holds, sentences

# Bump when the generated text changes, so old runs are never compared with new rooms.
GENERATOR_VERSION = 1
DEFAULT_DOCS = 500
DEFAULT_SEED = 7
MAX_DOCS = 10_000

CUSTOMERS = ["Alder", "Birchmoor", "Calloway", "Dunmere", "Eastvale", "Fennick", "Galloway"]
SUPPLIERS = ["Harrowgate", "Ivybridge", "Juniper", "Kestrel", "Larkspur", "Merrow", "Northcote"]
KINDS = ["supply agreement", "services agreement", "licence agreement", "distribution agreement"]


@dataclass(frozen=True)
class Issue:
    key: str
    label: str
    clause: str
    # Words a report must use for the issue, beside the contract number.
    keywords: tuple[str, ...]


ISSUES = (
    Issue(
        "change_of_control",
        "change-of-control termination right",
        "If any person acquires control of the Customer, the Supplier may terminate this "
        "Agreement immediately by written notice.",
        ("change of control", "change-of-control", "acquires control"),
    ),
    Issue(
        "uncapped_indemnity",
        "uncapped indemnity",
        "The Customer's indemnity under this clause is unlimited and is not subject to the cap "
        "in clause 5.",
        ("unlimited", "uncapped", "not subject to the cap", "no cap"),
    ),
    Issue(
        "long_auto_renewal",
        "automatic renewal for more than one year",
        "This Agreement renews automatically for successive 5-year terms unless either party "
        "gives 12 months' written notice.",
        ("5-year", "five-year", "5 year", "five year"),
    ),
    Issue(
        "foreign_law",
        "governing law other than Veloria",
        "This Agreement is governed by the laws of the Kingdom of Esterra, and the courts of "
        "Esterra have exclusive jurisdiction.",
        ("esterra",),
    ),
)

QUESTION = (
    "Review every contract in this data room. List each contract that has a change-of-control "
    "termination right, an uncapped indemnity, an automatic renewal for more than one year, or "
    "a governing law other than Veloria. Give the contract number for every issue you find."
)


def room_size() -> tuple[int, int]:
    return (
        int(os.environ.get("LEGALLABS_VDR_DOCS", DEFAULT_DOCS)),
        int(os.environ.get("LEGALLABS_VDR_SEED", DEFAULT_SEED)),
    )


def _contract(number: int, rng: random.Random, planted: list[Issue]) -> str:
    customer = f"{rng.choice(CUSTOMERS)} {rng.choice(['Holdings', 'Retail', 'Foods', 'Energy'])}"
    supplier = f"{rng.choice(SUPPLIERS)} {rng.choice(['Systems', 'Logistics', 'Labs', 'Works'])}"
    kind = rng.choice(KINDS)
    fee = rng.randrange(20, 900) * 1000
    keys = {issue.key for issue in planted}
    clauses = {issue.key: issue.clause for issue in planted}
    sections = [
        f"# Contract {number:04d}: {kind} between {customer} and {supplier}",
        "Fictional contract generated for evaluation. Every party is invented.",
        f"## 1. Services\n\n1.1 {supplier} (the Supplier) provides the goods and services in "
        f"Schedule 1 to {customer} (the Customer).\n\n1.2 The annual fee is {fee:,} crowns, "
        "payable quarterly in arrears.",
        "## 2. Term\n\n2.1 "
        + clauses.get(
            "long_auto_renewal",
            "This Agreement renews automatically for successive 12-month terms unless either "
            "party gives 30 days' written notice.",
        ),
        "## 3. Termination\n\n3.1 Either party may terminate for material breach not remedied "
        "within 30 days of notice."
        + (f"\n\n3.2 {clauses['change_of_control']}" if "change_of_control" in keys else ""),
        "## 4. Indemnity\n\n4.1 The Customer indemnifies the Supplier against third-party claims "
        "arising from the Customer's misuse of the deliverables.\n\n4.2 "
        + clauses.get(
            "uncapped_indemnity",
            "The Customer's indemnity under this clause is subject to the cap in clause 5.",
        ),
        "## 5. Liability\n\n5.1 Each party's aggregate liability is limited to the fees paid in "
        "the 12 months before the claim.",
        "## 6. Governing law\n\n6.1 "
        + clauses.get("foreign_law", "This Agreement is governed by the laws of Veloria."),
    ]
    return "\n\n".join(sections) + "\n"


def generate_room(docs: int, seed: int) -> tuple[list[Document], list[dict[str, Any]]]:
    """The same docs and seed always give the same room and the same planted issues."""
    # Bounded so a typo can't fill the disk; the largest spec room is 5,000.
    if not 1 <= docs <= MAX_DOCS:
        raise ValueError(f"a room needs 1 to {MAX_DOCS} contracts, not {docs}")
    rng = random.Random(seed)
    # Roughly 0.6% of contracts per issue, at least one: needles a skim would miss.
    per_issue = max(1, round(docs * 0.006))
    planted: dict[int, list[Issue]] = {}
    for issue in ISSUES:
        for number in rng.sample(range(1, docs + 1), min(per_issue, docs)):
            planted.setdefault(number, []).append(issue)
    documents = [
        Document(f"contract-{n:04d}.md", _contract(n, rng, planted.get(n, [])))
        for n in range(1, docs + 1)
    ]
    criteria = [
        {
            "id": f"{issue.key}-{number:04d}",
            "text": f"The report flags the {issue.label} in Contract {number:04d}.",
            "document": f"contract-{number:04d}.md",
            "number": f"{number:04d}",
            "keywords": list(issue.keywords),
        }
        for number, issues in sorted(planted.items())
        for issue in issues
    ]
    return documents, criteria


def criterion_met(criterion: dict[str, Any], answer: ThreadAnswer) -> bool:
    """Binary, like the LAB rubric: one sentence, line or bullet names the contract and the issue.

    Both must sit together, so a list of numbers beside an unrelated issue earns nothing.
    """
    return any(
        holds(s, criterion["number"]) and has_any(s, criterion["keywords"])
        for s in sentences(answer.content)
    )


class VdrGrader(Grader):
    def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
        answer = ThreadAnswer.parse(result.answer)
        met = [criterion_met(c, answer) for c in task.answer]
        passed = sum(met) / len(met) if met else 0.0
        metrics = {"criterion_pass": passed, "all_pass": float(all(met))}
        coverage = answer.coverage or {}
        if coverage.get("docs_in_scope"):
            metrics["read_fraction"] = coverage.get("docs_read", 0) / coverage["docs_in_scope"]
        missed = [c["id"] for c, ok in zip(task.answer, met, strict=True) if not ok]
        return GraderResult(passed, metrics, f"missed: {', '.join(missed) or 'none'}")


class CoverageVdr(Suite):
    """A deep-analysis run against a naive thread run over the same synthetic data room."""

    name = "coverage-vdr"
    kind = "thread"
    instructions = QUESTION
    primary_metric = "criterion_pass"
    read_gate = 0.10
    lift_gate = 0.20

    def __init__(self, docs: int | None = None, seed: int | None = None) -> None:
        default_docs, default_seed = room_size()
        self.docs = docs or default_docs
        self.seed = seed if seed is not None else default_seed
        self._room = generate_room(self.docs, self.seed)
        self.dataset_fingerprint = (
            f"vdr-v{GENERATOR_VERSION}-{self.docs}-{self.seed}-"
            + sha256("\0".join(d.text for d in self._room[0]))[:12]
        )

    def corpus(self) -> list[Document]:
        return self._room[0]

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        criteria = self._room[1]
        tasks = [
            TaskDatum(
                id=mode,
                problem=QUESTION,
                answer=criteria,
                metadata={"deep_analysis": mode == "deep-analysis"},
            )
            for mode in ("deep-analysis", "baseline")
        ]
        return limited(tasks, limit)

    def make_grader(self, system_vendors: frozenset[str]) -> Grader:
        return VdrGrader()

    def report(self, results: list[dict[str, Any]], tasks: list[TaskDatum]) -> dict[str, Any]:
        by_mode = {r["task_id"]: r["metrics"] for r in results}
        deep = by_mode.get("deep-analysis")
        base = by_mode.get("baseline")
        failed = errors(results, tasks)
        # Without both runs there is nothing to compare, so the gate fails rather than guess.
        complete = deep is not None and base is not None and failed["count"] == 0
        read = (deep or {}).get("read_fraction")
        lift = (
            deep["criterion_pass"] - base["criterion_pass"]
            if deep is not None and base is not None
            else None
        )
        return {
            "docs": self.docs,
            "seed": self.seed,
            "criteria": len(self._room[1]),
            "deep_analysis": deep,
            "baseline": base,
            "lift": None if lift is None else round(lift, 6),
            "errors": failed,
            "gate": {
                "read_min": self.read_gate,
                "lift_min": self.lift_gate,
                "pass": complete
                and read is not None
                and lift is not None
                and read >= self.read_gate
                and lift >= self.lift_gate,
            },
        }


def write_room(out: Path, docs: int, seed: int) -> int:
    """Writes the room to disk so a vault can be loaded with it before a large run."""
    documents, _ = generate_room(docs, seed)
    out.mkdir(parents=True, exist_ok=True)
    for doc in documents:
        (out / doc.name).write_text(doc.text, encoding="utf-8")
    return len(documents)
