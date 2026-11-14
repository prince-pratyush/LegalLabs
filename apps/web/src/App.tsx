import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  api,
  type Citation,
  type DocumentSummary,
  type Message,
  type Thread,
  type ThreadSummary,
} from "./api.js";
import { documentStatus, segments } from "./text.js";

const FALLBACK = "Something went wrong. Try again.";

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : FALLBACK);

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    api.session().then(
      () => setSignedIn(true),
      () => setSignedIn(false),
    );
  }, []);
  if (signedIn === null) return <p className="loading">Loading…</p>;
  return signedIn ? (
    <Workspace onSignedOut={() => setSignedIn(false)} />
  ) : (
    <SignIn onSignedIn={() => setSignedIn(true)} />
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(workspace.trim(), email.trim(), password);
      onSignedIn();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        status === 401
          ? "Those details didn't match an account."
          : status === 429
            ? "Too many attempts. Wait a minute, then try again."
            : status === 400
              ? "Check the workspace, email and password."
              : FALLBACK,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="sign-in">
      <h1>LegalLabs</h1>
      <form onSubmit={submit}>
        <h2>Sign in</h2>
        <label>
          Workspace
          <input
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            autoComplete="organization"
            required
          />
        </label>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          Sign in
        </button>
      </form>
    </main>
  );
}

