import argparse
import json
import sys
from pathlib import Path

from .config import DEFAULT_SYSTEMS, load_config
from .registry import SUITES, make_harness, make_suite
from .runner import Runner
from .schemas import HarnessError, NonRetryableError
from .suites.coverage_vdr import DEFAULT_DOCS, DEFAULT_SEED, write_room


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="legallabs-eval")
    parser.add_argument("--systems", type=Path, default=DEFAULT_SYSTEMS)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="show systems and suites")
    run = commands.add_parser("run", help="run one suite against one system")
    run.add_argument("--system", required=True)
    run.add_argument("--suite", required=True, choices=sorted(SUITES))
    run.add_argument("--limit", type=int)
    run.add_argument("--concurrency", type=int, default=4)
    run.add_argument("--suffix", default="")
    run.add_argument("--runs-dir", type=Path, default=Path("runs"))
    run.add_argument("--no-judge", action="store_true", help="skip paid judge criteria")
    room = commands.add_parser("make-room", help="write a coverage-vdr data room to disk")
    room.add_argument("--out", type=Path, required=True)
    room.add_argument("--docs", type=int, default=DEFAULT_DOCS)
    room.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args(argv)

    if args.command == "make-room":
        count = write_room(args.out, args.docs, args.seed)
        print(f"wrote {count} contracts to {args.out}")
        return 0

    config = load_config(args.systems)
    systems = config.get("systems", {})
    if args.command == "list":
        for name, system in systems.items():
            print(f"system  {name:24} harness={system['harness']}")
        for name in sorted(SUITES):
            print(f"suite   {name}")
        return 0

    if args.system not in systems:
        print(f"failed: no system named {args.system}", file=sys.stderr)
        return 2
    system = systems[args.system]
    judges = None if args.no_judge else config.get("judges")
    per_criterion = int(config.get("grading", {}).get("judges_per_criterion", 2))
    try:
        suite = make_suite(args.suite, judges, per_criterion)
        harness = make_harness(args.system, system)
        runner = Runner(
            args.system, system, harness, suite, args.runs_dir, args.suffix, args.concurrency
        )
        summary = runner.run(args.limit)
    except (HarnessError, NonRetryableError, ValueError) as err:
        print(f"failed: {err}", file=sys.stderr)
        return 1
    print(json.dumps(summary, indent=2))
    return 0
