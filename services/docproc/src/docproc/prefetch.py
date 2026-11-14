"""Downloads the layout model once so requests never touch the network.

Run: uv run python -m docproc.prefetch  (honours DOCPROC_MODELS_DIR)
"""

import os

os.environ["HF_HUB_OFFLINE"] = "0"
os.environ["TRANSFORMERS_OFFLINE"] = "0"

from docling.utils.model_downloader import download_models  # noqa: E402

from docproc.models import models_dir  # noqa: E402


def main() -> None:
    target = models_dir()
    download_models(
        output_dir=target,
        with_layout=True,
        with_tableformer=False,
        with_code_formula=False,
        with_picture_classifier=False,
        with_rapidocr=False,
        with_easyocr=False,
    )
    print(f"models ready in {target}")


if __name__ == "__main__":
    main()
