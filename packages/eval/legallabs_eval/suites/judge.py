from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import slug
from ..models import ModelClient, Send, parse_json
from ..schemas import Cost, NonRetryableError

VERDICT = {
    "type": "object",
    "properties": {"pass": {"type": "boolean"}, "reasoning": {"type": "string"}},
    "required": ["pass", "reasoning"],
    "additionalProperties": False,
}

SYSTEM = (
    "You grade one criterion for a legal AI evaluation. Judge only the criterion given. "
    "Answer pass true only if the criterion is fully met."
)


@dataclass(frozen=True)
class Verdict:
    score: float  # share of judges that passed it
    reasoning: str
    cost: Cost


class Judge:
    """Judges from other vendors than the system, since models favour their own vendor's output."""

    def __init__(
        self,
        judges: dict[str, dict[str, Any]],
        system_vendor: str,
        count: int = 2,
        send: Send | None = None,
    ) -> None:
        eligible = [(n, j) for n, j in judges.items() if j["vendor"] != system_vendor]
        if not eligible:
            raise NonRetryableError(f"no judge from a vendor other than {system_vendor!r}")
        self.clients = [
            (name, ModelClient(j["vendor"], j["model"], 1024, send)) for name, j in eligible[:count]
        ]

    def preflight(self) -> None:
        for _, client in self.clients:
            client.preflight()

    def check(self, criterion: str, material: str, trace_dir: Path) -> Verdict:
        """One call per judge for this one criterion; a malformed verdict counts as a fail."""
        prompt = f"Criterion: {criterion}\n\n{material}"
        passed, notes, cost = 0, [], Cost.free()
        for name, client in self.clients:
            text, spent = client.complete(
                SYSTEM, prompt, trace_dir / f"judge-{slug(name)}", VERDICT
            )
            cost = cost + spent
            verdict = parse_json(text)
            ok = bool(verdict and verdict.get("pass") is True)
            passed += ok
            notes.append(f"{name}: {(verdict or {}).get('reasoning', 'invalid verdict')}")
        return Verdict(passed / len(self.clients), "\n".join(notes), cost)
