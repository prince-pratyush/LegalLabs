import type {
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

export const factsApi = {
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
