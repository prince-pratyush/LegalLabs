import functools
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pypdfium2 as pdfium
from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption

from docproc.formats.docling_doc import convert, items
from docproc.models import models_dir
from docproc.page import Page, ParseFailure
from docproc.result import MAX_PAGES, Parsed


@functools.cache
def _converter() -> DocumentConverter:
    # Layout only: OCR is done by OCRmyPDF and tables are read as text rows.
    options = PdfPipelineOptions(
        do_ocr=False,
        do_table_structure=False,
        do_code_enrichment=False,
        do_formula_enrichment=False,
        do_picture_classification=False,
        # CPU keeps results reproducible and avoids MPS crashes on older macOS.
        accelerator_options=AcceleratorOptions(
            device=AcceleratorDevice.CPU,
            num_threads=int(os.environ.get("DOCPROC_THREADS", "4")),
        ),
        artifacts_path=models_dir(),
    )
    return DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
    )


def _textless_pages(data: bytes) -> tuple[int, set[int]]:
    try:
        pdf = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as exc:
        if "password" in str(exc).lower():
            raise ParseFailure("ENCRYPTED_NO_PASSWORD") from exc
        raise ParseFailure("CORRUPT_FILE") from exc
    try:
        count = len(pdf)
        if count > MAX_PAGES:
            raise ParseFailure("PAGE_LIMIT_EXCEEDED")
        empty = set()
        for i in range(count):
            page = pdf[i]
            textpage = page.get_textpage()
            if not textpage.get_text_range().strip():
                empty.add(i + 1)
            textpage.close()
            page.close()
        return count, empty
    finally:
        pdf.close()


def ocr_available() -> bool:
    return bool(shutil.which("ocrmypdf") and shutil.which("tesseract"))


def _ocr(data: bytes) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp, "in.pdf"), Path(tmp, "out.pdf")
        src.write_bytes(data)
        lang = os.environ.get("DOCPROC_OCR_LANG", "eng")
        # Output is discarded: OCR logs can contain recognised text.
        done = subprocess.run(
            ["ocrmypdf", "--skip-text", "-q", "-l", lang, "--output-type", "pdf", src, dst],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if done.returncode != 0 or not dst.exists():
            raise ParseFailure("NO_TEXT")
        return dst.read_bytes()


def parse_pdf(data: bytes) -> Parsed:
    count, textless = _textless_pages(data)
    ocr_pages: set[int] = set()
    if textless:
        if ocr_available():
            data = _ocr(data)
            ocr_pages = textless
        elif len(textless) == count:
            raise ParseFailure("NO_TEXT")
    doc = convert(_converter(), data, "input.pdf")
    pages = {}
    for n in range(1, count + 1):
        size = doc.pages[n].size if n in doc.pages else None
        pages[n] = Page(
            page_no=n,
            width=size.width if size else 0.0,
            height=size.height if size else 0.0,
            ocr=n in ocr_pages,
        )
    for item in items(doc, layout=True):
        page = pages.get(item.page_no)
        if page is not None:
            page.paragraph(item.text, box=item.box, heading=item.heading)
    return Parsed(pages=list(pages.values()))
