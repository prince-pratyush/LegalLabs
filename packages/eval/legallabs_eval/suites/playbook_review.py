import json
import os
import random
import shutil
import statistics
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import sha256
from ..harnesses.playbook_node import generate_corpus
from ..metrics import wilson
from ..schemas import GraderResult, HarnessResult, TaskDatum
from .base import Grader, Suite, limited
from .playbook_labels import accepted
from .thread_answers import errors

DEFAULT_SEED = 7
DEFAULT_COUNT = 16
CORPUS_ROOT = Path(__file__).resolve().parents[2] / "runs" / ".corpus"
VARIANTS = ("standard", "fallback", "unacceptable", "omitted")
KINDS = ("uncovered_clause", "existing_edit")
# The engine's deterministic guard for a tracked change the model passed over
# (review/src/gaps.ts). The spec makes it part of the product, so system recall counts it.
GUARD_REASON = "that no playbook rule or gap check addressed"
# The latency gate is for 40-page contracts; shorter ones are not scaled up to stand in.
LONG_PAGES = 35
BOOTSTRAP_REPS = 2000
UNVERIFIED = ("evidence_mismatch", "retry_exhausted")


def corpus_settings() -> tuple[int, int]:
    return (
        int(os.environ.get("LEGALLABS_PLAYBOOK_SEED", DEFAULT_SEED)),
        int(os.environ.get("LEGALLABS_PLAYBOOK_COUNT", DEFAULT_COUNT)),
    )


def is_guard(gap: dict[str, Any]) -> bool:
    return GUARD_REASON in gap.get("reason", "")


def _hits(gap: dict[str, Any], injected: dict[str, Any]) -> bool:
    """Same kind as planted, with evidence in the planted paragraph (WRD-002-d)."""
    return gap["kind"] == injected["kind"] and any(
        e.get("paragraph_index") == injected["paragraph_index"] for e in gap["evidence"]
    )


def _found(injected: dict[str, Any], gaps: list[dict[str, Any]], model_only: bool) -> bool:
    return any(_hits(g, injected) for g in gaps if not (model_only and is_guard(g)))


def grade_outcome(gold: dict[str, Any], run: dict[str, Any]) -> dict[str, float]:
    """Counts, not rates, so the report can pool them across contracts."""
    outcome = run["outcome"]
    found = {f["rule_title"]: f for f in outcome["results"]}
    labels = accepted(gold)
    m: dict[str, float] = {}

    def add(key: str, n: float = 1.0) -> None:
        m[key] = m.get(key, 0.0) + n

    for rule in gold["rules"]:
        finding = found.get(rule["rule"])
        status = finding["status"] if finding else "missing"
        # A skipped rule never ran, so it says nothing about classification.
        if status == "skipped":
            continue
        ok = status in labels[rule["rule"]][0]
        add("status_total")
        add("status_correct", ok)
        add("status_strict_correct", status == rule["status"])
        add(f"variant.{rule['variant']}.total")
        add(f"variant.{rule['variant']}.correct", ok)
        add(f"template.{gold['template']}.total")
        add(f"template.{gold['template']}.correct", ok)
        add(f"confusion.{rule['status']}.{status}")
        if not ok:
            # A verifier downgrade to needs_review is a quoting failure, not a wrong call.
            unverified = finding is not None and finding.get("verification") in UNVERIFIED
            add("status_wrong_unverified" if unverified else "status_wrong_misclassified")
    for key in ("status_total", "status_correct", "status_strict_correct"):
        m.setdefault(key, 0.0)
    m["status_accuracy"] = m["status_correct"] / m["status_total"] if m["status_total"] else 0.0

    gaps = outcome["gaps"]
    for kind in KINDS:
        chosen = [i for i in gold["injected"] if i["kind"] == kind]
        m[f"gaps_{kind}_total"] = len(chosen)
        m[f"gaps_{kind}_found"] = sum(_found(i, gaps, False) for i in chosen)
        m[f"gaps_{kind}_found_by_model"] = sum(_found(i, gaps, True) for i in chosen)
    m["gaps_injected"] = len(gold["injected"])
    m["gaps_found"] = sum(m[f"gaps_{k}_found"] for k in KINDS)
    m["gaps_found_by_model"] = sum(m[f"gaps_{k}_found_by_model"] for k in KINDS)
    m["gap_recall"] = m["gaps_found"] / m["gaps_injected"] if m["gaps_injected"] else 0.0
    # Precision against the planted items only: a gap elsewhere may still be a fair find.
    model_gaps = [g for g in gaps if not is_guard(g)]
    m["gaps_reported"] = len(gaps)
    m["gaps_reported_matching"] = sum(any(_hits(g, i) for i in gold["injected"]) for g in gaps)
    m["gaps_reported_by_model"] = len(model_gaps)
    m["gaps_reported_by_model_matching"] = sum(
        any(_hits(g, i) for i in gold["injected"]) for g in model_gaps
    )

    evidence = [e for f in outcome["results"] for e in f.get("evidence", [])]
    m["evidence_total"] = len(evidence)
    m["evidence_ok"] = sum(e.get("verified") == "ok" for e in evidence)
    for v in UNVERIFIED:
        m[f"findings_{v}"] = sum(f.get("verification") == v for f in outcome["results"])

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
            if not _found(i, run["outcome"]["gaps"], False)
        ]
        text = (
            f"status {int(m['status_correct'])}/{int(m['status_total'])}; "
            f"gaps missed: {', '.join(missed) or 'none'}"
        )
        return GraderResult(m["status_accuracy"], m, text)


