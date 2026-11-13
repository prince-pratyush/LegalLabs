import re
from dataclasses import dataclass, field

# Offsets are UTF-16 code units so they index JS strings directly.

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\ud800-\udfff]")
_SPACES = re.compile(r"\s+")

# Stops runaway pages early; the total across pages is checked at the end.
MAX_PAGE_CHARS = 5_000_000


class ParseFailure(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def clean(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return _CONTROL.sub("", text)


def one_line(text: str) -> str:
    return _SPACES.sub(" ", clean(text)).strip()


def u16len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


@dataclass
class Page:
    page_no: int
    width: float = 0.0
    height: float = 0.0
    ocr: bool = False
    _parts: list[str] = field(default_factory=list)
    _pos: int = 0
    blocks: list[dict] = field(default_factory=list)
    headings: list[dict] = field(default_factory=list)

    @property
    def size(self) -> int:
        return self._pos

    def paragraph(
        self,
        text: str,
        box: tuple[float, float, float, float] | None = None,
        heading: int | None = None,
    ) -> None:
        """Appends a paragraph, separated from the previous one by a blank line."""
        text = one_line(text) if heading or box else clean(text).strip("\n")
        if not text.strip():
            return
        if self._parts:
            self._append("\n\n")
        start = self._pos
        self._append(text)
        if box:
            x0, y0, x1, y1 = (round(float(v), 2) for v in box)
            self.blocks.append(
                {"from": start, "to": self._pos, "x0": x0, "y0": y0, "x1": x1, "y1": y1}
            )
        if heading:
            self.headings.append(
                {"from": start, "to": self._pos, "level": heading, "text": text}
            )

    def _append(self, text: str) -> None:
        self._parts.append(text)
        self._pos += u16len(text)
        if self._pos > MAX_PAGE_CHARS:
            raise ParseFailure("TOO_COMPLEX")

    def to_json(self) -> dict:
        return {
            "page_no": self.page_no,
            "width": round(float(self.width), 2),
            "height": round(float(self.height), 2),
            "text": "".join(self._parts),
            "blocks": self.blocks,
            "headings": self.headings,
            "ocr": self.ocr,
        }
