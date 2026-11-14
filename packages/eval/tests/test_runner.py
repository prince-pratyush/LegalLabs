from pathlib import Path

import pytest

from legallabs_eval.harnesses.base import Harness
from legallabs_eval.io import append_jsonl, read_json, write_json
from legallabs_eval.runner import Runner
from legallabs_eval.schemas import (
    Cost,
    GraderResult,
    HarnessError,
    HarnessRequest,
    HarnessResult,
    NonRetryableError,
    TaskDatum,
)
from legallabs_eval.suites.base import Grader, Suite


class EchoGrader(Grader):
    def __init__(self) -> None:
        self.calls = 0

    def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
        self.calls += 1
        return GraderResult(score=1.0 if result.answer == task.answer else 0.0, metrics={"m": 0.5})


class FakeSuite(Suite):
    name = "fake"
    kind = "answer"
    instructions = "say the answer"
    primary_metric = "accuracy"
    dataset_fingerprint = "v1"

    def __init__(self, n: int = 3) -> None:
        self.n = n
        self.grader = EchoGrader()

    def load_tasks(self, limit: int | None = None) -> list[TaskDatum]:
        tasks = [TaskDatum(id=f"t{i}", problem=f"q{i}", answer=f"a{i}") for i in range(self.n)]
        return tasks[:limit] if limit else tasks

    def make_grader(self, system_vendor) -> Grader:
        return self.grader


class FakeHarness(Harness):
    kinds = frozenset({"answer"})

    def __init__(self, fail: dict[str, Exception] | None = None) -> None:
        super().__init__("fake", {"harness": "fake"})
        self.fail = fail or {}
        self.calls: list[str] = []

    def run(self, request: HarnessRequest) -> HarnessResult:
        self.calls.append(request.task.id)
        err = self.fail.pop(request.task.id, None)
        if err:
            raise err
        return HarnessResult(answer=request.task.answer, cost=Cost(0.01, True))


def runner(tmp_path: Path, harness: Harness, suite: Suite | None = None) -> Runner:
    return Runner(
        "fake", {"harness": "fake"}, harness, suite or FakeSuite(), tmp_path, retry_delay=0
    )


def test_summary_counts_failures_as_zero(tmp_path: Path) -> None:
    harness = FakeHarness(fail={"t1": NonRetryableError("bad request")})
    summary = runner(tmp_path, harness).run()
    assert summary["selected_tasks"] == 3
    assert summary["completed_tasks"] == 2
    assert summary["failed_as_zero"] == pytest.approx(2 / 3, abs=1e-6)
    assert summary["failed_excluded"] == 1.0
    assert summary["cost"]["cost_known"] is True
    assert summary["cost"]["by_stage"]["agent"]["known_cost_usd"] == pytest.approx(0.02)


def test_retryable_error_moves_to_next_attempt(tmp_path: Path) -> None:
    harness = FakeHarness(fail={"t0": HarnessError("timeout")})
    r = runner(tmp_path, harness, FakeSuite(1))
    summary = r.run()
    assert summary["completed_tasks"] == 1
    task_dir = next((r.run_dir / "tasks").iterdir())
    assert read_json(task_dir / "attempts/000001/attempt.json")["status"] == "failed"
    assert read_json(task_dir / "result.json")["attempt_number"] == 2


def test_finished_tasks_are_not_rerun(tmp_path: Path) -> None:
    harness = FakeHarness()
    runner(tmp_path, harness).run()
    again = FakeHarness()
    runner(tmp_path, again).run()
    assert again.calls == []


def test_interrupted_attempt_reuses_agent_result(tmp_path: Path) -> None:
    suite = FakeSuite(1)
    r = runner(tmp_path, FakeHarness(), suite)
    r.run()
    task_dir = next((r.run_dir / "tasks").iterdir())
    # Simulate a crash after the agent stage but before grading finished.
    (task_dir / "result.json").unlink()
    (task_dir / "attempts/000001/grader/result.json").unlink()
    write_json(task_dir / "attempts/000001/attempt.json", {"status": "running"})
    again = FakeHarness()
    summary = runner(tmp_path, again, suite).run()
    assert again.calls == []
    assert suite.grader.calls == 2
    assert summary["completed_tasks"] == 1
    assert read_json(task_dir / "result.json")["attempt_number"] == 1


def test_changed_config_forks_a_new_run_dir(tmp_path: Path) -> None:
    a = runner(tmp_path, FakeHarness())
    suite = FakeSuite()
    suite.dataset_fingerprint = "v2"
    b = runner(tmp_path, FakeHarness(), suite)
    assert a.run_dir != b.run_dir


def test_manifest_mismatch_is_refused(tmp_path: Path) -> None:
    r = runner(tmp_path, FakeHarness())
    write_json(r.run_dir / "run_config.json", {"other": True})
    with pytest.raises(ValueError, match="mismatch"):
        r.run()


def test_unknown_cost_makes_total_unknown(tmp_path: Path) -> None:
    class Unpriced(FakeHarness):
        def run(self, request: HarnessRequest) -> HarnessResult:
            return HarnessResult(answer=request.task.answer, cost=Cost(None, False))

    summary = runner(tmp_path, Unpriced(), FakeSuite(2)).run()
    assert summary["cost"]["total_cost_usd"] is None
    assert summary["cost"]["missing_cost_count"] == 2


def test_metric_is_averaged_only_over_tasks_that_report_it(tmp_path: Path) -> None:
    class Partial(EchoGrader):
        def grade(self, task: TaskDatum, result: HarnessResult, trace_dir: Path) -> GraderResult:
            extra = {"iou": 0.8} if task.id == "t0" else {}
            return GraderResult(score=1.0, metrics=extra)

    suite = FakeSuite()
    suite.grader = Partial()
    summary = runner(tmp_path, FakeHarness(), suite).run()
    assert summary["metrics_failed_excluded"]["iou"] == pytest.approx(0.8)
    assert summary["metric_counts"]["iou"] == 1


def test_unexpected_error_costs_one_attempt_not_the_run(tmp_path: Path) -> None:
    harness = FakeHarness(fail={"t0": KeyError("choices")})
    summary = runner(tmp_path, harness, FakeSuite(2)).run()
    assert summary["completed_tasks"] == 2
    assert harness.calls.count("t0") == 2


def test_redone_stage_starts_with_a_clean_trace(tmp_path: Path) -> None:
    class Tracing(FakeHarness):
        def run(self, request: HarnessRequest) -> HarnessResult:
            append_jsonl(request.attempt_dir / "agent/requests.jsonl", {"q": request.task.id})
            return super().run(request)

    r = runner(tmp_path, Tracing(), FakeSuite(1))
    r.run()
    task_dir = next((r.run_dir / "tasks").iterdir())
    (task_dir / "result.json").unlink()
    (task_dir / "attempts/000001/agent/result.json").unlink()
    write_json(task_dir / "attempts/000001/attempt.json", {"status": "running"})
    runner(tmp_path, Tracing(), FakeSuite(1)).run()
    lines = (task_dir / "attempts/000001/agent/requests.jsonl").read_text().splitlines()
    assert len(lines) == 1