def bootstrap(
    results: list[dict[str, Any]], hit: str, total: str, reps: int = BOOTSTRAP_REPS
) -> list[float] | None:
    """95% percentile interval, resampling whole contracts: rules within one are not independent."""
    pairs = [(r["metrics"].get(hit, 0.0), r["metrics"].get(total, 0.0)) for r in results]
    if not pairs or not sum(t for _, t in pairs):
        return None
    rng = random.Random(0)
    rates = []
    for _ in range(reps):
        draw = [pairs[rng.randrange(len(pairs))] for _ in pairs]
        n = sum(t for _, t in draw)
        if n:
            rates.append(sum(k for k, _ in draw) / n)
    rates.sort()
    return [round(rates[int(0.025 * len(rates))], 6), round(rates[int(0.975 * len(rates)) - 1], 6)]


def _rate(results: list[dict[str, Any]], hit: str, total: str) -> dict[str, Any]:
    n = sum(r["metrics"].get(total, 0.0) for r in results)
    k = sum(r["metrics"].get(hit, 0.0) for r in results)
    low, high = wilson(k, int(n))
    return {
        "rate": round(k / n, 6) if n else None,
        "hits": int(k),
        "n": int(n),
        "wilson95": [round(low, 6), round(high, 6)],
        "bootstrap95_over_contracts": bootstrap(results, hit, total),
    }


def _p50(values: list[float]) -> float | None:
    return round(statistics.median(values), 3) if values else None


def _check(rate: float | None, ok: Callable[[float], bool]) -> bool | None:
    """None means not measured, which never passes a gate."""
    return None if rate is None else ok(rate)


