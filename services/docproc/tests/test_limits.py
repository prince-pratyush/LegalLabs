import pytest

from docproc.page import Page, ParseFailure
from docproc.result import MAX_CHARS, MAX_PAGES, Parsed


def _reason(parsed: Parsed) -> str:
    with pytest.raises(ParseFailure) as err:
        parsed.to_json("x/y")
    return err.value.reason


def _page(n: int, text: str = "x") -> Page:
    page = Page(page_no=n)
    page.paragraph(text)
    return page


def test_page_limit():
    pages = [_page(n) for n in range(1, MAX_PAGES + 2)]
    assert _reason(Parsed(pages=pages)) == "PAGE_LIMIT_EXCEEDED"


def test_char_limit_across_pages():
    half = "a" * (MAX_CHARS // 2 + 1)
    assert _reason(Parsed(pages=[_page(1, half), _page(2, half)])) == "TOO_COMPLEX"


def test_char_limit_within_a_page():
    page = Page(page_no=1)
    with pytest.raises(ParseFailure, match="TOO_COMPLEX"):
        page.paragraph("a" * (MAX_CHARS + 1))


def test_empty_document_has_no_text():
    assert _reason(Parsed(pages=[Page(page_no=1)])) == "NO_TEXT"
