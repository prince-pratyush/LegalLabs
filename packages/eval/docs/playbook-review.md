# playbook-review

Scores the playbook review engine (`@legallabs/review`, `runReview`) against held-out
synthetic contracts and the starter NDA and MSA playbooks (`@legallabs/contracts`).
Spec: playbooks-word.md §4.3, §9 and WRD-002/003/006; 04-ai-design.md §4.3 and §6.2.

## What it measures

Every rate is pooled over contracts and reported with a Wilson 95% interval and a
bootstrap 95% interval that resamples whole contracts (rules in one contract are not
independent, so the bootstrap is the honest one).

| Metric (report key)                            | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Gate          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `playbook.rule_classification_accuracy`        | A finding is right when its status is in the rule's accepted set (below). Every rule of every contract counts; a rule with no finding is wrong; `skipped` is left out. Also reported: `strict` (plain gold status only), by variant, by template, and wrong calls split into verifier downgrades (`wrong_unverified`) and real misclassifications.                                                                                                                                                                                                                              | ≥ 0.80        |
| `playbook.unanticipated_edit_detection_recall` | A planted item is found when a gap of the same kind (tracked change: `existing_edit`; planted clause: `uncovered_clause`, per WRD-002-d) has evidence in its paragraph. `system` counts every gap the engine returns, including its deterministic guard gap for a tracked change the model passed over; the spec makes that guard part of the product, so **`system` is the gate figure**. `model_only` leaves the guard out. `precision_vs_planted` is the share of reported gaps that match a planted item; a gap elsewhere can still be a fair find, so it is a lower bound. | system ≥ 0.90 |
| `playbook.evidence_verification_rate`          | Evidence quotes on findings marked `verified: ok`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ≥ 0.99        |
| `playbook.ooxml_validity_rate`                 | Each suggestion patched alone with `patchDocx`, re-read with `readDocx`, and its `after` text found in the target paragraph; over suggestions that applied. Anchor failures are reported beside it. With `SOFFICE_TEST=1` the file with every suggestion applied is also converted to PDF by LibreOffice, and any failure fails the gate.                                                                                                                                                                                                                                       | = 1.0         |
| `latency`                                      | Wall time of `runReview` per contract, all listed. The gate is the p50 over contracts of 35 pages or more; with none, it is "not measured" and the gate does not pass. Short contracts are never scaled up to stand in.                                                                                                                                                                                                                                                                                                                                                         | p50 ≤ 300 s   |

A gate with no data is `null` and never passes; a run with any failed contract fails.

### Accepted statuses (`legallabs_eval/suites/playbook_labels.py`)

Plain gold: standard and fallback variants are `acceptable`, unacceptable is
`not_acceptable`, an omitted clause is `not_found`. Where a second answer is defensible,
the rule accepts a set:

- **No-clause rules** (NDA Residuals, NDA Non-Solicitation, MSA Non-Solicitation): the
  standard position is that no such clause exists, so an omitted clause also accepts
  `acceptable`.
- **NDA Mutuality** is judged on the whole document. Any clause binding only Ardent (an
  unacceptable variant of IP, remedies, non-solicitation, personal information, warranty
  or assignment, any planted clause, or a one-sided counterparty edit) makes it one-sided:
  then a standard or fallback mutuality clause accepts `needs_review` or
  `not_acceptable`, and an omitted one also `not_found`. Every generated NDA has a planted
  clause, so in practice mutuality is never plainly acceptable. This is the one rule whose
  plain status can fall out of the set.
- **Flagged rules on a fallback** also accept `needs_review` (the playbook asks for a
  reviewer's eyes on flagged rules).
- **Known overlaps.** The MSA's data-protection trio (Data Protection, Processor Terms
  (EU/UK GDPR), Privacy Act Compliance (AU)): an omitted member with a sibling present also
  accepts `needs_review`. A planted receivables carve-out bears on Assignment (NDA) and
  Assignment and Change of Control (MSA), and a planted minimum spend on Payment Terms:
  those rules also accept `needs_review` and `not_acceptable`. For gaps the overlap is not
  relaxed: a planted clause the clause map assigns to a rule never reaches the gap pass
  and counts as missed.

On the default corpus 43 of 328 labels are widened; always answering "acceptable" scores
52%.

## Corpus

`node/generate.ts` writes the corpus from a seed; only the generator is committed. Each
run writes it once to `runs/.corpus/playbook-v<version>-s<seed>-n<count>-<gold hash>`
(a temporary directory renamed into place, so runs in parallel cannot clobber each
other), and the dataset fingerprint is the gold hash.

- Default: seed 7, 16 contracts (8 NDA, 8 MSA), 318 pages, page targets 3, 5, 8, 12, 18,
  25, 40 and 40 per template. `LEGALLABS_PLAYBOOK_SEED` and `LEGALLABS_PLAYBOOK_COUNT`
  change it. Contracts run shortest first, so `--limit N` takes the quick ones.
