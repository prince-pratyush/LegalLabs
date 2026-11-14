import base64
from dataclasses import dataclass, field

from docproc.page import Page, ParseFailure

MAX_PAGES = 1_000
MAX_CHARS = 5_000_000


@dataclass
class Parsed:
    pages: list[Page]
    children: list[tuple[str, bytes]] = field(default_factory=list)
    meta: dict = field(default_factory=dict)

    def to_json(self, mime: str) -> dict:
        if len(self.pages) > MAX_PAGES:
            raise ParseFailure("PAGE_LIMIT_EXCEEDED")
        if sum(p.size for p in self.pages) > MAX_CHARS:
            raise ParseFailure("TOO_COMPLEX")
        if not self.children and all(p.size == 0 for p in self.pages):
            raise ParseFailure("NO_TEXT")
        return {
            "ok": True,
            "mime": mime,
            "pages": [p.to_json() for p in self.pages],
            "children": [
                {"name": name, "content_base64": base64.b64encode(data).decode("ascii")}
                for name, data in self.children
            ],
            "meta": self.meta,
        }
