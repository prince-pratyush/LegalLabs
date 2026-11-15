import type {
  ApplyResult,
  Review,
  ReviewRequest,
  ReviewSummary,
  Suggestion,
} from "@legallabs/contracts";
import type { Alternate, ReviewParagraph } from "@legallabs/ui";
import { ApiError, type DocumentSummary } from "../api.js";

const FALLBACK = "Something went wrong. Try again.";

async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  throw new ApiError(
    res.status,
    String(body?.code ?? "UNKNOWN"),
    typeof body?.message === "string" ? body.message : FALLBACK,
  );
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "same-origin",
    headers: typeof init.body === "string" ? { "content-type": "application/json" } : {},
  });
  if (!res.ok) return fail(res);
  if (res.status === 202 || res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const send = <T>(path: string, body: unknown = {}) =>
  call<T>(path, { method: "POST", body: JSON.stringify(body) });
const r = (id: string) => `/reviews/${encodeURIComponent(id)}`;
const s = (reviewId: string, sid: string) =>
  `${r(reviewId)}/suggestions/${encodeURIComponent(sid)}`;

/** A file response saved through a temporary link, named as the server says. */
async function download(path: string, body: unknown, fallbackName: string) {
  const res = await fetch(`/api/v1${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return fail(res);
  const disposition = res.headers.get("content-disposition") ?? "";
  const named = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const name = named ? decodeURIComponent(named) : (plain ?? fallbackName);
  const url = URL.createObjectURL(await res.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Revoked after the click has been handled, or the download can be cut off.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export type ReviewListItem = Omit<Review, "results" | "gaps"> & { summary: ReviewSummary };
export type ReviewBody = { kind: "docx" | "pdf"; paragraphs: ReviewParagraph[] };

export const reviewApi = {
  start: (playbookId: string, request: ReviewRequest, draft: boolean) =>
    send<{ review_id: string; run_id: string }>(
      `/playbooks/${encodeURIComponent(playbookId)}/reviews${draft ? "?version=draft" : ""}`,
      request,
    ),
  get: async (id: string) => (await call<{ review: Review }>(r(id))).review,
  list: async (filter: { document_id?: string; playbook_id?: string } = {}) => {
    const params = new URLSearchParams();
    if (filter.document_id) params.set("filter[document_id]", filter.document_id);
    if (filter.playbook_id) params.set("filter[playbook_id]", filter.playbook_id);
    return (await call<{ reviews: ReviewListItem[] }>(`/reviews?${params}`)).reviews;
  },
  body: (id: string) => call<ReviewBody>(`${r(id)}/document`),
  cancel: (id: string) => send<void>(`${r(id)}/cancel`),
  apply: (id: string, sid: string, withComment: boolean, alternateId?: string) =>
    send<ApplyResult>(`${s(id, sid)}/apply`, {
      surface: "web",
      with_comment: withComment,
      ...(alternateId ? { alternate_id: alternateId } : {}),
    }),
  dismiss: async (id: string, sid: string) =>
    (await send<{ suggestion: Suggestion }>(`${s(id, sid)}/dismiss`)).suggestion,
  applyAll: (id: string, withComment: boolean) =>
    send<{ applied: string[]; failed: { sid: string; code: string }[] }>(
      `${r(id)}/suggestions/apply-all`,
      { surface: "web", with_comment: withComment },
    ),
  alternates: async (id: string, sid: string) =>
    (await send<{ alternates: Alternate[] }>(`${s(id, sid)}/alternates`)).alternates,
  revise: async (id: string, sid: string, instruction: string) =>
    (await send<{ suggestion: Suggestion }>(`${s(id, sid)}/revise`, { instruction })).suggestion,
  rerun: (id: string, ruleId: string, documentVersionId: string) =>
    send<{ run_id: string }>(`${r(id)}/rules/${encodeURIComponent(ruleId)}/rerun`, {
      document_version_id: documentVersionId,
    }),
  redline: (id: string, includePending: boolean) =>
    download(`${r(id)}/redline`, { include_pending: includePending }, "redline.docx"),
  exportSummary: (id: string, format: "docx" | "xlsx") =>
    download(`${r(id)}/export`, { format }, `review-summary.${format}`),
  document: async (id: string) =>
    (await call<{ document: DocumentSummary }>(`/documents/${encodeURIComponent(id)}`)).document,
};

const FINISHED = new Set(["done", "failed", "cancelled"]);
const POLL_MS = 2000;

/**
 * Follows a run's events until it ends. Falls back to polling the review where the
 * browser has no EventSource or the stream drops, so the page never waits forever.
 */
export function followRun(
  runId: string,
  reviewId: string,
  onEvent: (event: { type: string; [key: string]: unknown }) => void,
  onEnd: () => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = () => {
    if (stopped) return;
    stop();
    onEnd();
  };
  const poll = () => {
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        const review = await reviewApi.get(reviewId);
        if (FINISHED.has(review.status)) return end();
      } catch {
        // A dropped request is tried again on the next tick.
      }
      poll();
    }, POLL_MS);
  };
  let source: EventSource | null = null;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
  if (typeof EventSource === "undefined") {
    poll();
    return stop;
  }
  source = new EventSource(`/api/v1/runs/${encodeURIComponent(runId)}/events`);
  const types = [
    "review.planned",
    "review.rule_started",
    "review.rule_finished",
    "review.gap_pass_started",
    "review.gap_pass_finished",
    "review.done",
    "review.suggestion_changed",
    "status",
    "error",
  ];
  for (const type of types) {
    source.addEventListener(type, (message) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse((message as MessageEvent<string>).data) as Record<string, unknown>;
      } catch {
        // Not ours to parse: the browser's own error events carry no data.
        if (type === "error") return;
      }
      onEvent({ ...data, type });
      const status = data.status;
      if (type === "status" && typeof status === "string" && FINISHED.has(status)) end();
      if (type === "error" && data.retryable === false) end();
    });
  }
  source.onerror = () => {
    // The server closes the stream at the end; polling decides whether that was the end.
    source?.close();
    if (!stopped) poll();
  };
  return stop;
}
