"""Deterministic cell parsers and quote checks, the same rules for gold values and answers.

They mirror the product's review-table parsers closely enough to grade them; they are
not the product's code, so a disagreement here is a grading question, not a product bug.
"""

import re
import unicodedata
from decimal import Decimal, InvalidOperation
from typing import Any

MONTHS = {
    m: i
    for i, names in enumerate(
        [
            ("january", "jan"),
            ("february", "feb"),
            ("march", "mar"),
            ("april", "apr"),
            ("may",),
            ("june", "jun"),
            ("july", "jul"),
            ("august", "aug"),
            ("september", "sep", "sept"),
            ("october", "oct"),
            ("november", "nov"),
            ("december", "dec"),
        ],
        1,
    )
    for m in names
}
_MONTH = (
    r"(january|february|march|april|may|june|july|august|september|october|november|december"
    r"|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?"
)
_DAY = r"(\d{1,2})(?:st|nd|rd|th)?"
_YEAR = r"(\d{4})"
DATE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(rf"\b{_YEAR}-(\d{{2}})-(\d{{2}})\b"), "ymd"),
    (re.compile(rf"\b{_MONTH}\s+{_DAY},?\s+{_YEAR}", re.I), "mdy"),
    # "6th day of April, 1999" and "30 day of June 2016".
    (re.compile(rf"\b{_DAY}\s+(?:day\s+of\s+)?{_MONTH},?\s+{_YEAR}", re.I), "dmy"),
    (re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b"), "us"),
    (re.compile(rf"\b{_MONTH},?\s+{_YEAR}", re.I), "my"),
]


def _date(year: int, month: int, day: int | None) -> dict[str, Any] | None:
    if not (1 <= month <= 12 and 1900 <= year <= 2100):
        return None
    if day is None:
        return {"kind": "date", "iso": f"{year:04d}-{month:02d}", "precision": "month"}
    if not 1 <= day <= 31:
        return None
    return {"kind": "date", "iso": f"{year:04d}-{month:02d}-{day:02d}", "precision": "day"}


def parse_date(text: str | None) -> dict[str, Any] | None:
    """The first date in the text, with its precision; None when there is none."""
    if not text:
        return None
    text = " ".join(text.split())
    for pattern, kind in DATE_PATTERNS:
        m = pattern.search(text)
        if not m:
            continue
        g = m.groups()
        if kind == "ymd":
            return _date(int(g[0]), int(g[1]), int(g[2]))
        if kind == "mdy":
            return _date(int(g[2]), MONTHS[g[0].lower()], int(g[1]))
        if kind == "dmy":
            return _date(int(g[2]), MONTHS[g[1].lower()], int(g[0]))
        if kind == "us":
            return _date(int(g[2]), int(g[0]), int(g[1]))
        return _date(int(g[1]), MONTHS[g[0].lower()], None)
    m = re.search(r"\b(19|20)\d{2}\b", text)
    if m:
        return {"kind": "date", "iso": m.group(0), "precision": "year"}
    return None


CURRENCIES = {
    "$": "USD",
    "us$": "USD",
    "usd": "USD",
    "dollars": "USD",
    "€": "EUR",
    "eur": "EUR",
    "euros": "EUR",
    "£": "GBP",
    "gbp": "GBP",
    "pounds": "GBP",
    "rmb": "CNY",
    "cny": "CNY",
    "c$": "CAD",
    "cad": "CAD",
}
SCALES = {
    "thousand": 1_000,
    "million": 1_000_000,
    "billion": 1_000_000_000,
    "k": 1_000,
    "m": 1_000_000,
}
_CODE = r"(us\$|c\$|\$|€|£|usd|eur|gbp|rmb|cny|cad)"
_AMOUNT = r"(\d[\d,]*(?:\.\d+)?)"
_SCALE = r"(?:\s*(thousand|million|billion|k|m)\b)?"
MONEY = re.compile(
    rf"{_CODE}\s?{_AMOUNT}{_SCALE}|{_AMOUNT}{_SCALE}\s*(usd|eur|gbp|dollars|euros|pounds)\b", re.I
)


def _money(raw: str, scale: str | None, code: str) -> dict[str, Any] | None:
    try:
        amount = Decimal(raw.replace(",", ""))
    except InvalidOperation:
        return None
    if scale:
        amount *= SCALES[scale.lower()]
    return {"kind": "currency", "amount": f"{amount:.2f}", "currency": CURRENCIES[code.lower()]}


def money_all(text: str | None) -> list[dict[str, Any]]:
    """Every money amount in the text: "USD 1.5 million" is 1500000.00 USD."""
    found = []
    for m in MONEY.finditer(text or ""):
        if m.group(1):
            value = _money(m.group(2), m.group(3), m.group(1))
        else:
            value = _money(m.group(4), m.group(5), m.group(6))
        if value:
            found.append(value)
    return found


def parse_money(text: str | None) -> dict[str, Any] | None:
    found = money_all(text)
    return found[0] if found else None


def norm(text: str) -> str:
    """Lowercase words only: for comparing names, not for checking quotes."""
    text = unicodedata.normalize("NFKD", text)
    return " ".join(re.findall(r"[a-z0-9]+", text.lower()))


def match_option(text: str | None, labels: list[str]) -> str | None:
    """A classify answer must name one label, case-insensitively."""
    if not text:
        return None
    wanted = norm(text)
    for label in labels:
        if norm(label) == wanted:
            return label
    hits = [label for label in labels if re.search(rf"\b{re.escape(norm(label))}\b", wanted)]
    return hits[0] if len(hits) == 1 else None


# Quote checks follow packages/citations: fold quote marks and ligatures, collapse spaces,
# then require an exact match. The product also forgives 2% scan noise; this does not.
MIN_QUOTE = 12
_FOLD = str.maketrans(
    {
        "‘": "'",
        "’": "'",
        "‚": "'",
        "‛": "'",
        "′": "'",
        "“": '"',
        "”": '"',
        "„": '"',
        "‟": '"',
        "″": '"',
        "­": None,
        "​": None,
        "‌": None,
        "‍": None,
        "⁠": None,
        "﻿": None,
    }
)


def fold(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).translate(_FOLD)
    return " ".join(text.split())


def verify_quote(quote: str, text: str, folded_text: str | None = None) -> bool:
    needle = fold(quote)
    if len(needle) < MIN_QUOTE:
        return False
    return needle in (folded_text if folded_text is not None else fold(text))
