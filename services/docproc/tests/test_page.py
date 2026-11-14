from helpers import check_page, u16_slice

from docproc.page import Page


def test_offsets_count_utf16_units_past_astral_chars():
    page = Page(page_no=1, width=612, height=792)
    page.paragraph("Party \U0001f600 agrees", box=(1, 2, 3, 4))
    page.paragraph("2. Term", heading=1)
    out = page.to_json()
    assert out["text"] == "Party \U0001f600 agrees\n\n2. Term"
    heading = out["headings"][0]
    assert heading["from"] == len("Party ") + 2 + len(" agrees") + 2
    assert u16_slice(out["text"], heading["from"], heading["to"]) == "2. Term"
    check_page(out, layout=True)


def test_strips_control_chars_and_crlf():
    page = Page(page_no=1)
    page.paragraph("a\x00b\r\nc\x07\td")
    assert page.to_json()["text"] == "ab\nc\td"


def test_headings_and_boxes_are_one_line():
    page = Page(page_no=1)
    page.paragraph("1.  Defin-\nitions ", heading=2)
    out = page.to_json()
    assert out["headings"][0]["text"] == "1. Defin- itions"
    check_page(out, layout=False)


def test_blank_paragraphs_are_skipped():
    page = Page(page_no=1)
    page.paragraph(" \n ")
    page.paragraph("x")
    assert page.to_json()["text"] == "x"
