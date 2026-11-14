import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import make_manifest, run_dir_for, slug
from .costs import ledger, record_cost
from .harnesses.base import Harness
from .io import read_json, write_json
from .schemas import (
    Cost,
    GraderResult,
    HarnessRequest,
    HarnessResult,
    Hit,
    NonRetryableError,
    TaskDatum,
)
from .suites.base import Grader, Suite

MAX_TASK_ATTEMPTS = 3


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clear_traces(stage_dir: Path) -> None:
    """A redone stage starts clean, so its trace shows one call, not two."""
    for path in stage_dir.rglob("*.jsonl"):
        path.unlink()


def _result_json(result: HarnessResult) -> dict[str, Any]:
    return {
        "answer": result.answer,
        "hits": [asdict(h) for h in result.hits],
        "provider": result.provider,
        "model": result.model,
    }


def _result_from(data: dict[str, Any]) -> HarnessResult:
    return HarnessResult(
        answer=data["answer"],
        hits=[Hit(**h) for h in data["hits"]],
        provider=data["provider"],
        model=data["model"],
    )


class Runner:
    def __init__(
        self,
        system_name: str,
        system: dict[str, Any],
        harness: Harness,
        suite: Suite,
        runs_root: Path,
        suffix: str = "",
        concurrency: int = 4,
        retry_delay: float = 5.0,
    ) -> None:
        if suite.kind not in harness.kinds:
            raise NonRetryableError(f"{system_name} cannot run {suite.kind} suites")
        self.harness = harness
        self.suite = suite
        self.concurrency = concurrency
        self.retry_delay = retry_delay
        self.manifest = make_manifest(system_name, system, suite, suffix)
        self.run_dir = run_dir_for(runs_root, self.manifest)

    def run(self, limit: int | None = None) -> dict[str, Any]:
        config_path = self.run_dir / "run_config.json"
        if config_path.exists() and read_json(config_path) != self.manifest:
            raise ValueError("Run manifest mismatch")
        write_json(config_path, self.manifest)

        tasks = self.suite.load_tasks(limit)
        grader = self.suite.make_grader(self.harness.vendors)
        self.harness.prepare(self.suite.corpus())
        try:
            with ThreadPoolExecutor(self.concurrency) as pool:
                list(pool.map(lambda it: self._task(it[0], it[1], grader), enumerate(tasks, 1)))
        finally:
            self.harness.close()
        summary = self._summary(tasks)
        write_json(self.run_dir / "summary.json", summary)
        return summary

    def _task_dir(self, index: int, task: TaskDatum) -> Path:
        return self.run_dir / "tasks" / f"{index:06d}-{slug(task.id)}"

    def _task(self, index: int, task: TaskDatum, grader: Grader) -> None:
        task_dir = self._task_dir(index, task)
        # A finished task is never redone.
        if (task_dir / "result.json").exists():
            return
        write_json(task_dir / "task.json", {"id": task.id, "problem": task.problem})
        while True:
            number = self._next_attempt(task_dir)
            if number > MAX_TASK_ATTEMPTS:
                return
            attempt_dir = task_dir / "attempts" / f"{number:06d}"
            write_json(attempt_dir / "attempt.json", {"status": "running", "started_at": _now()})
            try:
                graded = self._attempt(task, attempt_dir, grader)
            except NonRetryableError as err:
                self._fail(task_dir, attempt_dir, err)
                return
            # Anything else, even a malformed reply, costs one attempt rather than the whole run.
            except Exception as err:
                self._fail(task_dir, attempt_dir, err)
                time.sleep(self.retry_delay)
                continue
            write_json(attempt_dir / "attempt.json", {"status": "complete", "ended_at": _now()})
            write_json(
                task_dir / "result.json",
                {
                    "task_id": task.id,
                    "score": graded.score,
                    "metrics": graded.metrics,
                    "attempt_number": number,
                },
            )
            (task_dir / "error.json").unlink(missing_ok=True)
            return

    def _next_attempt(self, task_dir: Path) -> int:
        attempts = sorted((task_dir / "attempts").glob("[0-9]*"))
        if not attempts:
            return 1
        last = attempts[-1]
        status = (
            read_json(last / "attempt.json")["status"]
            if (last / "attempt.json").exists()
            else "running"
        )
        # An interrupted attempt is reused; a failed one moves on.
        if status == "failed":
            if (task_dir / "error.json").exists() and read_json(task_dir / "error.json").get(
                "retryable"
            ) is False:
                return MAX_TASK_ATTEMPTS + 1
            return int(last.name) + 1
        return int(last.name)

    def _attempt(self, task: TaskDatum, attempt_dir: Path, grader: Grader) -> GraderResult:
        # A stage that already finished is read back, not paid for again.
        agent_path = attempt_dir / "agent" / "result.json"
        if agent_path.exists():
            result = _result_from(read_json(agent_path))
        else:
            request = HarnessRequest(
                task=task,
                suite=self.suite.name,
                instructions=self.suite.instructions,
                attempt_dir=attempt_dir,
                run_dir=self.run_dir,
                top_k=self.suite.top_k,
                output_schema=self.suite.output_schema,
            )
            _clear_traces(attempt_dir / "agent")
            result = self.harness.run(request)
            record_cost(attempt_dir / "agent", result.cost or Cost.free())
            write_json(agent_path, _result_json(result))

        grader_path = attempt_dir / "grader" / "result.json"
        if grader_path.exists():
            data = read_json(grader_path)
            return GraderResult(data["score"], data["metrics"], data["grade_text"])
        _clear_traces(attempt_dir / "grader")
        graded = grader.grade(task, result, attempt_dir / "grader")
        record_cost(attempt_dir / "grader", graded.cost or Cost.free())
        write_json(
            grader_path,
            {"score": graded.score, "metrics": graded.metrics, "grade_text": graded.grade_text},
        )
        return graded

    def _fail(self, task_dir: Path, attempt_dir: Path, err: Exception) -> None:
        error = {
            "type": type(err).__name__,
            "message": str(err),
            "retryable": not isinstance(err, NonRetryableError),
            "at": _now(),
        }
        write_json(attempt_dir / "error.json", error)
        write_json(attempt_dir / "attempt.json", {"status": "failed", "ended_at": _now()})
        write_json(task_dir / "error.json", error)

    def _summary(self, tasks: list[TaskDatum]) -> dict[str, Any]:
        results = []
        for index, task in enumerate(tasks, 1):
            path = self._task_dir(index, task) / "result.json"
            if path.exists():
                results.append(read_json(path))
        selected = len(tasks)
        completed = len(results)
        total = sum(r["score"] for r in results)
        names = sorted({k for r in results for k in r["metrics"]})
        # Averaged over the tasks that report it: IoU exists only when the label is right.
        metrics = {}
        counts = {}
        for n in names:
            values = [r["metrics"][n] for r in results if n in r["metrics"]]
            metrics[n] = sum(values) / len(values)
            counts[n] = len(values)
        return {
            "system": self.manifest["system"],
            "suite": self.suite.name,
            "config_hash": self.manifest["config_hash"],
            "run_dir": str(self.run_dir),
            "primary_metric": self.suite.primary_metric,
            "selected_tasks": selected,
            "completed_tasks": completed,
            "total_failed": selected - completed,
            # The headline: a task that failed counts as zero, so failures can't flatter the score.
            "failed_as_zero": round(total / selected, 6) if selected else 0.0,
            "failed_excluded": round(total / completed, 6) if completed else 0.0,
            "metrics_failed_excluded": {k: round(v, 6) for k, v in metrics.items()},
            "metric_counts": counts,
            "report": self.suite.report(results, selected),
            "cost": ledger(self.run_dir),
            "finished_at": _now(),
        }
