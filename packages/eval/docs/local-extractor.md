# Trialling a local extraction model

**No trained model exists.** This is the way to measure one if it is ever built: an eval system,
`ros-ai`, and the gates it would have to pass. Nothing here trains a model, downloads one, or
routes any of the product to it. The tests use a fake server and a few invented lines, so they
show that the plumbing works and nothing about any model's quality.

## Running it

Serve the model behind any OpenAI-compatible chat API and set:

| Variable                                       | Value                                        |
| ---------------------------------------------- | -------------------------------------------- |
| `LEGALLABS_EVAL_EXTRACTOR_URL`                 | Base URL, such as `http://localhost:8000/v1` |
| `LEGALLABS_EVAL_EXTRACTOR_MODEL`               | The model name the server expects            |
| `LEGALLABS_EVAL_EXTRACTOR_KEY`                 | Only if the server wants one                 |
| `LEGALLABS_EVAL_EXTRACTOR_INPUT_USD_PER_MTOK`  | What a million input tokens costs you        |
| `LEGALLABS_EVAL_EXTRACTOR_OUTPUT_USD_PER_MTOK` | What a million output tokens costs you       |

The suites download their pinned public datasets (CUAD and MAUD) on first use. The frontier
baseline is a paid system, such as `claude-cell`, so its runs cost money. Run both on the same
tasks:

```sh
for suite in extract-cuad extract-maud review-table-e2e; do
  uv run legallabs-eval run --system ros-ai --suite $suite --limit 200 --spread --no-judge
  uv run legallabs-eval run --system claude-cell --suite $suite --limit 200 --spread --no-judge
done
uv run legallabs-eval adopt \
  --candidate runs/ros-ai-extract-cuad-* runs/ros-ai-extract-maud-* runs/ros-ai-review-table-e2e-* \
  --baseline runs/claude-cell-extract-cuad-* runs/claude-cell-extract-maud-* runs/claude-cell-review-table-e2e-*
```

`review-table-e2e` has 100 rows, so run it without `--limit`. A glob that matches two runs of one
suite is refused: name the one meant.

## The gates

`adopt` exits 0 only if, on `extract-cuad`, `extract-maud` and `review-table-e2e` alike:

- both runs used the same data, instructions and tasks, at least 100 of them, and every task
  has a result;
- the candidate's score is at least the baseline's, with no margin;
- its share of quotes that are really in the document is at least the baseline's;
- both costs are known and above zero, and the candidate's is at most a tenth of the baseline's.
  Only the cost of answering counts, not of judging.

It exits 1 when a gate fails and 2 when the summaries cannot be compared.

## What it cannot check

- That the baseline is a frontier system, and that the declared price is honest. A price should
  include the hardware, idle time too.
- Whether a difference in score is chance: it compares the two numbers as they are. `n` is in
  the output.
- Calls made by an attempt that then failed and was tried again are not in the cost.
- Training data. A model trained on CUAD or MAUD test material would pass for the wrong reason.

## Data

The endpoint comes from the environment alone. An eval run sends the suite's documents to it and
nothing else; the platform has no path that sends customer documents to a training or eval
endpoint. A deployer who wants to train or test on their own documents exports them themselves.
