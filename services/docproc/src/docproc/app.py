import os
import threading

from fastapi import FastAPI, File, Form, UploadFile

from docproc.detect import MAX_FILE_BYTES
from docproc.runner import parse_isolated

app = FastAPI(title="docproc", docs_url=None, redoc_url=None, openapi_url=None)

# Each parse is a process holding a model; cap them to fit small hosts.
_slots = threading.BoundedSemaphore(int(os.environ.get("DOCPROC_CONCURRENCY", "2")))


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/parse")
def parse_file(file: UploadFile = File(...), name: str = Form("")) -> dict:
    data = file.file.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        return {"ok": False, "reason": "FILE_TOO_LARGE"}
    with _slots:
        return parse_isolated(data, name or file.filename or "")
