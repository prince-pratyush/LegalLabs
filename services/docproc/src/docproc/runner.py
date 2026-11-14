import multiprocessing
import os
import signal
from collections.abc import Callable
from typing import Any

from docproc.parse import parse

DEFAULT_TIMEOUT = float(os.environ.get("DOCPROC_TIMEOUT_SECONDS", "120"))

# forkserver keeps the server's threads out of the child and starts faster than spawn.
_ctx = multiprocessing.get_context("forkserver")
_ctx.set_forkserver_preload(["docproc.parse"])


class ChildDied(Exception):
    pass


def _child(conn, fn, args) -> None:
    # Own process group so OCR subprocesses die with us on timeout.
    os.setsid()
    try:
        conn.send(fn(*args))
    finally:
        conn.close()


def run_isolated(fn: Callable[..., Any], args: tuple, timeout: float) -> Any:
    recv, send = _ctx.Pipe(duplex=False)
    proc = _ctx.Process(target=_child, args=(send, fn, args), daemon=True)
    proc.start()
    send.close()
    try:
        if not recv.poll(timeout):
            raise TimeoutError
        try:
            return recv.recv()
        except EOFError as exc:
            raise ChildDied from exc
    finally:
        if proc.is_alive():
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                # Already exiting (macOS refuses killpg on a zombie leader).
                proc.kill()
        proc.join()
        recv.close()


def parse_isolated(data: bytes, name: str, timeout: float = DEFAULT_TIMEOUT) -> dict:
    try:
        return run_isolated(parse, (data, name), timeout)
    except TimeoutError:
        return {"ok": False, "reason": "PARSE_TIMEOUT"}
    except ChildDied:
        return {"ok": False, "reason": "INTERNAL"}
