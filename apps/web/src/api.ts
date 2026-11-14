export type CitationStatus = "ok" | "mismatch" | "unresolved";

export interface Citation {
  n: number;
  at: number;
  document_id: string | null;
  version_id: string | null;
  document_name: string | null;
  page: number | null;
  quote: string | null;
  char_from: number | null;
  char_to: number | null;
  status: CitationStatus;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  created_at: string;
  citations: Citation[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  matter_id: string | null;
  created_at: string;
}

export interface ThreadDocument {
  id: string;
  version_id: string;
  name: string;
  page_count: number;
  empty_page_count: number;
}

export interface Thread extends ThreadSummary {
  documents: ThreadDocument[];
  messages: Message[];
}

export interface DocumentSummary {
  id: string;
  version_id: string;
  name: string;
  mime: string;
  size: number;
  status: "queued" | "parsing" | "indexed" | "failed";
  failure_reason: string | null;
  page_count: number | null;
  empty_page_count: number;
  matter_id: string | null;
  created_at: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const FALLBACK = "Something went wrong. Try again.";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const json = typeof init.body === "string";
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: json ? { "content-type": "application/json" } : {},
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = String(body?.code ?? body?.error ?? "UNKNOWN");
    const message = typeof body?.message === "string" ? body.message : FALLBACK;
    throw new ApiError(res.status, code, message);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body) });

const threadPath = (id: string) => `/api/v1/threads/${encodeURIComponent(id)}`;

export const api = {
  session: () => call<{ user_id: string; workspace_id: string }>("/auth/session"),
  login: (workspace: string, email: string, password: string) =>
    post<{ user_id: string }>("/auth/login", { workspace, email, password }),
  logout: () => call<void>("/auth/logout", { method: "POST" }),
  documents: async () =>
    (await call<{ documents: DocumentSummary[] }>("/api/v1/documents")).documents,
  document: async (id: string) =>
    (await call<{ document: DocumentSummary }>(`/api/v1/documents/${encodeURIComponent(id)}`))
      .document,
  upload: async (file: File) => {
    const form = new FormData();
    form.set("file", file);
    const init = { method: "POST", body: form };
    return (await call<{ document: DocumentSummary }>("/api/v1/documents", init)).document;
  },
  threads: async () => (await call<{ threads: ThreadSummary[] }>("/api/v1/threads")).threads,
  thread: async (id: string) => (await call<{ thread: Thread }>(threadPath(id))).thread,
  ask: async (question: string, documentIds: readonly string[]) => {
    const body = { question, document_ids: documentIds };
    return (await post<{ thread: Thread }>("/api/v1/threads", body)).thread;
  },
  reply: async (threadId: string, question: string) =>
    (await post<{ thread: Thread }>(`${threadPath(threadId)}/messages`, { question })).thread,
};
