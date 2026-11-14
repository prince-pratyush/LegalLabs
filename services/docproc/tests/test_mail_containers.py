from email import message_from_bytes

from docproc.formats.emails import build_eml
from docproc.parse import parse

# No writer exists for .msg or .pst, so only the failure paths use real bytes.


def test_garbage_pst_is_corrupt():
    assert parse(b"!BDN" + b"\0" * 512, "box.pst") == {"ok": False, "reason": "CORRUPT_FILE"}


def test_ole_without_msg_streams_is_rejected():
    out = parse(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 504, "a.msg")
    assert out["ok"] is False


def test_rendered_eml_round_trips_through_parser():
    eml = build_eml(
        {"From": "a@example.com", "Subject": "Re: lease \U0001f4c4", "Date": "bad date"},
        "Body line",
        [("terms.pdf", b"%PDF-1.4")],
    )
    msg = message_from_bytes(eml)
    assert msg.get_payload()[0].get_payload(decode=True).decode().strip() == "Body line"
    out = parse(eml, "child.eml")
    assert out["ok"] is True
    assert out["pages"][0]["text"].startswith("From: a@example.com\n")
    assert out["children"][0]["name"] == "terms.pdf"
