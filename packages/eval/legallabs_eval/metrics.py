import math
import re
from collections.abc import Sequence
from dataclasses import dataclass

from .schemas import Hit


@dataclass(frozen=True)
class Relevant:
    doc: str
    page: int | None
    span: tuple[int, int] | None


def _matches(hit: Hit, rel: Relevant) -> bool:
    if hit.doc != rel.doc:
        return False
    if rel.page is not None and hit.page is not None and hit.page != rel.page:
        return False
    if rel.span is None or hit.char_from is None or hit.char_to is None:
        return True
    return hit.char_from < rel.span[1] and rel.span[0] < hit.char_to


def _found(hits: Sequence[Hit], relevant: Sequence[Relevant]) -> list[bool]:
    """Marks each hit that finds a relevant item not already found, so repeats earn nothing."""
    remaining = list(relevant)
    gains = []
    for hit in hits:
        match = next((r for r in remaining if _matches(hit, r)), None)
        if match is not None:
            remaining.remove(match)
        gains.append(match is not None)
    return gains


def ndcg_at(hits: Sequence[Hit], relevant: Sequence[Relevant], k: int) -> float:
    if not relevant:
        return 0.0
    gains = _found(hits[:k], relevant)
    dcg = sum(1 / math.log2(i + 2) for i, g in enumerate(gains) if g)
    ideal = sum(1 / math.log2(i + 2) for i in range(min(len(relevant), k)))
    return dcg / ideal


def recall_at(hits: Sequence[Hit], relevant: Sequence[Relevant], budget: int) -> float:
    if not relevant:
        return 0.0
    return sum(_found(hits[:budget], relevant)) / len(relevant)


def _tokens(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower())


def token_f1(predicted: str, gold: str) -> float:
    p, g = _tokens(predicted), _tokens(gold)
    if not p and not g:
        return 1.0
    if not p or not g:
        return 0.0
    common = 0
    pool = list(g)
    for t in p:
        if t in pool:
            pool.remove(t)
            common += 1
    if common == 0:
        return 0.0
    precision, recall = common / len(p), common / len(g)
    return 2 * precision * recall / (precision + recall)


def span_iou(a: set[int], b: set[int]) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)
