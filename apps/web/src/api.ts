import {
  type ContentBlock,
  type Coverage,
  isTerminal,
  type ResponseMode,
  RunEvent,
  type RunKind,
  type RunStatus,
  type SourceSelection,
  type SourceSummary,
  type ThreadScope,
  type VaultSummary,
} from "@legallabs/contracts";

export type CitationStatus = "ok" | "mismatch" | "unresolved";

export interface Citation {
  n: number;
  at: number;
  kind: "document" | "authority";
  document_id: string | null;
  version_id: string | null;
  version_no: number | null;
  document_name: string | null;
  page: number | null;
  quote: string | null;
  char_from: number | null;
  char_to: number | null;
  status: CitationStatus;
  authority: { id: string; citation: string; title: string; url: string } | null;
  /** Set only for a verified citation: a viewer deep link, or the authority's URL. */
  open_url: string | null;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  requested_model: string | null;
  fallback: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  ungrounded: [number, number][];
  created_at: string;
  citations: Citation[];
}

export interface Run {
  id: string;
  kind: RunKind;
  status: RunStatus;
  thread_id: string;
  question_id: string;
  message_id: string | null;
  coverage: Coverage | null;
  plan: unknown;
  model: string | null;
  cost_usd: number;
}

export interface ThreadDocument {
  id: string;
  version_id: string;
  version_no: number;
  name: string;
  page_count: number;
  empty_page_count: number;
}

export interface Thread {
  id: string;
  title: string;
  matter_id: string | null;
  created_at: string;
  read_only: boolean;
  vault_ids: string[];
  sources: SourceSelection[];
  documents: ThreadDocument[];
  messages: Message[];
  runs: Run[];
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

export interface Accepted {
  thread_id: string;
  message_id: string;
  run_id: string;
}

export type DocsBucket = "0" | "1" | "2-10" | "11-100" | ">100";

export interface HistoryQuery {
  q?: string;
  type?: "assist" | "deep_analysis";
  from?: string;
  to?: string;
  docs?: DocsBucket;
  favourites?: boolean;
  cursor?: string;
}

export interface HistoryItem {
  id: string;
  title: string;
  type: "assist" | "deep_analysis";
  matter_id: string | null;
  document_count: number;
  model: string | null;
  cost_usd: number;
  last_activity_at: string;
  status: "done" | "running" | "needs_input" | "failed";
  favourite: boolean;
  shared: boolean;
}

export interface Share {
  id: string;
  principal_type: "user" | "workspace";
  principal_id: string;
  email: string | null;
  granted_at: string;
}

export interface ShareResult {
  created: string[];
  rejected: { id: string; reason: "WALL_DENIED" | "NOT_MEMBER" }[];
}

export interface Member {
  id: string;
  email: string;
  name: string;
}

export interface ModelInfo {
  id: string;
  context_window: number;
  free: boolean;
}

export interface ScopeOptions {
  vaults: VaultSummary[];
  sources: SourceSummary[];
  models: ModelInfo[];
}

export interface AskInput {
  content: string | ContentBlock[];
  scope: ThreadScope;
  matter_id?: string | null;
  model?: string;
  response_mode?: ResponseMode;
  /** Plans first and waits for approval before reading anything. */
  deep_analysis?: boolean;
}

export interface DraftVersionInfo {
  no: number;
  author: "assistant" | "user";
  created_at: string;
  chars: number;
  changes: unknown;
}

export interface Draft {
  id: string;
  thread_id: string;
  kind: "notepad" | "editor";
  title: string;
  read_only: boolean;
  versions: DraftVersionInfo[];
  latest: { no: number; body: string };
}

export interface DraftDiff {
  ops: { op: "equal" | "insert" | "delete"; text: string }[];
  summary: unknown;
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

export const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : FALLBACK);

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const json = typeof init.body === "string";
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: json ? { "content-type": "application/json" } : {},
  });
  // 202 from cancel and 204 from the toggles carry no body.
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = String(body?.code ?? body?.error ?? "UNKNOWN");
    const message = typeof body?.message === "string" ? body.message : FALLBACK;
    throw new ApiError(res.status, code, message);
  }
  return body as T;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, body === undefined ? { method } : { method, body: JSON.stringify(body) });

const enc = encodeURIComponent;
const V1 = "/api/v1";
const threadPath = (id: string) => `${V1}/threads/${enc(id)}`;
const runPath = (id: string) => `${V1}/runs/${enc(id)}`;
const draftPath = (id: string) => `${V1}/drafts/${enc(id)}`;

