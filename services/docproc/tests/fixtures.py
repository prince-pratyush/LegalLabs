"""Synthetic documents built at test time; no real client data."""

import io
from email.message import EmailMessage

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


def pdf(pages: list[list[str]], image_pages: tuple[int, ...] = ()) -> bytes:
    """Each page is a list of lines; pages in image_pages are drawn as pictures only."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    for i, lines in enumerate(pages):
        if i in image_pages:
            c.drawImage(_text_image(lines), 0, 0, width=letter[0], height=letter[1])
        else:
            y = 720
            for line in lines:
                size = 16 if line.isupper() else 11
                c.setFont("Helvetica-Bold" if size == 16 else "Helvetica", size)
                c.drawString(72, y, line)
                y -= 28
        c.showPage()
    c.save()
    return buf.getvalue()


def _text_image(lines: list[str]):
    from PIL import Image, ImageDraw, ImageFont
    from reportlab.lib.utils import ImageReader

    img = Image.new("RGB", (1275, 1650), "white")
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=40)
    for n, line in enumerate(lines):
        draw.text((150, 150 + n * 70), line, fill="black", font=font)
    out = io.BytesIO()
    img.save(out, format="PNG")
    out.seek(0)
    return ImageReader(out)


def eml(body: str, attachments: list[tuple[str, bytes, str]] = (), html: str | None = None) -> bytes:
    msg = EmailMessage()
    msg["From"] = "Alice Example <alice@example.com>"
    msg["To"] = "bob@example.com"
    msg["Cc"] = "carol@example.com"
    msg["Date"] = "Mon, 02 Mar 2026 10:00:00 +0000"
    msg["Subject"] = "Draft lease \U0001f4c4"
    msg.set_content(body)
    if html is not None:
        msg.add_alternative(html, subtype="html")
    for name, data, mime in attachments:
        main, sub = mime.split("/")
        msg.add_attachment(data, maintype=main, subtype=sub, filename=name)
    return msg.as_bytes()
