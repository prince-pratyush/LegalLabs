from pathlib import Path

from ..datasets import Pinned, load_json
from ..metrics import locate, span_iou
from ..models import parse_json
from ..schemas import Cost, GraderResult, HarnessResult, TaskDatum
from .base import AnswerSuite, Grader, limited
from .judge import Judge

CONTRACT_NLI = Pinned(
    name="contractnli",
    url="https://stanfordnlp.github.io/contract-nli/resources/contract-nli.zip",
    sha256="e03fc77bbf8b53e2976a250e81d8a294bc3d5e5fb014521e477dee9340d6287b",
    member="contract-nli/test.json",
    licence="CC BY 4.0",
)

LABELS = ["Entailment", "Contradiction", "NotMentioned"]

OUTPUT = {
    "type": "object",
    "properties": {
        "label": {"type": "string", "enum": LABELS},
        "evidence": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["label", "evidence"],
    "additionalProperties": False,
}


class NliGrader(Grader):
    def __init__(self, judge: Judge | None) -> None:
        self.judge = judge

    def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
        parsed = parse_json(result.answer or "")
        label = parsed.get("label") if parsed else None
        evidence = parsed.get("evidence") if parsed else None
        if label not in LABELS or not isinstance(evidence, list):
            return GraderResult(0.0, {"valid_json": 0.0, "accuracy": 0.0}, "answer was not valid")
        gold = task.answer
        correct = label == gold["label"]
        metrics: dict[str, float] = {"valid_json": 1.0, "accuracy": float(correct)}
        context = task.context or ""
        predicted: set[int] = set()
        for quote in evidence:
            if isinstance(quote, str):
                predicted |= locate(quote, context) or set()
        # Evidence only means something when the label is right and the clause exists.
        if correct and gold["label"] != "NotMentioned":
            metrics["evidence_iou"] = span_iou(predicted, set(gold["evidence"]))
        cost, notes = Cost.free(), ""
        if self.judge is not None and label != "NotMentioned":
            verdict = self.judge.check(
                f"The quoted evidence, read alone, shows the label {label} is right for the "
                "hypothesis.",
                f"Hypothesis: {task.problem}\nLabel: {label}\nEvidence:\n{evidence}",
                trace_dir,
            )
            metrics["judge_pass"] = verdict.score
            cost, notes = verdict.cost, verdict.reasoning
        return GraderResult(metrics["accuracy"], metrics, notes, cost)


class NliContractNli(AnswerSuite):
    name = "nli-contractnli"
    instructions = (
        "Decide whether the contract entails, contradicts, or does not mention the hypothesis. "
        "Quote the sentences that are your evidence verbatim from the document."
    )
    primary_metric = "accuracy"
    output_schema = OUTPUT

    dataset_fingerprint = CONTRACT_NLI.fingerprint

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        data = load_json(CONTRACT_NLI, self.local)
        tasks = []
        for doc in data["documents"]:
            annotations = doc["annotation_sets"][0]["annotations"]
            for key, note in sorted(annotations.items()):
                chars: list[int] = []
                for index in note["spans"]:
                    start, end = doc["spans"][index]
                    chars.extend(range(start, end))
                tasks.append(
                    TaskDatum(
                        id=f"{doc['id']}-{key}",
                        problem=data["labels"][key]["hypothesis"],
                        answer={"label": note["choice"], "evidence": chars},
                        metadata={"hypothesis_id": key},
                        context=doc["text"],
                    )
                )
        return limited(tasks, limit)

    def grader(self, judge: Judge | None) -> Grader:
        return NliGrader(judge)
