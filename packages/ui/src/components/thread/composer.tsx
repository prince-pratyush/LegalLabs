import {
  ArrowUp,
  BookOpen,
  Briefcase,
  CircleAlert,
  FileText,
  Library,
  LoaderCircle,
  Paperclip,
  Radar,
  Square,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../cn.js";
import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Popover, PopoverContent, PopoverTrigger } from "../popover.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select.js";
import { Skeleton } from "../status.js";
import { insertMention, type Mentionable, matchMentions, mentionQuery } from "./mention.js";

export const MAX_VAULTS = 2;
export const MAX_SOURCES = 5;
const MAX_LINES = 12;

export type Attachment = {
  id: string;
  label: string;
  kind: "file" | "vault" | "source";
  status?: "ready" | "processing" | "failed";
};

export type VaultOption = { id: string; name: string; fileCount: number };
export type SourceOption = { id: string; name: string; jurisdiction?: string };
export type ModelOption = { id: string; label: string; hint?: string };

export type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  /** Set when sending is not allowed; shown as the reason. */
  disabledReason?: string;
  workIn: { label: string } | null;
  onWorkIn: () => void;
  attachments: readonly Attachment[];
  onRemove: (attachment: Attachment) => void;
  onAttachFiles: (files: File[]) => void;
  vaults: readonly VaultOption[];
  selectedVaultIds: readonly string[];
  onToggleVault: (id: string) => void;
  sources: readonly SourceOption[];
  selectedSourceIds: readonly string[];
  onToggleSource: (id: string) => void;
  models: readonly ModelOption[];
  model: string;
  onModel: (id: string) => void;
  deepAnalysis: boolean;
  onDeepAnalysis: (on: boolean) => void;
  mentionables: readonly Mentionable[];
  onMention: (item: Mentionable) => void;
  className?: string;
};

const KIND_ICON = { file: FileText, vault: Library, source: BookOpen } as const;

