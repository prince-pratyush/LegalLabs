import io
import zipfile

import olefile

from docproc.page import ParseFailure

MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_UNZIPPED_BYTES = 200 * 1024 * 1024
MAX_ZIP_ENTRIES = 10_000

MIMES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "msg": "application/vnd.ms-outlook",
    "pst": "application/vnd.ms-outlook-pst",
    "eml": "message/rfc822",
}


def detect(data: bytes, name: str) -> str:
    if len(data) > MAX_FILE_BYTES:
        raise ParseFailure("FILE_TOO_LARGE")
    head = data[:1024]
    if b"%PDF-" in head:
        return "pdf"
    if data.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return _ole(data)
    if data.startswith(b"PK\x03\x04"):
        return _zip(data)
    if data.startswith(b"!BDN"):
        return "pst"
    if name.lower().endswith(".eml"):
        return "eml"
    raise ParseFailure("UNSUPPORTED_TYPE")


def _ole(data: bytes) -> str:
    try:
        ole = olefile.OleFileIO(data)
    except Exception as exc:
        raise ParseFailure("CORRUPT_FILE") from exc
    with ole:
        streams = {"/".join(path) for path in ole.listdir()}
    # Password-protected OOXML is wrapped in an OLE container.
    if "EncryptionInfo" in streams:
        raise ParseFailure("ENCRYPTED_NO_PASSWORD")
    if "__properties_version1.0" in streams or any(
        s.startswith("__substg1.0_") for s in streams
    ):
        return "msg"
    raise ParseFailure("UNSUPPORTED_TYPE")


def _zip(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            infos = zf.infolist()
    except zipfile.BadZipFile as exc:
        raise ParseFailure("CORRUPT_FILE") from exc
    # zipfile stops at the declared size, so declared sizes bound real output.
    if len(infos) > MAX_ZIP_ENTRIES or sum(i.file_size for i in infos) > MAX_UNZIPPED_BYTES:
        raise ParseFailure("TOO_COMPLEX")
    names = {i.filename for i in infos}
    if "[Content_Types].xml" not in names:
        raise ParseFailure("UNSUPPORTED_TYPE")
    if "word/document.xml" in names:
        return "docx"
    if "xl/workbook.xml" in names:
        return "xlsx"
    raise ParseFailure("UNSUPPORTED_TYPE")
