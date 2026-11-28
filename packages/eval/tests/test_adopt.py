"""The adoption gates of MDL-006, on summaries written by hand."""

import copy
import json
from pathlib import Path

import pytest

from legallabs_eval.adopt import MIN_TASKS, REQUIRED, compare
from legallabs_eval.cli import main


def summary(system: str, suite: str, score: float = 0.8, usd: float = 10.0) -> dict:
    table = suite == "review-table-e2e"
    return {
        "system": system,
        "suite": suite,
        "dataset_fingerprint": f"{suite}:data",
        "suite_instructions_sha256": "i",
        "task_set": "t" * 64,
        "selected_tasks": MIN_TASKS,
        "completed_tasks": MIN_TASKS,
        "total_failed": 0,
        "failed_as_zero": score,
        "metrics_failed_excluded": {} if table else {"valid_quote_rate": 0.97},
        "report": {"cell_accuracy": score, "valid_citation_rate": 0.97} if table else {},
        "cost": {
            "by_stage": {
                "agent": {"known_cost_usd": usd, "missing_cost_count": 0, "records": MIN_TASKS},
                # Judging costs the same whatever answers, so it isn't compared.
                "grader": {"known_cost_usd": 99.0, "missing_cost_count": 1, "records": 1},
            }
        },
    }


def runs(score: float = 0.8) -> tuple[list[dict], list[dict]]:
    candidate = [summary("ros-ai", s, score, usd=1.0) for s in REQUIRED]
    baseline = [summary("claude-cell", s, 0.8, usd=10.0) for s in REQUIRED]
    return candidate, baseline


def reasons(result: dict) -> list[str]:
    return [r for s in result["suites"] for r in s["reasons"]]


def test_every_extraction_suite_and_the_review_table_are_required() -> None:
    assert REQUIRED == ("extract-cuad", "extract-maud", "review-table-e2e")


def test_matching_quality_at_a_tenth_of_the_cost_passes() -> None:
    result = compare(*runs())
    assert result["adopt"] is True
    assert reasons(result) == []
    assert [s["n"] for s in result["suites"]] == [MIN_TASKS] * 3
    assert result["suites"][0]["cost"] == {
        "candidate_usd": 1.0,
        "baseline_usd": 10.0,
        "ratio": 0.1,
    }
    assert "nothing" in result["note"].lower()


@pytest.mark.parametrize("missing", REQUIRED)
@pytest.mark.parametrize("side", [0, 1])
def test_a_missing_suite_fails(missing: str, side: int) -> None:
    both = list(runs())
    both[side] = [s for s in both[side] if s["suite"] != missing]
    result = compare(*both)
    assert result["adopt"] is False
    assert any("no " in r and "run" in r for r in reasons(result))


def change(side: int, suite: str, edit) -> dict:  # noqa: ANN001
    both = [copy.deepcopy(s) for s in runs()]
    edit(next(s for s in both[side] if s["suite"] == suite))
    return compare(*both)


def agent(**over: object):  # noqa: ANN201
    return lambda s: s["cost"]["by_stage"]["agent"].update(over)


def put(*path: str, value: object):  # noqa: ANN201
    def edit(s: dict) -> None:
        for key in path[:-1]:
            s = s[key]
        s[path[-1]] = value

    return edit


@pytest.mark.parametrize(
    ("side", "suite", "edit", "reason"),
    [
        (0, "extract-cuad", put("failed_as_zero", value=0.799), "quality"),
        (0, "review-table-e2e", put("report", "cell_accuracy", value=0.79), "quality"),
        (0, "review-table-e2e", put("report", "cell_accuracy", value=None), "quality"),
        (0, "extract-maud", put("metrics_failed_excluded", value={}), "citation"),
        (0, "review-table-e2e", put("report", "valid_citation_rate", value=0.9), "citation"),
        (0, "extract-cuad", agent(known_cost_usd=1.01), "tenth"),
        (0, "extract-cuad", agent(missing_cost_count=1), "candidate cost is unknown"),
        (1, "extract-cuad", agent(missing_cost_count=1), "baseline cost is unknown"),
        (0, "extract-cuad", put("cost", "by_stage", value={}), "candidate cost is unknown"),
        (0, "extract-cuad", agent(records=MIN_TASKS - 1), "candidate cost is unknown"),
        (0, "extract-cuad", agent(known_cost_usd=0.0), "no price"),
        (1, "extract-cuad", agent(known_cost_usd=0.0), "no price"),
        (0, "extract-cuad", put("total_failed", value=1), "without a result"),
        (1, "extract-cuad", put("total_failed", value=1), "without a result"),
        (0, "extract-cuad", put("task_set", value="u" * 64), "different tasks"),
        (0, "extract-cuad", put("dataset_fingerprint", value="other"), "different data"),
        (0, "extract-cuad", put("suite_instructions_sha256", value="j"), "different data"),
    ],
)
def test_anything_short_fails(side: int, suite: str, edit: object, reason: str) -> None:
    result = change(side, suite, edit)
    assert result["adopt"] is False
    assert len(reasons(result)) >= 1
    assert reason in " ".join(reasons(result))


def test_a_small_sample_cannot_pass() -> None:
    candidate, baseline = runs()
    for s in [*candidate, *baseline]:
        s["selected_tasks"] = s["completed_tasks"] = MIN_TASKS - 1
        s["cost"]["by_stage"]["agent"]["records"] = MIN_TASKS - 1
    result = compare(candidate, baseline)
    assert result["adopt"] is False
    assert all("at least 100" in " ".join(s["reasons"]) for s in result["suites"])


def test_sides_that_cannot_be_compared_are_refused() -> None:
    candidate, baseline = runs()
    with pytest.raises(ValueError, match="two candidate runs"):
        compare([*candidate, candidate[0]], baseline)
    mixed = [*baseline[:2], summary("gpt-plain", "review-table-e2e")]
    with pytest.raises(ValueError, match="one system"):
        compare(candidate, mixed)
    with pytest.raises(ValueError, match="itself"):
        compare(candidate, candidate)
    two = copy.deepcopy(candidate)
    two[0]["environment"] = {"model": "another"}
    with pytest.raises(ValueError, match="one model"):
        compare(two, baseline)
    old = copy.deepcopy(candidate)
    del old[0]["task_set"]
    with pytest.raises(ValueError, match="task_set"):
        compare(old, baseline)


def write(tmp_path: Path, side: str, summaries: list[dict]) -> list[str]:
    paths = []
    for s in summaries:
        run_dir = tmp_path / side / s["suite"]
        run_dir.mkdir(parents=True)
        (run_dir / "summary.json").write_text(json.dumps(s))
        paths.append(str(run_dir))
    return paths


def test_the_command_exits_by_the_verdict(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    candidate, baseline = runs()
    good = write(tmp_path, "c", candidate)
    base = write(tmp_path, "b", baseline)
    out = tmp_path / "verdict.json"
    assert main(["adopt", "--candidate", *good, "--baseline", *base, "--out", str(out)]) == 0
    assert json.loads(out.read_text())["adopt"] is True
    capsys.readouterr()

    # A summary file works as well as its run directory.
    files = [f"{p}/summary.json" for p in good[:2]]
    assert main(["adopt", "--candidate", *files, "--baseline", *base]) == 1
    assert json.loads(capsys.readouterr().out)["adopt"] is False

    assert main(["adopt", "--candidate", str(tmp_path / "none"), "--baseline", *base]) == 2
