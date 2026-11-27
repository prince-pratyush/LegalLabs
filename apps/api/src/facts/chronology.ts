import {
  type ChronologyFilter,
  type ChronologyRequest,
  type ChronologyStyle,
  FACT_LIMITS,
  type Fact,
  factDateLabel,
} from "@legallabs/contracts";
import { type Block, buildDocx, buildTableDocx, citationFootnote } from "@legallabs/docx";
import type pg from "pg";
import type { z } from "zod";
import type { Client, Principal } from "../auth/auth.js";
import { trackOutcome, trackUsage } from "../command-center/record.js";
import { csvSafe } from "../tables/export.js";
import { buildXlsx } from "../tables/xlsx.js";
import {
  type Db,
  FACT_COLUMNS,
  FactRefused,
  type FactResult,
  factTrail,
  factWhere,
  inFactSpace,
  locateOnPage,
  withCitations,
  workspaceAudit,
} from "./facts.js";

// Chronologies built from the fact table: the stored words in date order, with nothing written
// by a model. Every quote is checked against its page again before it goes out, and only facts
// the caller can see at that moment are used.

export interface ChronologyFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface Chronologies {
  /** A new thread of the caller's holding the chronology as a draft. */
  generate(
    p: Principal,
    spaceId: string,
    request: z.output<typeof ChronologyRequest>,
    client: Client,
  ): Promise<FactResult<{ thread_id: string; draft_id: string; facts: number; left_out: number }>>;
  export(
    p: Principal,
    spaceId: string,
    options: { format: "docx" | "xlsx"; style: ChronologyStyle; filter: ChronologyFilter },
    client: Client,
  ): Promise<FactResult<ChronologyFile>>;
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_BODY = 1_000_000;
const HEADER = ["Date", "Fact", "Status", "Source"];

export interface Chronology {
  space: { name: string; matterId: string | null };
  facts: Fact[];
  documents: string[];
  leftOut: number;
  notes: string[];
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const mark = (fact: Fact) => (fact.status === "disputed" ? " (disputed)" : "");
const sourceOf = (c: Fact["citations"][number]) => ({
  document: oneLine(c.document_name),
  page: c.page_no,
  quote: oneLine(c.quote),
});

/** Keeps only facts whose every quote is still on its page. */
async function verified(db: Db, facts: Fact[]) {
  const pages = new Map<string, string | null>();
  const pageText = async (versionId: string, page: number) => {
    const key = `${versionId}:${page}`;
    if (!pages.has(key)) {
      const { rows } = await db.query<{ text: string }>(
        "select text from content.page where version_id = $1 and page_no = $2",
        [versionId, page],
      );
      pages.set(key, rows[0]?.text ?? null);
    }
    return pages.get(key) ?? null;
  };
  const kept: Fact[] = [];
  for (const fact of facts) {
    let good = fact.citations.length > 0;
    for (const c of fact.citations) {
      const text = await pageText(c.version_id, c.page_no);
      good &&=
        text !== null &&
        (await locateOnPage(c.version_id, c.document_id, c.page_no, text, c.quote)) !== null;
    }
    if (good) kept.push(fact);
  }
  return kept;
}

/** A vault that forbids copies or downloads forbids this too, to all but its owner. */
async function mayCopy(db: Db, documents: string[]) {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int n
       from content.document d
       left join content.vault v on v.id = d.vault_id
      where d.id = any ($1::uuid[])
        and (v.id is null
             or (content.vault_level(v.id) is distinct from 'owner'
                 and (v.content_controls ->> 'allow_download' = 'false'
                      or v.content_controls ->> 'allow_duplicate' = 'false')))`,
    [documents],
  );
  if (rows[0]?.n !== 0) throw new FactRefused("EXPORT_DISABLED");
}

async function build(db: Db, spaceId: string, filter: ChronologyFilter): Promise<Chronology> {
  const { where, params } = factWhere(spaceId, { from: filter.from, to: filter.to });
  const clauses = [where];
  const add = (sql: (n: string) => string, value: unknown) => {
    params.push(value);
    clauses.push(sql(`$${params.length}`));
  };
  // Rejected facts are never used; disputed ones only when asked for.
  add(
    (n) => `f.status = any (${n}::text[])`,
    ["extracted", "confirmed", ...(filter.include_disputed ? ["disputed"] : [])],
  );
  for (const [kind, list] of [
    ["entity", filter.entity_ids],
    ["issue", filter.issue_ids],
  ] as const) {
    if (list?.length) {
      add(
        (n) => `exists (select 1 from apps.fact_${kind} l join apps.${kind} x on x.id = l.${kind}_id
                         where l.fact_id = f.id and x.id = any (${n}::uuid[]))`,
        list,
      );
    }
  }
  const { rows } = await db.query<Parameters<typeof withCitations>[1][number]>(
    `select ${FACT_COLUMNS} from apps.fact f where ${clauses.join(" and ")}
      order by f.sort_date, f.id limit ${FACT_LIMITS.chronology_facts + 1}`,
    params,
  );
  // Cut off, it would read as the whole story, so it is refused instead.
  if (rows.length > FACT_LIMITS.chronology_facts) throw new FactRefused("TOO_MANY_FACTS");
  const found = await withCitations(db, rows);
  const facts = await verified(db, found);
  if (facts.length === 0) throw new FactRefused("NOTHING_TO_INCLUDE");
  const documents = [...new Set(facts.flatMap((f) => f.citations.map((c) => c.document_id)))];
  await mayCopy(db, documents);
  const { rows: spaces } = await db.query<{ name: string; matter_id: string | null }>(
    "select name, matter_id from work.space where id = $1",
    [spaceId],
  );
  const { rows: unfinished } = await db.query(
    `select 1 from apps.fact_extraction where space_id = $1 and state <> 'done' limit 1`,
    [spaceId],
  );
  const leftOut = found.length - facts.length;
  const notes = [
    "Drawn from the facts in this Space's table that its maker could open. It may not include everything in the documents.",
    ...(unfinished.length ? ["At least one extraction here did not read every file."] : []),
    ...(leftOut
      ? [`${leftOut} fact(s) were left out because a quote could no longer be checked.`]
      : []),
    ...(filter.include_disputed ? ["Disputed facts are included and marked."] : []),
  ];
  return {
    space: { name: spaces[0]?.name ?? "Space", matterId: spaces[0]?.matter_id ?? null },
    facts,
    documents,
    leftOut,
    notes,
  };
}

/** Facts under one date heading, in order. */
function byDate(facts: Fact[]) {
  const groups: { date: string; facts: Fact[] }[] = [];
  for (const fact of facts) {
    const date = factDateLabel(fact);
    const last = groups.at(-1);
    if (last?.date === date) last.facts.push(fact);
    else groups.push({ date, facts: [fact] });
  }
  return groups;
}

// A fact's words are never allowed to open a heading or list of their own.
const inDraft = (text: string) => oneLine(text).replace(/^[#>*+\-\s]+/, "");

export function chronologyMarkdown(chronology: Chronology, style: ChronologyStyle): string {
  const sources: string[] = [];
  const entry = (fact: Fact) => {
    const refs = fact.citations.map((c) => {
      const s = sourceOf(c);
      sources.push(`${sources.length + 1}. ${s.document}, p. ${s.page}: "${s.quote}"`);
      return `[${sources.length}]`;
    });
    return `${inDraft(fact.text)}${mark(fact)} ${refs.join("")}`;
  };
  const body =
    style === "table"
      ? chronology.facts.map((f) => `- **${factDateLabel(f)}**: ${entry(f)}`).join("\n")
      : byDate(chronology.facts)
          .map((g) => `## ${g.date}\n\n${g.facts.map(entry).join(" ")}`)
          .join("\n\n");
  return `${body}\n\n## Sources\n\n${sources.join("\n")}\n\n${chronology.notes.join("\n\n")}\n`;
}

const sourceText = (fact: Fact) =>
  fact.citations
    .map((c) => {
      const s = sourceOf(c);
      return `${s.document}, p. ${s.page}: "${s.quote}"`;
    })
    .join("\n");

const statusWord = (fact: Fact) => fact.status[0]?.toUpperCase() + fact.status.slice(1);

function docx(chronology: Chronology, style: ChronologyStyle, at: Date): Uint8Array {
  const title = `Chronology: ${chronology.space.name}`;
  const note = (text: string): Block => ({ kind: "paragraph", runs: [{ text, italic: true }] });
  if (style === "table") {
    return buildTableDocx({
      title,
      author: "LegalLabs",
      date: at,
      header: HEADER,
      rows: chronology.facts.map((f) => [
        factDateLabel(f),
        oneLine(f.text),
        statusWord(f),
        sourceText(f),
      ]),
      after: chronology.notes.map(note),
    });
  }
  const footnotes: string[] = [];
  const blocks: Block[] = byDate(chronology.facts).flatMap((group): Block[] => [
    { kind: "heading2", runs: [{ text: group.date }] },
    {
      kind: "paragraph",
      runs: group.facts.flatMap((fact) => [
        { text: `${oneLine(fact.text)}${mark(fact)}` },
        ...fact.citations.map((c) => {
          footnotes.push(citationFootnote(sourceOf(c)));
          return { footnote: footnotes.length };
        }),
        { text: " " },
      ]),
    },
  ]);
  return buildDocx({
    title,
    author: "LegalLabs",
    date: at,
    blocks: [...blocks, ...chronology.notes.map(note)],
    footnotes,
  });
}

function xlsx(chronology: Chronology): Uint8Array {
  // Stored as text, never as a formula; quoted too, in case it is saved on as CSV.
  const cell = (text: string) => ({ text: csvSafe(text) });
  return buildXlsx([
    {
      name: "Chronology",
      rows: [
        ["Date", "Fact", "Status", "Document", "Page", "Quote"].map((text) => ({
          text,
          bold: true,
        })),
        ...chronology.facts.map((f) => [
          cell(factDateLabel(f)),
          cell(oneLine(f.text)),
          cell(statusWord(f)),
          cell(f.citations.map((c) => oneLine(c.document_name)).join("; ")),
          cell(f.citations.map((c) => String(c.page_no)).join("; ")),
          cell(f.citations.map((c) => oneLine(c.quote)).join("; ")),
        ]),
        [],
        ...chronology.notes.map((n) => [cell(n)]),
      ],
    },
  ]);
}

async function record(
  db: Db,
  p: Principal,
  spaceId: string,
  kind: "generated" | "exported",
  details: Record<string, unknown>,
  client: Client,
) {
  await factTrail(db, p, spaceId, null, kind, details);
  await workspaceAudit(db, p, `facts.${kind}`, "space", spaceId, details, client);
}

export function createChronologies(pool: pg.Pool): Chronologies {
  return {
    async generate(p, spaceId, request, client) {
      return inFactSpace(pool, p, spaceId, async (db) => {
        const chronology = await build(db, spaceId, request.filter);
        const body = chronologyMarkdown(chronology, request.style);
        if (body.length > MAX_BODY || chronology.documents.length > FACT_LIMITS.chronology_files) {
          throw new FactRefused("TOO_MANY_FACTS");
        }
        const title = `Chronology: ${chronology.space.name}`.slice(0, 200);
        // The thread names its sources, so it is closed to anyone who can't open them.
        const { rows: threads } = await db.query<{ id: string }>(
          `insert into work.thread (workspace_id, owner_id, matter_id, title, source_documents)
           values ($1, $2, $3, $4, $5) returning id`,
          [p.workspaceId, p.userId, chronology.space.matterId, title, chronology.documents],
        );
        const threadId = threads[0]?.id as string;
        const { rows: drafts } = await db.query<{ id: string }>(
          `insert into work.draft (workspace_id, thread_id, owner_id, kind, title)
           values ($1, $2, $3, 'editor', $4) returning id`,
          [p.workspaceId, threadId, p.userId, title],
        );
        const draftId = drafts[0]?.id as string;
        await db.query(
          `insert into work.draft_version (workspace_id, draft_id, no, body, author, created_by)
           values ($1, $2, 1, $3, 'assistant', $4)`,
          [p.workspaceId, draftId, body, p.userId],
        );
        await record(
          db,
          p,
          spaceId,
          "generated",
          {
            kind: request.kind,
            style: request.style,
            facts: chronology.facts.length,
            left_out: chronology.leftOut,
            thread_id: threadId,
          },
          client,
        );
        await trackUsage(db, {
          surface: "apps",
          action: "facts.generate",
          actionClass: "other",
          objectType: "space",
          objectId: spaceId,
          documentCount: chronology.documents.length,
        });
        await trackOutcome(db, {
          workflowType: "chronology_generated",
          quantity: chronology.facts.length,
        });
        return {
          thread_id: threadId,
          draft_id: draftId,
          facts: chronology.facts.length,
          left_out: chronology.leftOut,
        };
      });
    },

    async export(p, spaceId, { format, style, filter }, client) {
      return inFactSpace(pool, p, spaceId, async (db) => {
        const chronology = await build(db, spaceId, filter);
        const bytes = format === "docx" ? docx(chronology, style, new Date()) : xlsx(chronology);
        await record(
          db,
          p,
          spaceId,
          "exported",
          { format, style, facts: chronology.facts.length, left_out: chronology.leftOut },
          client,
        );
        return {
          filename: `chronology.${format}`,
          contentType: format === "docx" ? DOCX : XLSX,
          bytes,
        };
      });
    },
  };
}
