import { ApiError, messageOf, type StreamingApi, safeUrl } from "@legallabs/addin";
import {
  AnswerText,
  Button,
  Field,
  NativeSelect,
  SourcesList,
  StatusText,
  Textarea,
} from "@legallabs/ui";
import { type FormEvent, useEffect, useState } from "react";
import { type Answer, ask, ingest, latestAnswer, type MailThread } from "../mail/ask.js";
import type { Skipped } from "../mail/collect.js";
import type { MailHost, MailItem } from "../office/host.js";
import { DraftCard } from "./DraftCard.js";

const MAX_QUESTION = 4_000;

const DRAFT_REQUEST =
  "Draft a reply to this email. Answer each question or request in it, stating only facts from " +
  "the email and its attachments. Write only the body of the reply, and leave [placeholders] " +
  "for anything you can't support.";

const SKIPPED: Record<Skipped["reason"], string> = {
  UNSUPPORTED_TYPE: "can't be read",
  FILE_TOO_LARGE: "too large",
  OVER_LIMIT: "over the limit for one email",
  NOT_SENT: "not in the email itself",
};

type Matter = { id: string; client_name: string; matter_name: string; matter_number: string };

/** A question about the open email and its attachments, answered with verified sources. */
export function AskPanel({
  api,
  host,
  item,
  origin,
  thread,
  onThread,
}: {
  api: StreamingApi;
  host: MailHost;
  item: MailItem;
  origin: string;
  /** The thread already holding this email, if any. */
  thread: MailThread | null;
  onThread: (thread: MailThread | null) => void;
}) {
  const [question, setQuestion] = useState("");
  const [step, setStep] = useState<"reading" | "answering" | null>(null);
  const [streamed, setStreamed] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [drafted, setDrafted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the workspace wants a matter named before anything is stored.
  const [matters, setMatters] = useState<Matter[] | null>(null);
  const [matterId, setMatterId] = useState("");

  // Coming back after signing in again: the thread's answer is asked for, not remembered.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(() => {
    if (!thread) return;
    let live = true;
    latestAnswer(api, thread.threadId).then(
      (found) => live && setAnswer(found),
      // Someone else signed in, or the thread has gone: start again.
      (err) => live && err instanceof ApiError && err.status === 404 && onThread(null),
    );
    return () => {
      live = false;
    };
  }, []);

  const needMatter = async () => {
    const { items } = await api.get<{ items: Matter[] }>("/api/v1/matters?scope=picker");
    setMatters(items);
    setError("Choose the matter this email belongs to, then ask again.");
  };

  const put = async (q: string, draft = false) => {
    setError(null);
    setDrafted(draft);
    setStreamed("");
    setAnswer(null);
    try {
      let held = thread;
      if (!held) {
        setStep("reading");
        held = await ingest(api, host, item, matterId || null);
        onThread(held);
      }
      setStep("answering");
      setAnswer(await ask(api, held.threadId, q, setStreamed));
      if (!draft) setQuestion("");
    } catch (err) {
      if (err instanceof ApiError && err.code === "MATTER_REQUIRED") {
        await needMatter().catch((e) => setError(messageOf(e)));
      } else setError(messageOf(err));
    } finally {
      setStep(null);
      setStreamed("");
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const q = question.trim();
    if (q && !step) void put(q);
  };

  const open = (n: number) => {
    const link = answer?.citations.find((c) => c.n === n)?.openUrl;
    const url = link ? safeUrl(link, origin) : null;
    if (url) host.openInBrowser(url);
  };

  return (
    <div className="grid gap-3">
      <form className="grid gap-2" onSubmit={submit}>
        {matters && !thread && (
          <Field label="Matter">
            {(props) => (
              <NativeSelect
                {...props}
                value={matterId}
                onChange={(e) => setMatterId(e.target.value)}
              >
                <option value="">Choose a matter</option>
                {matters.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.client_name}: {m.matter_name} ({m.matter_number})
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
        <Textarea
          aria-label="Ask about this email"
          placeholder="Ask about this email…"
          value={question}
          maxLength={MAX_QUESTION}
          rows={3}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
              e.currentTarget.form?.requestSubmit();
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-dense text-fg-muted" aria-live="polite">
            {step === "reading"
              ? "Reading the email…"
              : step === "answering"
                ? "Answering…"
                : thread
                  ? "Follow-ups stay in this thread."
                  : ""}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={step !== null}
              onClick={() => void put(DRAFT_REQUEST, true)}
            >
              Draft reply
            </Button>
            <Button type="submit" disabled={!question.trim() || step !== null}>
              Ask
            </Button>
          </div>
        </div>
      </form>
      {error && <StatusText tone="failed">{error}</StatusText>}
      {thread && thread.skipped.length > 0 && (
        <ul aria-label="Not read" className="grid gap-1 text-dense text-fg-muted">
          {thread.skipped.map((s) => (
            <li key={`${s.name}-${s.reason}`}>
              Not read: {s.name} ({SKIPPED[s.reason]})
            </li>
          ))}
        </ul>
      )}
      {!answer && streamed && (
        <AnswerText
          text={streamed}
          citations={[]}
          onOpen={() => {}}
          streaming
          className="text-ui"
        />
      )}
      {answer && (
        <article className="grid gap-3">
          {drafted && thread && (
            <DraftCard
              key={answer.messageId}
              api={api}
              host={host}
              item={item}
              threadId={thread.threadId}
              messageId={answer.messageId}
              ungrounded={answer.ungrounded.length > 0}
            />
          )}
          <AnswerText
            text={answer.text}
            citations={answer.citations}
            ungrounded={answer.ungrounded}
            onOpen={open}
            className="text-ui"
          />
          <SourcesList citations={answer.citations} onOpen={open} />
          <Button
            size="sm"
            variant="quiet"
            className="justify-self-start"
            // The web app has no link to one thread yet; it lists this one first.
            onClick={() => host.openInBrowser(`${origin}/`)}
          >
            Continue in web
          </Button>
        </article>
      )}
    </div>
  );
}
