import re

_BAD = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\r]")


def u16_slice(text: str, start: int, end: int) -> str:
    """Slices like a JS string would."""
    raw = text.encode("utf-16-le")
    return raw[start * 2 : end * 2].decode("utf-16-le")


def u16len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def check_page(page: dict, layout: bool) -> None:
    text = page["text"]
    assert not _BAD.search(text)
    n = u16len(text)
    for h in page["headings"]:
        assert 0 <= h["from"] < h["to"] <= n
        assert u16_slice(text, h["from"], h["to"]) == h["text"]
    prev = 0
    for b in page["blocks"]:
        assert prev <= b["from"] < b["to"] <= n
        assert "\n" not in u16_slice(text, b["from"], b["to"])
        prev = b["to"]
        assert 0 <= b["x0"] <= b["x1"] <= page["width"] + 1
        assert 0 <= b["y0"] <= b["y1"] <= page["height"] + 1
    if not layout:
        assert page["width"] == 0 and page["height"] == 0
        assert page["blocks"] == []


def check_result(result: dict, layout: bool) -> None:
    assert result["ok"] is True, result
    assert result["pages"]
    for i, page in enumerate(result["pages"], start=1):
        assert page["page_no"] == i
        check_page(page, layout)
