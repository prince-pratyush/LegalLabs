import re
from pathlib import Path

from legallabs_eval.costs import PRICES

ROUTES = Path(__file__).resolve().parents[2] / "model-gateway" / "src" / "routes.ts"


def gateway_prices() -> dict[str, tuple[float, float]]:
    """Base rates per model from the gateway's route table, read as text."""
    out = {}
    pattern = r'model: "([^"]+)",.*?price: (?:FREE|\{\s*input: ([\d.]+),\s*output: ([\d.]+))'
    for match in re.finditer(pattern, ROUTES.read_text(), re.S):
        model, rate_in, rate_out = match.groups()
        out[model] = (float(rate_in or 0), float(rate_out or 0))
    return out


def test_one_price_table_for_models_both_sides_price():
    gateway = gateway_prices()
    assert "claude-haiku-5-5" in gateway
    shared = sorted(set(gateway) & set(PRICES))
    assert shared
    assert {m: PRICES[m] for m in shared} == {m: gateway[m] for m in shared}