function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const refreshThreads = useCallback(() => {
    api.threads().then(setThreads, (err) => setError(messageOf(err)));
  }, []);

  useEffect(() => {
    api.documents().then(setDocuments, (err) => setError(messageOf(err)));
    refreshThreads();
  }, [refreshThreads]);

  // Files are read in the background, so the list is refreshed until none are waiting.
  const reading = documents.some((d) => d.status === "queued" || d.status === "parsing");
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => {
      api.documents().then(setDocuments, (err) => setError(messageOf(err)));
    }, 2000);
    return () => clearInterval(timer);
  }, [reading]);

  useEffect(() => {
    if (focus) document.getElementById(focus)?.focus();
  }, [focus]);

  const show = (next: Thread) => {
    setThread(next);
    const answers = next.messages.filter((message) => message.role === "assistant");
    setActive(answers.at(-1)?.id ?? null);
    setFocus(null);
  };

  const open = async (id: string) => {
    setError(null);
    try {
      show(await api.thread(id));
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const startOver = () => {
    setThread(null);
    setActive(null);
    setError(null);
  };

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const added = await api.upload(file);
      setDocuments((current) => [added, ...current]);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setUploading(false);
    }
  };

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const text = question.trim();
      show(thread ? await api.reply(thread.id, text) : await api.ask(text, [...chosen]));
      setQuestion("");
      refreshThreads();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    onSignedOut();
  };

  const cite = (message: Message, citation: Citation) => {
    setActive(message.id);
    setFocus(`source-${message.id}-${citation.n}`);
  };

  const canAsk = !busy && question.trim() !== "" && (thread !== null || chosen.size > 0);
  const shown = thread?.messages.find((message) => message.id === active) ?? null;

  return (
    <div className="workspace">
      <header>
        <h1>LegalLabs</h1>
        <button type="button" className="quiet" onClick={signOut}>
          Sign out
        </button>
      </header>

      <nav aria-label="Documents and threads">
        <section>
          <h2>Documents</h2>
          <label className="upload">
            {uploading ? "Reading the document…" : "Upload a document (PDF, TXT or Markdown)"}
            <input
              type="file"
              accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
              disabled={uploading}
              onChange={(e) => {
                upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {documents.length === 0 ? (
            <p className="muted">No documents yet.</p>
          ) : (
            <ul className="documents">
              {documents.map((document) => (
                <li key={document.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(document.id)}
                      disabled={thread !== null || document.status !== "indexed"}
                      onChange={() => toggle(document.id)}
                    />
                    <span className="name">{document.name}</span>
                    <span className={document.status === "failed" ? "warning" : "muted"}>
                      {documentStatus(document)}
                    </span>
                    {document.empty_page_count > 0 && (
                      <span className="warning">
                        {`${document.empty_page_count} of ${document.page_count} pages had no readable text, so they can't be searched.`}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>Threads</h2>
          <button type="button" className="quiet" onClick={startOver}>
            New question
          </button>
          <ul className="threads">
            {threads.map((summary) => (
              <li key={summary.id}>
                <button
                  type="button"
                  className="link"
                  aria-current={summary.id === thread?.id ? "true" : undefined}
                  onClick={() => open(summary.id)}
                >
                  {summary.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </nav>

      <main>
        {thread ? (
          <>
            <h2>{thread.title}</h2>
            <p className="muted">
              Asking about {thread.documents.map((document) => document.name).join(", ")}
            </p>
            <ol className="messages">
              {thread.messages.map((message) => (
                <li key={message.id} className={message.role}>
                  {message.role === "user" ? (
                    <p className="question">{message.content}</p>
                  ) : (
                    <Answer message={message} onCite={(citation) => cite(message, citation)} />
                  )}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="muted">
            Choose one or more documents, then ask a question about them. Every answer shows where
            it came from, and whether that source was checked.
          </p>
        )}

        <form className="ask" onSubmit={ask}>
          <label>
            Question
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={2000}
              rows={3}
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button type="submit" disabled={!canAsk}>
            Ask
          </button>
          {busy && <span className="muted">Finding an answer…</span>}
        </form>
      </main>

      <Sources message={shown} />
    </div>
  );
}

const verified = (citation: Citation) => citation.status === "ok";

// Model text is only ever rendered as text nodes, never as markup.
function Answer({ message, onCite }: { message: Message; onCite: (citation: Citation) => void }) {
  // A reply with no model is the fixed "not found" answer, which claims nothing.
  const unsupported = message.model !== null && !message.citations.some(verified);
  return (
    <div className="answer" data-testid={`answer-${message.id}`}>
      {unsupported && (
        <p className="unsupported" role="note">
          Nothing in this answer was checked against your documents. Don't rely on it without
          reading the source.
        </p>
      )}
      {segments(message.content, message.citations).map((part, i) =>
        "text" in part ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments never reorder
          <span key={i}>{part.text}</span>
        ) : (
          <button
            key={`c${part.citation.n}`}
            type="button"
            className={`cite ${verified(part.citation) ? "verified" : "flagged"}`}
            aria-label={`Source ${part.citation.n}, ${verified(part.citation) ? "verified" : "not verified"}`}
            onClick={() => onCite(part.citation)}
          >
            {part.citation.n}
            {verified(part.citation) ? "" : "!"}
          </button>
        ),
      )}
    </div>
  );
}

const STATUS: Record<Citation["status"], { label: string; detail: string }> = {
  ok: { label: "Verified", detail: "The quote is on that page." },
  mismatch: { label: "Not verified", detail: "The quote wasn't found on that page." },
  unresolved: { label: "Not verified", detail: "This citation couldn't be checked." },
};

function Sources({ message }: { message: Message | null }) {
  const citations = message?.citations ?? [];
  return (
    <section className="sources" aria-labelledby="sources-heading">
      <h2 id="sources-heading">Sources</h2>
      {citations.length === 0 ? (
        <p className="muted">No sources to show.</p>
      ) : (
        <ol>
          {citations.map((citation) => {
            const status = STATUS[citation.status];
            return (
              <li
                key={citation.n}
                id={`source-${message?.id}-${citation.n}`}
                tabIndex={-1}
                className={verified(citation) ? "verified" : "flagged"}
              >
                <span className="number">{citation.n}</span>
                <span className="name">{citation.document_name ?? "Unknown document"}</span>
                <span className="muted">
                  {citation.page === null ? " no page given" : ` page ${citation.page}`}
                </span>
                <q>{citation.quote ?? "No quote given"}</q>
                <strong className="status">{status.label}</strong>
                <span className="detail">{` ${status.detail}`}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
