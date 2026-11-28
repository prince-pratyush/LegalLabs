import { type Api, ApiError, type StreamingApi } from "@legallabs/addin";
import type { OutlookIngest } from "@legallabs/contracts";
import type { AnswerCitation, Range } from "@legallabs/ui";
import type { MailHost, MailItem } from "../office/host.js";
import { collect, type Skipped } from "./collect.js";

/** The thread holding one email, so follow-ups don't send it again. */
export type MailThread = { itemId: string; threadId: string; skipped: Skipped[] };

export type AskCitation = AnswerCitation & {
  /** A LegalLabs path (the web viewer) or an https link; only for verified sources. */
  openUrl: string | null;
};

export type Answer = {
  messageId: string;
  text: string;
  citations: AskCitation[];
  ungrounded: Range[];
};

type CitationJson = {
  n: number;
  at: number;
  document_name: string | null;
  page: number | null;
  quote: string | null;
  status: AnswerCitation["status"];
  open_url: string | null;
};
type MessageJson = {
  id: string;
  role: "user" | "assistant";
  content: string;
  ungrounded: [number, number][];
  citations: CitationJson[];
};
type RunJson = { status: string; message_id: string | null };

export type Wait = (ms: number) => Promise<void>;
const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const POLL_MS = 1_000;
const MAX_WAIT_MS = 10 * 60_000;
const slow = (what: string) => new ApiError(504, "TIMEOUT", `${what} took too long.`);

/** Sends the open email and waits until the server has read what it can of it. */
export async function ingest(
  api: Api,
  host: MailHost,
  item: MailItem,
  matterId: string | null,
  wait: Wait = sleep,
): Promise<MailThread> {
  const { form, skipped } = await collect(host, item);
  if (matterId) form.append("matter_id", matterId);
  const made = await api.upload<OutlookIngest>("/api/v1/addins/outlook/items", form);
  const all = [...skipped, ...made.skipped];
  let reading = made.documents;
  for (let waited = 0; reading.length > 0; waited += POLL_MS) {
    const still: typeof reading = [];
    for (const document of reading) {
      const { document: now } = await api.get<{
        document: { status: (typeof document)["status"] };
      }>(`/api/v1/documents/${document.document_id}`);
      if (now.status === "failed") {
        if (document.kind === "email") {
          throw new ApiError(422, "READ_FAILED", "LegalLabs couldn't read this email.");
        }
        all.push({ name: document.sent_name ?? document.name, reason: "UNSUPPORTED_TYPE" });
      } else if (now.status !== "indexed") still.push(document);
    }
    reading = still;
    if (reading.length === 0) break;
    if (waited >= MAX_WAIT_MS) throw slow("Reading the email");
    await wait(POLL_MS);
  }
  return { itemId: item.itemId, threadId: made.thread_id, skipped: all };
}

/** The thread's latest answer, or null when nothing has been answered yet. */
export async function latestAnswer(
  api: Api,
  threadId: string,
  messageId?: string | null,
): Promise<Answer | null> {
  const { thread } = await api.get<{ thread: { messages: MessageJson[] } }>(
    `/api/v1/threads/${threadId}`,
  );
  const found = messageId
    ? thread.messages.find((m) => m.id === messageId)
    : thread.messages.findLast((m) => m.role === "assistant");
  if (!found) return null;
  return {
    messageId: found.id,
    text: found.content,
    ungrounded: found.ungrounded,
    citations: found.citations.map((c) => ({
      n: c.n,
      at: c.at,
      status: c.status,
      documentName: c.document_name,
      page: c.page,
      quote: c.quote,
      openUrl: c.open_url,
    })),
  };
}

/** One turn in the email's thread, its words handed to `onText` as they arrive. */
export async function ask(
  api: StreamingApi,
  threadId: string,
  question: string,
  onText: (text: string) => void,
  wait: Wait = sleep,
): Promise<Answer> {
  const { run_id } = await api.post<{ run_id: string }>(`/api/v1/threads/${threadId}/messages`, {
    content: question,
    scope: { document_ids: [], vault_ids: [], sources: [] },
  });
  let text = "";
  // A dropped stream is not a failed run: the run is asked about until it ends.
  await api
    .events(`/api/v1/runs/${run_id}/events`, (type, data) => {
      if (type !== "token") return;
      const { delta } = data as { delta?: unknown };
      if (typeof delta !== "string") return;
      text += delta;
      onText(text);
    })
    .catch(() => {});
  for (let waited = 0; ; waited += POLL_MS) {
    const { run } = await api.get<{ run: RunJson }>(`/api/v1/runs/${run_id}`);
    if (run.status === "done") {
      const answer = await latestAnswer(api, threadId, run.message_id);
      if (!answer)
        throw new ApiError(500, "NO_ANSWER", "The answer didn't arrive. Try asking again.");
      return answer;
    }
    if (run.status === "failed" || run.status === "cancelled") {
      throw new ApiError(500, "RUN_FAILED", "The answer didn't finish. Try asking again.");
    }
    if (waited >= MAX_WAIT_MS) throw slow("The answer");
    await wait(POLL_MS);
  }
}