/** Only the filters that are set, so the URL stays short and cacheable. */
export function historyParams(query: HistoryQuery): string {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.type) params.set("type", query.type);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.docs) params.set("docs", query.docs);
  if (query.favourites) params.set("favourites", "true");
  if (query.cursor) params.set("cursor", query.cursor);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const api = {
  session: () => call<{ user_id: string; workspace_id: string }>("/auth/session"),
  login: (workspace: string, email: string, password: string) =>
    send<{ user_id: string }>("POST", "/auth/login", { workspace, email, password }),
  logout: () => send<void>("POST", "/auth/logout"),

  documents: async () =>
    (await call<{ documents: DocumentSummary[] }>(`${V1}/documents`)).documents,
  document: async (id: string) =>
    (await call<{ document: DocumentSummary }>(`${V1}/documents/${enc(id)}`)).document,
  upload: async (file: File) => {
    const form = new FormData();
    form.set("file", file);
    const init = { method: "POST", body: form };
    return (await call<{ document: DocumentSummary }>(`${V1}/documents`, init)).document;
  },

  ask: (input: AskInput) => send<Accepted>("POST", `${V1}/threads`, input),
  reply: (threadId: string, input: AskInput) =>
    send<Accepted>("POST", `${threadPath(threadId)}/messages`, input),
  thread: async (id: string) => (await call<{ thread: Thread }>(threadPath(id))).thread,
  run: async (id: string) => (await call<{ run: Run }>(runPath(id))).run,
  cancel: (runId: string) => send<void>("POST", `${runPath(runId)}/cancel`),
  approve: (runId: string) => send<void>("POST", `${runPath(runId)}/approve`),
  editPlan: (runId: string, instruction: string) =>
    send<void>("POST", `${runPath(runId)}/plan/edit`, { instruction }),

  history: (query: HistoryQuery = {}) =>
    call<{ items: HistoryItem[]; next_cursor: string | null }>(
      `${V1}/history${historyParams(query)}`,
    ),
  favourite: (threadId: string, on: boolean) =>
    send<void>(on ? "PUT" : "DELETE", `${threadPath(threadId)}/favourite`),

  shares: async (threadId: string) =>
    (await call<{ items: Share[] }>(`${threadPath(threadId)}/shares`)).items,
  share: (threadId: string, input: { user_ids: string[]; link: boolean }) =>
    send<ShareResult>("POST", `${threadPath(threadId)}/shares`, input),
  revoke: (threadId: string, shareId: string) =>
    send<void>("DELETE", `${threadPath(threadId)}/shares/${enc(shareId)}`),
  duplicate: (threadId: string) =>
    send<{ thread_id: string }>("POST", `${threadPath(threadId)}/duplicate`),

  members: async (q = "") =>
    (await call<{ items: Member[] }>(`${V1}/members${q ? `?q=${enc(q)}` : ""}`)).items,
  scopeOptions: () => call<ScopeOptions>(`${V1}/scope-options`),

  drafts: async (threadId: string) =>
    (await call<{ items: Draft[] }>(`${threadPath(threadId)}/drafts`)).items,
  createDraft: async (threadId: string, fromMessageId: string) =>
    (
      await send<{ draft: Draft }>("POST", `${threadPath(threadId)}/drafts`, {
        kind: "editor",
        from_message_id: fromMessageId,
      })
    ).draft,
  draftVersion: async (draftId: string, no: number) =>
    (await call<{ no: number; body: string }>(`${draftPath(draftId)}/versions/${no}`)).body,
  draftDiff: (draftId: string, from: number, to: number) =>
    call<DraftDiff>(`${draftPath(draftId)}/diff?from=${from}&to=${to}`),
  saveDraft: async (draftId: string, body: string) =>
    (await send<{ draft: Draft }>("POST", `${draftPath(draftId)}/versions`, { body })).draft,
  restoreDraft: async (draftId: string, no: number) =>
    (await send<{ draft: Draft }>("POST", `${draftPath(draftId)}/versions/${no}/restore`)).draft,
  editDraft: async (draftId: string, instruction: string) =>
    (await send<{ draft: Draft }>("POST", `${draftPath(draftId)}/edit`, { instruction })).draft,
  /** The .docx; with a version, edits since it come out as Word tracked changes. */
  exportDraft: async (draftId: string, trackedFrom?: number) => {
    const query = trackedFrom ? `?tracked_from=${trackedFrom}` : "";
    const res = await fetch(`${draftPath(draftId)}/export${query}`, {
      credentials: "same-origin",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const message = typeof body?.message === "string" ? body.message : FALLBACK;
      throw new ApiError(res.status, String(body?.code ?? "UNKNOWN"), message);
    }
    return res.blob();
  },
};

const EVENT_TYPES: readonly RunEvent["type"][] = [
  "status",
  "plan",
  "token",
  "citation",
  "step",
  "coverage",
  "followups",
  "done",
  "error",
];

export interface StreamOptions {
  /** Resume after this seq, e.g. when reopening a run already partly shown. */
  after?: number;
  /** Called when the browser gives up reconnecting. */
  onDrop?: () => void;
}

/**
 * Follows a run's events. The browser reconnects on its own and sends
 * Last-Event-ID, so the server resumes where the stream dropped.
 */
export function streamRun(
  runId: string,
  onEvent: (event: RunEvent) => void,
  { after, onDrop }: StreamOptions = {},
): () => void {
  const url = `${runPath(runId)}/events${after ? `?after=${after}` : ""}`;
  const source = new EventSource(url, { withCredentials: true });
  let last = after ?? 0;
  const close = () => source.close();
  const handle = (type: RunEvent["type"]) => (message: MessageEvent<string>) => {
    let data: unknown;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    // The wire drops `type` and `seq` from the body; the SSE event name and id carry them.
    const parsed = RunEvent.safeParse({
      ...(data as object),
      type,
      seq: Number(message.lastEventId),
    });
    if (!parsed.success || parsed.data.seq <= last) return;
    last = parsed.data.seq;
    onEvent(parsed.data);
    if (isTerminal(parsed.data)) close();
  };
  for (const type of EVENT_TYPES) {
    source.addEventListener(type, handle(type) as EventListener);
  }
  source.onerror = () => {
    // 2 is CLOSED: the browser has stopped retrying, e.g. after a 404.
    if (source.readyState === 2) onDrop?.();
  };
  return close;
}
