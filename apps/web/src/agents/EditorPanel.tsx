import type { AgentAttachment, AgentSource } from "@legallabs/contracts";
import {
  type AgentContent,
  AgentEditor,
  type AttachChoice,
  Checkbox,
  Field,
  Input,
  Label,
  type SourceChoice,
  Textarea,
} from "@legallabs/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { api } from "../api.js";
import { type Agent, type AgentVersion, agentApi, agentError } from "./api.js";

export const contentOf = (version: AgentVersion | null | undefined): AgentContent => ({
  instructions: version?.instructions ?? "",
  attachments: (version?.attachments ?? []).map((a) => ({ ...a })),
  sources: (version?.sources ?? []).map((s) => ({ ...s })),
});

/** The version being worked on: the draft when there is one, else the live one. */
export const workingVersion = (agent: Agent, versions: readonly AgentVersion[]) =>
  versions.find((v) => v.id === (agent.draft_version_id ?? agent.live_version_id)) ?? null;

type Details = {
  title: string;
  description: string;
  areas: string;
  auto: boolean;
};

const detailsOf = (agent: Agent): Details => ({
  title: agent.title,
  description: agent.description,
  areas: agent.practice_areas.join(", "),
  auto: agent.auto_description,
});

const areasOf = (text: string) =>
  [
    ...new Set(
      text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].slice(0, 10);

let choicesCache: Promise<{ attach: AttachChoice[]; sources: SourceChoice[] }> | null = null;

/** Files, vaults and sources the person can pick; loaded once per page. */
function loadChoices() {
  choicesCache ??= Promise.all([
    api.documents().catch(() => []),
    api.scopeOptions().catch(() => ({ vaults: [], sources: [], models: [] })),
  ]).then(([docs, scope]) => ({
    attach: [
      ...scope.vaults.map((v): AttachChoice => ({ kind: "vault", ref: v.id, name: v.name })),
      ...docs
        .filter((d) => d.status === "indexed")
        .map((d): AttachChoice => ({ kind: "upload", ref: d.id, name: d.name })),
    ],
    sources: scope.sources.map(
      (s): SourceChoice => ({ kind: "knowledge_source", source: s.id, name: s.name }),
    ),
  }));
  const pending = choicesCache;
  // A failed load is retried next time rather than remembered.
  pending.catch(() => {
    choicesCache = null;
  });
  return pending;
}

export function resetChoices() {
  choicesCache = null;
}

/** Title, description and the instructions with their attachments and sources. */
export function EditorPanel({
  agent,
  versions,
  onSaved,
}: {
  agent: Agent;
  versions: readonly AgentVersion[];
  onSaved: () => void;
}) {
  const id = useId();
  const base = workingVersion(agent, versions);
  const [content, setContent] = useState<AgentContent>(() => contentOf(base));
  const [details, setDetails] = useState<Details>(() => detailsOf(agent));
  const [choices, setChoices] = useState<{ attach: AttachChoice[]; sources: SourceChoice[] }>({
    attach: [],
    sources: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // A new working version (a save, or the builder's draft) replaces what is shown.
  const baseId = base?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new version resets the form
  useEffect(() => {
    setContent(contentOf(base));
  }, [baseId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a server change resets details
  useEffect(() => {
    setDetails(detailsOf(agent));
  }, [agent.updated_at, agent.title, agent.description]);

  useEffect(() => {
    loadChoices().then(setChoices, () => undefined);
  }, []);

  const original = useMemo(() => JSON.stringify(contentOf(base)), [base]);
  const dirtyContent = JSON.stringify(content) !== original;
  const startDetails = detailsOf(agent);
  const dirtyDetails =
    details.title.trim() !== startDetails.title ||
    details.description.trim() !== startDetails.description ||
    areasOf(details.areas).join("|") !== agent.practice_areas.join("|") ||
    details.auto !== startDetails.auto;

  const save = async (promote: boolean) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      if (dirtyDetails) {
        if (!details.title.trim()) throw new Error("title");
        await agentApi.patch(agent.id, {
          title: details.title.trim(),
          description: details.description.trim(),
          practice_areas: areasOf(details.areas),
          auto_description: details.auto,
        });
      }
      const result = await agentApi.saveVersion(agent.id, {
        instructions: content.instructions,
        attachments: content.attachments as AgentAttachment[],
        sources: content.sources.map(({ name: _name, ...s }) => s) as AgentSource[],
        promote,
      });
      const missing = result.warnings
        .filter((w) => w.code === "UNRESOLVED_LABEL")
        .map((w) => w.label);
      setSaved(
        `${promote ? "Saved. This is now the live version." : "Saved as a draft."}${
          missing.length
            ? ` Nothing is attached for ${missing.join(", ")}; the agent will ask or go without.`
            : ""
        }`,
      );
      onSaved();
    } catch (err) {
      setError(
        err instanceof Error && err.message === "title"
          ? "Give the agent a title."
          : agentError(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File): Promise<AttachChoice> => {
    const doc = await api.upload(file);
    resetChoices();
    return { kind: "upload", ref: doc.id, name: doc.name };
  };

  return (
    <div className="grid gap-5">
      <section aria-label="Details" className="grid gap-3">
        <Field label="Title">
          {(props) => (
            <Input
              {...props}
              value={details.title}
              maxLength={120}
              onChange={(e) => setDetails({ ...details, title: e.target.value })}
            />
          )}
        </Field>
        <Field label="Description">
          {(props) => (
            <Textarea
              {...props}
              value={details.description}
              maxLength={1000}
              className="min-h-16"
              onChange={(e) => setDetails({ ...details, description: e.target.value })}
            />
          )}
        </Field>
        <Field label="Practice areas" hint="Separate with commas; up to 10.">
          {(props) => (
            <Input
              {...props}
              value={details.areas}
              onChange={(e) => setDetails({ ...details, areas: e.target.value })}
            />
          )}
        </Field>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-auto`}
            checked={details.auto}
            onCheckedChange={(on) => setDetails({ ...details, auto: on === true })}
          />
          <Label htmlFor={`${id}-auto`}>Update the description automatically on save</Label>
        </div>
      </section>
      <AgentEditor
        value={content}
        onChange={setContent}
        attachChoices={choices.attach}
        sourceChoices={choices.sources}
        onUpload={upload}
        onSave={save}
        hasLive={agent.live_version_id !== null}
        busy={busy}
        dirty={dirtyContent || dirtyDetails}
        error={error}
      />
      {saved && (
        <p role="status" className="text-dense text-fg">
          {saved}
        </p>
      )}
    </div>
  );
}
