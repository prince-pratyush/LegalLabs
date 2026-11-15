import hashlib
import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

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
# The gateway configures a provider only when its setting is present (gatewayOptionsFromEnv).
GATEWAY_KEYS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_GENERATIVE_AI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "ollama": "OLLAMA_BASE_URL",
}
# run.ts exits with this when a model other than the pinned one answered.
EXIT_WRONG_MODEL = 3

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


def engine_hash(root: Path = REPO / "packages") -> str:
    """Same as engineHash in node/run.ts: built engine, starter playbooks and the runner."""
    sets = [
        (root / "review" / "dist", lambda n: n.endswith(".js")),
        (root / "contracts" / "dist", lambda n: n.endswith(".js")),
        (root / "docx" / "dist", lambda n: n.endswith(".js")),
        (root / "contracts" / "playbooks" / "starters", lambda n: n.endswith(".json")),
        (root / "eval" / "node", lambda n: n.endswith(".ts") and not n.endswith(".test.ts")),
    ]
    lines = []
    for folder, keep in sets:
        for f in folder.rglob("*") if folder.exists() else []:
            if f.is_file() and keep(f.name):
                digest = hashlib.sha256(f.read_bytes()).hexdigest()
                lines.append(f"{f.relative_to(root).as_posix()}\0{digest}")
    return hashlib.sha256("\n".join(sorted(lines)).encode()).hexdigest()


def git_state() -> dict[str, Any]:
    def git(*args: str) -> str | None:
        try:
            out = subprocess.run(
                ["git", "-C", str(REPO), *args], capture_output=True, text=True, timeout=30
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        return out.stdout.strip() if out.returncode == 0 else None

    status = git("status", "--porcelain", "--untracked-files=no")
    return {
        "git_sha": git("rev-parse", "HEAD"),
        "git_dirty": bool(status) if status is not None else None,
    }


def ollama_facts(model: str) -> dict[str, Any]:
    base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
    facts: dict[str, Any] = {"ollama_version": None, "ollama_digest": None}
    try:
        facts["ollama_version"] = httpx.get(f"{base}/api/version", timeout=10).json()["version"]
        tags = httpx.get(f"{base}/api/tags", timeout=10).json()["models"]
        facts["ollama_digest"] = next((m["digest"] for m in tags if m["name"] == model), None)
    except (httpx.HTTPError, KeyError, ValueError):
        pass
    return facts


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

    def required_key(self) -> str | None:
        if self.client == "gateway":
            return GATEWAY_KEYS.get(str(self.model or "anthropic/").split("/")[0])
        return KEYS.get(self.client)

    def prepare(self, corpus: list) -> None:
        if self._run is _exec:
            check_node(self.node)
        key = self.required_key()
        if key and not os.environ.get(key):
            raise NonRetryableError(f"{key} is not set")

    def fingerprint(self) -> str:
        # In the config hash, so a rebuilt engine or a changed runner never reuses old results.
        return engine_hash()

    def environment(self) -> dict[str, Any]:
        env: dict[str, Any] = git_state() | {"engine_sha256": engine_hash()}
        try:
            env["node"] = subprocess.run(
                [self.node, "--version"], capture_output=True, text=True, timeout=30
            ).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            env["node"] = None
        if self.client == "ollama":
            env |= ollama_facts(str(self.model)) | {"ollama_seed": self.params.get("seed", 0)}
        return env

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
            ("--seed", "seed"),
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
        if code == EXIT_WRONG_MODEL:
            raise NonRetryableError(
                f"a model other than {self.model} answered; see {agent / 'run.log'}"
            )
        if code != 0 or not out.exists():
            raise HarnessError(f"review exited with code {code}; see {agent / 'run.log'}")
        text = out.read_text()
        data = json.loads(text)
        usage = data["outcome"]["usage"]
        # Priced as the model that answered; run.ts has already checked it is the pinned one.
        answered = data.get("answered_models") or usage.get("models") or [data.get("model", "")]
        return HarnessResult(
            answer=text,
            provider=self.client,
            model=",".join(answered),
            cost=self.cost(answered[0] if len(answered) == 1 else "", usage),
        )

    def cost(self, model: str, usage: dict[str, Any]) -> Cost:
        tokens_in, tokens_out = int(usage["input_tokens"]), int(usage["output_tokens"])
        if self.client in FREE_CLIENTS:
            return Cost(0.0, True, tokens_in, tokens_out)
        # Gateway ids are "provider/model"; every paid run is priced from one table here.
        return price(model.split("/")[-1], tokens_in, tokens_out)
