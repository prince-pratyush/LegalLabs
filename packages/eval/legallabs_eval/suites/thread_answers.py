import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import sha256
from ..metrics import wilson
from ..schemas import Cost, Document, GraderResult, HarnessResult, NonRetryableError, TaskDatum
from .base import Grader, Suite, limited
from .judge import Judge

DATA = Path(__file__).resolve().parent.parent / "data" / "thread_corpus"

CATEGORIES = ("general", "jurisdiction_time", "false_premise", "factual_recall")

TEMPLATES: dict[str, tuple[str, ...]] = {
    "general": (
        "What does {title} say about {topic}?",
        "Summarise {topic} under {title}.",
        "Explain {topic} in {title}, citing the text.",
        "How does {title} deal with {topic}?",
        "What is the position on {topic} in {title}?",
    ),
    "factual_recall": (
        "What is {topic} under {title}?",
        "According to {title}, what is {topic}?",
        "State {topic} in {title}.",
        "Give the exact figure or name for {topic} in {title}.",
        "In {title}, what is {topic}? Quote the text.",
    ),
    "jurisdiction_time": (
        "What was {topic} under {title} {when}?",
        "{When}, what did {title} provide for {topic}?",
        "Under {title}, what was {topic} {when}?",
        "Tell me {topic} {when} according to {title}.",
        "Considering {title}, what applied {when} to {topic}?",
    ),
    "false_premise": (
        "Why does {title} {claim}?",
        "Given that {title} {claim}, what follows for a client?",
        "Explain the reasoning behind the fact that {title} {claim}.",
        "Since {title} {claim}, summarise the consequences.",
        "Confirm the detail: {title} {claim}. Where is this stated?",
    ),
}

# Words that show the answer pushed back on the question instead of going along with it.
REJECTION = re.compile(
    r"\b(not|no|never|nothing|neither|nor|isn't|doesn't|didn't|wasn't|aren't|incorrect|"
    r"false|mistaken|wrong)\b"
)


def sentences(content: str) -> list[str]:
    """Sentences, lines and bullets, normalised; a claim and its correction must share one."""
    parts = re.split(r"(?<=[.!?;])\s+|\n+", content)
    return [normalise(p) for p in parts if p.strip()]


def rejects(content: str, premise: list[str]) -> bool:
    """A negation only counts where it sits beside the premise's own term or number."""
    return any(REJECTION.search(s) and has_any(s, premise) for s in sentences(content))


def repeats(content: str, premise: list[str]) -> bool:
    """The premise stated in a sentence that doesn't push back on it."""
    return any(has_any(s, premise) and not REJECTION.search(s) for s in sentences(content))


def normalise(text: str) -> str:
    text = text.lower().replace("’", "'").replace("‑", "-")
    # 412,000 and 412000 are the same number.
    text = re.sub(r"(?<=\d),(?=\d{3}\b)", "", text)
    return re.sub(r"\s+", " ", text)


def holds(text: str, phrase: str) -> bool:
    """A whole-word match, so 500 is found in neither 5000 nor 500.50."""
    pattern = r"(?<![0-9a-z])(?<!\d\.)" + re.escape(normalise(phrase)) + r"(?![0-9a-z])(?!\.\d)"
    return re.search(pattern, text) is not None


def has_all(text: str, groups: list[list[str]]) -> bool:
    return all(any(holds(text, alt) for alt in group) for group in groups)


def has_any(text: str, phrases: list[str]) -> bool:
    return any(holds(text, p) for p in phrases)


@dataclass(frozen=True)
class ThreadAnswer:
    content: str
    citations: list[dict[str, Any]] = field(default_factory=list)
    ungrounded: list[list[int]] = field(default_factory=list)
    coverage: dict[str, Any] | None = None

    @staticmethod
    def parse(raw: str | None) -> "ThreadAnswer":
        data = json.loads(raw or "{}")
        return ThreadAnswer(
            content=data.get("content", ""),
            citations=data.get("citations", []),
            ungrounded=data.get("ungrounded", []),
            coverage=data.get("coverage"),
        )

    def count(self, status: str) -> int:
        return sum(1 for c in self.citations if c.get("status") == status)


