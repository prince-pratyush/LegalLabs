import io
import zipfile

import pytest

from docproc.detect import MAX_FILE_BYTES, detect
from docproc.page import ParseFailure


def _zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _reason(data: bytes, name: str) -> str:
    with pytest.raises(ParseFailure) as err:
        detect(data, name)
    return err.value.reason


def test_magic_bytes_win_over_extension():
    assert detect(b"%PDF-1.7\n...", "notes.txt") == "pdf"
    assert detect(b"!BDN" + b"\0" * 20, "x.bin") == "pst"
    assert detect(_zip({"[Content_Types].xml": b"", "word/document.xml": b""}), "a") == "docx"
    assert detect(_zip({"[Content_Types].xml": b"", "xl/workbook.xml": b""}), "a") == "xlsx"


def test_eml_by_extension():
    assert detect(b"From: a@example.com\n\nhi", "Mail.EML") == "eml"


def test_text_files_are_left_to_the_caller():
    assert _reason(b"# notes", "notes.md") == "UNSUPPORTED_TYPE"
    assert _reason(b"plain", "notes.txt") == "UNSUPPORTED_TYPE"
    assert _reason(_zip({"a.txt": b"x"}), "a.zip") == "UNSUPPORTED_TYPE"


def test_size_limit():
    assert _reason(b"%PDF-" + b"\0" * MAX_FILE_BYTES, "a.pdf") == "FILE_TOO_LARGE"


def test_zip_bomb_is_rejected():
    bomb = _zip({"[Content_Types].xml": b"", "word/document.xml": b"\0" * (201 * 1024 * 1024)})
    assert len(bomb) < MAX_FILE_BYTES
    assert _reason(bomb, "a.docx") == "TOO_COMPLEX"


def test_broken_containers_are_corrupt():
    assert _reason(b"PK\x03\x04garbage", "a.docx") == "CORRUPT_FILE"
    assert _reason(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1garbage", "a.msg") == "CORRUPT_FILE"
