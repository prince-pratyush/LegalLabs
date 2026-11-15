import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..costs import price
from ..schemas import (
    Cost,
    HarnessError,
    HarnessRequest,
    HarnessResult,
    NonRetryableError,
)
from .base import Harness

NODE_DIR = Path(__file__).resolve().parents[2] / "node"
REPO = NODE_DIR.parents[2]
# Node strips TypeScript types without a flag from 22.18 on.
MIN_NODE = (22, 18)
FREE_CLIENTS = {"fake", "ollama"}
KEYS = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}

# (args, timeout seconds, stderr path) -> exit code; tests swap in a fake.
Exec = Callable[[list[str], float, Path], int]


def node_binary() -> str:
    return os.environ.get("LEGALLABS_NODE") or shutil.which("node") or "node"


def node_version(node: str) -> tuple[int, int]:
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as err:
        raise NonRetryableError(f"cannot run {node}: {err}") from err
    match = re.match(r"v(\d+)\.(\d+)", out.stdout.strip())
    return (int(match[1]), int(match[2])) if match else (0, 0)


def check_node(node: str) -> None:
    if node_version(node) < MIN_NODE:
        raise NonRetryableError(
            f"{node} must be Node {MIN_NODE[0]}.{MIN_NODE[1]} or later; set LEGALLABS_NODE"
        )
    # The runner imports the built workspace packages, not their sources.
    for package in ("contracts", "docx", "review", "model-gateway"):
        if not (REPO / "packages" / package / "dist" / "index.js").exists():
            raise NonRetryableError(
                "workspace packages are not built: run "
                "pnpm install && pnpm --filter '@legallabs/eval^...' build"
            )


def generate_corpus(out: Path, seed: int, count: int, node: str | None = None) -> None:
    """The generator is seeded, so writing the same corpus again gives the same files."""
    node = node or node_binary()
    check_node(node)
    args = [node, str(NODE_DIR / "generate.ts"), "--out", str(out)]
    args += ["--seed", str(seed), "--count", str(count)]
    done = subprocess.run(args, capture_output=True, text=True, timeout=600)
    if done.returncode != 0:
        raise NonRetryableError(f"corpus generation failed: {done.stderr.strip()[-500:]}")


def _exec(args: list[str], timeout: float, stderr: Path) -> int:
    stderr.parent.mkdir(parents=True, exist_ok=True)
    with stderr.open("w") as log:
        try:
            return subprocess.run(args, stdout=log, stderr=log, timeout=timeout).returncode
        except subprocess.TimeoutExpired as err:
            raise HarnessError(f"review ran past {timeout:.0f} s") from err


class PlaybookNodeHarness(Harness):
    """Runs node/run.ts once per contract: readDocx, runReview, then the OOXML checks."""

    kinds = frozenset({"playbook"})

    def __init__(self, system_name: str, system: dict[str, Any], run: Exec | None = None) -> None:
        super().__init__(system_name, system)
        params = system.get("params", {})
        self.client = str(params.get("client", "fake"))
        self.model = params.get("model")
        self.params = params
        self.task_timeout = float(params.get("task_timeout_seconds", 3600))
        self._run = run or _exec
        self.node = node_binary()

    def prepare(self, corpus: list) -> None:
        if self._run is _exec:
            check_node(self.node)
        key = KEYS.get(self.client)
        if key and not os.environ.get(key):
            raise NonRetryableError(f"{key} is not set")

    def _args(self, contract: str, template: str, out: Path) -> list[str]:
        p = self.params
        args = [self.node, str(NODE_DIR / "run.ts"), "--contract", contract]
        args += ["--template", template, "--client", self.client, "--out", str(out)]
        if self.model:
            args += ["--model", str(self.model)]
        for flag, name in (
            ("--parallelism", "parallelism"),
            ("--rule-timeout-ms", "rule_timeout_ms"),
            ("--call-timeout-ms", "call_timeout_ms"),
            ("--num-ctx", "num_ctx"),
        ):
            if name in p:
                args += [flag, str(p[name])]
        return args

    def run(self, request: HarnessRequest) -> HarnessResult:
        meta = request.task.metadata
        agent = request.attempt_dir / "agent"
        out = agent / "outcome.json"
        code = self._run(
            self._args(meta["path"], meta["template"], out), self.task_timeout, agent / "run.log"
        )
        if code != 0 or not out.exists():
            raise HarnessError(f"review exited with code {code}; see {agent / 'run.log'}")
        text = out.read_text()
        data = json.loads(text)
        usage = data["outcome"]["usage"]
        return HarnessResult(
            answer=text,
            provider=self.client,
            model=data.get("model", self.model or ""),
            cost=self.cost(data.get("model", ""), usage),
        )

    def cost(self, model: str, usage: dict[str, Any]) -> Cost:
        tokens_in, tokens_out = int(usage["input_tokens"]), int(usage["output_tokens"])
        if self.client in FREE_CLIENTS:
            return Cost(0.0, True, tokens_in, tokens_out)
        # Gateway ids are "provider/model"; every paid run is priced from one table here.
        return price(model.split("/")[-1], tokens_in, tokens_out)
