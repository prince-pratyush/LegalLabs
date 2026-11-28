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

These are about a matter's policy. The workspace's own settings, below, apply to all of the
calls here.

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

The model gateway reads them on every call and applies them before any provider is reached, with
the matter policy on top, so the strictest wins. The app builds its gateway in one place
(`api/admin-models/gateway.ts`; a test fails if anything else builds one), and every call must say
which workspace and which person it is for.

| ID    | Severity | Area         | Finding                                                                                                                          | Status                                                                                              |
| ----- | -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| F-105 | High     | Model policy | The model allow-list, "zero data retention only" and region settings were saved and filtered a list, but no model call used them | Fixed: applied by the gateway to every call and stream (`api/admin-models/gateway.test.ts`)         |
| F-106 | Medium   | Model policy | Models from a hosted provider were listed as zero data retention before anyone had said so                                       | Fixed: only local models are until an admin declares it. Rows saved earlier keep what they recorded |

### Decisions

- **Allow-list.** In force once an admin has configured any model (any stored row, including one
  made by setting a key or a flag). From then a model must be enabled and listed for the person's
  role or for them. Before that, the install's models are usable, so a new deployment still works.
- **No person.** Work nobody is behind (intake classification) may use a model that is enabled and
  listed for at least one role or user.
- **Zero data retention and region** apply whether or not any model is configured. A model's region
  is `local` for Ollama and `unspecified` otherwise until an admin sets it, so a region setting
  leaves out every model not labelled with that region.
- **Fail closed.** If the settings can't be read, or the workspace can't be found, no model is
  called. If none qualifies the work is refused with a message naming the settings.
- **When.** Read on each call, so a change also stops work already running. This is stricter than
  ADM-005's "running runs continue with the model they started with".

### Not covered

- Search embedding and reranking do not go through the gateway and are not checked. The only
  adapters are for a TEI or Ollama server the deployer runs and names in the environment
  (`packages/embed`); the deployer must keep it inside the zero retention and region rules.
- Bring-your-own keys and local OpenAI-compatible endpoints are stored but not yet used for calls.
- "Disable the model selector" hides the list; the per-task default model is not used for routing.
- The workspace's own region is not matched against model regions (06 §6.3), and there are no
  expiring zero retention exceptions (SEC-033) or refusal audit events.
- The eval harness has no workspace and applies no settings.
