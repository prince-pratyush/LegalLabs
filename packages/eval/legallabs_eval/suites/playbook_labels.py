"""Accepted statuses per rule, derived from which clause variants a contract holds.

gold.json records each rule's variant and its plain status. Some rules can be judged
more than one defensible way once the rest of the contract is taken into account; those
get a set of accepted statuses here, with the reason. `strict` accuracy (plain status
only) is reported beside the gate figure. Only NDA Mutuality drops its plain status: it is
relabelled from the symmetry of the whole document.
"""

import json
from functools import cache
from pathlib import Path
from typing import Any

STARTERS = Path(__file__).resolve().parents[3] / "contracts" / "playbooks" / "starters"

# Rules whose standard position is that no such clause exists: leaving it out meets it.
NO_CLAUSE_RULES = {
    ("nda", "Residuals"),
    ("nda", "Non-Solicitation"),
    ("msa", "Non-Solicitation"),
}

# NDA clause variants that bind only Ardent or help only Corvane. One of them anywhere
# makes the agreement one-sided, whatever its mutuality clause says.
ONE_SIDED_VARIANTS = {
    "Mutuality": {"unacceptable"},
    "No Licence or Transfer of IP": {"unacceptable"},
    "Remedies and Injunctive Relief": {"unacceptable"},
    "Non-Solicitation": {"unacceptable"},
    "Personal Information": {"unacceptable"},
    "No Warranty and No Obligation to Proceed": {"unacceptable"},
    "Assignment": {"unacceptable"},
}
# Counterparty edits that shift a cost or a right to one side (notices and waiver don't).
ONE_SIDED_EDITS = {"variation", "costs", "entire_agreement", "agency", "counterparts", "severance"}

# The MSA's three data-protection rules read the same clauses: with one omitted and a
# sibling present, a reviewer may judge it from the sibling.
DATA_TRIO = {"Data Protection", "Processor Terms (EU/UK GDPR)", "Privacy Act Compliance (AU)"}

# Planted clauses that also bear on a rule: the rule may be marked down because of them.
OVERLAPS = {
    "receivables_carve_out": {"Assignment", "Assignment and Change of Control"},
    "minimum_commitment": {"Payment Terms"},
}
DOUBT = {"needs_review", "not_acceptable"}


@cache
def flagged(template: str) -> frozenset[str]:
    rules = json.loads((STARTERS / f"{template}.json").read_text())["rules"]
    return frozenset(r["title"] for r in rules if r.get("flag"))


def one_sided(contract: dict[str, Any]) -> bool:
    if contract["template"] != "nda":
        return False
    for r in contract["rules"]:
        if r["variant"] in ONE_SIDED_VARIANTS.get(r["rule"], set()) and r["rule"] != "Mutuality":
            return True
    for inj in contract["injected"]:
        # Every planted NDA clause binds Ardent alone.
        if inj["kind"] == "uncovered_clause" or inj["key"] in ONE_SIDED_EDITS:
            return True
    return False


def accepted(contract: dict[str, Any]) -> dict[str, tuple[set[str], list[str]]]:
    """Rule title -> (accepted statuses, reasons the set is wider than the plain status)."""
    template = contract["template"]
    variants = {r["rule"]: r["variant"] for r in contract["rules"]}
    planted = {i["key"] for i in contract["injected"] if i["kind"] == "uncovered_clause"}
    asymmetric = one_sided(contract)
    out: dict[str, tuple[set[str], list[str]]] = {}
    for r in contract["rules"]:
        rule, variant = r["rule"], r["variant"]
        ok, why = {r["status"]}, []
        if template == "nda" and rule == "Mutuality" and variant != "unacceptable":
            # Judged on the whole document, which every planted NDA clause makes one-sided.
            if asymmetric:
                ok = DOUBT | ({"not_found"} if variant == "omitted" else set())
                why.append("one-sided terms elsewhere")
            elif variant == "omitted":
                ok |= {"acceptable"}
                why.append("symmetric document")
        if variant == "omitted" and (template, rule) in NO_CLAUSE_RULES:
            ok |= {"acceptable"}
            why.append("standard position is no clause")
        if variant == "fallback" and rule in flagged(template):
            ok |= {"needs_review"}
            why.append("flagged rule on a fallback")
        if (
            template == "msa"
            and variant == "omitted"
            and rule in DATA_TRIO
            and any(variants.get(s) != "omitted" for s in DATA_TRIO - {rule})
        ):
            ok |= {"needs_review"}
            why.append("data-protection sibling present")
        for key, rules in OVERLAPS.items():
            if key in planted and rule in rules:
                ok |= DOUBT
                why.append(f"overlaps planted {key}")
        out[rule] = (ok, why)
    return out
