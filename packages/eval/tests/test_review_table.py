import csv
import io
import json
from pathlib import Path

import pytest

from legallabs_eval.harnesses.cell import ReviewCellHarness, typed_cell
from legallabs_eval.harnesses.model import PlainModelHarness
from legallabs_eval.models import recorded
from legallabs_eval.runner import Runner
from legallabs_eval.schemas import HarnessResult
from legallabs_eval.suites.extract_cuad import CuadGrader, ExtractCuad
from legallabs_eval.suites.extract_maud import ExtractMaud
from legallabs_eval.suites.review_table_e2e import (
    COLUMNS,
    UNKNOWN,
    ReviewTableE2e,
    gold_values,
    places,
)
from legallabs_eval.typed import match_option, money_all, parse_date, parse_money, verify_quote

CONTRACT = (
    "SUPPLY AGREEMENT made on the 6th day of April, 1999 between Acme Widgets, Inc. and "
    "Beta Stores LLC.\n\n"
    "1. Exclusivity. Beta Stores LLC shall be the exclusive reseller in Ruritania.\n\n"
    "2. Insurance. Each party shall carry insurance of not less than $5,000,000.\n\n"
    "3. Termination. Either party may terminate this Agreement for convenience on 30 days "
    "notice.\n\n"
    "4. Law. This Agreement is governed by the laws of the State of New York."
)
Q = 'Highlight the parts (if any) of this contract related to "{}" that should be reviewed.'
SPANS = {
    "Parties": ["Acme Widgets, Inc.", "Beta Stores LLC"],
    "Agreement Date": ["6th day of April, 1999"],
    "Governing Law": ["This Agreement is governed by the laws of the State of New York."],
    "Insurance": ["Each party shall carry insurance of not less than $5,000,000."],
    "Exclusivity": ["Beta Stores LLC shall be the exclusive reseller in Ruritania."],
    "Termination For Convenience": [
        "Either party may terminate this Agreement for convenience on 30 days notice."
    ],
}


def cell(value: object, quotes: list[str], not_found: bool = False) -> str:
    return json.dumps(
        {
            "value": value,
            "reasoning": "r",
            "citations": [{"document_id": "d", "page": 1, "quote": q} for q in quotes],
            "not_found": not_found,
        }
    )


@pytest.fixture
def cuad_file(tmp_path: Path) -> Path:
    qas = [
        {"id": f"x__{k}", "question": Q.format(k), "answers": [{"text": t} for t in v]}
        for k, v in SPANS.items()
    ]
    data = {"data": [{"title": "Acme Supply", "paragraphs": [{"context": CONTRACT, "qas": qas}]}]}
    path = tmp_path / "cuad.json"
    path.write_text(json.dumps(data))
    return path


@pytest.fixture
def maud_file(tmp_path: Path) -> Path:
    out = io.StringIO()
    fields = ["data_type", "contract_name", "text", "answer", "label", "question"]
    fields += ["subquestion", "text_type", "id", "category"]
    w = csv.DictWriter(out, fieldnames=fields)
    w.writeheader()
    base = {"data_type": "main", "text_type": "t", "id": "3", "category": "General"}
    w.writerow(
        base
        | {
            "contract_name": "c1",
            "text": "Each Share shall be converted into the right to receive $10.00 in cash.",
            "answer": "All Cash",
            "label": "0",
            "question": "Type of Consideration-Answer",
            "subquestion": "<NONE>",
        }
    )
    w.writerow(
        base
        | {
            "contract_name": "c2",
            "text": "Each Share shall be converted into 2 shares of Parent Common Stock.",
            "answer": "All Stock",
            "label": "1",
            "question": "Type of Consideration-Answer",
            "subquestion": "<NONE>",
        }
    )
    w.writerow(base | {"data_type": "abridged", "contract_name": "c1", "text": "x"} | {
        "answer": "All Cash", "label": "0", "question": "Type of Consideration-Answer",
        "subquestion": "<NONE>"})  # fmt: skip
    path = tmp_path / "maud.csv"
    path.write_text(out.getvalue())
    return path


