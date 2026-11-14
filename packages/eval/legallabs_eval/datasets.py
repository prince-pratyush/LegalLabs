import hashlib
import json
import os
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from .schemas import NonRetryableError


@dataclass(frozen=True)
class Pinned:
    """An upstream file fixed by URL and hash; it is downloaded, never committed."""

    name: str
    url: str
    sha256: str
    member: str  # the JSON file inside the zip
    licence: str

    @property
    def fingerprint(self) -> str:
        return f"{self.name}:{self.sha256[:16]}:{self.member}"


def cache_dir() -> Path:
    return Path(os.environ.get("LEGALLABS_EVAL_CACHE", Path.home() / ".cache" / "legallabs-eval"))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(pinned: Pinned) -> Path:
    path = cache_dir() / f"{pinned.name}-{pinned.sha256[:16]}.zip"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        with httpx.stream("GET", pinned.url, follow_redirects=True, timeout=300) as response:
            response.raise_for_status()
            with tmp.open("wb") as f:
                for block in response.iter_bytes():
                    f.write(block)
        tmp.rename(path)
    # Checked every time, so a swapped upstream file can't silently change scores.
    if _sha256(path) != pinned.sha256:
        path.unlink()
        raise NonRetryableError(f"{pinned.name} does not match its pinned hash")
    return path


def load_json(pinned: Pinned, local: Path | None = None) -> Any:
    """Reads the pinned member, or a local file in the same format (used by tests)."""
    if local is not None:
        return json.loads(local.read_text())
    with zipfile.ZipFile(fetch(pinned)) as z:
        return json.loads(z.read(pinned.member))
