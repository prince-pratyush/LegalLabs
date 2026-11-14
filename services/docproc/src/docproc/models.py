import os
from pathlib import Path


def models_dir() -> Path:
    default = Path.home() / ".cache" / "docproc" / "models"
    return Path(os.environ.get("DOCPROC_MODELS_DIR", default))
