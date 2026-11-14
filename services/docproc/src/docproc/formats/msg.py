import io

import extract_msg

from docproc.formats.emails import build_eml, email_page, html_to_text
from docproc.page import ParseFailure
from docproc.result import Parsed


def _text(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return "" if value is None else str(value)


def _body(msg) -> str:
    body = _text(msg.body)
    if body.strip():
        return body
    try:
        return html_to_text(_text(msg.htmlBody))
    except Exception:
        return ""


def _headers(msg) -> dict[str, str]:
    return {
        "From": _text(msg.sender),
        "To": _text(msg.to),
        "Cc": _text(msg.cc),
        "Date": _text(msg.date),
        "Subject": _text(msg.subject),
    }


def _attachments(msg) -> list[tuple[str, bytes]]:
    out = []
    for i, att in enumerate(msg.attachments, start=1):
        data = att.data
        name = _text(getattr(att, "longFilename", None) or getattr(att, "shortFilename", None))
        if isinstance(data, bytes):
            out.append((name or f"attachment-{i}", data))
        elif data is not None and hasattr(data, "attachments"):
            # Embedded message: hand it back as .eml so the caller recurses.
            eml = build_eml(_headers(data), _body(data), _attachments(data))
            out.append(((name or f"message-{i}") + ".eml", eml))
    return out


def parse_msg(data: bytes) -> Parsed:
    try:
        msg = extract_msg.openMsg(io.BytesIO(data), strict=False)
    except Exception as exc:
        raise ParseFailure("CORRUPT_FILE") from exc
    try:
        return Parsed(pages=[email_page(_headers(msg), _body(msg))], children=_attachments(msg))
    finally:
        msg.close()
