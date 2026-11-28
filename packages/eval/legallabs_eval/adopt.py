"""The adoption gates for a post-trained extraction model (MDL-006).

A candidate is adopted only when it matches a frontier system on every extract-* suite and on
review-table-e2e at no more than a tenth of its cost. Anything that cannot be shown, such as
an unknown price, a missing suite or a small sample, fails. This compares summaries of runs
already made; it calls no model, and a pass changes nothing in the product.
"""

from pathlib import Path
from typing import Any

from .io import read_json
from .registry import SUITES

REQUIRED = (*sorted(n for n in SUITES if n.startswith("extract-")), "review-table-e2e")
# Fewer tasks than this and a match can't be told from luck. The review table has 100 rows.
MIN_TASKS = 100
MAX_COST_RATIO = 0.1

KEYS = (
    "system",
    "suite",
    "dataset_fingerprint",
    "suite_instructions_sha256",
    "task_set",
    "selected_tasks",
    "total_failed",
    "failed_as_zero",
    "metrics_failed_excluded",
    "report",
    "cost",
)


def load_summaries(paths: list[Path]) -> list[dict[str, Any]]:
    """Each path is a run directory or its summary.json."""
    return [read_json(p / "summary.json" if p.is_dir() else p) for p in paths]


def _by_suite(side: str, summaries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for summary in summaries:
        missing = [k for k in KEYS if k not in summary]
        if missing:
            raise ValueError(
                f"a {side} summary has no {', '.join(missing)}: run it again with this version"
            )
        if summary["suite"] in out:
            raise ValueError(f"two {side} runs of {summary['suite']}")
        out[summary["suite"]] = summary
    if len({s["system"] for s in out.values()}) != 1:
        raise ValueError(f"the {side} runs must all be of one system")
    # A system that takes its model from the environment must have taken the same one.
    if len({s.get("environment", {}).get("model") for s in out.values()}) != 1:
        raise ValueError(f"the {side} runs must all be of one model")
    return out


def _quality(summary: dict[str, Any]) -> float | None:
    # The review table's headline is pooled over cells rather than averaged over rows.
    if summary["suite"] == "review-table-e2e":
        return summary["report"].get("cell_accuracy")
    return summary["failed_as_zero"]


def _citations(summary: dict[str, Any]) -> float | None:
    """The share of quotes that are really in the document."""
    if "valid_citation_rate" in summary["report"]:
        return summary["report"]["valid_citation_rate"]
    return summary["metrics_failed_excluded"].get("valid_quote_rate")


def _cost(summary: dict[str, Any]) -> float | None:
    """What answering cost. Judging is left out; unless every task is priced, it is unknown."""
    agent = summary["cost"]["by_stage"].get("agent")
    if not agent or agent["missing_cost_count"] or agent["records"] < summary["selected_tasks"]:
        return None
    return agent["known_cost_usd"]


def _suite(
    name: str, candidate: dict[str, Any] | None, baseline: dict[str, Any] | None
) -> dict[str, Any]:
    if candidate is None or baseline is None:
        sides = (("candidate", candidate), ("baseline", baseline))
        reasons = [f"no {side} run" for side, run in sides if run is None]
        return {"suite": name, "passes": False, "reasons": reasons}

    reasons = []
    data = ("dataset_fingerprint", "suite_instructions_sha256")
    if any(candidate[k] != baseline[k] for k in data):
        reasons.append("the runs used different data or instructions")
    if candidate["task_set"] != baseline["task_set"]:
        reasons.append("the runs took different tasks")
    n = min(candidate["selected_tasks"], baseline["selected_tasks"])
    if n < MIN_TASKS:
        reasons.append(f"only {n} tasks; at least {MIN_TASKS} are needed")
    for side, run in (("candidate", candidate), ("baseline", baseline)):
        if run["total_failed"]:
            reasons.append(f"{run['total_failed']} {side} task(s) without a result")

    quality = {"candidate": _quality(candidate), "baseline": _quality(baseline)}
    if None in quality.values() or quality["candidate"] < quality["baseline"]:
        reasons.append("quality is below the baseline, or cannot be read")

    citations = {"candidate": _citations(candidate), "baseline": _citations(baseline)}
    if citations["baseline"] is not None and (
        citations["candidate"] is None or citations["candidate"] < citations["baseline"]
    ):
        reasons.append("the valid citation rate is below the baseline")

    spent = {"candidate": _cost(candidate), "baseline": _cost(baseline)}
    ratio = None
    for side, usd in spent.items():
        if usd is None:
            reasons.append(f"{side} cost is unknown")
        elif usd <= 0:
            # A zero is a local or free model's list price, not what it costs to run.
            reasons.append(f"{side} cost is zero, which is no price to compare")
    if all(usd is not None and usd > 0 for usd in spent.values()):
        ratio = spent["candidate"] / spent["baseline"]
        if ratio > MAX_COST_RATIO + 1e-9:
            reasons.append("cost is more than a tenth of the baseline's")

    return {
        "suite": name,
        "passes": not reasons,
        "reasons": reasons,
        "n": n,
        "quality": quality,
        "valid_citation_rate": citations,
        "cost": {
            "candidate_usd": spent["candidate"],
            "baseline_usd": spent["baseline"],
            "ratio": None if ratio is None else round(ratio, 4),
        },
    }


def compare(candidate: list[dict[str, Any]], baseline: list[dict[str, Any]]) -> dict[str, Any]:
    """The verdict. Raises ValueError when the two sides cannot be told apart or read."""
    ours, theirs = _by_suite("candidate", candidate), _by_suite("baseline", baseline)
    names = [next(iter(side.values()))["system"] for side in (ours, theirs)]
    if names[0] == names[1]:
        raise ValueError("a system cannot be compared with itself")
    suites = [_suite(name, ours.get(name), theirs.get(name)) for name in REQUIRED]
    return {
        "adopt": all(s["passes"] for s in suites),
        "candidate": names[0],
        "baseline": names[1],
        "models": {
            side: next(iter(runs.values())).get("environment", {}).get("model")
            for side, runs in (("candidate", ours), ("baseline", theirs))
        },
        "rules": {"min_tasks": MIN_TASKS, "max_cost_ratio": MAX_COST_RATIO},
        "suites": suites,
        "note": (
            "Nothing in the product changes on a pass. Check that the baseline is a frontier "
            "system and that the candidate's declared price is honest: neither can be checked here."
        ),
    }
