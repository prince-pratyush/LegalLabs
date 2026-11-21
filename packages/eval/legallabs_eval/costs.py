from pathlib import Path
from typing import Any

from .io import read_json, write_json
from .schemas import Cost

# USD per million tokens. A model missing here is priced as unknown, never as free.
# Claude rates are Anthropic's list prices, and must match the gateway's route table
# (packages/model-gateway/src/routes.ts); test_costs.py checks they agree.
PRICES: dict[str, tuple[float, float]] = {
    "claude-sonnet-5-5": (2.0, 10.0),
    # Prompts up to 100K tokens; longer ones cost $0.50/$2.50, which no eval prompt reaches.
    "claude-haiku-5-5": (0.10, 0.50),
    "gpt-5.5": (1.25, 10.0),
    "gpt-5.5-mini": (0.25, 2.0),
    "gemini-2.5-pro": (1.25, 10.0),
    # Runs on this machine through Ollama.
    "qwen3:4b-instruct": (0.0, 0.0),
}


def price(model: str, input_tokens: int, output_tokens: int) -> Cost:
    rates = PRICES.get(model)
    if rates is None:
        return Cost(None, False, input_tokens, output_tokens)
    usd = (input_tokens * rates[0] + output_tokens * rates[1]) / 1_000_000
    return Cost(usd, True, input_tokens, output_tokens)


def record_cost(stage_dir: Path, cost: Cost) -> None:
    write_json(stage_dir / "cost.json", cost.to_json())


def ledger(run_dir: Path) -> dict[str, Any]:
    """Totals each cost.json once, by stage; one unknown makes the total unknown."""
    stages: dict[str, dict[str, Any]] = {}
    for path in sorted(run_dir.glob("tasks/*/attempts/*/*/cost.json")):
        record = read_json(path)
        stage = stages.setdefault(
            path.parent.name, {"known_cost_usd": 0.0, "missing_cost_count": 0, "records": 0}
        )
        stage["records"] += 1
        if record["cost_known"]:
            stage["known_cost_usd"] += record["usd"]
        else:
            stage["missing_cost_count"] += 1
    known = sum(s["known_cost_usd"] for s in stages.values())
    missing = sum(s["missing_cost_count"] for s in stages.values())
    return {
        "total_cost_usd": None if missing else round(known, 6),
        "known_cost_usd": round(known, 6),
        "missing_cost_count": missing,
        "cost_known": missing == 0,
        "by_stage": stages,
    }
