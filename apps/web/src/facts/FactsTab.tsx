import type {
  Anchor,
  EntityKind,
  Fact,
  FactEntity,
  FactFile,
  FactIssue,
  FactStatus,
} from "@legallabs/contracts";
import { Button, Input, Label, StatusText, Textarea, type Tone, toast } from "@legallabs/ui";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { messageOf } from "../api.js";
import { formatDate } from "../vaults/shared.js";
import { openCitation } from "../viewer/open-citation.js";
import { AddFact, DateFields, toWhen, type When } from "./AddFact.js";
import { type FactFilter, factsApi } from "./api.js";
import { ExtractPanel } from "./ExtractPanel.js";

const select = "h-8 rounded-md border border-control bg-bg-raised px-2 text-ui";

const STATUS: Record<FactStatus, { label: string; tone: Tone }> = {
  extracted: { label: "Extracted", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "verified" },
  disputed: { label: "Disputed", tone: "flagged" },
  rejected: { label: "Rejected", tone: "failed" },
};

const DECIDE: { status: FactStatus; verb: string }[] = [
  { status: "confirmed", verb: "Confirm" },
  { status: "disputed", verb: "Dispute" },
  { status: "rejected", verb: "Reject" },
];

/** The date as exact as the fact claims to be, never more. */
export function factDate(fact: Pick<Fact, "event_date" | "event_date_end" | "date_precision">) {
  if (!fact.event_date) return "Undated";
  const show = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
      timeZone: "UTC",
      year: "numeric",
      ...(fact.date_precision === "year" ? {} : { month: "short" }),
      ...(fact.date_precision === "day" ? { day: "numeric" } : {}),
    });
  const start = show(fact.event_date);
  return fact.event_date_end ? `${start} to ${show(fact.event_date_end)}` : start;
}

type GroupBy = "none" | "issue" | "entity";

/** One heading per issue or name; a fact with several sits under each. */
export function grouped(
  facts: Fact[],
  by: GroupBy,
  issues: FactIssue[],
  entities: FactEntity[],
): { heading: string | null; facts: Fact[] }[] {
  if (by === "none") return [{ heading: null, facts }];
  const names =
    by === "issue"
      ? issues.map((i) => [i.id, i.name] as const)
      : entities.map((e) => [e.id, e.canonical_name] as const);
  const of = (f: Fact) => (by === "issue" ? f.issue_ids : f.entity_ids);
  const groups = names
    .map(([id, heading]) => ({ heading, facts: facts.filter((f) => of(f).includes(id)) }))
    .filter((g) => g.facts.length);
  const rest = facts.filter((f) => of(f).length === 0);
  const none = by === "issue" ? "No issue" : "No one named";
  return rest.length ? [...groups, { heading: none, facts: rest }] : groups;
}

const anchors = (fact: Fact): Anchor[] =>
  fact.citations.map((c) => ({
    document_id: c.document_id,
    version_id: c.version_id,
    page: c.page_no,
    char_from: c.char_from,
    char_to: c.char_to,
    quote: c.quote,
    status: c.verified,
  }));

