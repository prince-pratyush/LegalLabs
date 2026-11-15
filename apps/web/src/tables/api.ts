import type {
  BulkCellsBody,
  Cell,
  CellCitation,
  CellHistory,
  Column,
  ColumnProposal,
  CreateColumnBody,
  CreateTableBody,
  Estimate,
  EstimateBody,
  ExportBody,
  PatchCellBody,
  PatchColumnBody,
  ReviewTable,
  Row,
  RowFilter,
  RowSort,
  RunColumnBody,
} from "@legallabs/contracts";
import { ApiError } from "../api.js";

const FALLBACK = "Something went wrong. Try again.";

export const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : FALLBACK);

// Codes the reviewer can act on get plain words; the rest use the server's message.
const MESSAGES: Record<string, string> = {
  CELL_LOCKED: "That cell is locked. Unlock it to change it.",
  EXPORT_DISABLED_BY_SOURCE: "The source vault doesn't allow downloads, so this can't be exported.",
  COLUMN_RUNNING: "Three columns are already running. Wait for one to finish.",
  COLUMN_LIMIT: "This table already has 500 columns.",
  MODEL_UNAVAILABLE: "No model is available just now. Try again shortly.",
};

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const json = typeof init.body === "string";
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "same-origin",
    headers: json ? { "content-type": "application/json" } : {},
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const code = String(body?.code ?? "UNKNOWN");
    const message = MESSAGES[code] ?? (typeof body?.message === "string" ? body.message : FALLBACK);
    throw new ApiError(res.status, code, message);
  }
  return res;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const text = await (await request(path, init)).text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const send = <T>(method: string, path: string, body: unknown) =>
  call<T>(path, { method, body: JSON.stringify(body) });

const t = (id: string) => `/review-tables/${encodeURIComponent(id)}`;
const c = (id: string, cellId: string) => `${t(id)}/cells/${encodeURIComponent(cellId)}`;
const col = (id: string, columnId: string) => `${t(id)}/columns/${encodeURIComponent(columnId)}`;

export interface RowsPage {
  rows: Row[];
  cells: Cell[];
  next_cursor: string | null;
}

export interface RowsQuery {
  cursor?: string | null;
  limit?: number;
  filter?: RowFilter | null;
  sort?: RowSort | null;
}

export function rowsSearch(query: RowsQuery): string {
  const params = new URLSearchParams();
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.filter && query.filter.conditions.length > 0) {
    params.set("filter", JSON.stringify(query.filter));
  }
  if (query.sort) params.set("sort", `${query.sort.column_id}:${query.sort.direction}`);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export interface CellDetail {
  cell: Cell;
  citations: CellCitation[];
  history: CellHistory[];
}

/** Paths follow review-tables.md §5, as mounted by apps/api/src/tables/http.ts. */
export const tableApi = {
  list: async (starred: boolean) =>
    (
      await call<{ items: ReviewTable[]; next_cursor: string | null }>(
        `/review-tables${starred ? "?filter[starred]=true" : ""}`,
      )
    ).items,
  create: async (body: CreateTableBody) =>
    (await send<{ table: ReviewTable }>("POST", "/review-tables", body)).table,
  get: (id: string) => call<{ table: ReviewTable; columns: Column[] }>(t(id)),
  star: (id: string, on: boolean) =>
    call<void>(`${t(id)}/star`, { method: on ? "POST" : "DELETE" }),
  rows: (id: string, query: RowsQuery = {}) => call<RowsPage>(`${t(id)}/rows${rowsSearch(query)}`),
  createColumn: async (id: string, body: CreateColumnBody) =>
    (await send<{ column: Column }>("POST", `${t(id)}/columns`, body)).column,
  updateColumn: async (id: string, columnId: string, body: PatchColumnBody) =>
    (await send<{ column: Column }>("PATCH", col(id, columnId), body)).column,
  deleteColumn: (id: string, columnId: string) =>
    call<void>(col(id, columnId), { method: "DELETE" }),
  generate: async (id: string, description: string) =>
    (
      await send<{ proposals: ColumnProposal[] }>("POST", `${t(id)}/columns/generate`, {
        description,
      })
    ).proposals,
  runColumn: (id: string, columnId: string, body: RunColumnBody) =>
    send<{ run_id: string | null }>("POST", `${col(id, columnId)}/run`, body),
  estimate: (id: string, body: EstimateBody) => send<Estimate>("POST", `${t(id)}/estimate`, body),
  cancel: (runId: string) =>
    call<void>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
  cell: (id: string, cellId: string) => call<CellDetail>(c(id, cellId)),
  patchCell: async (id: string, cellId: string, body: PatchCellBody) =>
    (await send<{ cell: Cell }>("PATCH", c(id, cellId), body)).cell,
  rerunCell: (id: string, cellId: string) =>
    call<unknown>(`${c(id, cellId)}/rerun`, { method: "POST" }),
  bulk: (id: string, body: BulkCellsBody) =>
    send<{ affected: number; skipped: number; run_ids: string[] }>(
      "POST",
      `${t(id)}/cells/bulk`,
      body,
    ),
  /** The file comes back in the response; the caller hands it to the browser. */
  export: async (id: string, body: ExportBody) => {
    const res = await request(`${t(id)}/export`, { method: "POST", body: JSON.stringify(body) });
    const disposition = res.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `table.${body.format}`;
    return { blob: await res.blob(), filename };
  },
};

/** Saves a blob through a temporary link, since fetch can't trigger a download itself. */
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
