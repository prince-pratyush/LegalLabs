from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1


@dataclass(frozen=True)
class Document:
    name: str
    text: str


@dataclass(frozen=True)
class TaskDatum:
    id: str
    problem: str
    answer: Any
    metadata: dict[str, Any] = field(default_factory=dict)
    # Text the system reads for this task, e.g. one contract.
    context: str | None = None


@dataclass(frozen=True)
class Hit:
    doc: str
    page: int | None = None
    char_from: int | None = None
    char_to: int | None = None
    text: str = ""


@dataclass(frozen=True)
class HarnessRequest:
    task: TaskDatum
    suite: str
    instructions: str
    attempt_dir: Path
    run_dir: Path
    # Set for retrieval suites: how many hits to return.
    top_k: int | None = None
    # Set for answer suites: the JSON shape the answer must take.
    output_schema: dict[str, Any] | None = None


@dataclass(frozen=True)
class Cost:
    usd: float | None
    cost_known: bool
    input_tokens: int = 0
    output_tokens: int = 0

    def to_json(self) -> dict[str, Any]:
        return {
            "usd": self.usd,
            "cost_known": self.cost_known,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
        }

    @staticmethod
    def free() -> Cost:
        return Cost(usd=0.0, cost_known=True)

    def __add__(self, other: Cost) -> Cost:
        known = self.cost_known and other.cost_known
        return Cost(
            usd=(self.usd or 0.0) + (other.usd or 0.0) if known else None,
            cost_known=known,
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
        )


@dataclass(frozen=True)
class HarnessResult:
    answer: str | None = None
    hits: list[Hit] = field(default_factory=list)
    provider: str = ""
    model: str = ""
    cost: Cost | None = None


@dataclass(frozen=True)
class GraderResult:
    score: float
    metrics: dict[str, float] = field(default_factory=dict)
    grade_text: str = ""
    cost: Cost | None = None


class HarnessError(Exception):
    """Worth another attempt."""


class NonRetryableError(Exception):
    """Another attempt would fail the same way."""


def raise_for_status(status: int, what: str) -> None:
    """Rate limits and server errors may pass; other client errors will repeat."""
    if status == 429 or status >= 500:
        raise HarnessError(f"{what} returned {status}")
    if status >= 400:
        raise NonRetryableError(f"{what} returned {status}")