function Chip({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const Icon = KIND_ICON[attachment.kind];
  const status = attachment.status ?? "ready";
  return (
    <li className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg-subtle pr-0.5 pl-2 text-dense">
      {status === "processing" ? (
        <LoaderCircle aria-hidden className="size-3.5 animate-spin text-accent" />
      ) : status === "failed" ? (
        <CircleAlert aria-hidden className="size-3.5 text-destructive" />
      ) : (
        <Icon aria-hidden className="size-3.5 text-fg-muted" strokeWidth={1.5} />
      )}
      <span className="max-w-48 truncate">{attachment.label}</span>
      {status !== "ready" && (
        <span className="sr-only">{status === "processing" ? ", still reading" : ", failed"}</span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.label}`}
        className="grid size-6 place-items-center rounded-sm text-fg-muted hover:tint-hover hover:text-fg"
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </li>
  );
}

function Checklist<T extends { id: string }>({
  label,
  icon,
  items,
  selected,
  max,
  render,
  onToggle,
}: {
  label: string;
  icon: ReactNode;
  items: readonly T[];
  selected: readonly string[];
  max: number;
  render: (item: T) => ReactNode;
  onToggle: (id: string) => void;
}) {
  const full = selected.length >= max;
  const hintId = useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="quiet" size="sm">
          {icon}
          {label}
          {selected.length > 0 && <span className="tabular-nums">({selected.length})</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="grid gap-1 p-2">
        <p id={hintId} className="px-1 text-caption text-fg-muted">
          {full ? `Up to ${max} per thread. Remove one to add another.` : `Choose up to ${max}.`}
        </p>
        {items.length === 0 ? (
          <p className="px-1 py-2 text-dense text-fg-muted">Nothing to choose yet.</p>
        ) : (
          <ul className="grid max-h-64 gap-0.5 overflow-y-auto">
            {items.map((item) => {
              const checked = selected.includes(item.id);
              const id = `${hintId}-${item.id}`;
              return (
                <li
                  key={item.id}
                  className="flex items-center gap-1 rounded-sm px-1 hover:tint-hover"
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    disabled={!checked && full}
                    aria-describedby={hintId}
                    onCheckedChange={() => onToggle(item.id)}
                  />
                  <label htmlFor={id} className="flex-1 py-1 text-dense">
                    {render(item)}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One place to say what to ask, what to read and which model answers. */
export function Composer(props: ComposerProps) {
  const { value, onChange, onSend, onStop, streaming, disabledReason, mentionables, onMention } =
    props;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const listId = useId();
  const reasonId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const mention = mentionQuery(value, caret);
  const matches =
    mention && mention.start !== dismissed ? matchMentions(mentionables, mention.query) : [];
  const open = matches.length > 0;
  const current = matches[Math.min(active, matches.length - 1)];

  // Grows with the text up to twelve lines, then scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_LINES + 16)}px`;
  }, [value]);

  const choose = (item: Mentionable) => {
    if (!mention) return;
    const next = insertMention(value, mention.start, caret, item.label);
    onChange(next.text);
    onMention(item);
    setCaret(next.caret);
    requestAnimationFrame(() => textarea.current?.setSelectionRange(next.caret, next.caret));
  };

  const canSend = !streaming && !disabledReason && value.trim().length > 0;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && current) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + step + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        choose(current);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(mention?.start ?? null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  const track = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value);
    setCaret(event.target.selectionStart);
    setActive(0);
  };

  const sendButton = streaming ? (
    <Button size="icon" variant="secondary" onClick={onStop} aria-label="Stop">
      <Square aria-hidden />
    </Button>
  ) : (
    <Button
      size="icon"
      onClick={onSend}
      disabled={!canSend}
      aria-label="Send"
      aria-describedby={disabledReason ? reasonId : undefined}
    >
      <ArrowUp aria-hidden />
    </Button>
  );

  return (
    <div
      className={cn(
        "grid rounded-xl border border-border bg-bg-raised focus-within:shadow-lg",
        props.className,
      )}
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <Button variant="quiet" size="sm" onClick={props.onWorkIn}>
          <Briefcase aria-hidden />
          Work in: {props.workIn?.label ?? "No matter"}
        </Button>
      </div>
      {props.attachments.length > 0 && (
        <ul aria-label="In scope" className="flex flex-wrap gap-1 px-3 pt-2">
          {props.attachments.map((attachment) => (
            <Chip
              key={`${attachment.kind}:${attachment.id}`}
              attachment={attachment}
              onRemove={() => props.onRemove(attachment)}
            />
          ))}
        </ul>
      )}
      <div className="relative px-3 py-2">
        <textarea
          ref={textarea}
          aria-label="Ask a question"
          aria-autocomplete="list"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={
            open && current ? `${listId}-${current.type}-${current.id}` : undefined
          }
          rows={1}
          value={value}
          onChange={track}
          onKeyDown={onKeyDown}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          placeholder="Ask anything, or type @ to mention a file, vault or source"
          className="block w-full resize-none bg-transparent text-body text-fg outline-none placeholder:text-fg-muted"
        />
        {open && (
          <div
            id={listId}
            role="listbox"
            aria-label="Mention"
            className="absolute bottom-full left-3 z-20 mb-1 grid w-72 gap-0.5 rounded-md border border-border bg-bg-raised p-1 shadow-lg"
          >
            {matches.map((item, i) => {
              const Icon = KIND_ICON[item.type === "document" ? "file" : item.type];
              return (
                <div
                  key={`${item.type}-${item.id}`}
                  id={`${listId}-${item.type}-${item.id}`}
                  role="option"
                  // Focus stays in the textarea; the active option is announced through it.
                  tabIndex={-1}
                  aria-selected={item === current}
                  // Pointer down, not click, so the textarea keeps focus.
                  onPointerDown={(event) => {
                    event.preventDefault();
                    choose(item);
                  }}
                  onPointerEnter={() => setActive(i)}
                  className="flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-dense aria-selected:tint-selected"
                >
                  <Icon aria-hidden className="size-4 text-fg-muted" strokeWidth={1.5} />
                  <span className="truncate">{item.label}</span>
                  <span className="ml-auto text-caption text-fg-muted">{item.type}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
        <input
          ref={files}
          type="file"
          multiple
          hidden
          aria-hidden
          tabIndex={-1}
          onChange={(event) => {
            const chosen = [...(event.target.files ?? [])];
            if (chosen.length) props.onAttachFiles(chosen);
            event.target.value = "";
          }}
        />
        <Button variant="quiet" size="sm" onClick={() => files.current?.click()}>
          <Paperclip aria-hidden />
          Files
        </Button>
        <Checklist
          label="Vaults"
          icon={<Library aria-hidden />}
          items={props.vaults}
          selected={props.selectedVaultIds}
          max={MAX_VAULTS}
          onToggle={props.onToggleVault}
          render={(vault) => (
            <span className="flex justify-between gap-2">
              <span className="truncate">{vault.name}</span>
              <span className="text-fg-muted tabular-nums">
                {vault.fileCount.toLocaleString("en-US")} files
              </span>
            </span>
          )}
        />
        <Checklist
          label="Sources"
          icon={<BookOpen aria-hidden />}
          items={props.sources}
          selected={props.selectedSourceIds}
          max={MAX_SOURCES}
          onToggle={props.onToggleSource}
          render={(source) => (
            <span className="flex justify-between gap-2">
              <span className="truncate">{source.name}</span>
              {source.jurisdiction && <span className="text-fg-muted">{source.jurisdiction}</span>}
            </span>
          )}
        />
        <div className="ml-auto flex items-center gap-1">
          <Select value={props.model} onValueChange={props.onModel}>
            <SelectTrigger aria-label="Model" className="h-7 w-40 text-dense">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {props.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                  {model.hint && <span className="ml-2 text-fg-muted">{model.hint}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant={props.deepAnalysis ? "secondary" : "quiet"}
            size="sm"
            aria-pressed={props.deepAnalysis}
            onClick={() => props.onDeepAnalysis(!props.deepAnalysis)}
          >
            <Radar aria-hidden />
            Deep
          </Button>
          {sendButton}
        </div>
      </div>
      {disabledReason && !streaming && (
        <p id={reasonId} className="px-3 pb-2 text-caption text-fg-muted">
          {disabledReason}
        </p>
      )}
    </div>
  );
}

export function ComposerSkeleton() {
  return (
    <div className="grid gap-2 rounded-xl border border-border p-3" aria-hidden>
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-7 w-full" />
    </div>
  );
}
