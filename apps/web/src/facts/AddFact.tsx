import type { DatePrecision, FactEntity, FactFile, FactIssue } from "@legallabs/contracts";
import { Button, Input, Label, Textarea, toast } from "@legallabs/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { messageOf } from "../api.js";
import { CheckRow } from "../vaults/shared.js";
import { factsApi } from "./api.js";

const select = "h-8 rounded-md border border-control bg-bg-raised px-2 text-ui";

export interface When {
  date: string;
  precision: DatePrecision;
}

export const toWhen = ({ date, precision }: When) =>
  date && precision !== "unknown"
    ? { event_date: date, event_date_end: null, date_precision: precision }
    : { event_date: null, event_date_end: null, date_precision: "unknown" as const };

export function DateFields({
  id,
  value,
  onChange,
}: {
  id: string;
  value: When;
  onChange: (value: When) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1">
        <Label htmlFor={`${id}-date`}>Date</Label>
        <Input
          id={`${id}-date`}
          type="date"
          value={value.date}
          onChange={(e) =>
            onChange({
              date: e.target.value,
              precision: value.precision === "unknown" ? "day" : value.precision,
            })
          }
        />
      </div>
      <label className="grid gap-1 text-ui">
        How exact
        <select
          className={select}
          value={value.precision}
          onChange={(e) => onChange({ ...value, precision: e.target.value as DatePrecision })}
        >
          <option value="day">That day</option>
          <option value="month">That month</option>
          <option value="year">That year</option>
          <option value="unknown">Undated</option>
        </select>
      </label>
    </div>
  );
}

/** A fact typed by a person, cited by selecting its words on a page of a file. */
export function AddFact({
  spaceId,
  available,
  entities,
  issues,
  onAdded,
}: {
  spaceId: string;
  available: FactFile[];
  entities: FactEntity[];
  issues: FactIssue[];
  onAdded: () => void;
}) {
  const ready = available.filter((f) => f.ready);
  const [documentId, setDocumentId] = useState("");
  const [pageNo, setPageNo] = useState(1);
  const [page, setPage] = useState<string | null>(null);
  const [quote, setQuote] = useState("");
  const [text, setText] = useState("");
  const [when, setWhen] = useState<When>({ date: "", precision: "unknown" });
  const [entityIds, setEntityIds] = useState<string[]>([]);
  const [issueIds, setIssueIds] = useState<string[]>([]);
  const pageRef = useRef<HTMLElement>(null);
  const file = ready.find((f) => f.document_id === documentId);
  const version = file?.version_id;

  useEffect(() => {
    setPage(null);
    setQuote("");
    if (!documentId || !version) return;
    let current = true;
    factsApi.page(documentId, version, pageNo).then(
      (found) => current && setPage(found),
      (err) => toast.error(messageOf(err)),
    );
    return () => {
      current = false;
    };
  }, [documentId, version, pageNo]);

  // What is highlighted on the page, and only there.
  const quoteSelection = () => {
    const selected = window.getSelection();
    const inside =
      selected?.anchorNode &&
      selected.focusNode &&
      pageRef.current?.contains(selected.anchorNode) &&
      pageRef.current.contains(selected.focusNode);
    const words = inside ? selected.toString().trim() : "";
    if (words) setQuote(words);
    else toast.error("Highlight the words on the page first.");
  };

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !text.trim() || !quote.trim()) return;
    try {
      await factsApi.create(spaceId, {
        text: text.trim(),
        ...toWhen(when),
        entity_ids: entityIds,
        issue_ids: issueIds,
        citations: [{ document_version_id: file.version_id, page_no: pageNo, quote }],
      });
      setText("");
      setQuote("");
      onAdded();
    } catch (err) {
      toast.error(messageOf(err));
    }
  };

  return (
    <form onSubmit={save} aria-label="Add a fact" className="grid gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-ui">
          File
          <select
            className={select}
            value={documentId}
            onChange={(e) => {
              setDocumentId(e.target.value);
              setPageNo(1);
            }}
          >
            <option value="">Choose a file</option>
            {ready.map((f) => (
              <option key={f.document_id} value={f.document_id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        {file && (
          <div className="grid gap-1">
            <Label htmlFor="fact-page">Page (of {file.page_count})</Label>
            <Input
              id="fact-page"
              type="number"
              min={1}
              max={file.page_count}
              value={pageNo}
              onChange={(e) =>
                setPageNo(Math.min(file.page_count, Math.max(1, Number(e.target.value) || 1)))
              }
            />
          </div>
        )}
      </div>
      {page !== null && (
        <div className="grid gap-1">
          <section
            ref={pageRef}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: scrolls, so it takes the keyboard.
            tabIndex={0}
            aria-label="Page text"
            className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-control bg-bg-sunken p-2 text-dense"
          >
            {page}
          </section>
          <Button size="sm" variant="quiet" className="justify-self-start" onClick={quoteSelection}>
            Quote the highlighted words
          </Button>
        </div>
      )}
      <div className="grid gap-1">
        <Label htmlFor="fact-quote">Quote, exactly as on the page</Label>
        <Textarea
          id="fact-quote"
          value={quote}
          maxLength={2000}
          onChange={(e) => setQuote(e.target.value)}
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="fact-text">Fact, in one sentence</Label>
        <Textarea
          id="fact-text"
          value={text}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <DateFields id="new-fact" value={when} onChange={setWhen} />
      {entities.length > 0 && (
        <fieldset className="grid max-h-32 gap-1 overflow-auto">
          <legend className="text-ui">People and organisations</legend>
          {entities.map((e) => (
            <CheckRow
              key={e.id}
              label={e.canonical_name}
              checked={entityIds.includes(e.id)}
              onChange={(on) => setEntityIds((list) => toggle(list, e.id, on))}
            />
          ))}
        </fieldset>
      )}
      {issues.length > 0 && (
        <fieldset className="grid max-h-32 gap-1 overflow-auto">
          <legend className="text-ui">Issues</legend>
          {issues.map((i) => (
            <CheckRow
              key={i.id}
              label={i.name}
              checked={issueIds.includes(i.id)}
              onChange={(on) => setIssueIds((list) => toggle(list, i.id, on))}
            />
          ))}
        </fieldset>
      )}
      <Button
        type="submit"
        className="justify-self-start"
        disabled={!file || !text.trim() || !quote.trim()}
      >
        Add fact
      </Button>
    </form>
  );
}
