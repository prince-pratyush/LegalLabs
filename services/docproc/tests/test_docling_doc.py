from docproc.formats.docling_doc import clause_level


def test_numbered_lines_are_headings_at_their_depth():
    assert clause_level("1. DEFINITIONS") == 1
    assert clause_level("12.2 Cap on liability") == 2
    assert clause_level("3.1.4 Notices") == 3


def test_sentences_and_plain_text_are_not():
    assert clause_level("1. The Tenant shall pay rent monthly.") is None
    assert clause_level("2 years: the term") is None
    assert clause_level("Definitions") is None
    assert clause_level("12 " + "x" * 100) is None
