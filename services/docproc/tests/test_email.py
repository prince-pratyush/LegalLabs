import base64
from email.message import EmailMessage

import fixtures
from helpers import check_result

from docproc.formats.emails import html_to_text
from docproc.parse import parse


def test_eml_header_block_then_body_and_attachment():
    attached = fixtures.pdf([["Schedule A"]])
    body = "Hi Bob,\r\n\r\nPlease review the lease.\r\n\r\n\r\nThanks"
    out = parse(fixtures.eml(body, [("lease.pdf", attached, "application/pdf")]), "m.eml")
    check_result(out, layout=False)
    assert out["mime"] == "message/rfc822"
    text = out["pages"][0]["text"]
    head, rest = text.split("\n\n", 1)
    assert head.splitlines() == [
        "From: Alice Example <alice@example.com>",
        "To: bob@example.com",
        "Cc: carol@example.com",
        "Date: Mon, 02 Mar 2026 10:00:00 +0000",
        "Subject: Draft lease \U0001f4c4",
    ]
    assert rest == "Hi Bob,\n\nPlease review the lease.\n\nThanks"
    [child] = out["children"]
    assert child["name"] == "lease.pdf"
    assert base64.b64decode(child["content_base64"]) == attached


def test_html_only_body_is_stripped():
    msg = EmailMessage()
    msg["Subject"] = "x"
    msg.set_content("<p>One</p><script>bad()</script><p>Two &amp; three</p>", subtype="html")
    out = parse(msg.as_bytes(), "m.eml")
    assert out["pages"][0]["text"] == "Subject: x\n\nOne\n\nTwo & three"


def test_forwarded_message_becomes_eml_child():
    inner = EmailMessage()
    inner["Subject"] = "inner"
    inner.set_content("nested")
    outer = EmailMessage()
    outer["Subject"] = "outer"
    outer.set_content("see attached")
    outer.add_attachment(inner)
    out = parse(outer.as_bytes(), "m.eml")
    [child] = out["children"]
    assert child["name"].endswith(".eml")
    assert b"nested" in base64.b64decode(child["content_base64"])


def test_html_to_text_keeps_paragraphs():
    assert html_to_text("<div>a  b</div><div>c</div>") == "a b\n\nc"
