import json
import os
import statistics
from pathlib import Path
from typing import Any

from ..config import sha256
from ..harnesses.playbook_node import generate_corpus
from ..metrics import wilson
from ..schemas import GraderResult, HarnessResult, TaskDatum
from .base import Grader, Suite, limited
from .thread_answers import errors

DEFAULT_SEED = 7
DEFAULT_COUNT = 16
CORPUS_ROOT = Path(__file__).resolve().parents[2] / "runs" / ".corpus"
STATUSES = ("acceptable", "needs_review", "not_acceptable", "not_found")
# The engine's own catch-all for a tracked change the model passed over (review/src/gaps.ts).
FALLBACK_REASON = "that no playbook rule or gap check addressed"
PAGES_PER_GATE = 40


def corpus_settings() -> tuple[int, int]:
    return (
        int(os.environ.get("LEGALLABS_PLAYBOOK_SEED", DEFAULT_SEED)),
        int(os.environ.get("LEGALLABS_PLAYBOOK_COUNT", DEFAULT_COUNT)),
    )


def _detected(injected: dict[str, Any], gaps: list[dict[str, Any]], model_only: bool) -> bool:
    """A gap counts when its evidence sits in the injected paragraph."""
    for gap in gaps:
        if model_only and FALLBACK_REASON in gap.get("reason", ""):
            continue
        if any(e.get("paragraph_index") == injected["paragraph_index"] for e in gap["evidence"]):
            return True
    return False


def grade_outcome(gold: dict[str, Any], run: dict[str, Any]) -> dict[str, float]:
    """Counts, not rates, so the report can pool them across contracts."""
    outcome = run["outcome"]
    found = {f["rule_title"]: f for f in outcome["results"]}
    m: dict[str, float] = {}
    correct = total = 0
    for rule in gold["rules"]:
        finding = found.get(rule["rule"])
        status = finding["status"] if finding else "missing"
        # A skipped rule never ran, so it says nothing about classification.
        if status == "skipped":
            continue
        total += 1
        correct += status == rule["status"]
        key = f"confusion.{rule['status']}.{status}"
        m[key] = m.get(key, 0.0) + 1
    m["status_total"] = total
    m["status_correct"] = correct
    m["status_accuracy"] = correct / total if total else 0.0

    gaps = outcome["gaps"]
    for kind in ("uncovered_clause", "existing_edit"):
        chosen = [i for i in gold["injected"] if i["kind"] == kind]
        m[f"gaps_{kind}_total"] = len(chosen)
        m[f"gaps_{kind}_found"] = sum(_detected(i, gaps, False) for i in chosen)
        m[f"gaps_{kind}_found_by_model"] = sum(_detected(i, gaps, True) for i in chosen)
    injected = len(gold["injected"])
    m["gap_recall"] = (
        (m["gaps_uncovered_clause_found"] + m["gaps_existing_edit_found"]) / injected
        if injected
        else 0.0
    )
    m["gaps_reported"] = len(gaps)

    evidence = [e for f in outcome["results"] for e in f.get("evidence", [])]
    m["evidence_total"] = len(evidence)
    m["evidence_ok"] = sum(e.get("verified") == "ok" for e in evidence)
    m["findings_evidence_mismatch"] = sum(
        f.get("verification") == "evidence_mismatch" for f in outcome["results"]
    )
    m["findings_retry_exhausted"] = sum(
        f.get("verification") == "retry_exhausted" for f in outcome["results"]
    )

    ooxml = run["ooxml"]
    m["ooxml_suggestions"] = ooxml["suggestions"]
    m["ooxml_applied"] = ooxml["applied"]
    m["ooxml_valid"] = ooxml["valid"]
    m["ooxml_anchor_failed"] = sum(
        n for code, n in ooxml["failed"].items() if code not in ("REREAD_FAILED", "OOXML_INVALID")
    )
    m["ooxml_combined_ok"] = float(ooxml["combined"]["reread_ok"])
    if ooxml["combined"]["soffice_ok"] is not None:
        m["ooxml_soffice_ok"] = float(ooxml["combined"]["soffice_ok"])

    m["wall_seconds"] = run["wall_ms"] / 1000
    m["pages"] = run["pages"]
    m["seconds_per_40_pages"] = m["wall_seconds"] / max(run["pages"], 1) * PAGES_PER_GATE
    m["input_tokens"] = outcome["usage"]["input_tokens"]
    m["output_tokens"] = outcome["usage"]["output_tokens"]
    m["model_calls"] = sum(
        p["calls"] for p in [outcome["phases"]["plan"], outcome["phases"]["verify"]]
    ) + sum(p["calls"] for p in outcome["phases"]["rules"].values())
    return m


