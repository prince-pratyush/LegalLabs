import type { SourceSelection } from "@legallabs/contracts";
import { type Attachment, Composer, type Mentionable, type ModelOption } from "@legallabs/ui";
import { useEffect, useMemo, useState } from "react";
import { type AskInput, api, type DocumentSummary, messageOf, type ScopeOptions, type Thread } from "../api.js";
import { documentStatus } from "../text.js";
import { toBlocks } from "./compose.js";

const AUTO = "auto";
const POLL_MS = 2000;

const reading = (d: DocumentSummary) => d.status === "queued" || d.status === "parsing";

type FileStatus = NonNullable<Attachment["status"]>;

const chipStatus = (d: DocumentSummary): FileStatus =>
  reading(d) ? "processing" : d.status === "failed" ? "failed" : "ready";

/** The composer's scope, uploads and model, kept apart from the conversation. */
export function ThreadComposer({
  thread,
  options,
  streaming,
  onSend,
  onStop,
}: {
  thread: Thread | null;
  options: ScopeOptions | null;
  streaming: boolean;
  /** Resolves true once the question was accepted, so the draft can be cleared. */
  onSend: (input: AskInput) => Promise<boolean>;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<Mentionable[]>([]);
  const [uploads, setUploads] = useState<DocumentSummary[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [vaultIds, setVaultIds] = useState<string[]>(thread?.vault_ids ?? []);
  const [sources, setSources] = useState<SourceSelection[]>(thread?.sources ?? []);
  const [model, setModel] = useState(AUTO);
  const [notice, setNotice] = useState<string | null>(null);

  // Files are read in the background, so their chips are refreshed until each settles.
  const pending = uploads.filter(reading).map((d) => d.id);
  const pendingKey = pending.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingKey stands for pending
  useEffect(() => {
    if (!pendingKey) return;
    const timer = setInterval(() => {
      Promise.all(pendingKey.split(",").map((id) => api.document(id))).then(
        (fresh) =>
          setUploads((current) => current.map((d) => fresh.find((f) => f.id === d.id) ?? d)),
        () => undefined,
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pendingKey]);

  // A file that couldn't be read says why, rather than just turning red.
  const failures = uploads
    .filter((d) => d.status === "failed" && !removed.has(d.id))
    .map((d) => `${d.name}: ${documentStatus(d)}`);

  const files = useMemo(() => {
    const fromThread = (thread?.documents ?? []).map((d) => ({
      id: d.id,
      label: d.name,
      status: "ready" as FileStatus,
    }));
    const added = uploads.map((d) => ({ id: d.id, label: d.name, status: chipStatus(d) }));
    const seen = new Set(fromThread.map((d) => d.id));
    return [...fromThread, ...added.filter((d) => !seen.has(d.id))].filter(
      (d) => !removed.has(d.id),
    );
  }, [thread, uploads, removed]);

  const vaultName = (id: string) => options?.vaults.find((v) => v.id === id)?.name ?? "Vault";
  const sourceName = (id: string) => options?.sources.find((s) => s.id === id)?.name ?? "Source";

  const attachments: Attachment[] = [
    ...files.map((f) => ({ ...f, kind: "file" as const })),
    ...vaultIds.map((id) => ({ id, label: vaultName(id), kind: "vault" as const })),
    ...sources.map((s) => ({
      id: s.source_id,
      label: sourceName(s.source_id),
      kind: "source" as const,
    })),
  ];

  const mentionables: Mentionable[] = [
    ...files.filter((f) => f.status === "ready").map((f) => ({ type: "document" as const, id: f.id, label: f.label })),
    ...(options?.vaults ?? []).map((v) => ({ type: "vault" as const, id: v.id, label: v.name })),
    ...(options?.sources ?? []).map((s) => ({ type: "source" as const, id: s.id, label: s.name })),
  ];

  const models: ModelOption[] = [
    { id: AUTO, label: "Auto", hint: "Best for the question" },
    ...(options?.models ?? []).map((m) => ({
      id: m.id,
      label: m.id,
      ...(m.free ? { hint: "Free" } : {}),
    })),
  ];

  const ready = files.filter((f) => f.status === "ready").map((f) => f.id);
  const content = toBlocks(draft, mentions);
  const mentioned = typeof content !== "string";
  const disabledReason = files.some((f) => f.status === "processing")
    ? "Wait until your files have been read."
    : ready.length + vaultIds.length + sources.length === 0 && !mentioned
      ? "Attach a file, a vault or a source to ask about."
      : undefined;

  const attach = async (chosen: File[]) => {
    setNotice(null);
    for (const file of chosen) {
      try {
        const added = await api.upload(file);
        setUploads((current) => [...current, added]);
      } catch (err) {
        setNotice(`${file.name}: ${messageOf(err)}`);
      }
    }
  };

  const remove = (attachment: Attachment) => {
    if (attachment.kind === "file") setRemoved((set) => new Set([...set, attachment.id]));
    if (attachment.kind === "vault") setVaultIds((ids) => ids.filter((id) => id !== attachment.id));
    if (attachment.kind === "source") {
      setSources((list) => list.filter((s) => s.source_id !== attachment.id));
    }
  };

  const send = async () => {
    const input: AskInput = {
      content,
      scope: { document_ids: ready, vault_ids: vaultIds, sources },
      ...(model !== AUTO ? { model } : {}),
    };
    if (await onSend(input)) {
      setDraft("");
      setMentions([]);
    }
  };

  return (
    <div className="grid gap-1">
      <Composer
        value={draft}
        onChange={setDraft}
        onSend={send}
        onStop={onStop}
        streaming={streaming}
        {...(disabledReason ? { disabledReason } : {})}
        workIn={thread?.matter_id ? { label: "This thread's matter" } : null}
        onWorkIn={() => setNotice("Choosing a matter is coming soon.")}
        attachments={attachments}
        onRemove={remove}
        onAttachFiles={attach}
        vaults={(options?.vaults ?? []).map((v) => ({ id: v.id, name: v.name, fileCount: v.file_count }))}
        selectedVaultIds={vaultIds}
        onToggleVault={(id) =>
          setVaultIds((ids) => (ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id]))
        }
        sources={(options?.sources ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          ...(s.jurisdiction ? { jurisdiction: s.jurisdiction } : {}),
        }))}
        selectedSourceIds={sources.map((s) => s.source_id)}
        onToggleSource={(id) =>
          setSources((list) =>
            list.some((s) => s.source_id === id)
              ? list.filter((s) => s.source_id !== id)
              : [...list, { source_id: id }],
          )
        }
        models={models}
        model={model}
        onModel={setModel}
        deepAnalysis={false}
        onDeepAnalysis={() => setNotice("Deep analysis is coming soon.")}
        mentionables={mentionables}
        onMention={(item) => setMentions((list) => [...list.filter((m) => m.label !== item.label), item])}
      />
      {failures.map((line) => (
        <p key={line} role="status" className="px-1 text-caption text-destructive">
          {line}
        </p>
      ))}
      {notice && (
        <p role="status" className="px-1 text-caption text-fg-muted">
          {notice}
        </p>
      )}
    </div>
  );
}
