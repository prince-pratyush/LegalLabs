import hashlib
import json
import re
import tomllib
from pathlib import Path
from typing import Any

from .schemas import SCHEMA_VERSION

DEFAULT_SYSTEMS = Path(__file__).resolve().parent.parent / "systems.toml"


def load_config(path: Path = DEFAULT_SYSTEMS) -> dict[str, Any]:
    with path.open("rb") as f:
        data = tomllib.load(f)
    for name, system in data.get("systems", {}).items():
        if "harness" not in system:
            raise ValueError(f"system {name} has no harness")
    return data


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "x"


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def make_manifest(
    system_name: str, system: dict[str, Any], suite: Any, suffix: str = ""
) -> dict[str, Any]:
    """Anything that changes a score goes in the hash, so old results can't be reused."""
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "system": system_name,
        "system_config": system,
        "suite": suite.name,
        "suite_instructions_sha256": sha256(suite.instructions),
        "dataset_fingerprint": suite.dataset_fingerprint,
        "output_schema": suite.output_schema,
        # The judges grade the answers, so a new judge model means a new run.
        "judges": getattr(suite, "judges", None),
        "run_suffix": suffix,
    }
    manifest["config_hash"] = sha256(json.dumps(manifest, sort_keys=True))[:12]
    return manifest


def run_dir_for(runs_root: Path, manifest: dict[str, Any]) -> Path:
    parts = [slug(manifest["system"]), slug(manifest["suite"])]
    if manifest["run_suffix"]:
        parts.append(slug(manifest["run_suffix"]))
    parts.append(manifest["config_hash"])
    return runs_root / "-".join(parts)
