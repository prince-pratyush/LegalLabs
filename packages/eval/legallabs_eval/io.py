import json
import os
from pathlib import Path
from typing import Any


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write then rename, so a killed run never leaves half a file that resume trusts.
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def append_jsonl(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(data, sort_keys=True) + "\n")
