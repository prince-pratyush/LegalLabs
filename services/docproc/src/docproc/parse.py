import importlib
import logging

from docproc.detect import MIMES, detect
from docproc.page import ParseFailure

log = logging.getLogger("docproc")

_PARSERS = {
    "pdf": "docproc.formats.pdf:parse_pdf",
    "docx": "docproc.formats.docx:parse_docx",
    "xlsx": "docproc.formats.xlsx:parse_xlsx",
    "eml": "docproc.formats.emails:parse_eml",
    "msg": "docproc.formats.msg:parse_msg",
    "pst": "docproc.formats.pst:parse_pst",
}


def parse(data: bytes, name: str) -> dict:
    """Never raises; failures come back as {"ok": false, "reason": ...}."""
    try:
        kind = detect(data, name)
        module, func = _PARSERS[kind].split(":")
        # Imported lazily so light formats never load the layout model.
        parsed = getattr(importlib.import_module(module), func)(data)
        return parsed.to_json(MIMES[kind])
    except ParseFailure as failure:
        return {"ok": False, "reason": failure.reason}
    except MemoryError:
        return {"ok": False, "reason": "TOO_COMPLEX"}
    except Exception as exc:
        # Type only: messages can echo file contents.
        log.error("parse failed: %s", type(exc).__name__)
        return {"ok": False, "reason": "INTERNAL"}
