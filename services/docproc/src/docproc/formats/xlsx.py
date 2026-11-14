import datetime
import io
import zipfile

import openpyxl
from openpyxl.worksheet.formula import ArrayFormula

from docproc.page import Page, ParseFailure
from docproc.result import Parsed

# openpyxl parses XML through defusedxml when it is installed.


def _load(data: bytes, data_only: bool):
    try:
        return openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=data_only)
    except (zipfile.BadZipFile, KeyError, ValueError, OSError) as exc:
        raise ParseFailure("CORRUPT_FILE") from exc


def _show(value) -> str:
    if isinstance(value, ArrayFormula):
        return value.text or ""
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def parse_xlsx(data: bytes) -> Parsed:
    formulas = _load(data, data_only=False)
    cached = _load(data, data_only=True)
    pages = []
    try:
        for n, name in enumerate(formulas.sheetnames, start=1):
            page = Page(page_no=n)
            page.paragraph(name, heading=1)
            values = cached[name].iter_rows()
            for row in formulas[name].iter_rows():
                cached_row = next(values, ())
                lines = []
                for i, cell in enumerate(row):
                    if cell.value is None or not hasattr(cell, "coordinate"):
                        continue
                    shown = _show(cell.value)
                    if isinstance(cell.value, ArrayFormula) or shown.startswith("="):
                        result = cached_row[i].value if i < len(cached_row) else None
                        if result is not None:
                            shown = f"{shown} → {_show(result)}"
                    lines.append(f"{cell.coordinate}: {' '.join(shown.split())}")
                if lines:
                    page.paragraph("\n".join(lines))
            pages.append(page)
    finally:
        formulas.close()
        cached.close()
    return Parsed(pages=pages)
