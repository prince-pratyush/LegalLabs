import { type Api, messageOf, safeUrl } from "@legallabs/addin";
import { AnswerText, Button, SourcesList, StatusText, Textarea } from "@legallabs/ui";
import { type FormEvent, useState } from "react";
import type { Scope, WordHost } from "../office/host.js";
import { type Answer, type AskContext, type AskStep, ask } from "./ask.js";

const STEP: Record<AskStep, string> = {
  uploading: "Sending the text…",
  reading: "Reading it…",
  answering: "Answering…",
};

const MAX_QUESTION = 4_000;

/** The Threads tab: a question about the selection or document, answered with verified sources. */
export function AskPanel({
  api,
  host,
  scope,
  origin,
}: {
  api: Api;
  host: WordHost;
  scope: Scope;
  origin: string;
}) {
  const [question, setQuestion] = useState("");
  const [step, setStep] = useState<AskStep | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [context, setContext] = useState<AskContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<number | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const q = question.trim();
    if (!q) return;
    setError(null);
    setStep("uploading");
    try {
      const { text } = await host.read(scope);
      if (!text.trim()) {
        setError(
          scope === "selection"
            ? "Select some text first, or ask about the whole document."
            : "The document is empty.",
        );
        return;
      }
      const result = await ask(
        api,
        { question: q, text, scope, title: host.title(), previous: context },
        setStep,
      );
      setAnswer(result);
      setContext(result.context);
      setQuestion("");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setStep(null);
    }
  };

  const citation = (n: number) => answer?.citations.find((c) => c.n === n);

  // Quotes from the open document are shown in place: Word is the viewer.
  const showInWord = async (n: number) => {
    const c = citation(n);
    if (!c?.quote) return;
    const found = await host.select(c.quote).catch(() => false);
    setMissing(found ? null : n);
  };

  const openInViewer = (n: number) => {
    const c = citation(n);
    if (!c?.openUrl) return;
    const url = safeUrl(c.openUrl, origin);
    if (url) host.openInBrowser(url);
  };

  const onMarker = (n: number) => {
    const c = citation(n);
    if (c?.documentId && c.documentId === answer?.documentId) void showInWord(n);
    else openInViewer(n);
  };

  return (
    <div className="grid gap-3">
      <form className="grid gap-2" onSubmit={submit}>
        <Textarea
          aria-label={`Ask about the ${scope}`}
          placeholder={`Ask about the ${scope}…`}
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
            {step ? STEP[step] : context ? "Follow-ups stay in this thread." : ""}
          </span>
          <Button type="submit" disabled={!question.trim() || step !== null}>
            Ask
          </Button>
        </div>
      </form>
      {error && <StatusText tone="failed">{error}</StatusText>}
      {answer && (
        <article className="grid gap-3">
          <AnswerText
            text={answer.text}
            citations={answer.citations}
            ungrounded={answer.ungrounded}
            onOpen={onMarker}
            className="text-ui"
          />
          {missing !== null && (
            <StatusText tone="warning">That passage isn't in the document as it is now.</StatusText>
          )}
          <SourcesList
            citations={answer.citations}
            onOpen={openInViewer}
            onFlagged={(n) => void showInWord(n)}
          />
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
