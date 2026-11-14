import io
from collections.abc import Iterator
from dataclasses import dataclass

from docling.datamodel.base_models import ConversionStatus, DocumentStream
from docling_core.types.doc import (
    DocItemLabel,
    ListItem,
    SectionHeaderItem,
    TableItem,
    TextItem,
)

from docproc.page import ParseFailure


@dataclass
class Item:
    page_no: int
    text: str
    box: tuple[float, float, float, float] | None
    heading: int | None


def convert(converter, data: bytes, name: str):
    try:
        result = converter.convert(
            DocumentStream(name=name, stream=io.BytesIO(data)), raises_on_error=False
        )
    except Exception as exc:
        raise ParseFailure("CORRUPT_FILE") from exc
    if result.status not in (ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS):
        raise ParseFailure("CORRUPT_FILE")
    return result.document


def items(doc, layout: bool) -> Iterator[Item]:
    """Body items in reading order; boxes are top-left origin PDF points."""
    for node, _level in doc.iterate_items():
        if isinstance(node, TableItem):
            for row in _rows(node):
                yield Item(_page_no(node), row, _box(doc, node) if layout else None, None)
            continue
        if not isinstance(node, TextItem) or not node.text.strip():
            continue
        text = node.text
        if isinstance(node, ListItem) and node.marker and not text.startswith(node.marker):
            text = f"{node.marker} {text}"
        heading = None
        if node.label == DocItemLabel.TITLE:
            heading = 1
        elif isinstance(node, SectionHeaderItem):
            heading = max(1, int(node.level or 1))
        yield Item(_page_no(node), text, _box(doc, node) if layout else None, heading)


def _rows(table: TableItem) -> list[str]:
    rows = []
    for row in table.data.grid if table.data else []:
        cells, last = [], None
        for cell in row:
            # Spanning cells repeat across the grid; print them once.
            if cell is last or not cell.text.strip():
                continue
            cells.append(" ".join(cell.text.split()))
            last = cell
        if cells:
            rows.append(" | ".join(cells))
    return rows


def _page_no(node) -> int:
    return node.prov[0].page_no if node.prov else 1


def _box(doc, node) -> tuple[float, float, float, float] | None:
    if not node.prov:
        return None
    prov = node.prov[0]
    page = doc.pages.get(prov.page_no)
    if page is None:
        return None
    b = prov.bbox.to_top_left_origin(page_height=page.size.height)
    x0, x1 = sorted((b.l, b.r))
    y0, y1 = sorted((b.t, b.b))
    w, h = page.size.width, page.size.height
    return (max(0.0, x0), max(0.0, y0), min(w, x1), min(h, y1))
