import functools

from docling.datamodel.base_models import InputFormat
from docling.document_converter import DocumentConverter

from docproc.formats.docling_doc import convert, items
from docproc.page import Page
from docproc.result import Parsed


@functools.cache
def _converter() -> DocumentConverter:
    return DocumentConverter(allowed_formats=[InputFormat.DOCX])


def parse_docx(data: bytes) -> Parsed:
    doc = convert(_converter(), data, "input.docx")
    # Word has no fixed pages, so the whole document is page 1 without layout.
    page = Page(page_no=1)
    for item in items(doc, layout=False):
        page.paragraph(item.text, heading=item.heading)
    return Parsed(pages=[page])
