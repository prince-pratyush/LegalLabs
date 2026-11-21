import { ACCESS_LEVELS, type AccessLevel, findRefs } from "@legallabs/contracts";

export type { AccessLevel };

export const ACCESS_LABEL: Record<AccessLevel, string> = {
  run: "Can run",
  view: "Can view",
  edit: "Can edit",
  full: "Full access",
};

export const LEVEL_OPTIONS = ACCESS_LEVELS.map((value) => ({ value, label: ACCESS_LABEL[value] }));

export type AttachmentKind =
  | "upload"
  | "vault"
  | "vault_folder"
  | "review_table"
  | "playbook"
  | "template_file"
  | "dms_file";
export type SourceKind = "knowledge_source" | "connector" | "scan";

export const KIND_LABEL: Record<AttachmentKind | SourceKind, string> = {
  upload: "File",
  vault: "Vault",
  vault_folder: "Vault folder",
  review_table: "Review table",
  playbook: "Playbook",
  template_file: "Template",
  dms_file: "DMS file",
  knowledge_source: "Knowledge source",
  connector: "Connector",
  scan: "Scan",
};

export type AgentAttachmentItem = {
  label: string;
  kind: AttachmentKind;
  ref: string;
  name: string;
};
export type AgentSourceItem = { label: string; kind: SourceKind; source: string; name?: string };

export type AgentContent = {
  instructions: string;
  attachments: AgentAttachmentItem[];
  sources: AgentSourceItem[];
};

/** Something that can be attached, before it has a label. */
export type AttachChoice = { kind: AttachmentKind; ref: string; name: string };
export type SourceChoice = { kind: SourceKind; source: string; name: string };

/** A label as the API accepts it: a letter, then letters, digits, `_` or spaces, 40 at most. */
export function toLabel(name: string): string {
  const cleaned = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^A-Za-z0-9_ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const start = cleaned.search(/[A-Za-z]/);
  const label = (start < 0 ? "" : cleaned.slice(start)).slice(0, 40).trim();
  return label || "Attachment";
}

export const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_ ]{0,39}$/;

/** `@` names in the instructions that match no attachment or source. */
export function unresolvedLabels(content: AgentContent): string[] {
  const known = [...content.attachments, ...content.sources].map((x) => x.label);
  const raw = findRefs(content.instructions, known)
    .filter((r) => r.label === null && r.raw.length > 1)
    .map((r) => r.raw.slice(1));
  return [...new Set(raw)];
}

/** The native select, styled like the kit's other controls; it needs no portal in tests. */
export const selectStyles =
  "h-8 rounded-md border border-control bg-bg-raised px-2 text-ui text-fg disabled:cursor-not-allowed disabled:opacity-50";

const when = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" });
export const formatWhen = (iso: string | null | undefined, timeZone?: string) => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return timeZone
    ? new Intl.DateTimeFormat("en-AU", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(date)
    : when.format(date);
};

export function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return "—";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}
