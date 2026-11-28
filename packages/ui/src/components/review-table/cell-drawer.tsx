import { CircleCheck, ExternalLink, Flag, Lock, LockOpen, RotateCcw, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { Textarea } from "../field.js";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../menu.js";
import { Skeleton, StatusText } from "../status.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs.js";
import { ReviewCell } from "./review-cell.js";
import {
  errorText,
  FLAG_CLASS,
  FLAG_COLORS,
  type FlagColor,
  flagName,
  formatUsd,
  type GridCell,
} from "./types.js";

export interface DrawerCitation {
  id: string;
  ordinal: number;
  document_name: string;
  page: number | null;
  quote: string;
  status: "ok" | "mismatch" | "unresolved";
  open_url: string | null;
}

export interface DrawerHistory {
  at: string;
  actor_id: string | null;
  field: string;
  old: unknown;
  new: unknown;
}

export interface DrawerDetail {
  cell: GridCell & {
    reasoning: string | null;
    looked_at: {
      documents: { document_id: string; pages: number[] }[];
      queries: string[];
      chunks_read: number;
      note: string;
    } | null;
    model: string | null;
    cost_usd: number | null;
  };
  citations: DrawerCitation[];
  history: DrawerHistory[];
}

const show = (value: unknown) =>
  value === null || value === undefined || value === ""
    ? "—"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

const FIELD_NAMES: Record<string, string> = {
  value: "Value edited",
  status: "Status",
  verified: "Verification",
  locked: "Lock",
  flag: "Flag",
  run: "Run",
};

/**
 * The cell's detail, in a bottom drawer under the grid (UX §5.4). Esc closes it;
 * the grid keeps arrow keys, so the drawer follows the active cell.
 */
export function CellDrawer({
  columnLabel,
  documentName,
  detail,
  error,
  onClose,
  onRerun,
  onVerify,
  onFlag,
  onLock,
  onSave,
  onOpenCitation,
  readOnly = false,
  height = 320,
}: {
  columnLabel: string;
  documentName: string;
  /** Null while loading. */
  detail: DrawerDetail | null;
  error?: string | null;
  onClose: () => void;
  onRerun: () => void;
  onVerify: (verified: boolean) => void;
  onFlag: (color: FlagColor | null) => void;
  onLock: (locked: boolean) => void;
  onSave: (value: string) => void;
  onOpenCitation: (citation: DrawerCitation) => void;
  /** Shows the cell without re-run, verify, flag, lock or editing. */
  readOnly?: boolean;
  height?: number;
}) {
  const cell = detail?.cell;
  const [draft, setDraft] = useState(cell?.value_text ?? "");
  const [tab, setTab] = useState("value");
  const valueId = useId();
  const [cited, setCited] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new active cell resets the draft and citation cursor
  useEffect(() => {
    setDraft(cell?.value_text ?? "");
    setCited(0);
  }, [cell?.id, cell?.value_text]);

  const locked = cell?.locked ?? false;
  const citations = detail?.citations ?? [];

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.stopPropagation();
      onClose();
    }
    // J and K step through citations, as in the viewer.
    if (tab === "citations" && citations.length > 0 && (event.key === "j" || event.key === "k")) {
      const target = event.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
      setCited((i) => (i + (event.key === "j" ? 1 : citations.length - 1)) % citations.length);
    }
  };

  const lockTip = locked ? "Unlock the cell to change it" : undefined;

  return (
    <section
      aria-label={`${columnLabel} for ${documentName}`}
      aria-busy={!detail || undefined}
      onKeyDown={onKeyDown}
      style={{ height }}
      className="flex shrink-0 flex-col border-t border-border bg-bg-subtle animate-fade-in max-tablet:fixed max-tablet:inset-0 max-tablet:z-40 max-tablet:h-auto! max-tablet:pt-[env(safe-area-inset-top)]"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="grid min-w-0 flex-1">
          <h2 className="truncate text-ui font-semibold">
            {columnLabel} · {documentName}
          </h2>
          <span className="flex items-center gap-2 text-caption text-fg-muted">
            {cell ? (
              <>
                <ReviewCell cell={cell} />
                {cell.model && <span>{cell.model}</span>}
                {cell.cost_usd !== null && <span>{formatUsd(cell.cost_usd)}</span>}
              </>
            ) : (
              <Skeleton className="h-3 w-40" />
            )}
          </span>
        </div>
        {!readOnly && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={onRerun}
              disabled={!cell || locked}
              title={lockTip}
            >
              <RotateCcw aria-hidden />
              Re-run
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onVerify(!cell?.verified_at)}
              disabled={!cell || locked}
              title={lockTip}
              aria-pressed={Boolean(cell?.verified_at)}
            >
              <CircleCheck aria-hidden />
              {cell?.verified_at ? "Verified" : "Verify"}
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="secondary" size="sm" disabled={!cell || locked} title={lockTip}>
                  <Flag
                    aria-hidden
                    className={cell?.flag_color ? FLAG_CLASS[cell.flag_color].text : undefined}
                    fill={cell?.flag_color ? "currentColor" : "none"}
                  />
                  {cell?.flag_color ? `Flagged ${flagName(cell.flag_color).toLowerCase()}` : "Flag"}
                </Button>
              </MenuTrigger>
              <MenuContent>
                {FLAG_COLORS.map((color) => (
                  <MenuItem key={color} onSelect={() => onFlag(color)}>
                    <Flag aria-hidden className={FLAG_CLASS[color].text} fill="currentColor" />
                    {flagName(color)}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem onSelect={() => onFlag(null)}>Remove flag</MenuItem>
              </MenuContent>
            </Menu>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onLock(!locked)}
              disabled={!cell}
              aria-pressed={locked}
            >
              {locked ? <LockOpen aria-hidden /> : <Lock aria-hidden />}
              {locked ? "Unlock" : "Lock"}
            </Button>
          </>
        )}
        <Button variant="quiet" size="icon" aria-label="Close cell detail" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </header>
      {error && (
        <p role="alert" className="px-4 pt-2 text-caption text-destructive">
          {error}
        </p>
      )}
      {!detail ? (
        <div className="grid gap-2 p-4" aria-hidden>
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : (
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="px-4">
            <TabsTrigger value="value">Value</TabsTrigger>
            <TabsTrigger value="reasoning">Reasoning</TabsTrigger>
            <TabsTrigger value="citations">Citations ({citations.length})</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <TabsContent value="value" className="grid gap-2">
              {detail.cell.status === "error" && (
                <StatusText tone="failed">{errorText(detail.cell.error_code)}</StatusText>
              )}
              {detail.cell.status === "null" && detail.cell.looked_at && (
                <section aria-label="Where I looked" className="grid gap-1 text-dense">
                  <p className="font-medium">No answer found. Where I looked:</p>
                  <p className="text-fg-muted">{detail.cell.looked_at.note}</p>
                  <ul className="list-disc pl-5">
                    {detail.cell.looked_at.documents.map((d) => (
                      <li key={d.document_id}>
                        {documentName}: pages {d.pages.join(", ") || "none"}
                      </li>
                    ))}
                  </ul>
                  {detail.cell.looked_at.queries.length > 0 && (
                    <p>
                      Searched for: {detail.cell.looked_at.queries.map((q) => `“${q}”`).join(", ")}
                    </p>
                  )}
                  <p className="text-fg-muted">
                    {detail.cell.looked_at.chunks_read} passages read.
                  </p>
                </section>
              )}
              <label htmlFor={valueId} className="text-ui font-medium">
                Cell value
              </label>
              <Textarea
                id={valueId}
                value={draft}
                rows={3}
                readOnly={readOnly || locked}
                onChange={(e) => setDraft(e.target.value)}
              />
              {!readOnly && (
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={locked || draft === (detail.cell.value_text ?? "")}
                    onClick={() => onSave(draft)}
                  >
                    Save value
                  </Button>
                </div>
              )}
            </TabsContent>
            <TabsContent value="reasoning">
              <p className="whitespace-pre-wrap text-dense">
                {detail.cell.reasoning || "No reasoning was recorded for this cell."}
              </p>
            </TabsContent>
            <TabsContent value="citations">
              {citations.length === 0 ? (
                <p className="text-dense text-fg-muted">No citations.</p>
              ) : (
                <ol className="grid gap-2">
                  {citations.map((c, i) => (
                    <li
                      key={c.id}
                      aria-current={i === cited || undefined}
                      className={cn(
                        "grid gap-1 rounded-md border border-border p-2 text-dense",
                        i === cited && "border-accent",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-medium text-citation">[{c.ordinal}]</span>
                        <span className="min-w-0 flex-1 truncate">
                          {c.document_name}
                          {c.page !== null && `, page ${c.page}`}
                        </span>
                        {c.status === "ok" ? (
                          <StatusText tone="verified">Quote found</StatusText>
                        ) : (
                          <StatusText tone="warning">Quote not found</StatusText>
                        )}
                        <Button
                          variant="quiet"
                          size="sm"
                          disabled={!c.open_url}
                          title={c.open_url ? undefined : "Only found quotes open in the viewer"}
                          onClick={() => onOpenCitation(c)}
                        >
                          <ExternalLink aria-hidden />
                          Jump
                        </Button>
                      </span>
                      <blockquote className="border-l-2 border-border pl-2 text-fg-muted">
                        {c.quote}
                      </blockquote>
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>
            <TabsContent value="activity">
              {detail.history.length === 0 ? (
                <p className="text-dense text-fg-muted">No activity yet.</p>
              ) : (
                <ol className="grid gap-1 text-dense">
                  {detail.history.map((h) => (
                    <li key={`${h.at}-${h.field}`} className="flex gap-2">
                      <time dateTime={h.at} className="shrink-0 text-fg-muted">
                        {new Date(h.at).toLocaleString()}
                      </time>
                      <span>
                        {FIELD_NAMES[h.field] ?? h.field}: {show(h.old)} → {show(h.new)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>
          </div>
        </Tabs>
      )}
    </section>
  );
}
