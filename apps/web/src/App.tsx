import {
  AppShell,
  Button,
  buttonStyles,
  Checkbox,
  CitationMarker,
  cn,
  type Evidence,
  Field,
  formatKeys,
  Input,
  type PaletteCommand,
  ResizeHandle,
  StatusText,
  setThemeSetting,
  Textarea,
  Tooltip,
} from "@legallabs/ui";
import { X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  type Citation,
  type DocumentSummary,
  type Message,
  type Thread,
  type ThreadSummary,
} from "./api.js";
import { segments } from "./text.js";

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
  if (signedIn === null) return <p className="p-6 text-fg-muted">Loading…</p>;
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
    <main className="mx-auto grid max-w-sm gap-6 px-4 py-12">
      <h1 className="text-title font-semibold">LegalLabs</h1>
      <form onSubmit={submit} className="grid gap-4">
        <h2 className="text-section font-semibold">Sign in</h2>
        <Field label="Workspace">
          {(props) => (
            <Input
              {...props}
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              autoComplete="organization"
              required
            />
          )}
        </Field>
        <Field label="Email">
          {(props) => (
            <Input
              {...props}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          )}
        </Field>
        <Field label="Password">
          {(props) => (
            <Input
              {...props}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          )}
        </Field>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="justify-self-start">
          Sign in
        </Button>
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
  const picker = useRef<HTMLInputElement>(null);
  const [sourcesOpen, setSourcesOpen] = useState(true);

  const refreshThreads = useCallback(() => {
    api.threads().then(setThreads, (err) => setError(messageOf(err)));
  }, []);

  useEffect(() => {
    api.documents().then(setDocuments, (err) => setError(messageOf(err)));
    refreshThreads();
  }, [refreshThreads]);

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
      setChosen((current) => new Set([...current, added.id]));
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
    setSourcesOpen(true);
    setActive(message.id);
    setFocus(`source-${message.id}-${citation.n}`);
  };

  const canAsk = !busy && question.trim() !== "" && (thread !== null || chosen.size > 0);
  const shown = thread?.messages.find((message) => message.id === active) ?? null;

  const commands: PaletteCommand[] = [
    ...threads.map(
      (summary): PaletteCommand => ({
        id: `thread-${summary.id}`,
        kind: "object",
        group: "Threads",
        label: summary.title,
        run: () => open(summary.id),
      }),
    ),
    { id: "new", kind: "action", group: "Actions", label: "New question", run: startOver },
    {
      id: "upload",
      kind: "action",
      group: "Actions",
      label: "Upload a document",
      run: () => picker.current?.click(),
    },
    {
      id: "light",
      kind: "action",
      group: "Settings",
      label: "Use the light theme",
      run: () => setThemeSetting("light"),
    },
    {
      id: "dark",
      kind: "action",
      group: "Settings",
      label: "Use the dark theme",
      run: () => setThemeSetting("dark"),
    },
    {
      id: "system",
      kind: "action",
      group: "Settings",
      label: "Match the system theme",
      run: () => setThemeSetting("system"),
    },
    { id: "sign-out", kind: "action", group: "Account", label: "Sign out", run: signOut },
  ];

  return (
    <AppShell
      brand="LegalLabs"
      sidebarLabel="Documents and threads"
      commands={commands}
      panel={sourcesOpen && <Sources message={shown} onHide={() => setSourcesOpen(false)} />}
      onTogglePanel={() => setSourcesOpen((open) => !open)}
      sidebar={
        <div className="grid min-w-0 gap-6">
          <section className="grid gap-2">
            <h2 className="text-caption font-semibold text-fg-muted uppercase">Documents</h2>
            <label
              className={cn(
                buttonStyles({ variant: "secondary", size: "sm" }),
                "h-auto min-h-7 justify-start py-1 text-left whitespace-normal focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent",
                uploading && "opacity-50",
              )}
            >
              {uploading ? "Reading the document…" : "Upload a document (PDF, TXT or Markdown)"}
              <input
                ref={picker}
                type="file"
                className="sr-only"
                accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
                disabled={uploading}
                onChange={(e) => {
                  upload(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            {documents.length === 0 ? (
              <p className="text-fg-muted">No documents yet.</p>
            ) : (
              <ul className="grid">
                {documents.map((document) => (
                  <li key={document.id} className="flex items-start gap-1 py-1">
                    <Checkbox
                      id={`document-${document.id}`}
                      checked={chosen.has(document.id)}
                      disabled={thread !== null}
                      onCheckedChange={() => toggle(document.id)}
                    />
                    <label htmlFor={`document-${document.id}`} className="grid min-w-0 pt-0.5">
                      <span className="truncate font-medium">{document.name}</span>
                      <span className="text-caption text-fg-muted">
                        {document.page_count === 1 ? "1 page" : `${document.page_count} pages`}
                      </span>
                      {document.empty_page_count > 0 && (
                        <span className="text-caption text-warning">
                          {`${document.empty_page_count} of ${document.page_count} pages had no readable text, so they can't be searched.`}
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-2">
            <h2 className="text-caption font-semibold text-fg-muted uppercase">Threads</h2>
            <Button variant="secondary" size="sm" className="justify-start" onClick={startOver}>
              New question
            </Button>
            <ul className="grid">
              {threads.map((summary) => (
                <li key={summary.id}>
                  <Button
                    variant="quiet"
                    size="sm"
                    className="w-full justify-start truncate aria-[current]:tint-selected"
                    aria-current={summary.id === thread?.id ? "true" : undefined}
                    onClick={() => open(summary.id)}
                  >
                    {summary.title}
                  </Button>
                </li>
              ))}
            </ul>
          </section>

          <Button variant="quiet" size="sm" className="justify-start" onClick={signOut}>
            Sign out
          </Button>
        </div>
      }
    >
      <div className="mx-auto grid max-w-[880px] gap-4 px-8 py-6">
        {thread ? (
          <>
            <h2 className="text-title font-semibold">{thread.title}</h2>
            <p className="text-fg-muted">
              Asking about {thread.documents.map((document) => document.name).join(", ")}
            </p>
            <ol className="grid gap-4">
              {thread.messages.map((message) => (
                <li key={message.id}>
                  {message.role === "user" ? (
                    <p className="text-prose font-semibold whitespace-pre-wrap">
                      {message.content}
                    </p>
                  ) : (
                    <Answer message={message} onCite={(citation) => cite(message, citation)} />
                  )}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="text-fg-muted">
            Choose one or more documents, then ask a question about them. Every answer shows where
            it came from, and whether that source was checked.
          </p>
        )}

        <form className="grid justify-items-start gap-2 border-t border-border pt-4" onSubmit={ask}>
          <Field label="Question" className="w-full">
            {(props) => (
              <Textarea
                {...props}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                maxLength={2000}
                rows={3}
              />
            )}
          </Field>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!canAsk}>
              Ask
            </Button>
            {busy && <span className="text-fg-muted">Finding an answer…</span>}
          </div>
        </form>
      </div>
    </AppShell>
  );
}

const verified = (citation: Citation) => citation.status === "ok";

// Model text is only ever rendered as text nodes, never as markup.
const evidenceOf = (citation: Citation): Evidence => ({
  n: citation.n,
  status: citation.status,
  documentName: citation.document_name,
  page: citation.page,
  quote: citation.quote,
});

function Answer({ message, onCite }: { message: Message; onCite: (citation: Citation) => void }) {
  // A reply with no model is the fixed "not found" answer, which claims nothing.
  const unsupported = message.model !== null && !message.citations.some(verified);
  return (
    <div
      className="max-w-[72ch] text-prose whitespace-pre-wrap"
      data-testid={`answer-${message.id}`}
    >
      {unsupported && (
        <p
          className="mb-2 border-l-4 border-warning py-2 pl-3 font-semibold whitespace-normal text-warning"
          role="note"
        >
          Nothing in this answer was checked against your documents. Don't rely on it without
          reading the source.
        </p>
      )}
      {segments(message.content, message.citations).map((part, i) =>
        "text" in part ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments never reorder
          <span key={i}>{part.text}</span>
        ) : (
          <CitationMarker
            key={`c${part.citation.n}`}
            evidence={evidenceOf(part.citation)}
            onOpen={() => onCite(part.citation)}
          />
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

function Sources({ message, onHide }: { message: Message | null; onHide: () => void }) {
  const citations = message?.citations ?? [];
  const [width, setWidth] = useState(360);
  return (
    <section
      aria-labelledby="sources-heading"
      style={{ width }}
      className="relative flex h-full flex-col border-l border-border bg-bg-subtle"
    >
      <ResizeHandle value={width} onChange={setWidth} label="Resize sources" />
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 id="sources-heading" className="text-section font-semibold">
          Sources
        </h2>
        <Tooltip content="Hide sources" shortcut={formatKeys("mod+/")}>
          <Button variant="quiet" size="icon" aria-label="Hide sources" onClick={onHide}>
            <X aria-hidden />
          </Button>
        </Tooltip>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {citations.length === 0 ? (
          <p className="text-fg-muted">No sources to show.</p>
        ) : (
          <ol className="grid gap-2">
            {citations.map((citation) => {
              const status = STATUS[citation.status];
              const ok = verified(citation);
              return (
                <li
                  key={citation.n}
                  id={`source-${message?.id}-${citation.n}`}
                  tabIndex={-1}
                  className={cn(
                    "grid gap-1 rounded-md border border-border border-l-4 bg-bg-raised p-3",
                    ok ? "border-l-verified" : "border-l-flagged border-dashed",
                  )}
                >
                  <p className="flex items-baseline gap-2">
                    <span className="font-semibold text-fg-muted tabular-nums">{citation.n}</span>
                    <span className="font-semibold">
                      {citation.document_name ?? "Unknown document"}
                    </span>
                    <span className="text-fg-muted">
                      {citation.page === null ? " no page given" : ` page ${citation.page}`}
                    </span>
                  </p>
                  <q className="italic">{citation.quote ?? "No quote given"}</q>
                  <p>
                    <StatusText tone={ok ? "verified" : "flagged"}>{status.label}</StatusText>
                    <span className="text-fg-muted">{` ${status.detail}`}</span>
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
