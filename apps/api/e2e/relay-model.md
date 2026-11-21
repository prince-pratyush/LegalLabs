# Relay model (dev tool)

`e2e/relay-model.mjs` is an OpenAI-compatible server whose "model" is a person, or a Claude
session acting as one. Every request the API makes is written to a folder; the server waits
for a reply file. Use it to see how a **strong** model behaves with our prompts and parsers
without a paid API and without a local model. It is not a benchmark: no real latency,
tokens or model identity, and a model that knows it is being tested may be more careful.

```sh
cd apps/api && pnpm build
node e2e/relay-model.mjs --dir /tmp/relay --port 18080 --clean
PILOT_OLLAMA_URL=http://127.0.0.1:18080 node e2e/stack.mjs > /tmp/stack.json   # real stack, relay as model
node e2e/sandbox.mjs /tmp/stack.json playbook|threads|table                    # drive a feature, print a report
```

`stack.mjs` needs Docker (object storage) and a local Postgres, as for the pilot tests.

## Folder protocol

| Path                           | Meaning                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `pending/NNNNN.request.txt`    | A header line, then the `SYSTEM` and `USER` turns. Read this.                                             |
| `pending/NNNNN.request.json`   | The exact OpenAI chat body the API sent.                                                                  |
| `responses/NNNNN.response.txt` | Write the assistant message text here. Write to a `.tmp` and `mv`, so the relay never reads half a reply. |
| `responses/NNNNN.error.txt`    | Write an HTTP status (`500`) to fail the call instead.                                                    |
| `done/`, `cancelled/`          | Answered requests, and ones the caller gave up on.                                                        |

Streaming and non-streaming calls are both served; the reply is the plain message content.
Our gateway only sends text (no tool calls or `response_format`), so a reply is just text:
JSON where the prompt asks for JSON, citation tags where it asks for them.

## Acting as the model with Claude

Dispatch one or more subagents with the folder path and these rules: answer only from the
request file (do not read the repo), follow the prompt's output format exactly, and write
each reply atomically. Split by request number parity to run two workers without collisions.
Keep the workers away from the source and the expected results, or the run measures the
worker's guess at the test, not a model's reading of the prompt.

## What it is for

- Telling a wiring, prompt or parsing bug from a weak-model failure: if a strong model gets
  the prompt and still fails, the prompt or the parser is the suspect.
- Checking that a reply shaped as a real provider would shape it is accepted end to end.

`e2e/sandbox.mjs` is a small report driver (not assertions): `playbook` (a review of an MSA
`.docx` with another party's tracked insertion), `threads` (five questions over a vault of
three contracts) and `table` (a review table over the same three documents).

## First run (21 Nov 2026)

With Claude subagents as the model, the playbook review, threads with the citation verifier,
a review table and a deep analysis all ran end to end on short contracts. The strong model
caught the other side's tracked insertion (the local 4B model caught 0 of 6), every citation
verified, and no prompt or parser needed a fix. See the shared notes for detail.