- `node/clauses.ts` has a standard-position, fallback and unacceptable clause for each of
  the 41 starter rules; each contract picks one per rule or leaves the clause out.
- **Held out**, enforced by `generate.test.ts`: no 8-word run of any `sample_language`
  appears anywhere, and no variant shares more than 20% of its 3-grams with its rule's
  standard position, fallbacks, unacceptable text and sample language. Generator v1 failed
  the second check for 70 of 123 variants (up to 56%); v2 rewords them, keeping the same
  variant choice and planted positions for a seed.
- Planted unanticipated edits, each gold as a gap: one or two clauses no rule covers (right
  of first refusal, most-favoured customer, non-compete on our client, evaluation fee,
  costs shift, receivables carve-out, minimum spend, unilateral amendment, exclusivity),
  and one or two counterparty tracked changes to boilerplate made with `patchDocx` as
  another author, so the files hold real `w:ins`/`w:del` runs.
- Long contracts are padded with operational schedule items that add no terms.

## Running it

Needs Node 22.18 or later (type stripping), pnpm and uv.

```sh
pnpm install
pnpm --filter "@legallabs/eval^..." build    # contracts, docx, review, model-gateway
cd packages/eval
uv sync
# Offline, canned replies; CI runs this. Its scores only prove the pipeline.
uv run legallabs-eval run --system playbook-fake --suite playbook-review --fail-on-task-errors
# Local model, one contract at a time, shortest first.
uv run legallabs-eval run --system playbook-ollama --suite playbook-review --concurrency 1 --limit 3
# LibreOffice check on any run:
SOFFICE_TEST=1 uv run legallabs-eval run --system playbook-fake --suite playbook-review
# Grade saved outcomes again (no model calls):
uv run legallabs-eval rescore --gold <corpus dir with gold.json> --outcomes <dir of <id>.json>
```

`node node/run.ts --contract <file> --template nda|msa --client <client>` reviews one
contract by hand; `node node/generate.ts --out <dir>` writes the corpus.

