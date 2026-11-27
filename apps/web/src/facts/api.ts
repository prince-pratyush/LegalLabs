import type {
  ChronologyStyle,
  EntityKind,
  Fact,
  FactEntity,
  FactExtraction,
  FactFile,
  FactIssue,
  FactStatus,
  FactWhen,
  PageLayout,
} from "@legallabs/contracts";
import { ApiError, FALLBACK } from "../api.js";
import { request, send } from "../http.js";

export interface FactFilter {
  entity_id?: string;
  issue_id?: string;
  document_id?: string;
  status?: FactStatus | "";
  from?: string;
  to?: string;
}

export interface NewFact extends FactWhen {
  text: string;
  entity_ids: string[];
  issue_ids: string[];
  citations: { document_version_id: string; page_no: number; quote: string }[];
}

export type FactChange = Partial<FactWhen> & { text?: string };

const enc = encodeURIComponent;
const base = (space: string) => `/apps/chronology/spaces/${enc(space)}`;

export function filterQuery(filter: FactFilter, cursor?: string): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value) query.set(`filter[${key}]`, value);
  }
  if (cursor) query.set("cursor", cursor);
  const text = query.toString();
  return text ? `?${text}` : "";
}

export interface ChronologyChoice {
  style: ChronologyStyle;
  include_disputed: boolean;
}

/** The part of the table's filters a chronology takes: names, issues and dates. */
const chronologyFilter = (filter: FactFilter, include_disputed: boolean) => ({
  ...(filter.entity_id ? { entity_ids: [filter.entity_id] } : {}),
  ...(filter.issue_id ? { issue_ids: [filter.issue_id] } : {}),
  ...(filter.from ? { from: filter.from } : {}),
  ...(filter.to ? { to: filter.to } : {}),
  include_disputed,
});

export function exportUrl(
  space: string,
  format: "docx" | "xlsx",
  filter: FactFilter,
  choice: ChronologyChoice,
): string {
  const { entity_id, issue_id, from, to } = filter;
  const query = new URLSearchParams({ format, view: choice.style });
  for (const [key, value] of Object.entries({ entity_id, issue_id, from, to })) {
    if (value) query.set(`filter[${key}]`, value);
  }
  if (choice.include_disputed) query.set("include_disputed", "true");
  return `${base(space)}/facts/export?${query}`;
}

/** Fetched rather than linked, so a refusal is shown as words and not saved as a file. */
async function download(path: string, filename: string) {
  const res = await fetch(`/api/v1${path}`, { credentials: "same-origin" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
    } | null;
    throw new ApiError(res.status, body?.code ?? "UNKNOWN", body?.message ?? FALLBACK);
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export const factsApi = {
  generate: (space: string, filter: FactFilter, choice: ChronologyChoice) =>
    send<{ thread_id: string; facts: number; left_out: number }>(
      "POST",
      `${base(space)}/facts/generate`,
      { style: choice.style, filter: chronologyFilter(filter, choice.include_disputed) },
    ),
  export: (space: string, format: "docx" | "xlsx", filter: FactFilter, choice: ChronologyChoice) =>
    download(exportUrl(space, format, filter, choice), `chronology.${format}`),
  list: (space: string, filter: FactFilter, cursor?: string) =>
    request<{ facts: Fact[]; next_cursor: string | null }>(
      `${base(space)}/facts${filterQuery(filter, cursor)}`,
    ),
  create: (space: string, fact: NewFact) =>
    send<{ fact: Fact }>("POST", `${base(space)}/facts`, fact).then((r) => r.fact),
  change: (space: string, id: string, change: FactChange) =>
    send<{ fact: Fact }>("PATCH", `${base(space)}/facts/${enc(id)}`, change).then((r) => r.fact),
  setStatus: (space: string, id: string, status: FactStatus) =>
    send<{ fact: Fact }>("POST", `${base(space)}/facts/${enc(id)}/status`, { status }).then(
      (r) => r.fact,
    ),
  entities: (space: string) =>
    request<{ entities: FactEntity[] }>(`${base(space)}/entities`).then((r) => r.entities),
  addEntity: (space: string, kind: EntityKind, name: string) =>
    send("POST", `${base(space)}/entities`, { kind, canonical_name: name }),
  issues: (space: string) =>
    request<{ issues: FactIssue[] }>(`${base(space)}/issues`).then((r) => r.issues),
  addIssue: (space: string, name: string) => send("POST", `${base(space)}/issues`, { name }),
  files: (space: string) =>
    request<{ files: FactFile[]; truncated: boolean }>(`${base(space)}/files`),
  /** The page as citation offsets index it, read through the viewer's own route. */
  page: (document: string, version: string, page: number) =>
    request<{ pages: PageLayout[] }>(
      `/documents/${enc(document)}/versions/${enc(version)}/pages?from=${page}&to=${page}`,
    ).then((r) => r.pages[0]?.text ?? ""),
  extract: (space: string, body: { vault_id: string } | { document_ids: string[] }) =>
    send<{ run_id: string; documents_total: number }>("POST", `${base(space)}/facts/extract`, body),
  extractions: (space: string) =>
    request<{ extractions: FactExtraction[] }>(`${base(space)}/facts/extractions`).then(
      (r) => r.extractions,
    ),
  extraction: (space: string, run: string) =>
    request<{ extraction: FactExtraction }>(`${base(space)}/facts/extractions/${enc(run)}`).then(
      (r) => r.extraction,
    ),
};
