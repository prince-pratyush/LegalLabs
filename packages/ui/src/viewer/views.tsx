import type { PageLayout } from "@legallabs/contracts";
import { type ReactNode, useMemo, useState } from "react";
import { cn } from "../cn.js";
import { columnLetters, parseEmail, parseSheet, parseTranscript } from "./formats.js";

export type MarkKind = "cite" | "approx" | "hit";

export interface Mark {
  from: number;
  to: number;
  kind: MarkKind;
  /** Read out by screen readers, e.g. the quote. */
  label: string;
}

export const MARK_STYLES: Record<MarkKind, string> = {
  cite: "bg-citation/25 border-l-2 border-citation",
  approx: "bg-flagged/15 outline-1 outline-dashed outline-flagged",
  hit: "bg-accent/20",
};

// Read before the marked words, since a mark's colour means nothing to a screen reader.
const PREFIX: Record<MarkKind, string> = {
  cite: "Cited:",
  approx: "Approximate match:",
  hit: "Search match:",
};

/** Text from `from` to `to`, with every mark that overlaps it drawn in place. */
export function MarkedText({
  text,
  from = 0,
  to = text.length,
  marks,
}: {
  text: string;
  from?: number;
  to?: number;
  marks: readonly Mark[];
}) {
  const parts: ReactNode[] = [];
  let at = from;
  const inside = marks.filter((m) => m.from < to && m.to > from).sort((a, b) => a.from - b.from);
  for (const mark of inside) {
    const start = Math.max(mark.from, at);
    const end = Math.min(mark.to, to);
    if (end <= start) continue;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark
        key={`${mark.kind}-${start}`}
        data-mark={mark.kind}
        className={cn("rounded-xs text-fg", MARK_STYLES[mark.kind])}
      >
        <span className="sr-only">{`${PREFIX[mark.kind]} `}</span>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < to) parts.push(text.slice(at, to));
  return <>{parts}</>;
}

export function TextPage({
  page,
  marks,
  ocr,
}: {
  page: PageLayout;
  marks: readonly Mark[];
  ocr: boolean;
}) {
  return (
    <div className="whitespace-pre-wrap break-words font-sans text-prose">
      {ocr ? (
        <p className="mb-2 text-caption text-fg-muted">
          Text read by OCR. Check it against the page.
        </p>
      ) : null}
      <MarkedText text={page.text} marks={marks} />
    </div>
  );
}

export function EmailPage({
  page,
  marks,
  attachments,
}: {
  page: PageLayout;
  marks: readonly Mark[];
  attachments: ReactNode;
}) {
  const email = useMemo(() => parseEmail(page.text), [page.text]);
  return (
    <article className="grid gap-4">
      {email.headers.length ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 border-b border-border pb-3">
          {email.headers.map((header) => (
            <div key={header.name} className="contents">
              <dt className="font-semibold text-fg-muted">{header.name}</dt>
              <dd className="break-words">{header.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {attachments}
      <div className="whitespace-pre-wrap break-words text-prose">
        <MarkedText text={page.text} from={email.bodyFrom} marks={marks} />
      </div>
    </article>
  );
}

export function TranscriptPage({ page, marks }: { page: PageLayout; marks: readonly Mark[] }) {
  const segments = useMemo(() => parseTranscript(page.text), [page.text]);
  if (!segments) return <TextPage page={page} marks={marks} ocr={false} />;
  return (
    <ol className="grid gap-3">
      {segments.map((segment) => (
        <li key={segment.from} className="grid grid-cols-[5rem_1fr] gap-3">
          <span className="text-caption text-fg-muted tabular-nums">{segment.time}</span>
          <p>
            <span className="font-semibold">{segment.speaker}: </span>
            <MarkedText text={page.text} from={segment.from} to={segment.to} marks={marks} />
          </p>
        </li>
      ))}
    </ol>
  );
}

export const isTranscript = (page: PageLayout | undefined) =>
  page ? parseTranscript(page.text) !== null : false;

const MAX_GRID_ROWS = 500;

/** One sheet as a grid. Cited cells are outlined; the formula bar shows the chosen cell. */
export function SheetPage({ page, marks }: { page: PageLayout; marks: readonly Mark[] }) {
  const sheet = useMemo(() => parseSheet(page.text), [page.text]);
  const byAddr = useMemo(() => new Map(sheet.cells.map((cell) => [cell.addr, cell])), [sheet]);
  const markOf = (from: number, to: number) => marks.find((m) => m.from < to && m.to > from);
  const cited = sheet.cells.find(
    (cell) => markOf(cell.from, cell.to)?.kind !== "hit" && markOf(cell.from, cell.to),
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const shown = byAddr.get(chosen ?? cited?.addr ?? "") ?? null;
  const rows = Math.min(sheet.rows, MAX_GRID_ROWS);
  const cols = Array.from({ length: sheet.cols }, (_, i) => i + 1);
  return (
    <div className="grid gap-2">
      <p className="flex min-h-8 items-center gap-2 rounded-md border border-border bg-bg-raised px-2 font-mono text-dense">
        <span className="font-semibold">{shown?.addr ?? "—"}</span>
        <span className="text-fg-muted">{shown?.formula ?? shown?.value ?? ""}</span>
        {shown?.formula ? <span>= {shown.value}</span> : null}
      </p>
      <div className="overflow-auto">
        <table className="border-collapse text-dense">
          <caption className="sr-only">{`Sheet ${sheet.name}`}</caption>
          <thead className="sticky top-0 bg-bg-subtle">
            <tr>
              <th scope="col" className="w-10 border border-border" />
              {cols.map((col) => (
                <th
                  key={col}
                  scope="col"
                  className="min-w-20 border border-border px-2 font-semibold text-fg-muted"
                >
                  {columnLetters(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => i + 1).map((row) => (
              <tr key={row}>
                <th scope="row" className="border border-border px-2 text-fg-muted tabular-nums">
                  {row}
                </th>
                {cols.map((col) => {
                  const addr = `${columnLetters(col)}${row}`;
                  const cell = byAddr.get(addr);
                  const mark = cell ? markOf(cell.from, cell.to) : undefined;
                  return (
                    <td
                      key={addr}
                      data-mark={mark?.kind}
                      aria-label={mark ? `${addr}, ${mark.label}` : undefined}
                      className={cn(
                        "max-w-60 truncate border border-border px-2",
                        mark && MARK_STYLES[mark.kind],
                        mark?.kind === "cite" && "outline-2 outline-citation",
                      )}
                    >
                      {cell ? (
                        <button
                          type="button"
                          onClick={() => setChosen(addr)}
                          className="w-full truncate text-left focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          {cell.value}
                        </button>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.rows > MAX_GRID_ROWS ? (
          <p className="p-2 text-fg-muted">{`Showing the first ${MAX_GRID_ROWS} rows of ${sheet.rows}.`}</p>
        ) : null}
      </div>
    </div>
  );
}
