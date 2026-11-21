import {
  type ChangeEvent,
  type KeyboardEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../cn.js";
import { Textarea } from "../field.js";

export interface MentionColumn {
  id: string;
  label: string;
}

/** The `@` the caret is just after, with what has been typed since, or null. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s(])@\{?([^{}\n@]{0,80})$/.exec(before);
  if (!match) return null;
  // `start` is where the @ is, so a choice replaces everything from there to the caret.
  return { start: match.index + (match[1] ?? "").length, query: match[2] ?? "" };
}

/**
 * A prompt box where typing `@` lists the table's other columns; choosing one inserts
 * `@{Label}`, which the caller turns back into the column's id when it saves.
 */
export function PromptField({
  value,
  onChange,
  columns,
  id,
  rows = 3,
  maxLength = 4000,
  placeholder,
  ...aria
}: {
  value: string;
  onChange: (value: string) => void;
  columns: readonly MentionColumn[];
  id?: string;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}) {
  const listId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  // Where the caret goes once the inserted text is in the box.
  const nextCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const at = nextCaret.current;
    if (at === null || !box.current) return;
    nextCaret.current = null;
    box.current.focus();
    box.current.setSelectionRange(at, at);
  });

  const mention = dismissed ? null : mentionAt(value, caret);
  const wanted = mention?.query.trim().toLowerCase() ?? "";
  const options = mention
    ? columns.filter((c) => c.label.toLowerCase().includes(wanted)).slice(0, 8)
    : [];
  const open = options.length > 0;

  const track = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value);
    setCaret(event.target.selectionStart);
    setDismissed(false);
    setActive(0);
  };

  const choose = (column: MentionColumn) => {
    if (!mention) return;
    const end = caret;
    const insert = `@{${column.label}}`;
    const next = `${value.slice(0, mention.start)}${insert}${value.slice(end)}`;
    onChange(next);
    const at = mention.start + insert.length;
    setCaret(at);
    setDismissed(true);
    nextCaret.current = at;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      const picked = options[active];
      if (picked) {
        event.preventDefault();
        choose(picked);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    }
  };

  return (
    <div className="relative">
      <Textarea
        {...aria}
        ref={box}
        id={id}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={track}
        onKeyDown={onKeyDown}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onBlur={() => setDismissed(true)}
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Columns"
          className="absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-auto rounded-md border border-border bg-bg-raised p-1 shadow-md"
        >
          {options.map((column, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the textarea keeps focus and owns the keys (aria-activedescendant)
            <div
              key={column.id}
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              // The textarea keeps focus, so a click must not blur it before it lands.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(column)}
              className={cn(
                "cursor-pointer truncate rounded-sm px-2 py-1 text-ui",
                index === active && "tint-selected",
              )}
            >
              {column.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
