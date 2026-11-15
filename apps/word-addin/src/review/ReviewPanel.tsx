import type { PlaybookSummary } from "@legallabs/contracts";
import {
  Button,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusText,
} from "@legallabs/ui";
import { useEffect, useRef, useState } from "react";
import { type Api, messageOf } from "../api.js";
import { CardList } from "../cards/CardList.js";
import { type Card, type CardState, cardsFromReview } from "../cards/card.js";
import type { WordHost } from "../office/host.js";
import {
  listPlaybooks,
  type Mode,
  type Paper,
  reportDecision,
  rerunRule,
  sizeOf,
  startReview,
  waitForReview,
} from "./client.js";

type Phase =
  | { kind: "pick" }
  | { kind: "running"; done: number }
  | { kind: "results"; reviewId: string | null };

const REGION: Record<string, string> = {
  header: "headers",
  footer: "footers",
  toc: "tables of contents",
  text_box: "text boxes",
  footnote: "footnotes",
};

/** Spec WRD-006: say which parts Word won't be edited in, so nobody assumes they were checked. */
export const excludedLine = (regions: Record<string, number>) => {
  const parts = Object.entries(regions)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${REGION[kind] ?? kind.replace(/_/g, " ")}`);
  return parts.length ? `Read but never edited: ${parts.join(", ")}.` : null;
};

/** Library → Playbooks: customise, run against the open document, then work the cards. */
export function ReviewPanel({ api, host }: { api: Api | null; host: WordHost }) {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[] | null | undefined>(undefined);
  const [playbookId, setPlaybookId] = useState("");
  const [party, setParty] = useState("");
  const [paper, setPaper] = useState<Paper>("theirs");
  const [mode, setMode] = useState<Mode>("standard");
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [cards, setCards] = useState<Card[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  // Polling stops when the pane leaves this panel.
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const live = () => alive.current;

  useEffect(() => {
    if (!api) {
      setPlaybooks(null);
      return;
    }
    let live = true;
    listPlaybooks(api)
      .then((list) => live && setPlaybooks(list))
      .catch((err) => {
        if (!live) return;
        setPlaybooks([]);
        setError(messageOf(err));
      });
    return () => {
      live = false;
    };
  }, [api]);

  const change = (id: string, state: CardState) =>
    setCards((list) => list.map((c) => (c.id === id ? { ...c, state } : c)));

  const run = async () => {
    if (!api) return;
    setError(null);
    try {
      const { text } = await host.read("document");
      const size = sizeOf(text.length);
      if (!size.ok) {
        setError(
          "This document is over a million characters, too long to review. Ask about a selection instead.",
        );
        return;
      }
      setWarning(
        size.long
          ? "Reviews over 100 pages are slower and less accurate; consider running selected rules."
          : null,
      );
      setPhase({ kind: "running", done: 0 });
      const reviewId = await startReview(api, host, playbookId, { party, paper, mode });
      const review = await waitForReview(
        api,
        reviewId,
        (r) => live() && setPhase({ kind: "running", done: r.results.length }),
        undefined,
        live,
      );
      setCards(cardsFromReview(review));
      setExcluded(excludedLine(review.excluded_regions));
      setPhase({ kind: "results", reviewId });
    } catch (err) {
      if (!live()) return;
      setError(messageOf(err));
      setPhase({ kind: "pick" });
    }
  };

  const runSample = async () => {
    if (!import.meta.env.DEV) return;
    try {
      const { sampleCards } = await import("../dev/sample.js");
      const { paragraphs } = await host.read("document");
      setCards(await sampleCards(paragraphs));
      setPhase({ kind: "results", reviewId: null });
    } catch (err) {
      setError(messageOf(err));
    }
  };

  if (phase.kind === "results") {
    const reviewId = phase.reviewId;
    return (
      <div className="grid gap-3">
        <Button
          size="sm"
          variant="quiet"
          className="justify-self-start"
          onClick={() => setPhase({ kind: "pick" })}
        >
          New review
        </Button>
        <CardList
          cards={cards}
          host={host}
          onChange={change}
          {...(api && reviewId ? { onDecide: reportDecision(api, reviewId) } : {})}
          {...(api && reviewId
            ? {
                onRerun: (card: Card) => {
                  if (!card.ruleId || rerunning) return;
                  setRerunning(true);
                  void rerunRule(api, host, reviewId, card.ruleId)
                    .then(() => waitForReview(api, reviewId, () => {}, undefined, live))
                    .then((review) => setCards(cardsFromReview(review)))
                    .catch((err) => live() && setError(messageOf(err)))
                    .finally(() => live() && setRerunning(false));
                },
              }
            : {})}
        />
        {excluded && <p className="text-dense text-fg-muted">{excluded}</p>}
        {rerunning && (
          <p className="text-dense text-fg-muted" aria-live="polite">
            Re-running the rule…
          </p>
        )}
        {error && <StatusText tone="failed">{error}</StatusText>}
      </div>
    );
  }

  if (phase.kind === "running") {
    return (
      <div className="grid gap-2" aria-live="polite">
        <div className="h-1 overflow-hidden rounded bg-bg-subtle">
          <div className="h-full w-1/3 animate-pulse bg-accent" />
        </div>
        <p className="text-ui">Reviewing… {phase.done} rules checked</p>
        {warning && <StatusText tone="warning">{warning}</StatusText>}
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {playbooks === undefined && <p className="text-ui text-fg-muted">Loading playbooks…</p>}
      {playbooks === null && api && (
        <p className="text-ui text-fg-muted">
          Playbook reviews aren't available on this server yet.
        </p>
      )}
      {playbooks && playbooks.length === 0 && (
        <p className="text-ui text-fg-muted">No published playbooks you can use yet.</p>
      )}
      {playbooks && playbooks.length > 0 && (
        <>
          <Field label="Playbook">
            {(props) => (
              <Select value={playbookId} onValueChange={setPlaybookId}>
                <SelectTrigger {...props}>
                  <SelectValue placeholder="Choose a playbook" />
                </SelectTrigger>
                <SelectContent>
                  {playbooks.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="Party" hint="Who you act for, as named in the document.">
            {(props) => (
              <Input {...props} value={party} onChange={(e) => setParty(e.target.value)} />
            )}
          </Field>
          <Field label="Paper">
            {(props) => (
              <Select value={paper} onValueChange={(v) => setPaper(v as Paper)}>
                <SelectTrigger {...props}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="theirs">Their paper</SelectItem>
                  <SelectItem value="ours">Our paper</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="Mode">
            {(props) => (
              <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <SelectTrigger {...props}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="in_depth">In depth</SelectItem>
                  <SelectItem value="redline_only">Redlines only</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          <Button disabled={!playbookId || !party.trim()} onClick={() => void run()}>
            Review this document
          </Button>
        </>
      )}
      {import.meta.env.DEV && (
        <Button variant="secondary" onClick={() => void runSample()}>
          Sample NDA review (development)
        </Button>
      )}
      {error && <StatusText tone="failed">{error}</StatusText>}
    </div>
  );
}
