"""Writes a mixed corpus of made-up legal files for load tests. No real data.

Run: uv run python scripts/synthetic_corpus.py OUT_DIR [COUNT]
"""

import io
import random
import sys
from email.message import EmailMessage
from pathlib import Path

import openpyxl
from docx import Document
from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

PARTIES = ["Northwind Pty Ltd", "Blue Harbour Ltd", "Kestrel Labs Inc", "Ardent Freight LLC"]
TOPICS = [
    ("Limitation of Liability", "The {a} shall not be liable to the {b} for any indirect loss."),
    ("Confidentiality", "The {b} must keep the {a}'s confidential information secret."),
    ("Termination", "Either party may terminate this agreement on {n} days' written notice."),
    ("Payment", "The {b} will pay each invoice within {n} days of receipt."),
    ("Governing Law", "This agreement is governed by the laws of New South Wales."),
    ("Indemnity", "The {a} indemnifies the {b} against third-party claims up to ${n},000."),
]
# Share of the corpus per kind; the rest are files that should fail.
MIX = [("pdf", 0.25), ("scan", 0.05), ("docx", 0.20), ("xlsx", 0.10), ("eml", 0.15), ("txt", 0.10),
       ("md", 0.10)]


def clauses(rng, count):
    a, b = rng.sample(PARTIES, 2)
    picked = rng.sample(TOPICS, min(count, len(TOPICS)))
    return [(f"{i + 1}. {title}", body.format(a=a, b=b, n=rng.randint(5, 90)))
            for i, (title, body) in enumerate(picked)]


def pdf(items):
    out = io.BytesIO()
    page = canvas.Canvas(out, pagesize=letter)
    y = 720
    for title, body in items:
        page.setFont("Helvetica-Bold", 13)
        page.drawString(72, y, title)
        page.setFont("Helvetica", 11)
        page.drawString(72, y - 18, body)
        y -= 60
        if y < 100:
            page.showPage()
            y = 720
    page.save()
    return out.getvalue()


def scan(items):
    image = Image.new("L", (1275, 1650), 255)
    draw = ImageDraw.Draw(image)
    y = 150
    for title, body in items[:4]:
        draw.text((150, y), title, fill=0, font_size=36)
        draw.text((150, y + 50), body[:70], fill=0, font_size=28)
        y += 160
    out = io.BytesIO()
    image.save(out, format="PDF", resolution=150)
    return out.getvalue()


def docx(items):
    document = Document()
    for title, body in items:
        document.add_heading(title, level=1)
        document.add_paragraph(body)
    out = io.BytesIO()
    document.save(out)
    return out.getvalue()


def xlsx(rng):
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "Fees"
    sheet.append(["Item", "Amount"])
    for i in range(rng.randint(3, 8)):
        sheet.append([f"Service {i + 1}", rng.randint(100, 9000)])
    sheet.append(["Total", f"=SUM(B2:B{sheet.max_row})"])
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def eml(rng, items, index):
    message = EmailMessage()
    message["From"] = "counsel@example.test"
    message["To"] = "legal@example.test"
    message["Subject"] = f"Re: draft agreement {index}"
    message["Date"] = "Mon, 2 Nov 2026 09:00:00 +1100"
    message.set_content("\n\n".join(body for _, body in items))
    if rng.random() < 0.6:
        message.add_attachment(pdf(items), maintype="application", subtype="pdf",
                               filename=f"draft-{index}.pdf")
    return bytes(message)


def text(items, markdown):
    heading = "## " if markdown else ""
    return "\n\n".join(f"{heading}{title}\n\n{body}" for title, body in items).encode()


def broken(rng, index):
    kind = index % 4
    if kind == 0:
        return f"truncated-{index}.pdf", b"%PDF-1.7\n1 0 obj << /Type /Catalog"
    if kind == 1:
        return f"blank-{index}.txt", b"   \n\n  "
    if kind == 2:
        return f"binary-{index}.bin", bytes(rng.randrange(256) for _ in range(64))
    return f"bad-{index}.docx", b"PK\x03\x04not really a zip"


def main():
    out = Path(sys.argv[1])
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 1000
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261114)
    kinds = [kind for kind, share in MIX for _ in range(round(share * count))]
    kinds += ["broken"] * (count - len(kinds))
    for index, kind in enumerate(kinds):
        items = clauses(rng, rng.randint(2, 6))
        if kind == "pdf":
            name, data = f"agreement-{index}.pdf", pdf(items)
        elif kind == "scan":
            name, data = f"scanned-{index}.pdf", scan(items)
        elif kind == "docx":
            name, data = f"contract-{index}.docx", docx(items)
        elif kind == "xlsx":
            name, data = f"fees-{index}.xlsx", xlsx(rng)
        elif kind == "eml":
            name, data = f"message-{index}.eml", eml(rng, items, index)
        elif kind in ("txt", "md"):
            name, data = f"notes-{index}.{kind}", text(items, kind == "md")
        else:
            name, data = broken(rng, index)
        (out / name).write_bytes(data)
    print(f"wrote {len(kinds)} files to {out}")


if __name__ == "__main__":
    main()
