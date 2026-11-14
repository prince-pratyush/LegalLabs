import io

import fixtures
import pytest
from helpers import check_result, u16_slice
from reportlab.lib.pagesizes import letter
from reportlab.lib.pdfencrypt import StandardEncryption
from reportlab.pdfgen import canvas

from docproc.formats import pdf as pdf_format
from docproc.parse import parse

needs_ocr = pytest.mark.skipif(
    not pdf_format.ocr_available(), reason="ocrmypdf/tesseract not installed"
)


def test_text_pdf_has_layout_headings_and_line_blocks():
    data = fixtures.pdf(
        [
            ["1. DEFINITIONS", "The Tenant shall pay rent monthly."],
            ["2. TERM", "The term is five years."],
        ]
    )
    out = parse(data, "lease.pdf")
    check_result(out, layout=True)
    first, second = out["pages"]
    assert (first["width"], first["height"]) == (612.0, 792.0)
    assert "The Tenant shall pay rent monthly." in first["text"]
    assert "The term is five years." in second["text"]
    assert not first["ocr"]
    texts = [u16_slice(p["text"], b["from"], b["to"]) for p in out["pages"] for b in p["blocks"]]
    assert "The term is five years." in texts
    # Body text was drawn about 100pt below the top edge, left margin 72pt.
    text = second["text"]
    block = next(b for b in second["blocks"] if "five" in u16_slice(text, b["from"], b["to"]))
    assert 60 <= block["x0"] <= 80
    assert 90 <= block["y0"] <= 130
    headings = [h["text"] for p in out["pages"] for h in p["headings"]]
    assert "1. DEFINITIONS" in headings or "2. TERM" in headings


def test_encrypted_pdf_needs_password():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter, encrypt=StandardEncryption("secret", canPrint=0))
    c.drawString(72, 720, "Confidential")
    c.save()
    assert parse(buf.getvalue(), "a.pdf") == {"ok": False, "reason": "ENCRYPTED_NO_PASSWORD"}


def test_corrupt_pdf():
    assert parse(b"%PDF-1.7\nnot really", "a.pdf") == {"ok": False, "reason": "CORRUPT_FILE"}


def test_scanned_pdf_without_ocr_tools_has_no_text(monkeypatch):
    monkeypatch.setattr(pdf_format, "ocr_available", lambda: False)
    data = fixtures.pdf([["SCANNED PAGE"]], image_pages=(0,))
    assert parse(data, "scan.pdf") == {"ok": False, "reason": "NO_TEXT"}


@needs_ocr
def test_image_only_page_is_ocred():
    data = fixtures.pdf(
        [["1. PARTIES", "Typed text page."], ["Scanned clause about payment"]],
        image_pages=(1,),
    )
    out = parse(data, "mixed.pdf")
    check_result(out, layout=True)
    typed, scanned = out["pages"]
    assert not typed["ocr"] and scanned["ocr"]
    assert "payment" in scanned["text"].lower()