def test_parsers() -> None:
    assert parse_date("6th day of April, 1999")["iso"] == "1999-04-06"
    assert parse_date("30  day of June 2016")["iso"] == "2016-06-30"
    assert parse_date("March 3, 2019") == {"kind": "date", "iso": "2019-03-03", "precision": "day"}
    assert parse_date("July 2018")["precision"] == "month"
    assert parse_date("no date") is None
    assert parse_money("USD 1.5 million") == {
        "kind": "currency",
        "amount": "1500000.00",
        "currency": "USD",
    }
    assert parse_money("$5,000,000")["amount"] == "5000000.00"
    assert [m["currency"] for m in money_all("€10 and 20 pounds")] == ["EUR", "GBP"]
    assert match_option("yes", ["Yes", "No"]) == "Yes"
    assert match_option("Yes and No", ["Yes", "No"]) is None
    assert places("governed by the laws of the State of West Virginia") == ["west virginia"]
    assert places("the People’s Republic of China") == ["china"]


def test_quote_check_folds_marks_and_spaces() -> None:
    text = "The “Company” shall\n  pay the fee."
    assert verify_quote('The "Company" shall pay the fee.', text)
    assert not verify_quote("The Company shall pay", text)
    assert not verify_quote("pay the", text)  # too short to prove anything


def test_typed_cell_rules() -> None:
    date = {"key": "d", "type": "date"}
    done = typed_cell(
        date, json.loads(cell("April 6, 1999", ["6th day of April, 1999"])), CONTRACT, CONTRACT
    )
    assert done["status"] == "done" and done["value_typed"]["iso"] == "1999-04-06"
    assert done["citations"] == [{"quote": "6th day of April, 1999", "verified": True}]
    assert (
        typed_cell(date, json.loads(cell("soon", [])), CONTRACT, CONTRACT)["error_code"]
        == "PARSE_FAILED"
    )
    null = typed_cell(
        date, json.loads(cell(None, ["made up quote here"], True)), CONTRACT, CONTRACT
    )
    assert null["status"] == "null" and null["citations"] == []
    verbatim = {"key": "v", "type": "verbatim"}
    bad = typed_cell(
        verbatim, json.loads(cell("Either party may quit at will.", [])), CONTRACT, CONTRACT
    )
    assert bad["error_code"] == "CITATION_UNVERIFIED"
    assert typed_cell(date, None, CONTRACT, CONTRACT)["error_code"] == "INVALID_OUTPUT"
    classify = {"key": "c", "type": "classify", "options": ["Yes", "No"]}
    assert (
        typed_cell(classify, json.loads(cell("Maybe", [])), CONTRACT, CONTRACT)["error_code"]
        == "PARSE_FAILED"
    )


def test_gold_rules() -> None:
    gold = gold_values(SPANS)
    assert gold["agreement_date"]["iso"] == "1999-04-06"
    assert gold["governing_law"] == ["new york"]
    assert gold["insurance_amount"][0]["amount"] == "5000000.00"
    assert gold["exclusivity"] == "Yes"
    empty = gold_values({"Parties": ["Acme Widgets, Inc."], "Governing Law": ["Laws of Utopia"]})
    assert empty["agreement_date"] is None and empty["governing_law"] == UNKNOWN
    assert empty["exclusivity"] == "No" and empty["termination_for_convenience"] is None


REPLIES = [
    cell("Acme Widgets, Inc.; Beta Stores LLC", ["Acme Widgets, Inc. and Beta Stores LLC"]),
    cell("6th day of April, 1999", ["6th day of April, 1999"]),
    cell("New York", ["governed by the laws of the State of New York"]),
    cell("$5,000,000", ["insurance of not less than $9,000,000"]),  # wrong and unverifiable
    cell("Yes", ["shall be the exclusive reseller in Ruritania"]),
    cell(None, [], True),  # misses the termination clause
]


def test_review_table_offline_run(cuad_file: Path, tmp_path: Path) -> None:
    suite = ReviewTableE2e(local=cuad_file)
    system = {
        "harness": "review-cell",
        "vendor": "ollama",
        "params": {"model": "qwen3:4b-instruct"},
    }
    harness = ReviewCellHarness("qwen-cell", system, send=recorded(REPLIES))
    summary = Runner("qwen-cell", system, harness, suite, tmp_path / "runs", retry_delay=0).run()
    report = summary["report"]
    assert summary["completed_tasks"] == 1
    assert report["cells_scored"] == len(COLUMNS)
    assert report["cell_accuracy"] == pytest.approx(5 / 6, abs=1e-3)
    assert report["by_column"]["termination_for_convenience"]["accuracy"] == 0.0
    assert report["valid_citation_rate"] == pytest.approx(4 / 5, abs=1e-3)
    assert report["null_precision"] == 0.0
    assert report["cost_usd"] == 0.0
    assert report["gates"]["valid_citation_rate>=0.95"] is False
    assert suite.corpus()[0].text == CONTRACT


