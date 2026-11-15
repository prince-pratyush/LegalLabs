# playbook-review

Scores the playbook review engine (`@legallabs/review`, `runReview`) against held-out
synthetic contracts and the starter NDA and MSA playbooks (`@legallabs/contracts`).
Spec: playbooks-word.md §4.3, §9 and WRD-002/003/006; 04-ai-design.md §4.3 and §6.2.

## What it measures

| Metric (report key)                            | Definition                                                                                                                                                                                                                                                                                                                                | Gate                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `playbook.rule_classification_accuracy`        | Findings whose status equals the gold status, over every rule of every contract (a rule with no finding counts as wrong; `skipped` is left out). Pooled, with a Wilson 95% interval.                                                                                                                                                      | ≥ 0.80                   |
| `playbook.unanticipated_edit_detection_recall` | Injected unusual clauses and counterparty tracked changes that have a gap whose evidence sits in the injected paragraph. Also split by kind, and for tracked changes without the engine's catch-all gap (`existing_edit_by_model`).                                                                                                       | ≥ 0.90                   |
| `playbook.evidence_verification_rate`          | Evidence quotes on findings marked `verified: ok`.                                                                                                                                                                                                                                                                                        | ≥ 0.99                   |
| `playbook.ooxml_validity_rate`                 | Each suggestion patched alone with `patchDocx`, re-read with `readDocx`, and its `after` text found in the target paragraph; over suggestions that applied. Anchor failures are reported beside it. With `SOFFICE_TEST=1` the file with every suggestion applied is also converted to PDF by LibreOffice, and any failure fails the gate. | = 1.0                    |
| `latency`                                      | Wall time per contract (`runReview` only), its p50, and seconds per 40 pages (`wall / estimatePages(chars) × 40`).                                                                                                                                                                                                                        | p50 per 40 pages ≤ 300 s |

The report also has the status confusion matrix, token totals and model-call counts.
A run with any failed contract fails the gate.

## Corpus

`node/generate.ts` writes the corpus from a seed; only the generator is committed. The
suite regenerates it into `runs/.corpus/` on each run (about a second), and the dataset
fingerprint is the hash of `gold.json`, so a changed generator never reuses old results.

- Default: seed 7, 16 contracts (8 NDA, 8 MSA), 318 pages, with page targets 3, 5, 8, 12,
  18, 25, 40 and 40 per template. `LEGALLABS_PLAYBOOK_SEED` and `LEGALLABS_PLAYBOOK_COUNT`
  change it. Contracts are ordered shortest first, so `--limit N` takes the quick ones.
- `node/clauses.ts` has, for each of the 41 starter rules, a standard-position, a fallback
  and an unacceptable clause, written fresh. Each contract picks one variant per rule, or
  leaves the clause out. Gold: standard and fallback are `acceptable`, unacceptable is
  `not_acceptable`, omitted is `not_found`. No `needs_review` gold is generated, so a
  `needs_review` finding is always counted wrong. The default corpus has 171 acceptable,
  80 not acceptable and 77 not found: always answering "acceptable" scores 52%.
- Held out: `generate.test.ts` fails if any 8-word run of a starter's `sample_language`
  appears in any clause text.
- Injected unanticipated edits, each gold as a gap: one or two unusual clauses no rule
  covers (a right of first refusal, a most-favoured-customer clause, a non-compete on our
  client, an evaluation fee, a costs shift, a receivables carve-out from the transfer
  clause, a minimum spend, unilateral amendment, exclusivity), and one or two counterparty
  tracked changes to boilerplate (notices, variation, costs, waiver, entire agreement,
  agency, counterparts, severance) made with `patchDocx` as a different author, so the
  files hold real `w:ins`/`w:del` runs.
- Long contracts are padded with operational schedule items that add no terms.

## Running it

Needs Node 22.18 or later (type stripping), pnpm and uv.

```sh
pnpm install
pnpm --filter "@legallabs/eval^..." build    # contracts, docx, review, model-gateway
cd packages/eval
uv sync
# Offline, canned replies; CI runs this. Its scores mean nothing.
uv run legallabs-eval run --system playbook-fake --suite playbook-review
# Local model, one contract at a time, short contracts first.
uv run legallabs-eval run --system playbook-ollama --suite playbook-review --concurrency 1 --limit 3
# Add the LibreOffice check to any run:
SOFFICE_TEST=1 uv run legallabs-eval run --system playbook-fake --suite playbook-review
```

`node node/run.ts --contract <file> --template nda|msa --client <client>` reviews one
contract by hand; `node node/generate.ts --out <dir>` writes the corpus.