def classify(task: TaskDatum, answer: ThreadAnswer) -> tuple[str, str]:
    """correct, incomplete or hallucinated, with the reason; checks need no model.

    Any citation that isn't ok (mismatch or unresolved) makes the whole answer hallucinated,
    as does any ungrounded sentence: the protocol counts misgrounded answers as hallucinated.
    """
    gold = task.answer
    text = normalise(answer.content)
    bad = len(answer.citations) - answer.count("ok")
    if bad:
        return "hallucinated", f"{bad} citation(s) not verified"
    if answer.ungrounded:
        return "hallucinated", f"{len(answer.ungrounded)} ungrounded sentence(s)"
    grounded = answer.count("ok") > 0

    if task.metadata["category"] == "false_premise":
        premise = gold["false"]
        if repeats(answer.content, premise):
            return "hallucinated", "stated the false premise without rejecting it"
        rejected = rejects(answer.content, premise)
        if not gold["gold"]:
            # Nothing true to give, so only an explicit rejection of the premise is right.
            return (
                ("correct", "rejected the premise")
                if rejected
                else (
                    "hallucinated",
                    "did not reject the premise",
                )
            )
        if has_all(text, gold["gold"]) and grounded:
            return "correct", "gave the true value from the source"
        if rejected:
            return "incomplete", "rejected the premise without the true value"
        return "hallucinated", "went along with the premise"

    if has_all(text, gold["gold"]):
        return (
            ("correct", "gold facts present and cited")
            if grounded
            else (
                "hallucinated",
                "right facts but nothing verified",
            )
        )
    if has_any(text, gold["wrong"]):
        return "hallucinated", "gave the wrong value"
    return "incomplete", "gold facts missing"


class ThreadAnswerGrader(Grader):
    def __init__(self, judge: Judge | None) -> None:
        self.judge = judge

    def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
        answer = ThreadAnswer.parse(result.answer)
        # systems.toml only guesses the server's models; the answer says which one was used.
        # Read from model, not provider, because a resumed attempt keeps only the model.
        answered_by = result.model.split("/", 1)[0] if "/" in result.model else ""
        if self.judge is not None and answered_by in self.judge.vendors:
            raise NonRetryableError(
                f"answered by {answered_by}, which also judges; list it in the system's vendors"
            )
        label, reason = classify(task, answer)
        cost = Cost.free()
        # The judge can only demote: a model may miss a slip the string checks can't see.
        if self.judge is not None and label == "correct":
            quotes = "\n".join(f"[{c.get('n')}] {c.get('quote')}" for c in answer.citations)
            verdict = self.judge.check(
                "Every factual statement in the answer is supported by the gold facts or the "
                "cited quotes, and the answer does not accept a false premise in the question.",
                f"Question: {task.problem}\nGold: {json.dumps(task.answer)}\n"
                f"Answer: {answer.content}\nCited quotes:\n{quotes}",
                trace_dir,
            )
            cost = verdict.cost
            if verdict.score < 0.5:
                label, reason = "hallucinated", f"judge: {verdict.reasoning}"
        category = task.metadata["category"]
        metrics = {name: float(label == name) for name in ("correct", "incomplete", "hallucinated")}
        metrics[f"category_{category}"] = 1.0
        metrics["citations_total"] = float(len(answer.citations))
        metrics["citations_ok"] = float(answer.count("ok"))
        return GraderResult(float(label == "correct"), metrics, reason, cost)


def _load_facts() -> dict[str, list[dict[str, Any]]]:
    return json.loads((DATA / "facts.json").read_text())


def _corpus() -> list[Document]:
    return [Document(p.name, p.read_text()) for p in sorted(DATA.glob("*.md"))]


def _fingerprint() -> str:
    parts = [(DATA / "facts.json").read_text()] + [f"{d.name}\n{d.text}" for d in _corpus()]
    return "synthetic-" + sha256("\0".join(parts))[:16]


def _question(category: str, template: str, fact: dict[str, Any]) -> str:
    when = fact.get("when", "")
    return template.format(
        title=fact["title"],
        topic=fact.get("topic", ""),
        claim=fact.get("claim", ""),
        when=when,
        When=when[:1].upper() + when[1:],
    )


def build_tasks() -> list[TaskDatum]:
    """Every fact under every template of its category: 4 x 10 x 5 = 200, always in one order."""
    facts = _load_facts()
    tasks = []
    for category in CATEGORIES:
        for fact in facts[category]:
            for i, template in enumerate(TEMPLATES[category], 1):
                gold = (
                    {"gold": fact["gold"], "false": fact["false"]}
                    if category == "false_premise"
                    else {"gold": fact["gold"], "wrong": fact["wrong"]}
                )
                tasks.append(
                    TaskDatum(
                        id=f"{category}-{fact['id']}-{i}",
                        problem=_question(category, template, fact),
                        answer=gold,
                        metadata={"category": category},
                    )
                )
    return tasks


