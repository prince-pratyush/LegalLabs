from collections.abc import Callable
from typing import Any

from .harnesses.base import Harness
from .harnesses.bm25 import Bm25Harness
from .harnesses.cell import ReviewCellHarness
from .harnesses.legallabs_search import LegalLabsSearchHarness
from .harnesses.legallabs_thread import LegalLabsThreadHarness
from .harnesses.model import NaiveRagHarness, PlainModelHarness
from .schemas import NonRetryableError
from .suites.base import Suite
from .suites.coverage_vdr import CoverageVdr
from .suites.extract_cuad import ExtractCuad
from .suites.extract_maud import ExtractMaud
from .suites.nli_contractnli import NliContractNli
from .suites.retrieval_golden import RetrievalGolden
from .suites.review_table_e2e import ReviewTableE2e
from .suites.thread_answers import Hallucination200, VerifierLive

HARNESSES: dict[str, type[Harness]] = {
    "bm25": Bm25Harness,
    "legallabs-search": LegalLabsSearchHarness,
    "legallabs-thread": LegalLabsThreadHarness,
    "model": PlainModelHarness,
    "naive-rag": NaiveRagHarness,
    "review-cell": ReviewCellHarness,
}

# Each factory takes the judges table, or None to grade without judges.
SUITES: dict[str, Callable[[dict[str, Any] | None, int], Suite]] = {
    "retrieval-golden": lambda judges, n: RetrievalGolden(),
    "extract-cuad": lambda judges, n: ExtractCuad(judges, judges_per_criterion=n),
    "nli-contractnli": lambda judges, n: NliContractNli(judges, judges_per_criterion=n),
    "hallucination-200": lambda judges, n: Hallucination200(judges, n),
    "verifier-live": lambda judges, n: VerifierLive(),
    "coverage-vdr": lambda judges, n: CoverageVdr(),
    # Graded by rules, not judges: the answers are typed values and checkable quotes.
    "extract-maud": lambda judges, n: ExtractMaud(),
    "review-table-e2e": lambda judges, n: ReviewTableE2e(),
}


def make_harness(name: str, system: dict[str, Any]) -> Harness:
    kind = HARNESSES.get(system["harness"])
    if kind is None:
        raise NonRetryableError(f"unknown harness {system['harness']!r} for system {name}")
    return kind(name, system)


def make_suite(name: str, judges: dict[str, Any] | None, judges_per_criterion: int) -> Suite:
    factory = SUITES.get(name)
    if factory is None:
        raise NonRetryableError(f"unknown suite {name!r}")
    return factory(judges, judges_per_criterion)
