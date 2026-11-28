import { type Api, messageOf } from "@legallabs/addin";
import {
  Button,
  Checkbox,
  Field,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusText,
} from "@legallabs/ui";
import { ArrowLeft, BookCheck, Languages, SpellCheck } from "lucide-react";
import { useId, useState } from "react";
import { CardList } from "../cards/CardList.js";
import type { Card, CardState } from "../cards/card.js";
import type { Scope, WordHost } from "../office/host.js";
import { ReviewPanel } from "../review/ReviewPanel.js";
import { proofread, translate } from "./tools.js";

export const LANGUAGES = [
  "English",
  "French",
  "German",
  "Spanish",
  "Italian",
  "Portuguese",
  "Dutch",
  "Chinese (Simplified)",
  "Japanese",
  "Korean",
  "Arabic",
  "Hindi",
] as const;

const scopeWord = (scope: Scope) => (scope === "selection" ? "selection" : "document");

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <p className="text-ui tabular-nums" aria-live="polite">
      Working… {Math.min(done + 1, total)} of {total}
    </p>
  );
}

function ProofreadPanel({ api, host, scope }: { api: Api; host: WordHost; scope: Scope }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    setNote(null);
    setProgress({ done: 0, total: 1 });
    try {
      const result = await proofread(api, host, scope, (done, total) =>
        setProgress({ done, total }),
      );
      setCards(result.cards);
      if (result.skipped) setNote(`${result.skipped} very long paragraphs were left out.`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setProgress(null);
    }
  };

  const change = (id: string, state: CardState) =>
    setCards((list) => list?.map((c) => (c.id === id ? { ...c, state } : c)) ?? null);

  return (
    <div className="grid gap-3">
      <p className="text-ui text-fg-muted">
        Spelling, grammar, defined terms and cross-references in the {scopeWord(scope)}.
      </p>
      {progress ? (
        <Progress {...progress} />
      ) : (
        <Button onClick={() => void start()}>{cards ? "Proofread again" : "Proofread"}</Button>
      )}
      {note && <p className="text-dense text-fg-muted">{note}</p>}
      {error && <StatusText tone="failed">{error}</StatusText>}
      {cards && !progress && <CardList cards={cards} host={host} onChange={change} />}
    </div>
  );
}

function TranslatePanel({ api, host, scope }: { api: Api; host: WordHost; scope: Scope }) {
  const [language, setLanguage] = useState<string>("French");
  const [showEdits, setShowEdits] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editsId = useId();

  const start = async () => {
    setError(null);
    setResult(null);
    setProgress({ done: 0, total: 1 });
    try {
      const out = await translate(api, host, scope, language, showEdits, (done, total) =>
        setProgress({ done, total }),
      );
      const parts = [
        `Translated ${out.changed} paragraphs${showEdits ? " as tracked changes" : ""}.`,
      ];
      if (out.missed) parts.push(`${out.missed} came back empty and were left as they were.`);
      if (out.skipped) parts.push(`${out.skipped} very long paragraphs were left out.`);
      setResult(parts.join(" "));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="grid gap-3">
      <Field label="Translate into">
        {(props) => (
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger {...props}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      {host.capabilities.tracked && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={editsId}
            checked={showEdits}
            onCheckedChange={(on) => setShowEdits(on === true)}
          />
          <Label htmlFor={editsId}>Show edits as tracked changes</Label>
        </div>
      )}
      {progress ? (
        <Progress {...progress} />
      ) : (
        <Button disabled={!host.capabilities.tracked} onClick={() => void start()}>
          Translate the {scopeWord(scope)}
        </Button>
      )}
      {!host.capabilities.tracked && (
        <p className="text-dense text-fg-muted">
          This version of Word can't change the document from an add-in.
        </p>
      )}
      <p aria-live="polite" className="text-ui">
        {result}
      </p>
      {error && <StatusText tone="failed">{error}</StatusText>}
    </div>
  );
}

type Tool = "playbooks" | "proofread" | "translate";

const TOOLS = [
  {
    id: "playbooks",
    label: "Playbook review",
    icon: BookCheck,
    hint: "Check the document against a playbook",
  },
  { id: "proofread", label: "Proofread", icon: SpellCheck, hint: "Fix errors, as suggestions" },
  { id: "translate", label: "Translate", icon: Languages, hint: "Into another language" },
] as const;

/** The Library tab: pre-built workflows run against the open document. */
export function LibraryPanel({
  api,
  host,
  scope,
}: {
  api: Api | null;
  host: WordHost;
  scope: Scope;
}) {
  const [tool, setTool] = useState<Tool | null>(null);
  if (!tool) {
    return (
      <ul className="grid gap-2">
        {TOOLS.map(({ id, label, icon: Icon, hint }) => (
          <li key={id}>
            <button
              type="button"
              disabled={!api && id !== "playbooks"}
              onClick={() => setTool(id)}
              className="flex w-full items-center gap-3 rounded-md border border-border bg-bg-raised p-3 text-left hover:tint-hover disabled:opacity-50"
            >
              <Icon aria-hidden className="size-5 shrink-0 text-accent" strokeWidth={1.5} />
              <span className="grid">
                <span className="text-ui font-medium">{label}</span>
                <span className="text-dense text-fg-muted">{hint}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  const current = TOOLS.find((t) => t.id === tool);
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="quiet"
          aria-label="Back to Library"
          onClick={() => setTool(null)}
        >
          <ArrowLeft />
        </Button>
        <h2 className="text-ui font-semibold">{current?.label}</h2>
      </div>
      {tool === "playbooks" && <ReviewPanel api={api} host={host} />}
      {tool === "proofread" && api && <ProofreadPanel api={api} host={host} scope={scope} />}
      {tool === "translate" && api && <TranslatePanel api={api} host={host} scope={scope} />}
    </div>
  );
}