function Sources({ fact }: { fact: Fact }) {
  const context = anchors(fact);
  return (
    <ul className="grid gap-1">
      {fact.citations.map((c, i) => (
        <li key={c.citation_id}>
          <button
            type="button"
            className="text-left underline"
            title={c.quote}
            onClick={() => {
              const anchor = context[i];
              if (anchor) openCitation(anchor, { context });
            }}
          >
            {c.document_name}, p. {c.page_no}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Row({
  spaceId,
  fact,
  names,
  topics,
  onChanged,
}: {
  spaceId: string;
  fact: Fact;
  names: Map<string, string>;
  topics: Map<string, string>;
  onChanged: (fact: Fact) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.text);
  const [when, setWhen] = useState<When>({
    date: fact.event_date ?? "",
    precision: fact.date_precision,
  });
  const apply = (work: Promise<Fact>) =>
    work.then(
      (next) => {
        onChanged(next);
        setEditing(false);
      },
      (err) => toast.error(messageOf(err)),
    );

  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = toWhen(when);
    // A date left alone keeps its end date.
    const moved =
      next.event_date !== fact.event_date || next.date_precision !== fact.date_precision;
    apply(factsApi.change(spaceId, fact.id, { text: text.trim(), ...(moved ? next : {}) }));
  };

  return (
    <tr className="border-t border-control align-top">
      <td className="p-2 whitespace-nowrap">{factDate(fact)}</td>
      <td className="p-2">
        {editing ? (
          <form onSubmit={save} className="grid gap-2">
            <Label htmlFor={`edit-${fact.id}`}>Fact</Label>
            <Textarea
              id={`edit-${fact.id}`}
              value={text}
              maxLength={1000}
              onChange={(e) => setText(e.target.value)}
            />
            <DateFields id={`edit-${fact.id}`} value={when} onChange={setWhen} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!text.trim()}>
                Save
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p>{fact.text}</p>
            {fact.version_no > 1 && (
              <p className="text-caption text-fg-muted">Edited, version {fact.version_no}</p>
            )}
          </>
        )}
      </td>
      <td className="p-2">{fact.entity_ids.map((id) => names.get(id)).join(", ")}</td>
      <td className="p-2">{fact.issue_ids.map((id) => topics.get(id)).join(", ")}</td>
      <td className="p-2">
        <Sources fact={fact} />
      </td>
      <td className="p-2">
        <StatusText tone={STATUS[fact.status].tone}>{STATUS[fact.status].label}</StatusText>
      </td>
      <td className="p-2 whitespace-nowrap">
        {fact.source === "extracted" ? "Extraction" : "By hand"}
        <span className="block text-caption text-fg-muted">{formatDate(fact.created_at)}</span>
      </td>
      <td className="p-2">
        <div className="flex flex-wrap gap-1">
          {DECIDE.filter((d) => d.status !== fact.status).map((d) => (
            <Button
              key={d.status}
              size="sm"
              variant="quiet"
              aria-label={`${d.verb}: ${fact.text}`}
              onClick={() => apply(factsApi.setStatus(spaceId, fact.id, d.status))}
            >
              {d.verb}
            </Button>
          ))}
          <Button
            size="sm"
            variant="quiet"
            aria-label={`Edit: ${fact.text}`}
            onClick={() => {
              setText(fact.text);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        </div>
      </td>
    </tr>
  );
}

const HEADINGS = [
  "Date",
  "Fact",
  "People and organisations",
  "Issues",
  "Source",
  "Status",
  "Added",
  "Actions",
];

function Registry({
  spaceId,
  entities,
  issues,
  onChanged,
}: {
  spaceId: string;
  entities: FactEntity[];
  issues: FactIssue[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<EntityKind>("person");
  const [issue, setIssue] = useState("");
  const add = (work: Promise<unknown>, clear: () => void) =>
    work.then(
      () => {
        clear();
        onChanged();
      },
      (err) => toast.error(messageOf(err)),
    );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section aria-labelledby="entities-heading" className="grid content-start gap-2">
        <h2 id="entities-heading" className="text-section font-semibold">
          People and organisations
        </h2>
        <ul aria-label="People and organisations" className="grid gap-1 text-ui">
          {entities.map((e) => (
            <li key={e.id}>
              {e.canonical_name} <span className="text-fg-muted">({e.kind})</span>
              {e.provisional && (
                <StatusText tone="warning" className="ml-2">
                  May be a duplicate
                </StatusText>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) {
              add(factsApi.addEntity(spaceId, kind, name.trim()), () => setName(""));
            }
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="new-entity">Name</Label>
            <Input
              id="new-entity"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <label className="grid gap-1 text-ui">
            Kind
            <select
              className={select}
              value={kind}
              onChange={(e) => setKind(e.target.value as EntityKind)}
            >
              <option value="person">Person</option>
              <option value="org">Organisation</option>
              <option value="place">Place</option>
              <option value="other">Other</option>
            </select>
          </label>
          <Button type="submit" size="sm" disabled={!name.trim()}>
            Add name
          </Button>
        </form>
      </section>
      <section aria-labelledby="issues-heading" className="grid content-start gap-2">
        <h2 id="issues-heading" className="text-section font-semibold">
          Issues
        </h2>
        <ul aria-label="Issues" className="grid gap-1 text-ui">
          {issues.map((i) => (
            <li key={i.id}>{i.name}</li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (issue.trim()) add(factsApi.addIssue(spaceId, issue.trim()), () => setIssue(""));
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="new-issue">New issue</Label>
            <Input
              id="new-issue"
              value={issue}
              maxLength={200}
              onChange={(e) => setIssue(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={!issue.trim()}>
            Add issue
          </Button>
        </form>
      </section>
    </div>
  );
}

/** A Space's fact table: extract, filter, check and add facts. */
export function FactsTab({ spaceId }: { spaceId: string }) {
  const [filter, setFilter] = useState<FactFilter>({});
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [entities, setEntities] = useState<FactEntity[]>([]);
  const [issues, setIssues] = useState<FactIssue[]>([]);
  const [files, setFiles] = useState<FactFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadNames = useCallback(() => {
    factsApi.entities(spaceId).then(setEntities, () => {});
    factsApi.issues(spaceId).then(setIssues, () => {});
  }, [spaceId]);
  const load = useCallback(() => {
    factsApi.list(spaceId, filter).then(
      (page) => {
        setFacts(page.facts);
        setCursor(page.next_cursor);
        setError(null);
      },
      (err) => setError(messageOf(err)),
    );
  }, [spaceId, filter]);
  const reload = useCallback(() => {
    load();
    loadNames();
  }, [load, loadNames]);
  useEffect(load, [load]);
  useEffect(loadNames, [loadNames]);
  useEffect(() => {
    factsApi.files(spaceId).then(
      (found) => {
        setFiles(found.files);
        setTruncated(found.truncated);
      },
      () => {},
    );
  }, [spaceId]);

  const set = (key: keyof FactFilter, value: string) => setFilter((f) => ({ ...f, [key]: value }));
  const filtered = Object.values(filter).some(Boolean);
  const names = new Map(entities.map((e) => [e.id, e.canonical_name]));
  const topics = new Map(issues.map((i) => [i.id, i.name]));
  const choose = (label: string, key: keyof FactFilter, options: (readonly [string, string])[]) => (
    <label className="grid gap-1 text-ui">
      {label}
      <select
        className={select}
        value={filter[key] ?? ""}
        onChange={(e) => set(key, e.target.value)}
      >
        <option value="">Any</option>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="grid gap-6 pt-4">
      <ExtractPanel spaceId={spaceId} available={files} onFacts={reload} />
      {truncated && (
        <p className="text-dense text-fg-muted">
          Only the first {files.length} files are listed here. Extracting a whole vault reads all of
          its files, up to the limit for one extraction.
        </p>
      )}
      <section aria-labelledby="table-heading" className="grid gap-3">
        <h2 id="table-heading" className="text-section font-semibold">
          Fact table
        </h2>
        <div className="flex flex-wrap items-end gap-2">
          {choose(
            "Person or organisation",
            "entity_id",
            entities.map((e) => [e.id, e.canonical_name]),
          )}
          {choose(
            "Issue",
            "issue_id",
            issues.map((i) => [i.id, i.name]),
          )}
          {choose(
            "Status",
            "status",
            Object.entries(STATUS).map(([value, s]) => [value, s.label]),
          )}
          {choose(
            "Source file",
            "document_id",
            files.map((f) => [f.document_id, f.name]),
          )}
          {(["from", "to"] as const).map((key) => (
            <div key={key} className="grid gap-1">
              <Label htmlFor={`facts-${key}`}>{key === "from" ? "From" : "To"}</Label>
              <Input
                id={`facts-${key}`}
                type="date"
                value={filter[key] ?? ""}
                onChange={(e) => set(key, e.target.value)}
              />
            </div>
          ))}
          <label className="grid gap-1 text-ui">
            Group by
            <select
              className={select}
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            >
              <option value="none">Date only</option>
              <option value="issue">Issue</option>
              <option value="entity">Person or organisation</option>
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {facts === null ? (
          <p role="status" className="text-fg-muted">
            Loading facts
          </p>
        ) : facts.length === 0 ? (
          <p className="text-fg-muted">
            {filtered
              ? "No facts match these filters."
              : "No facts yet. Extract them from files, or add one by hand."}
          </p>
        ) : (
          <>
            {cursor && groupBy !== "none" && (
              <p className="text-dense text-fg-muted">
                Groups cover the facts loaded so far. Load more to see the rest.
              </p>
            )}
            {grouped(facts, groupBy, issues, entities).map((group) => (
              <div key={group.heading ?? "all"} className="grid gap-1 overflow-x-auto">
                {group.heading && <h3 className="font-semibold">{group.heading}</h3>}
                <table
                  aria-label={group.heading ? `Facts: ${group.heading}` : "Facts"}
                  className="w-full text-left text-ui"
                >
                  <thead>
                    <tr>
                      {HEADINGS.map((h) => (
                        <th key={h} scope="col" className="p-2 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.facts.map((fact) => (
                      <Row
                        key={fact.id}
                        spaceId={spaceId}
                        fact={fact}
                        names={names}
                        topics={topics}
                        onChanged={(next) =>
                          setFacts(
                            (list) => list?.map((f) => (f.id === next.id ? next : f)) ?? null,
                          )
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}
        {cursor && (
          <Button
            size="sm"
            variant="quiet"
            className="justify-self-start"
            onClick={() =>
              factsApi.list(spaceId, filter, cursor).then(
                (page) => {
                  setFacts((list) => [...(list ?? []), ...page.facts]);
                  setCursor(page.next_cursor);
                },
                (err) => toast.error(messageOf(err)),
              )
            }
          >
            Load more
          </Button>
        )}
        <Button
          size="sm"
          variant="quiet"
          className="justify-self-start"
          aria-expanded={adding}
          onClick={() => setAdding((on) => !on)}
        >
          Add a fact by hand
        </Button>
        {adding && (
          <AddFact
            spaceId={spaceId}
            available={files}
            entities={entities}
            issues={issues}
            onAdded={() => {
              setAdding(false);
              reload();
            }}
          />
        )}
      </section>
      <Registry spaceId={spaceId} entities={entities} issues={issues} onChanged={loadNames} />
    </div>
  );
}