def test_long_document_uses_retrieval() -> None:
    system = {"vendor": "ollama", "params": {"model": "m", "context_tokens": 400}}
    harness = ReviewCellHarness("x", system, send=recorded([]))
    filler = "\n\n".join(f"Clause {i}. Boilerplate about notices and filings." for i in range(200))
    text, looked = harness.context("d", filler + "\n\nGoverned by the laws of Utopia.", COLUMNS[2])
    assert looked["mode"] == "retrieval" and "Utopia" in text
    assert len(text) < len(filler)


def test_cuad_grader_reads_a_cell() -> None:
    task = ExtractCuad(local=None)  # only the grader is used
    del task
    grader = CuadGrader(None)
    from legallabs_eval.schemas import TaskDatum

    datum = TaskDatum(
        "t",
        "q",
        ["Governed by the laws of Ruritania."],
        {"category": "Law"},
        "Governed by the laws of Ruritania.",
    )
    answer = {
        "cells": {
            "clause": {
                "citations": [{"quote": "Governed by the laws of Ruritania.", "verified": True}]
            }
        }
    }
    graded = grader.grade(datum, HarnessResult(answer=json.dumps(answer)), Path("."))
    assert graded.metrics["f1"] == 1.0 and graded.metrics["valid_quote_rate"] == 1.0


def test_maud_plain_and_cited(maud_file: Path, tmp_path: Path) -> None:
    suite = ExtractMaud(local=maud_file)
    tasks = suite.load_tasks()
    assert len(tasks) == 2  # abridged rows are left out
    assert tasks[0].metadata["options"] == ["All Cash", "All Stock"]
    by_contract = {t.metadata["contract"]: t for t in tasks}
    order = [t.metadata["contract"] for t in tasks]

    plain_replies = {
        "c1": json.dumps({"answer": "All Cash", "quotes": ["right to receive $10.00 in cash"]}),
        "c2": json.dumps({"answer": "All Cash", "quotes": ["2 shares of Parent stock"]}),
    }
    system = {"harness": "model", "vendor": "ollama", "params": {"model": "qwen3:4b-instruct"}}
    harness = PlainModelHarness("p", system, send=recorded([plain_replies[c] for c in order]))
    summary = Runner(
        "p", system, harness, suite, tmp_path / "a", concurrency=1, retry_delay=0
    ).run()
    assert summary["failed_as_zero"] == 0.5
    assert summary["report"]["valid_citation_rate"] == 0.5

    stock = "converted into 2 shares of Parent Common Stock"
    cited = {"c1": cell("All Cash", ["right to receive $10.00 in cash"]),
             "c2": cell("All Stock", [stock])}  # fmt: skip
    system = {
        "harness": "review-cell",
        "vendor": "ollama",
        "params": {"model": "qwen3:4b-instruct"},
    }
    harness = ReviewCellHarness("c", system, send=recorded([cited[c] for c in order]))
    summary = Runner(
        "c", system, harness, suite, tmp_path / "b", concurrency=1, retry_delay=0
    ).run()
    assert summary["failed_as_zero"] == 1.0
    assert summary["report"]["valid_citation_rate"] == 1.0
    assert by_contract["c2"].answer == "All Stock"


def test_spread_sample_sets_the_corpus(cuad_file: Path) -> None:
    suite = ReviewTableE2e(local=cuad_file)
    suite.load_tasks()
    suite.selected([])
    assert suite.corpus() == []


def test_spread_takes_evenly_spaced_tasks(maud_file: Path, tmp_path: Path) -> None:
    suite = ExtractMaud(local=maud_file)
    system = {"harness": "model", "vendor": "ollama", "params": {"model": "m"}}
    reply = json.dumps({"answer": "All Cash", "quotes": []})
    harness = PlainModelHarness("p", system, send=recorded([reply]))
    runner = Runner("p", system, harness, suite, tmp_path, retry_delay=0, spread=True)
    assert runner.manifest["sample"] == "spread"
    assert runner.run(limit=1)["selected_tasks"] == 1
