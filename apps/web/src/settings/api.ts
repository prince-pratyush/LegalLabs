import { request, send } from "../notifications/http.js";

export interface Memory {
  id: string;
  text: string;
  source: "asked" | "inferred" | "manual" | "imported";
  created_at: string;
  updated_at: string;
  conflicts_with?: string[];
}

export interface MemoryList {
  items: Memory[];
  count: number;
  limit: number;
  enabled: boolean;
}

export interface MemorySettings {
  use_memory: boolean;
  permitted: boolean;
  pending_candidates: number;
}

export interface Candidate {
  id: string;
  text: string;
  from_message_id: string | null;
  created_at: string;
  expires_at: string;
}

export const PERSONALISE_QUESTIONS = [
  { key: "role", label: "What is your role?" },
  { key: "practice_areas", label: "Which practice areas do you work in?" },
  { key: "jurisdictions", label: "Which jurisdictions do you work in?" },
  { key: "writing_preferences", label: "How do you like your writing to read?" },
  { key: "citation_preferences", label: "How should citations be handled?" },
  { key: "output_format", label: "What output format do you prefer?" },
] as const;

export interface ImportRow {
  line: number;
  text: string;
  category?: string;
  created_at?: string;
  source_platform?: string;
  status: "ok" | "duplicate" | "error";
  error?: string;
}

export interface ImportPreview {
  import_id: string;
  rows: ImportRow[];
  would_exceed_cap: number;
}

export interface WritingStyle {
  id: string;
  name: string;
  owner_id: string;
  owner_name: string;
  kind: "instructions" | "sample";
  instructions: string | null;
  derived_instructions: string | null;
  sample: { pages: number; chars: number } | null;
  shared: boolean;
  status: "processing" | "ready" | "failed";
  editable: boolean;
  updated_at: string;
}

const enc = encodeURIComponent;

export const memoryApi = {
  settings: () => request<MemorySettings>("/memory/settings"),
  setUse: (use_memory: boolean) =>
    send<MemorySettings>("PATCH", "/memory/settings", { use_memory }),
  list: (q: string) => request<MemoryList>(`/memory${q ? `?q=${enc(q)}` : ""}`),
  create: (text: string) => send<Memory>("POST", "/memory", { text }),
  update: (id: string, text: string) => send<Memory>("PATCH", `/memory/${enc(id)}`, { text }),
  remove: (id: string) => send<null>("DELETE", `/memory/${enc(id)}`),
  removeAll: () => request<null>("/memory", { method: "DELETE", headers: { "x-confirm": "all" } }),
  candidates: async () => (await request<{ items: Candidate[] }>("/memory/candidates")).items,
  accept: (id: string, text?: string) =>
    send<Memory>("POST", `/memory/candidates/${enc(id)}/accept`, text ? { text } : {}),
  dismiss: (id: string) => send<null>("POST", `/memory/candidates/${enc(id)}/dismiss`),
  personalise: async (answers: Record<string, string>) =>
    (await send<{ proposals: { text: string }[] }>("POST", "/memory/personalise", { answers }))
      .proposals,
  parseImport: (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return request<ImportPreview>("/memory/import/parse", { method: "POST", body: form });
  },
  commitImport: (id: string, rows: { line: number; text?: string }[]) =>
    send<{ created: number; skipped: number }>("POST", `/memory/import/${enc(id)}/commit`, {
      rows,
    }),
  /** A link the browser downloads; the session cookie goes with it. */
  exportUrl: "/api/v1/memory/export",
};

export const stylesApi = {
  list: () => request<{ mine: WritingStyle[]; workspace: WritingStyle[] }>("/writing-styles"),
  createFromInstructions: (name: string, instructions: string) =>
    send<WritingStyle>("POST", "/writing-styles", { name, instructions }),
  createFromSample: (name: string, sample: File) => {
    const form = new FormData();
    form.set("name", name);
    form.set("sample", sample);
    return request<WritingStyle>("/writing-styles", { method: "POST", body: form });
  },
  update: (
    id: string,
    patch: { name?: string; instructions?: string; derived_instructions?: string },
  ) => send<WritingStyle>("PATCH", `/writing-styles/${enc(id)}`, patch),
  remove: (id: string) => send<null>("DELETE", `/writing-styles/${enc(id)}`),
  share: (id: string, shared: boolean) =>
    send<WritingStyle>("POST", `/writing-styles/${enc(id)}/share`, { shared }),
};