Systems (`systems.toml`): `playbook-fake`, `playbook-ollama` (qwen3:4b-instruct),
`playbook-gateway-haiku` (the model gateway's Anthropic route, `claude-haiku-5-5`),
`playbook-claude-sonnet` and `playbook-gpt` (direct API calls: the gateway routes neither
`claude-sonnet-5-5` nor any OpenAI model).

### Reproducibility

- Rule ids come from the template and rule title, not a random UUID.
- Ollama runs with a fixed seed (0) at temperature 0.
- Each outcome records the Node version, the engine hash and, for Ollama, its version and
  the model digest. The engine hash covers the built `review`, `contracts` and `docx`
  packages, the starter playbooks and `node/*.ts`.
- The engine hash is part of the config hash, so a rebuilt engine never reuses old
  results. The summary's `environment` records the git SHA (and whether the tree was dirty),
  Node, the engine hash and the Ollama facts.
- `run.ts` records every model that answered (`CompleteResult.model`). The suite prices
  that model, and the run fails (exit 3, not retried) if it is not the pinned one. The
  gateway's `provider/` prefix and a dated snapshot suffix are allowed.

Committed results live in `results/playbook-review/`: summaries and run configs with the
run directory made relative; traces stay in `runs/`.

## Local model: qwen3:4b-instruct, 15 November 2026

`results/playbook-review/2026-11-15-playbook-ollama-limit3/`.

- **What ran:** the three shortest contracts (4, 4 and 6 pages; 57 rule labels; 10
  planted edits).
- **Setup:** `qwen3:4b-instruct` (Q4_K_M) on Ollama 0.40.16, on an 8 GB laptop with
  12–32% memory free. One contract and one model call at a time, `num_ctx` 8192, 600 s
  timeouts.
- **Re-score:** the run predates the fixes above. Its saved outcomes (`outcomes/`) are
  graded again with `rescore` against `corpus-v1/gold.json`, the v1 corpus they ran on,
  with no new model calls (`rescore.json`). The v2 rewording changed all three of these
  documents, so **no v2 score exists for the local model**.
- **Held-out caveat:** the v1 text these outcomes saw shared up to 56% of its 3-grams with
  the rule text, so their accuracy may flatter the model.
- **Not reproducible:** `environment.json` is reconstructed after the run. Rule ids were
  random, the Ollama seed was unset and the engine hash was not recorded.
- `summary-as-run.json` is the original, superseded scoring.

| Gate                               | Result                                                                        | Wilson 95% | Bootstrap 95% (3 contracts) | Verdict                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------- | ---------- | --------------------------- | ------------------------------------------------------------------------------- |
| Rule classification accuracy ≥ 80% | 77.2% (44/57); strict 71.9% (41/57)                                           | 65–86%     | 60–100%                     | **Fail**, and too few contracts to tell                                         |
| Gap recall ≥ 90%, system (gate)    | 100% (10/10)                                                                  | 72–100%    | 100–100%                    | **Pass**, but see model-only                                                    |
| Gap recall, model only             | 40% (4/10): clauses 4/4, tracked changes **0/6**                              | 17–69%     | 33–50%                      | (not gated)                                                                     |
| Evidence verification ≥ 99%        | 93.9% (46/49)                                                                 | 83–98%     | 92–96%                      | **Fail**                                                                        |
| OOXML validity = 100%              | 100% (25/25); LibreOffice converted all 3 combined files (`libreoffice.json`) | 87–100%    |                             | **Pass**                                                                        |
| Latency p50 ≤ 300 s at ≥ 35 pages  | not measured; 977 s, 1,590 s and 1,508 s for the 4, 4 and 6 page contracts    |            |                             | **Not measured** (no 40-page contract ran), but 4 pages already took 16 minutes |

Detail:

- **By variant:** the model gets unacceptable clauses right (16/16) and standard ones
  (11/12), and misses fallbacks (7/17): it calls an allowed fallback not acceptable.
  Omitted clauses: 10/12. By template: NDA 29/32, MSA 15/25.
- **Wrong calls:** 12 of the 13 are misclassifications and 1 is a verifier downgrade.
- **Tracked changes:** the model never reported one as an edit. It flagged all six
  edited paragraphs as uncovered clauses, so only the engine's guard put them in `gaps`.
- **Gap precision against planted items:** system 87% (45/52), but most of those 52 are
  guard gaps, one per tracked-change fragment; model-only 36% (4/11).

## Fake client on the v2 corpus

`results/playbook-review/2026-11-16-playbook-fake-soffice/`: all 16 contracts with canned
replies and `SOFFICE_TEST=1`. All 16 suggestions re-read and all 11 combined files
converted to PDF. Its accuracy and recall measure nothing.

## Paid runs

Not run: the eval budget is $0. Each command runs the full default corpus (16 contracts,
318 pages); add `--limit N` for a sample and `SOFFICE_TEST=1` for the LibreOffice check.

```sh
cd packages/eval
# The gateway's Anthropic provider (gatewayOptionsFromEnv reads ANTHROPIC_API_KEY).
ANTHROPIC_API_KEY=... uv run legallabs-eval run --system playbook-gateway-haiku --suite playbook-review --concurrency 4 --fail-on-task-errors
# Claude Sonnet 5.5, direct (the gateway routes only claude-haiku-5-5).
ANTHROPIC_API_KEY=... uv run legallabs-eval run --system playbook-claude-sonnet --suite playbook-review --concurrency 4 --fail-on-task-errors
# OpenAI gpt-5.5, direct: the gateway has no OpenAI provider; gpt-5.5 is what systems.toml names.
OPENAI_API_KEY=... uv run legallabs-eval run --system playbook-gpt --suite playbook-review --concurrency 4 --fail-on-task-errors
```

**Token estimate.** The local run's tokens per phase give about 1.05 M input and 0.18 M
output tokens for a full run:

- clause map and gap pass: about 2,000 in and 300 out per page;
- rule subagents, retries included: about 18,000 in and 3,400 out per NDA (16 rules), and
  33,000 in and 6,500 out per MSA (25 rules).

**One price table.** `legallabs_eval/costs.py` is now the only table the suite uses.
`tests/test_costs.py` keeps it equal to the gateway's `routes.ts` for every model both
list.

- **Fixed:** `costs.py` had Claude wrong: Sonnet 5.5 at $3/$15 and Haiku 5.5 at $1/$5.
  The list prices are $2/$10 and $0.10/$0.50 per million tokens (Haiku is $0.50/$2.50
  above 100K input tokens, which no prompt here reaches). The gateway's Haiku price was
  right.
- **Not checked:** gpt-5.5's $1.25/$10 is the existing figure, not checked against
  OpenAI's price page.

| System                   | Model             | $/M in, out | Per full run                        |
| ------------------------ | ----------------- | ----------- | ----------------------------------- |
| `playbook-claude-sonnet` | claude-sonnet-5-5 | 2, 10       | ≈ $3.90                             |
| `playbook-gpt`           | gpt-5.5           | 1.25, 10    | ≈ $3.10, more with reasoning tokens |
| `playbook-gateway-haiku` | claude-haiku-5-5  | 0.10, 0.50  | ≈ $0.20                             |

Treat these as ±50%: other tokenizers, fewer retries from stronger models and reasoning
tokens all move them.

## Caveats

- Gold is the generator's label, not a lawyer's; the accepted sets above are judgement
  calls that a lawyer should check.
- Gap matching is by paragraph: a gap that cites the right paragraph for the wrong reason
  still counts.
- A fake-client run proves the pipeline only. `tests/test_playbook_regression.py` pins its
  scores so a change to generation, the engine, the runner or grading shows up in CI.
