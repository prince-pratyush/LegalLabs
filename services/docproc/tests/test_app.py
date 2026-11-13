import time

import fixtures
from fastapi.testclient import TestClient

from docproc.app import app
from docproc.runner import parse_isolated, run_isolated

client = TestClient(app)


def test_health():
    assert client.get("/health").json() == {"ok": True}


def test_parse_endpoint_runs_in_a_child_process():
    res = client.post(
        "/parse",
        files={"file": ("m.eml", fixtures.eml("hello"), "message/rfc822")},
        data={"name": "m.eml"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["pages"][0]["text"].endswith("hello")


def test_failures_are_values():
    res = client.post("/parse", files={"file": ("a.txt", b"hi")}, data={"name": "a.txt"})
    assert res.status_code == 200
    assert res.json() == {"ok": False, "reason": "UNSUPPORTED_TYPE"}


def test_hung_parse_is_killed():
    started = time.monotonic()
    try:
        run_isolated(time.sleep, (30,), timeout=1)
    except TimeoutError:
        pass
    else:
        raise AssertionError("expected timeout")
    assert time.monotonic() - started < 10


def test_timeout_is_a_reason():
    # No child can start and answer within zero seconds.
    assert parse_isolated(fixtures.eml("x"), "m.eml", timeout=0) == {
        "ok": False,
        "reason": "PARSE_TIMEOUT",
    }