class PlaybookGrader(Grader):
    def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
        run = json.loads(result.answer or "{}")
        m = grade_outcome(task.answer, run)
        missed = [
            i["key"]
            for i in task.answer["injected"]
            if not _detected(i, run["outcome"]["gaps"], False)
        ]
        text = (
            f"status {int(m['status_correct'])}/{int(m['status_total'])}; "
            f"gaps missed: {', '.join(missed) or 'none'}"
        )
        return GraderResult(m["status_accuracy"], m, text)


def _rate(results: list[dict[str, Any]], hit: str, total: str) -> dict[str, Any]:
    n = sum(r["metrics"].get(total, 0.0) for r in results)
    k = sum(r["metrics"].get(hit, 0.0) for r in results)
    low, high = wilson(k, int(n))
    return {"rate": round(k / n, 6) if n else None, "n": int(n), "ci95": [low, high]}


def _p50(values: list[float]) -> float | None:
    return round(statistics.median(values), 3) if values else None


class PlaybookReview(Suite):
    """Held-out synthetic contracts against the starter playbooks (04-ai-design 6.2)."""

    name = "playbook-review"
    kind = "playbook"
    instructions = "Review each contract against its starter playbook in standard mode."
    primary_metric = "status_accuracy"
    gates = {
        "status_accuracy_min": 0.80,
        "gap_recall_min": 0.90,
        "evidence_verification_min": 0.99,
        "ooxml_validity_min": 1.0,
        "seconds_per_40_pages_p50_max": 300.0,
    }

    def __init__(
        self,
        corpus_dir: Path | None = None,
        seed: int | None = None,
        count: int | None = None,
        generate: bool = True,
    ) -> None:
        default_seed, default_count = corpus_settings()
        self.seed = default_seed if seed is None else seed
        self.count = count or default_count
        self.corpus_dir = corpus_dir or CORPUS_ROOT / f"playbook-s{self.seed}-n{self.count}"
        if generate:
            generate_corpus(self.corpus_dir, self.seed, self.count)
        gold_text = (self.corpus_dir / "gold.json").read_text()
        self.gold = json.loads(gold_text)
        self.dataset_fingerprint = (
            f"playbook-v{self.gold['generator_version']}-{self.seed}-{self.count}-"
            + sha256(gold_text)[:12]
        )

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        tasks = [
            TaskDatum(
                id=c["id"],
                problem=f"Review {c['file']} against the {c['template']} starter playbook.",
                answer=c,
                metadata={
                    "path": str(self.corpus_dir / c["file"]),
                    "template": c["template"],
                    "pages": c["pages"],
                },
            )
            for c in self.gold["contracts"]
        ]
        return limited(tasks, limit)

    def make_grader(self, system_vendors: frozenset[str]) -> Grader:
        return PlaybookGrader()

    def report(self, results: list[dict[str, Any]], tasks: list[TaskDatum]) -> dict[str, Any]:
        failed = errors(results, tasks)
        accuracy = _rate(results, "status_correct", "status_total")
        found = sum(
            r["metrics"].get(f"gaps_{k}_found", 0.0)
            for r in results
            for k in ("uncovered_clause", "existing_edit")
        )
        injected = sum(
            r["metrics"].get(f"gaps_{k}_total", 0.0)
            for r in results
            for k in ("uncovered_clause", "existing_edit")
        )
        low, high = wilson(found, int(injected))
        gap_recall = {
            "rate": round(found / injected, 6) if injected else None,
            "n": int(injected),
            "ci95": [low, high],
            "uncovered_clause": _rate(
                results, "gaps_uncovered_clause_found", "gaps_uncovered_clause_total"
            ),
            "existing_edit": _rate(results, "gaps_existing_edit_found", "gaps_existing_edit_total"),
            # Without the engine's catch-all gap for unaddressed tracked changes.
            "existing_edit_by_model": _rate(
                results, "gaps_existing_edit_found_by_model", "gaps_existing_edit_total"
            ),
        }
        evidence = _rate(results, "evidence_ok", "evidence_total")
        ooxml = _rate(results, "ooxml_valid", "ooxml_applied")
        soffice = [
            r["metrics"]["ooxml_soffice_ok"] for r in results if "ooxml_soffice_ok" in r["metrics"]
        ]
        per40 = [r["metrics"]["seconds_per_40_pages"] for r in results]
        long = [r["metrics"]["wall_seconds"] for r in results if r["metrics"]["pages"] >= 35]
        confusion: dict[str, dict[str, int]] = {}
        for r in results:
            for key, n in r["metrics"].items():
                if key.startswith("confusion."):
                    _, gold, got = key.split(".")
                    row = confusion.setdefault(gold, {})
                    row[got] = row.get(got, 0) + int(n)
        latency = {
            "wall_seconds_p50": _p50([r["metrics"]["wall_seconds"] for r in results]),
            "seconds_per_40_pages_p50": _p50(per40),
            "seconds_per_40_pages_max": round(max(per40), 3) if per40 else None,
            "wall_seconds_p50_at_35_pages_or_more": _p50(long),
            "contracts_at_35_pages_or_more": len(long),
        }
        g = self.gates
        checks = {
            "status_accuracy": accuracy["rate"] is not None
            and accuracy["rate"] >= g["status_accuracy_min"],
            "gap_recall": gap_recall["rate"] is not None
            and gap_recall["rate"] >= g["gap_recall_min"],
            "evidence_verification": evidence["rate"] is not None
            and evidence["rate"] >= g["evidence_verification_min"],
            # No suggestion to patch proves nothing either way, so it does not pass.
            "ooxml_validity": ooxml["rate"] is not None
            and ooxml["rate"] >= g["ooxml_validity_min"]
            and all(soffice),
            "latency": latency["seconds_per_40_pages_p50"] is not None
            and latency["seconds_per_40_pages_p50"] <= g["seconds_per_40_pages_p50_max"],
        }
        return {
            "contracts": len(tasks),
            "pages": int(sum(r["metrics"]["pages"] for r in results)),
            "playbook.rule_classification_accuracy": accuracy,
            "playbook.unanticipated_edit_detection_recall": gap_recall,
            "playbook.evidence_verification_rate": evidence,
            "playbook.ooxml_validity_rate": ooxml
            | {
                "anchor_failed": int(sum(r["metrics"]["ooxml_anchor_failed"] for r in results)),
                "suggestions": int(sum(r["metrics"]["ooxml_suggestions"] for r in results)),
                "soffice_checked": len(soffice),
                "soffice_ok": int(sum(soffice)),
            },
            "latency": latency,
            "confusion": confusion,
            "tokens": {
                "input": int(sum(r["metrics"]["input_tokens"] for r in results)),
                "output": int(sum(r["metrics"]["output_tokens"] for r in results)),
                "model_calls": int(sum(r["metrics"]["model_calls"] for r in results)),
            },
            "errors": failed,
            "gate": g | {"checks": checks, "pass": failed["count"] == 0 and all(checks.values())},
        }
