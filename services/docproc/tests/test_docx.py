import io

import docx
from helpers import check_result

from docproc.parse import parse


def _document() -> bytes:
    d = docx.Document()
    d.add_heading("Lease Agreement", level=1)
    d.add_paragraph("This lease is made between the parties \U0001f3e0.")
    d.add_heading("1. Definitions", level=2)
    d.add_paragraph("Premises means the flat.")
    table = d.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Rent"
    table.cell(0, 1).text = "100"
    table.cell(1, 0).text = "Deposit"
    table.cell(1, 1).text = "200"
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def test_docx_is_one_page_with_style_headings():
    out = parse(_document(), "lease.docx")
    check_result(out, layout=False)
    [page] = out["pages"]
    headings = [(h["text"], h["level"]) for h in page["headings"]]
    assert ("Lease Agreement", 1) in headings or ("Lease Agreement", 2) in headings
    assert any(text == "1. Definitions" for text, _ in headings)
    assert "This lease is made between the parties \U0001f3e0." in page["text"]
    assert "Rent | 100" in page["text"]
    assert "\n\nPremises means the flat.\n\n" in page["text"]
