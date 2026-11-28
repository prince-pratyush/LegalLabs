# Matter model policy (F-92 to F-97)

Kept apart from `evidence.md` while the Slack intake change, which also edits that file, is open.
It replaces the paragraph there that begins "Not applying a matter's model policy yet", and takes
the next number after that change's F-88 to F-91.

| ID   | Severity | Area         | Finding                                                                                                                                                                                                            | Status                                                                |
| ---- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| F-92 | Medium   | Model policy | A matter's denied providers and models were not applied to playbook and contract reviews and their redrafts, review-table cells and column generation, workflow model steps, agent building or playbook generation | Fixed: they leave them out, and the work is refused when none is left |

Found by a security review of that change before it was merged.

| ID   | Severity | Area             | Finding                                                                                                | Status                                                                                                             |
| ---- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| F-93 | Medium   | Review redrafts  | Re-runs, alternates and revisions dropped the matter of the thread the review was asked in             | Fixed: the review's thread counts (`api/reviews/reviews.test.ts`)                                                  |
| F-94 | Low      | Review redrafts  | The review did not keep which background files it was given, so their matters were dropped afterwards  | Fixed: kept on the review and never returned by the API. Reviews made before this change did not record them       |
| F-95 | Medium   | Model policy     | A matter or file the caller could not see counted as having no policy                                  | Fixed: the call is refused when an id, or the matter behind it, can't be seen (`api/matters/model-policy.test.ts`) |
| F-96 | Medium   | Agent runs       | Only the run's own matter counted, so a run outside any matter sent a matter's files to a denied model | Fixed: the files each turn is shown, and those of earlier turns, count (`api/agents/run-policy.test.ts`)           |
| F-97 | Low      | Workflow history | Drafting and table selection did not record what they read, so later steps lost those files' matters   | Fixed: recorded on the step (`workflows/handler.test.ts`)                                                          |

Every one of these, and the thread, agent and fact extraction calls that already applied the
policy, now asks `api/matters/model-policy.ts`. The matters that count are those of everything the
call draws on: documents, threads, review tables and their rows, and Spaces. It is read when the
work is asked for and again when it runs. Nothing is allowed when something named can't be seen,
so work over a file that has since been binned, walled or unshared is refused.

A workflow step also answers for the files and tables of the run's earlier steps, since its prompt
may quote what they produced.

Tests: `api/reviews/reviews.test.ts`, `api/playbooks/playbooks.test.ts`,
`api/tables/model-policy.test.ts`, `api/workflows/model-policy.test.ts`,
`api/agents/builder-policy.test.ts`.

## Not covered

- Intake classification (`api/intake/classify.ts`): a request that has a message to read arrives by
  mail and has no matter. One typed in by staff may name a matter, but has no message, so no model
  reads it. A change that lets a request with a message hold a matter must apply the policy.
- The Word pane's proofread and translate: the pane sends paragraphs with no document or matter, so
  there is no policy to read.
- A file with no matter, including copies the Word pane uploads.
- Review tables: a row whose file the caller can't see is left out of the work, and of its policy.
- Text a person types or pastes into a prompt, whatever matter it came from.
- Horizon scanning reads public sources; memory and style derivation read the person's own samples
  and answers.
- Search embedding and reranking do not go through the model gateway.

## Workspace model settings

The workspace's model allow-list, zero data retention and region settings are not enforced by the
model gateway. They are stored, and filter the list `GET /models/allowed` returns; no model call
consults them.