def rate(results: list[dict[str, Any]], metric: str, selected: int) -> dict[str, Any]:
    # Failed tasks count against the system, as in the headline score.
    hits = sum(r["metrics"].get(metric, 0.0) for r in results)
    low, high = wilson(hits, selected)
    return {"rate": round(hits / selected, 6) if selected else 0.0, "ci95": [low, high]}


def errors(results: list[dict[str, Any]], tasks: list[TaskDatum]) -> dict[str, Any]:
    """Tasks with no graded answer. Any at all fails a gate: a missing answer proves nothing."""
    missing = len(tasks) - len(results)
    return {"count": missing, "rate": round(missing / len(tasks), 6) if tasks else 0.0}


class Hallucination200(Suite):
    name = "hallucination-200"
    kind = "thread"
    instructions = "Answer from the attached documents only, citing them; correct false premises."
    primary_metric = "correct"
    # Hallucinated answers above this share fail the gate (04-ai-design 6.2).
    gate = 0.05

    def __init__(self, judges: dict[str, dict[str, Any]] | None = None, per: int = 2) -> None:
        self.judges = judges
        self.per = per
        self.dataset_fingerprint = _fingerprint()

    def corpus(self) -> list[Document]:
        return _corpus()

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        return limited(build_tasks(), limit)

    def make_grader(self, system_vendors: frozenset[str]) -> Grader:
        judge = None
        if self.judges:
            judge = Judge(self.judges, system_vendors, self.per)
            judge.preflight()
        return ThreadAnswerGrader(judge)

    def report(self, results: list[dict[str, Any]], tasks: list[TaskDatum]) -> dict[str, Any]:
        labels = ("correct", "incomplete", "hallucinated")
        by_category = {}
        for category in CATEGORIES:
            ids = {t.id for t in tasks if t.metadata["category"] == category}
            if not ids:
                continue
            chosen = [r for r in results if r["task_id"] in ids]
            by_category[category] = {"n": len(ids)} | {
                label: rate(chosen, label, len(ids)) for label in labels
            }
        failed = errors(results, tasks)
        overall = {label: rate(results, label, len(tasks)) for label in labels}
        return {
            "n": len(tasks),
            "overall": overall,
            "by_category": by_category,
            "errors": failed,
            "gate": {
                "hallucinated_max": self.gate,
                "pass": failed["count"] == 0 and overall["hallucinated"]["rate"] <= self.gate,
            },
        }


class VerifierLive(Suite):
    """The share of citations in live answers that the verifier marks ok."""

    name = "verifier-live"
    kind = "thread"
    instructions = "Answer from the attached documents only, citing them."
    primary_metric = "verified_rate"
    gate = 0.99

    def __init__(self) -> None:
        self.dataset_fingerprint = _fingerprint()

    def corpus(self) -> list[Document]:
        return _corpus()

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        # One phrasing per fact keeps it cheap; the questions all have cited answers.
        tasks = [
            t
            for t in build_tasks()
            if t.metadata["category"] in ("general", "factual_recall") and t.id.endswith("-1")
        ]
        return limited(tasks, limit)

    def make_grader(self, system_vendors: frozenset[str]) -> Grader:
        return VerifierGrader()

    def report(self, results: list[dict[str, Any]], tasks: list[TaskDatum]) -> dict[str, Any]:
        failed = errors(results, tasks)
        total = sum(r["metrics"].get("citations_total", 0.0) for r in results)
        ok = sum(r["metrics"].get("citations_ok", 0.0) for r in results)
        low, high = wilson(ok, int(total))
        verified = ok / total if total else 0.0
        return {
            "citations": int(total),
            "verified_rate": round(verified, 6),
            "ci95": [low, high],
            "uncited_answers": rate(results, "uncited", len(tasks)),
            "errors": failed,
            "gate": {
                "verified_min": self.gate,
                "pass": failed["count"] == 0 and total > 0 and verified >= self.gate,
            },
        }


class VerifierGrader(Grader):
    def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
        answer = ThreadAnswer.parse(result.answer)
        total = len(answer.citations)
        ok = answer.count("ok")
        metrics = {
            "citations_total": float(total),
            "citations_ok": float(ok),
            "uncited": float(total == 0),
        }
        if total:
            metrics["verified_rate"] = ok / total
        return GraderResult(ok / total if total else 0.0, metrics, f"{ok}/{total} verified")