Systems (`systems.toml`): `playbook-fake`, `playbook-ollama` (qwen3:4b-instruct),
`playbook-gateway-haiku` (the model gateway's Anthropic route, `claude-haiku-5-5`),
`playbook-claude-sonnet` and `playbook-gpt` (direct API calls, since the gateway routes
neither `claude-sonnet-5-5` nor any OpenAI model).

Committed baselines live in `results/playbook-review/`: `summary.json` and
`run_config.json` only, with the run directory made relative. Traces stay in `runs/`.

## Baseline: local model, 15 November 2026

`results/playbook-review/2026-11-15-playbook-ollama-limit3/`: `qwen3:4b-instruct` (Q4_K_M)
on Ollama, an 8 GB Apple-silicon laptop with 12–32% memory free during the run, one
contract and one model call at a time, `num_ctx` 8192, 600 s rule and call timeouts. Only
the three shortest contracts (`--limit 3`: 4, 4 and 6 pages, 57 rule findings, 10
injected edits); no 40-page contract was run locally, as one would take hours.

| Metric                                                | Result                                                         | 95% CI  | Gate          |
| ----------------------------------------------------- | -------------------------------------------------------------- | ------- | ------------- |
| Rule classification accuracy                          | 71.9% (41/57)                                                  | 59–82%  | ≥ 80%: fail   |
| Gap recall                                            | 100% (10/10)                                                   | 72–100% | ≥ 90%: pass   |
| Gap recall, tracked changes found by the model itself | 100% (6/6)                                                     | 61–100% |               |
| Evidence verification                                 | 93.9% (46/49)                                                  | 83–98%  | ≥ 99%: fail   |
| OOXML validity (re-read)                              | 100% (25/25), and LibreOffice converted all 3 patched files    | 87–100% | 100%: pass    |
| Latency                                               | p50 1,508 s per contract; 10,053 s per 40 pages (extrapolated) |         | ≤ 300 s: fail |

Most misses are acceptable clauses called not acceptable (9 of 29) and omitted clauses
called needs review (3 of 12). Tokens: 96,464 in and 17,739 out over 70 calls. With
three contracts the intervals are wide; the 80% gate is inside the accuracy interval.

`2026-11-15-playbook-fake-soffice/` is the full corpus with canned replies and
`SOFFICE_TEST=1`: every one of the 10 patched files converted to PDF. Its accuracy and
recall numbers measure nothing.

## Paid runs

Not run: the eval budget is $0. Each command runs the full default corpus (16 contracts,
318 pages); add `--limit N` for a sample and `SOFFICE_TEST=1` for the LibreOffice check.

```sh
cd packages/eval
# The gateway's Anthropic provider (gatewayOptionsFromEnv reads ANTHROPIC_API_KEY).
ANTHROPIC_API_KEY=... uv run legallabs-eval run --system playbook-gateway-haiku --suite playbook-review --concurrency 4
# Claude Sonnet 5.5, direct (the gateway routes only claude-haiku-5-5).
ANTHROPIC_API_KEY=... uv run legallabs-eval run --system playbook-claude-sonnet --suite playbook-review --concurrency 4
# OpenAI gpt-5.5, direct: the gateway has no OpenAI provider; gpt-5.5 is the model systems.toml already names.
OPENAI_API_KEY=... uv run legallabs-eval run --system playbook-gpt --suite playbook-review --concurrency 4
```

Cost per full run, estimated from the local run's tokens per phase: the clause map and gap
pass took about 2,000 input and 300 output tokens per page; the rule subagents about
18,000 in and 3,400 out per NDA (16 rules) and 33,000 in and 6,500 out per MSA (25 rules),
retries included. For 318 pages, 8 NDAs and 8 MSAs that is about 1.05 M input and
0.18 M output tokens. Priced with `legallabs_eval/costs.py`:

| System                   | Model             | $/M in, out | Per full run |
| ------------------------ | ----------------- | ----------- | ------------ |
| `playbook-claude-sonnet` | claude-sonnet-5-5 | 3, 15       | ≈ $5.85      |
| `playbook-gpt`           | gpt-5.5           | 1.25, 10    | ≈ $3.10      |
| `playbook-gateway-haiku` | claude-haiku-5-5  | 1, 5        | ≈ $1.95      |

Treat these as ±50%: other tokenizers, fewer retries from stronger models, and OpenAI
reasoning tokens (billed as output) all move them. The gateway's own route table prices
`claude-haiku-5-5` at $0.10/$0.50, a tenth of `costs.py`; the suite prices from
`costs.py`. Neither table was checked against the providers' current price pages.

## Caveats

- Gap recall for tracked changes is near-guaranteed: the engine adds a low-severity gap
  for any substantive tracked change the model passes over.
  `existing_edit_by_model` leaves those out.
- Gold is the generator's label, not a lawyer's. Some rules overlap (the MSA's three data
  protection rules, termination for cause and change of control), so a model can argue
  with a label.
- The fake client's scores only prove the pipeline: generation, review, scoring, patching.