def build_corpus(seed: int, count: int) -> Path:
    """Content-addressed, written once: two suites built at once can't clobber each other."""
    CORPUS_ROOT.mkdir(parents=True, exist_ok=True)
    tmp = CORPUS_ROOT / f".tmp-{uuid.uuid4().hex}"
    generate_corpus(tmp, seed, count)
    gold = json.loads((tmp / "gold.json").read_text())
    target = CORPUS_ROOT / (
        f"playbook-v{gold['generator_version']}-s{seed}-n{count}-"
        + sha256((tmp / "gold.json").read_text())[:12]
    )
    try:
        os.rename(tmp, target)
    except OSError:
        # Already built by an earlier or a parallel run: the same seed gives the same files.
        shutil.rmtree(tmp, ignore_errors=True)
    return target


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
        "long_contract_wall_seconds_p50_max": 300.0,
        "long_contract_min_pages": LONG_PAGES,
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
        if corpus_dir is None:
            corpus_dir = (
                build_corpus(self.seed, self.count)
                if generate
                else CORPUS_ROOT / f"playbook-s{self.seed}-n{self.count}"
            )
        self.corpus_dir = corpus_dir
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
        accuracy = _rate(results, "status_correct", "status_total") | {
            "strict": _rate(results, "status_strict_correct", "status_total"),
            "by_variant": {
                v: _rate(results, f"variant.{v}.correct", f"variant.{v}.total") for v in VARIANTS
            },
            "by_template": {
                t: _rate(results, f"template.{t}.correct", f"template.{t}.total")
                for t in ("nda", "msa")
            },
            "wrong_misclassified": int(
                sum(r["metrics"].get("status_wrong_misclassified", 0) for r in results)
            ),
            "wrong_unverified": int(
                sum(r["metrics"].get("status_wrong_unverified", 0) for r in results)
            ),
        }
        recall = {
            # The gate figure: the product's output, the engine's guard included.
            "system": _rate(results, "gaps_found", "gaps_injected")
            | {k: _rate(results, f"gaps_{k}_found", f"gaps_{k}_total") for k in KINDS},
            "model_only": _rate(results, "gaps_found_by_model", "gaps_injected")
            | {k: _rate(results, f"gaps_{k}_found_by_model", f"gaps_{k}_total") for k in KINDS},
            "precision_vs_planted": {
                "system": _rate(results, "gaps_reported_matching", "gaps_reported"),
                "model_only": _rate(
                    results, "gaps_reported_by_model_matching", "gaps_reported_by_model"
                ),
            },
        }
        evidence = _rate(results, "evidence_ok", "evidence_total")
        ooxml = _rate(results, "ooxml_valid", "ooxml_applied")
        soffice = [
            r["metrics"]["ooxml_soffice_ok"] for r in results if "ooxml_soffice_ok" in r["metrics"]
        ]
        per_contract = [
            {
                "id": r["task_id"],
                "pages": int(r["metrics"]["pages"]),
                "wall_seconds": round(r["metrics"]["wall_seconds"], 3),
            }
            for r in results
        ]
        long = [c["wall_seconds"] for c in per_contract if c["pages"] >= LONG_PAGES]
        confusion: dict[str, dict[str, int]] = {}
        for r in results:
            for key, n in r["metrics"].items():
                if key.startswith("confusion."):
                    _, gold, got = key.split(".")
                    row = confusion.setdefault(gold, {})
                    row[got] = row.get(got, 0) + int(n)
        long_p50 = _p50(long)
        latency = {
            "long_contract_wall_seconds_p50": long_p50 if long else "not measured",
            "long_contracts": len(long),
            "per_contract": per_contract,
        }
        g = self.gates
        system_recall = recall["system"]["rate"]
        checks = {
            "status_accuracy": _check(accuracy["rate"], lambda r: r >= g["status_accuracy_min"]),
            "gap_recall": _check(system_recall, lambda r: r >= g["gap_recall_min"]),
            "evidence_verification": _check(
                evidence["rate"], lambda r: r >= g["evidence_verification_min"]
            ),
            "ooxml_validity": _check(
                ooxml["rate"], lambda r: r >= g["ooxml_validity_min"] and all(soffice)
            ),
            "latency": _check(long_p50, lambda s: s <= g["long_contract_wall_seconds_p50_max"]),
        }
        return {
            "contracts": len(tasks),
            "pages": int(sum(r["metrics"]["pages"] for r in results)),
            "playbook.rule_classification_accuracy": accuracy,
            "playbook.unanticipated_edit_detection_recall": recall,
            "playbook.evidence_verification_rate": evidence
            | {
                "findings_evidence_mismatch": int(
                    sum(r["metrics"].get("findings_evidence_mismatch", 0) for r in results)
                ),
                "findings_retry_exhausted": int(
                    sum(r["metrics"].get("findings_retry_exhausted", 0) for r in results)
                ),
            },
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
            "gate": g
            | {
                "checks": checks,
                "pass": failed["count"] == 0 and all(v is True for v in checks.values()),
            },
        }


def rescore(gold_dir: Path, outcomes_dir: Path) -> dict[str, Any]:
    """Grade saved node/run.ts outcomes (<contract id>.json) again, with no model calls.

    Only contracts with an outcome are scored, against the gold.json of the corpus the
    outcomes were produced on.
    """
    suite = PlaybookReview(corpus_dir=gold_dir, generate=False)
    tasks = [t for t in suite.load_tasks() if (outcomes_dir / f"{t.id}.json").exists()]
    if not tasks:
        raise ValueError(f"no outcome in {outcomes_dir} matches a contract in {gold_dir}")
    results = []
    for task in tasks:
        run = json.loads((outcomes_dir / f"{task.id}.json").read_text())
        m = grade_outcome(task.answer, run)
        results.append({"task_id": task.id, "score": m["status_accuracy"], "metrics": m})
    return {
        "suite": suite.name,
        "mode": "rescore",
        "dataset_fingerprint": suite.dataset_fingerprint,
        "contracts": [t.id for t in tasks],
        "report": suite.report(results, tasks),
    }
