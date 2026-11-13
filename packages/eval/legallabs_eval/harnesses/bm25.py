import math
import re
from collections import Counter

from ..schemas import Cost, Document, HarnessRequest, HarnessResult, Hit
from .base import Harness

MAX_CHUNK = 1500


def tokens(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower())


def chunk(doc: Document, size: int = MAX_CHUNK) -> list[Hit]:
    """Packs whole paragraphs into chunks, roughly as ingestion does."""
    hits: list[Hit] = []
    start = end = 0
    for para in re.finditer(r"[^\n]+(?:\n(?!\n)[^\n]*)*", doc.text):
        if end > start and para.end() - start > size:
            hits.append(Hit(doc.name, 1, start, end, doc.text[start:end]))
            start = para.start()
        end = para.end()
    if end > start:
        hits.append(Hit(doc.name, 1, start, end, doc.text[start:end]))
    return hits


class Bm25Harness(Harness):
    """An offline lexical baseline that needs no server, so CI can run a real suite."""

    kinds = frozenset({"retrieval"})

    def __init__(self, system_name: str, system: dict) -> None:
        super().__init__(system_name, system)
        params = system.get("params", {})
        self.k1 = float(params.get("k1", 1.2))
        self.b = float(params.get("b", 0.75))
        self.chunk_size = int(params.get("chunk_size", MAX_CHUNK))
        self.chunks: list[Hit] = []

    def prepare(self, corpus: list[Document]) -> None:
        self.chunks = [c for doc in corpus for c in chunk(doc, self.chunk_size)]
        self.tf = [Counter(tokens(c.text)) for c in self.chunks]
        self.lengths = [sum(t.values()) for t in self.tf]
        self.avg = sum(self.lengths) / len(self.lengths) if self.lengths else 0.0
        df: Counter[str] = Counter()
        for t in self.tf:
            df.update(t.keys())
        n = len(self.chunks)
        self.idf = {w: math.log(1 + (n - f + 0.5) / (f + 0.5)) for w, f in df.items()}

    def run(self, request: HarnessRequest) -> HarnessResult:
        query = set(tokens(request.task.problem))
        scored = []
        for i, tf in enumerate(self.tf):
            score = 0.0
            for w in query:
                f = tf.get(w, 0)
                if f:
                    norm = 1 - self.b + self.b * self.lengths[i] / self.avg
                    score += self.idf[w] * f * (self.k1 + 1) / (f + self.k1 * norm)
            if score > 0:
                scored.append((score, i))
        scored.sort(key=lambda s: (-s[0], s[1]))
        top = [self.chunks[i] for _, i in scored[: request.top_k or 10]]
        return HarnessResult(hits=top, provider="local", model="bm25", cost=Cost.free())
