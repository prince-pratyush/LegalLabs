import io
import zipfile

import openpyxl
from helpers import check_result

from docproc.parse import parse


def _with_cached_value(data: bytes, sheet_xml_path: str, value: str) -> bytes:
    """openpyxl never computes formulas, so write the cached result like Excel would."""
    src = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as dst:
        for item in src.infolist():
            raw = src.read(item.filename)
            if item.filename == sheet_xml_path:
                raw = raw.replace(b"</f><v></v>", b"</f>", 1)
                raw = raw.replace(b"</f>", f"</f><v>{value}</v>".encode(), 1)
            dst.writestr(item, raw)
    return out.getvalue()


def _workbook() -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Fees"
    ws["A1"] = "Item"
    ws["B1"] = "Amount \U0001f4b0"
    ws["A2"] = "Rent"
    ws["B2"] = 2
    ws["B3"] = 4
    ws["B4"] = "=SUM(B2:B3)"
    other = wb.create_sheet("Notes")
    other["A1"] = "Line one\r\nline two"
    buf = io.BytesIO()
    wb.save(buf)
    return _with_cached_value(buf.getvalue(), "xl/worksheets/sheet1.xml", "6")


def test_one_page_per_sheet_with_cell_lines():
    out = parse(_workbook(), "fees.xlsx")
    check_result(out, layout=False)
    fees, notes = out["pages"]
    assert fees["headings"] == [{"from": 0, "to": 4, "level": 1, "text": "Fees"}]
    assert fees["text"] == (
        "Fees\n\nA1: Item\nB1: Amount \U0001f4b0\n\nA2: Rent\nB2: 2\n\nB3: 4\n\n"
        "B4: =SUM(B2:B3) → 6"
    )
    assert notes["text"] == "Notes\n\nA1: Line one line two"


def test_corrupt_workbook():
    bad = io.BytesIO()
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("xl/workbook.xml", "not xml")
    assert parse(bad.getvalue(), "x.xlsx") == {"ok": False, "reason": "CORRUPT_FILE"}
