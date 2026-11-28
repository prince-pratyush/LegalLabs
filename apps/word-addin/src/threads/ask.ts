import { type Api, ApiError } from "@legallabs/addin";
import type { AnswerCitation, Range } from "@legallabs/ui";
import type { Scope } from "../office/host.js";

export type AskCitation = AnswerCitation & {
  documentId: string | null;
  /** A LegalLabs path (the web viewer) or an https link; only for verified sources. */
  openUrl: string | null;
};

export type Answer = {
  threadId: string;
  documentId: string;
  text: string;
  citations: AskCitation[];
  ungrounded: Range[];
};

type DocumentJson = { id: string; status: string; failure_reason: string | null };
type CitationJson = {
  n: number;
  at: number;
  document_id: string | null;
  document_name: string | null;
  page: number | null;
  quote: string | null;
  status: AnswerCitation["status"];
  open_url: string | null;
};
type MessageJson = {
  role: "user" | "assistant";
  content: string;
  ungrounded: [number, number][];
  citations: CitationJson[];
};

export type Wait = (ms: number) => Promise<void>;
const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const POLL_MS = 1_000;
// Reading a long contract locally can take a while; past this the pane stops waiting.
const MAX_WAIT_MS = 10 * 60_000;

export type AskStep = "uploading" | "reading" | "answering";

/** What a previous ask left behind, so a follow-up on the same text skips the upload. */
export type AskContext = { threadId: string; documentId: string; textHash: string };

export async function textHash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Asks over the selection or document through the normal thread pipeline: the text
 * becomes a document, so every citation is verified against it like any other.
 */
export async function ask(
  api: Api,
  input: {
    question: string;
    text: string;
    scope: Scope;
    title: string;
    previous: AskContext | null;
  },
  onStep: (step: AskStep) => void,
  wait: Wait = sleep,
): Promise<Answer & { context: AskContext }> {
  const hash = await textHash(input.text);
  const same = input.previous?.textHash === hash ? input.previous : null;

  let documentId = same?.documentId;
  if (!documentId) {
    onStep("uploading");
    const form = new FormData();
    const name = `${input.title} (${input.scope === "selection" ? "selection" : "document"}).txt`;
    form.append("file", new File([input.text], name, { type: "text/plain" }));
    const { document } = await api.upload<{ document: DocumentJson }>("/api/v1/documents", form);
    documentId = document.id;
    onStep("reading");
    for (let waited = 0, current = document; ; waited += POLL_MS) {
      if (current.status === "indexed") break;
      if (current.status === "failed") {
        throw new ApiError(
          422,
          "READ_FAILED",
          current.failure_reason ?? "LegalLabs couldn't read this text.",
        );
      }
      if (waited >= MAX_WAIT_MS)
        throw new ApiError(504, "TIMEOUT", "Reading the document took too long.");
      await wait(POLL_MS);
      current = (await api.get<{ document: DocumentJson }>(`/api/v1/documents/${documentId}`))
        .document;
    }
  }

  onStep("answering");
  const body = {
    content: input.question,
    scope: { document_ids: [documentId], vault_ids: [], sources: [] },
  };
  const started = await api.post<{ thread_id: string; run_id: string }>(
    same ? `/api/v1/threads/${same.threadId}/messages` : "/api/v1/threads",
    body,
  );
  for (let waited = 0; ; waited += POLL_MS) {
    const { run } = await api.get<{ run: { status: string } }>(`/api/v1/runs/${started.run_id}`);
    if (run.status === "done") break;
    if (run.status === "failed" || run.status === "cancelled") {
      throw new ApiError(500, "RUN_FAILED", "The answer didn't finish. Try asking again.");
    }
    if (waited >= MAX_WAIT_MS) throw new ApiError(504, "TIMEOUT", "The answer took too long.");
    await wait(POLL_MS);
  }

  const { thread } = await api.get<{ thread: { messages: MessageJson[] } }>(
    `/api/v1/threads/${started.thread_id}`,
  );
  const last = thread.messages.findLast((m) => m.role === "assistant");
  if (!last) throw new ApiError(500, "NO_ANSWER", "The answer didn't arrive. Try asking again.");
  return {
    threadId: started.thread_id,
    documentId,
    text: last.content,
    ungrounded: last.ungrounded,
    citations: last.citations.map((c) => ({
      n: c.n,
      at: c.at,
      status: c.status,
      documentName: c.document_name,
      page: c.page,
      quote: c.quote,
      documentId: c.document_id,
      openUrl: c.open_url,
    })),
    context: { threadId: started.thread_id, documentId, textHash: hash },
  };
}
