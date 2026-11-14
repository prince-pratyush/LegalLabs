import io
from email.parser import HeaderParser

import pypff

from docproc.formats.emails import HEADERS, build_eml, html_to_text
from docproc.page import Page, ParseFailure
from docproc.result import Parsed

MAX_MESSAGES = 10_000


def _text(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return "" if value is None else str(value)


def _messages(folder, path: str):
    for i in range(folder.number_of_sub_messages):
        yield path, folder.get_sub_message(i)
    for i in range(folder.number_of_sub_folders):
        sub = folder.get_sub_folder(i)
        yield from _messages(sub, f"{path}/{_text(sub.name)}")


def _eml(message) -> tuple[str, bytes]:
    parsed = HeaderParser().parsestr(_text(message.transport_headers))
    headers = {k: _text(parsed.get(k, "")) for k in HEADERS}
    headers["From"] = headers["From"] or _text(message.sender_name)
    headers["Subject"] = headers["Subject"] or _text(message.subject)
    body = _text(message.plain_text_body)
    if not body.strip() and message.html_body:
        body = html_to_text(_text(message.html_body))
    attachments = []
    for i in range(message.number_of_attachments):
        att = message.get_attachment(i)
        size = att.get_size() or 0
        attachments.append((f"attachment-{i + 1}", att.read_buffer(size) if size else b""))
    return headers["Subject"], build_eml(headers, body, attachments)


def parse_pst(data: bytes) -> Parsed:
    pst = pypff.file()
    try:
        pst.open_file_object(io.BytesIO(data))
    except Exception as exc:
        raise ParseFailure("CORRUPT_FILE") from exc
    try:
        page = Page(page_no=1)
        children = []
        for n, (path, message) in enumerate(_messages(pst.get_root_folder(), ""), start=1):
            if n > MAX_MESSAGES:
                raise ParseFailure("TOO_COMPLEX")
            subject, eml = _eml(message)
            name = f"message-{n}.eml"
            children.append((name, eml))
            page.paragraph(f"{name}: {path or '/'} — {subject}")
        return Parsed(pages=[page], children=children)
    finally:
        pst.close()
