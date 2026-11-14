import re
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from html.parser import HTMLParser

from docproc.page import Page, clean
from docproc.result import Parsed

HEADERS = ("From", "To", "Cc", "Date", "Subject")
_BLOCK_TAGS = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table"}


class _HtmlText(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self._skip += 1
        elif tag in _BLOCK_TAGS:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self._skip = max(0, self._skip - 1)
        elif tag in _BLOCK_TAGS:
            self.out.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.out.append(data)


def html_to_text(html: str) -> str:
    parser = _HtmlText()
    parser.feed(html)
    parser.close()
    lines = [" ".join(line.split()) for line in "".join(parser.out).split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def prose(text: str) -> str:
    lines = [line.rstrip() for line in clean(text).split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def email_page(headers: dict[str, str], body: str) -> Page:
    page = Page(page_no=1)
    lines = [f"{k}: {' '.join(v.split())}" for k, v in headers.items() if v and v.strip()]
    page.paragraph("\n".join(lines))
    for para in prose(body).split("\n\n"):
        page.paragraph(para)
    return page


def build_eml(
    headers: dict[str, str], body: str, attachments: list[tuple[str, bytes]]
) -> bytes:
    """Renders a message from another container as .eml so the caller can recurse."""
    msg = EmailMessage()
    for key, value in headers.items():
        if value:
            try:
                msg[key] = " ".join(value.split())
            except Exception:
                msg[f"X-Original-{key}"] = " ".join(value.split())
    msg.set_content(body or "")
    for name, data in attachments:
        msg.add_attachment(
            data, maintype="application", subtype="octet-stream", filename=name
        )
    return msg.as_bytes(policy=policy.SMTP)


def parse_eml(data: bytes) -> Parsed:
    msg = BytesParser(policy=policy.default).parsebytes(data)
    headers = {k: str(msg.get(k, "")) for k in HEADERS}
    body = ""
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is not None:
        content = _content(part)
        body = html_to_text(content) if part.get_content_type() == "text/html" else content
    children = []
    for i, att in enumerate(msg.iter_attachments(), start=1):
        if att.get_content_type() == "message/rfc822":
            inner = att.get_payload()
            payload = inner[0].as_bytes() if isinstance(inner, list) and inner else b""
            name = att.get_filename() or f"message-{i}.eml"
        else:
            payload = att.get_payload(decode=True) or b""
            name = att.get_filename() or f"attachment-{i}"
        children.append((name, payload))
    return Parsed(pages=[email_page(headers, body)], children=children)


def _content(part) -> str:
    try:
        return part.get_content()
    except (LookupError, UnicodeError):
        raw = part.get_payload(decode=True) or b""
        return raw.decode("utf-8", errors="replace")
