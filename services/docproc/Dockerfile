FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ocrmypdf tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.10.4 /uv /usr/local/bin/uv

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    DOCPROC_MODELS_DIR=/opt/docproc/models

WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

# Models are baked in so the container never downloads at request time.
RUN uv run --no-sync python -m docproc.prefetch

RUN useradd --system --home /app docproc
USER docproc
EXPOSE 8000
CMD ["uv", "run", "--no-sync", "uvicorn", "docproc.app:app", "--host", "0.0.0.0", "--port", "8000"]
